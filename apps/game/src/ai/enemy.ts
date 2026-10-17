/**
 * Enemy bot. Rapier kinematic capsule moved along a recast navmesh path, a perception model
 * (view cone + LOS raycast + hearing), and a combat FSM (patrol → alert → engage → search → dead).
 *
 * Fairness (CoD-style, so the player is never deleted by something they couldn't see):
 *  - round-start grace: no enemy fire for the first 2.5 s;
 *  - reaction delay (≈0.6–0.9 s on Regular, ±15% per sighting) before the first shot;
 *  - accuracy ramp: spread ×3 on acquisition, easing to the archetype's spread over 1.5 s of
 *    continuous line of sight; optional off-screen penalty if the player exposes `viewDir`;
 *  - attack tokens: only a couple of bots fire aimed shots at once; the rest lay down slower
 *    suppressive fire — deliberate near misses that crack past the player — until one frees up;
 *  - a hit flinches them and pushes their next shot back.
 * While engaging they shoulder the rifle at the player and strafe (navmesh-checked, direction
 * flips every 0.8–1.6 s) instead of standing still. Corpses stay until the round is cleared.
 *
 * Registers its collider in the HitRegistry so the player's weapon damages it; headshots use a
 * height threshold. The collider is removed on death so corpses never stop bullets.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Navigation } from './navmesh';
import type { HitRegistry, Hittable } from '../combat/hittable';
import type { Tracers } from '../vfx/tracers';
import type { ParticleFx } from '../vfx/particles';
import { MuzzleFlash } from '../vfx/muzzleFlash';
import type { Sfx } from '../audio/audio';
import { Soldier, type AnimState } from './soldier';
import type { Archetype } from './archetypes';

export interface PlayerTarget {
  eye(out: THREE.Vector3): THREE.Vector3;
  isAlive(): boolean;
  applyDamage(amount: number, fromPos: THREE.Vector3): void;
  readonly colliderHandle: number;
  /** Optional: the player's view direction (unit). Enables the off-screen accuracy penalty. */
  viewDir?: (out: THREE.Vector3) => THREE.Vector3;
}

export interface EnemyDeps {
  scene: THREE.Scene;
  world: RAPIER_NS.World;
  nav: Navigation;
  registry: HitRegistry;
  tracers: Tracers; // reddish enemy tracers
  fx: ParticleFx; // muzzle smoke
  player: PlayerTarget;
  sfx: Sfx;
}

const RADIUS = 0.35;
const CYL_HALF = 0.55; // total capsule ≈ 1.8 m
export const CAPSULE_HALF_HEIGHT = CYL_HALF + RADIUS;
export const CONTROLLER_OFFSET = 0.02;

const VIEW_DIST = 42;
const FOV_COS = Math.cos((100 * Math.PI) / 180 / 2); // 100° cone
const HEAR_DIST = 26;
const GRAVITY = 24;
const EYE_Y = 0.55; // eye above capsule centre

const GRACE_T = 2.5; // s of no enemy fire after the round starts
const RAMP_T = 1.5; // s of continuous LOS to reach base accuracy
const RAMP_MUL = 3; // spread multiplier at first acquisition
const LOS_FORGET = 0.3; // s without LOS before the accuracy ramp resets
const OFFSCREEN_COS = Math.cos((55 * Math.PI) / 180); // outside ~110° of the player's view
const OFFSCREEN_MUL = 2.2;
const FLINCH_DELAY = 0.25; // s added to the next shot when hit
const NEAR_MISS = 2.5; // m: tracers that would end this close to the eye stop short
const STRAFE_MIN = 0.8;
const STRAFE_MAX = 1.6;
const TOKEN_HOLD = 2.2; // s an aimed-fire token is held
const TOKEN_COOLDOWN = 0.8; // s before the same bot may take a token again
const SUPPRESS_OFFSET = 0.75; // m: suppressive rounds are aimed at least this far off the body

/** Limits how many bots may fire *aimed* shots at the player at the same time. */
export class AttackTokens {
  private held = 0;
  constructor(private readonly max: number) {}
  tryTake(): boolean {
    if (this.held >= this.max) return false;
    this.held += 1;
    return true;
  }
  release(): void {
    if (this.held > 0) this.held -= 1;
  }
  reset(): void {
    this.held = 0;
  }
}

type State = 'patrol' | 'alert' | 'engage' | 'search' | 'dead';

export class Enemy implements Hittable {
  private readonly group = new THREE.Group();
  private readonly body: RAPIER_NS.RigidBody;
  private readonly collider: RAPIER_NS.Collider;
  private readonly controller: RAPIER_NS.KinematicCharacterController;
  private physicsLive = true;

  private readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private state: State = 'patrol';

  private readonly path: THREE.Vector3[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private waitTimer = 0;
  private reactionTimer = 0;
  private fireTimer = 0;
  private searchTimer = 0;
  private graceTimer = GRACE_T;
  private losTime = 0; // continuous line-of-sight time (accuracy ramp)
  private lostTimer = 0;
  private strafeDir = 0; // -1 / 0 / +1 (left / hold / right of the line to the player)
  private strafeTimer = 0;
  private readonly strafeTarget = new THREE.Vector3();
  private aimPitch = 0;
  private tokenT = 0; // > 0 while holding an aimed-fire token
  private tokenCool = 0;
  private readonly lastKnown = new THREE.Vector3();

  // Oversized vs. real (~0.25 m) so a shooter reads at 30 m — standard FPS readability cheat.
  private readonly muzzleFlash = new MuzzleFlash(0.5);
  private readonly character: Soldier;
  private animState: AnimState = 'idle';
  private hp: number;

  // scratch (no per-tick allocations; the Ray aliases _eye/_toPlayer)
  private readonly _eye = new THREE.Vector3();
  private readonly _pEye = new THREE.Vector3();
  private readonly _toPlayer = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _wp = new THREE.Vector3();
  private readonly _snap = new THREE.Vector3();
  private readonly _muzzle = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _end = new THREE.Vector3();
  private readonly _move = { x: 0, y: 0, z: 0 };
  private readonly ray: RAPIER_NS.Ray;

  constructor(
    private readonly deps: EnemyDeps,
    spawn: THREE.Vector3,
    private readonly arch: Archetype,
    private readonly tokens: AttackTokens,
  ) {
    this.pos.copy(spawn);
    this.prevPos.copy(spawn);
    this.hp = arch.maxHp;
    this.ray = new RAPIER.Ray(this._eye, this._toPlayer);

    this.character = new Soldier(arch.soldier);
    this.group.add(this.character.root);
    this.group.position.copy(spawn);
    deps.scene.add(this.group);

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      spawn.x,
      spawn.y,
      spawn.z,
    );
    this.body = deps.world.createRigidBody(bodyDesc);
    this.collider = deps.world.createCollider(
      RAPIER.ColliderDesc.capsule(CYL_HALF, RADIUS),
      this.body,
    );
    deps.registry.register(this.collider.handle, this);

    this.controller = deps.world.createCharacterController(CONTROLLER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.4, 0.2, true);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    this.character.muzzleAnchor.add(this.muzzleFlash.root); // at the rifle muzzle
  }

  get isDead(): boolean {
    return this.state === 'dead';
  }

  // --- Hittable ---
  headY(): number {
    return this.pos.y + 0.42;
  }
  onHit(damage: number, _point: THREE.Vector3, _headshot: boolean): boolean {
    if (this.state === 'dead') return false;
    this.hp -= damage;
    if (this.hp <= 0) {
      this.die();
      return true;
    }
    // Flinch: visible reaction + their next shot is pushed back.
    this.character.flinch();
    this.fireTimer = Math.max(this.fireTimer, 0) + FLINCH_DELAY;
    // Getting shot alerts + reveals the player instantly.
    if (this.state === 'patrol') this.toAlert();
    this.deps.player.eye(this.lastKnown);
    return false;
  }

  private die(): void {
    this.state = 'dead';
    this.animState = 'dead';
    this.vel.set(0, 0, 0);
    this.muzzleFlash.hide();
    this.deps.sfx.enemyDeath(this.pos);
    this.dropToken();
    this.removePhysics(); // the corpse stays visible but never blocks shots or movement
  }

  private dropToken(): void {
    if (this.tokenT > 0) this.tokens.release();
    this.tokenT = 0;
  }

  private removePhysics(): void {
    if (!this.physicsLive) return;
    this.physicsLive = false;
    this.deps.registry.unregister(this.collider.handle);
    this.deps.world.removeCharacterController(this.controller);
    this.deps.world.removeCollider(this.collider, false);
    this.deps.world.removeRigidBody(this.body);
  }

  /** Player gunfire heard from `pos`. */
  hear(pos: THREE.Vector3): void {
    if (this.state === 'dead') return;
    const d = this.pos.distanceTo(pos);
    if (d > HEAR_DIST) return;
    this.lastKnown.copy(pos);
    if (this.state === 'patrol') this.toAlert();
  }

  private toAlert(): void {
    this.state = 'alert';
    this.reactionTimer = this.arch.reaction * (0.85 + Math.random() * 0.3);
    this.path.length = 0;
  }

  // --- Perception ---
  private canSeePlayer(): boolean {
    if (!this.deps.player.isAlive()) return false;
    this.deps.player.eye(this._pEye);
    this._eye.copy(this.pos);
    this._eye.y += EYE_Y;
    this._toPlayer.subVectors(this._pEye, this._eye);
    const dist = this._toPlayer.length();
    if (dist > VIEW_DIST || dist < 0.001) return false;
    this._toPlayer.multiplyScalar(1 / dist);

    // View cone (skip the cone test once already engaged, so it keeps tracking).
    if (this.state === 'patrol' || this.state === 'search') {
      this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      if (this._fwd.dot(this._toPlayer) < FOV_COS) return false;
    }

    // Line of sight: ray to the player; visible iff the first thing hit is the player.
    const hit = this.deps.world.castRay(this.ray, dist + 0.5, true, undefined, undefined, this.collider);
    return hit !== null && hit.collider.handle === this.deps.player.colliderHandle;
  }

  // --- Fixed-step update ---
  integrate(dt: number): void {
    this.prevPos.copy(this.pos);
    if (this.state === 'dead') return;

    const seesPlayer = this.canSeePlayer();
    this.repathTimer -= dt;
    this.fireTimer -= dt;
    this.graceTimer -= dt;
    this.tokenCool -= dt;
    if (this.tokenT > 0) {
      this.tokenT -= dt;
      if (this.tokenT <= 0) {
        this.tokens.release();
        this.tokenCool = TOKEN_COOLDOWN;
      }
    }
    if (seesPlayer) {
      // The accuracy ramp only starts once they're allowed to shoot (not during the grace).
      if (this.graceTimer <= 0) this.losTime += dt;
      this.lostTimer = 0;
    } else {
      this.lostTimer += dt;
      if (this.lostTimer > LOS_FORGET) this.losTime = 0;
    }

    switch (this.state) {
      case 'patrol':
        this.tickPatrol(dt, seesPlayer);
        break;
      case 'alert':
        this.tickAlert(dt, seesPlayer);
        break;
      case 'engage':
        this.tickEngage(dt, seesPlayer);
        break;
      case 'search':
        this.tickSearch(dt, seesPlayer);
        break;
    }

    this.applyMovement(dt);

    // Locomotion animation state (dead is set in die()); aim pitch toward the last known eye.
    const moving = Math.hypot(this.vel.x, this.vel.z) > 0.4;
    this.animState = moving ? 'run' : 'idle';
    const dx = this.lastKnown.x - this.pos.x;
    const dz = this.lastKnown.z - this.pos.z;
    this.aimPitch = Math.atan2(this.lastKnown.y - (this.pos.y + EYE_Y), Math.max(0.5, Math.hypot(dx, dz)));

    this.muzzleFlash.update(dt);
  }

  private tickPatrol(dt: number, sees: boolean): void {
    if (sees) {
      this.deps.player.eye(this.lastKnown);
      this.toAlert();
      return;
    }
    this.vel.x = 0;
    this.vel.z = 0;
    if (this.waitTimer > 0) {
      this.waitTimer -= dt;
      return;
    }
    if (this.pathIndex >= this.path.length) {
      const p = this.deps.nav.randomPoint(this.pos, 14);
      if (p) this.setPath(p);
      else this.waitTimer = 1;
      return;
    }
    this.steerAlongPath(this.arch.patrolSpeed);
  }

  private tickAlert(dt: number, sees: boolean): void {
    this.vel.x = 0;
    this.vel.z = 0;
    if (sees) this.deps.player.eye(this.lastKnown);
    this.faceToward(this.lastKnown);
    this.reactionTimer -= dt;
    if (this.reactionTimer <= 0) {
      this.state = 'engage';
      this.strafeTimer = 0;
    }
  }

  private tickEngage(dt: number, sees: boolean): void {
    if (sees) {
      this.deps.player.eye(this.lastKnown);
      this.faceToward(this.lastKnown);
      const dist = this.pos.distanceTo(this.lastKnown);
      if (dist <= this.arch.fireRange) {
        this.strafe(dt);
        if (this.fireTimer <= 0 && this.graceTimer <= 0) {
          if (this.tokenT <= 0 && this.tokenCool <= 0 && this.tokens.tryTake()) this.tokenT = TOKEN_HOLD;
          const aimed = this.tokenT > 0;
          const offscreen = this.shoot(aimed);
          const slow = (offscreen ? 1.5 : 1) * (aimed ? 1 : 1.6);
          this.fireTimer = this.arch.fireInterval * (0.8 + Math.random() * 0.4) * slow;
        }
      } else {
        this.advanceTo(this.lastKnown);
      }
    } else {
      this.state = 'search';
      this.searchTimer = 4;
      this.setPath(this.lastKnown);
    }
  }

  private tickSearch(dt: number, sees: boolean): void {
    if (sees) {
      this.deps.player.eye(this.lastKnown);
      // Re-acquired: a short re-aim before shooting (the accuracy ramp restarts too).
      this.state = 'engage';
      this.strafeTimer = 0;
      this.fireTimer = Math.max(this.fireTimer, this.arch.reaction * 0.5);
      return;
    }
    this.searchTimer -= dt;
    if (this.searchTimer <= 0 || this.pathIndex >= this.path.length) {
      this.state = 'patrol';
      this.path.length = 0;
      this.pathIndex = 0;
      return;
    }
    this.steerAlongPath(this.arch.engageSpeed);
    if (this.path.length) this.faceToward(this.path[Math.min(this.pathIndex, this.path.length - 1)]);
  }

  // --- Engagement movement ---
  /** Side-steps across the line to the player, flipping direction every 0.8–1.6 s. */
  private strafe(dt: number): void {
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) this.pickStrafe();
    if (this.strafeDir !== 0) {
      const dx = this.strafeTarget.x - this.pos.x;
      const dz = this.strafeTarget.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.2) {
        const s = this.arch.strafeSpeed;
        this.vel.x = (dx / d) * s;
        this.vel.z = (dz / d) * s;
        return;
      }
      this.strafeTimer = Math.min(this.strafeTimer, 0.15); // arrived: brief plant, then flip
    }
    this.vel.x = 0;
    this.vel.z = 0;
  }

  /** Chooses a navmesh-valid side-step target (no walking off docks or into walls). */
  private pickStrafe(): void {
    const tx = this.lastKnown.x - this.pos.x;
    const tz = this.lastKnown.z - this.pos.z;
    const l = Math.hypot(tx, tz) || 1;
    const px = -tz / l;
    const pz = tx / l;
    const dur = STRAFE_MIN + Math.random() * (STRAFE_MAX - STRAFE_MIN);
    const dist = this.arch.strafeSpeed * dur;
    let sign = this.strafeDir === 0 ? (Math.random() < 0.5 ? -1 : 1) : -this.strafeDir;
    const feetY = this.pos.y - CAPSULE_HALF_HEIGHT;
    for (let attempt = 0; attempt < 2; attempt++, sign = -sign) {
      this._wp.set(this.pos.x + px * sign * dist, feetY, this.pos.z + pz * sign * dist);
      if (
        this.deps.nav.closestPointInto(this._wp, this._snap) &&
        Math.hypot(this._snap.x - this._wp.x, this._snap.z - this._wp.z) < 0.35 &&
        Math.abs(this._snap.y - feetY) < 0.35
      ) {
        this.strafeTarget.set(this._snap.x, this.pos.y, this._snap.z);
        this.strafeDir = sign;
        this.strafeTimer = dur;
        return;
      }
    }
    this.strafeDir = 0;
    this.strafeTimer = 0.4;
  }

  private advanceTo(target: THREE.Vector3): void {
    if (this.repathTimer <= 0) {
      this.setPath(target);
      this.repathTimer = 0.5;
    }
    this.steerAlongPath(this.arch.engageSpeed);
  }

  private setPath(target: THREE.Vector3): void {
    if (this.deps.nav.findPath(this.pos, target, this.path)) {
      this.pathIndex = 0;
      // Skip the first waypoint if we're basically on it.
      if (this.path.length && this.pos.distanceTo(this.path[0]) < 0.4) this.pathIndex = 1;
    } else {
      this.path.length = 0;
      this.pathIndex = 0;
    }
  }

  private steerAlongPath(speed: number): void {
    if (this.pathIndex >= this.path.length) {
      this.vel.x = 0;
      this.vel.z = 0;
      return;
    }
    this._wp.copy(this.path[this.pathIndex]);
    const dx = this._wp.x - this.pos.x;
    const dz = this._wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) {
      this.pathIndex += 1;
      return;
    }
    this.vel.x = (dx / d) * speed;
    this.vel.z = (dz / d) * speed;
    this.yaw = Math.atan2(-this.vel.x, -this.vel.z);
  }

  private faceToward(target: THREE.Vector3): void {
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    if (dx * dx + dz * dz > 1e-4) this.yaw = Math.atan2(-dx, -dz);
  }

  private applyMovement(dt: number): void {
    this.vel.y -= GRAVITY * dt;
    this._move.x = this.vel.x * dt;
    this._move.y = this.vel.y * dt;
    this._move.z = this.vel.z * dt;
    this.controller.computeColliderMovement(this.collider, this._move);
    const c = this.controller.computedMovement();
    this.pos.x += c.x;
    this.pos.y += c.y;
    this.pos.z += c.z;
    if (this.controller.computedGrounded() && this.vel.y < 0) this.vel.y = 0;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  /** Fires one round (aimed, or a suppressive near miss). Returns true if fired from off-screen. */
  private shoot(aimed: boolean): boolean {
    this._eye.copy(this.pos);
    this._eye.y += EYE_Y - 0.05;
    this.deps.player.eye(this._pEye);
    this._aim.copy(this._pEye);
    const dist = this._eye.distanceTo(this._pEye);

    // Accuracy ramp on fresh acquisition + penalty when shooting from outside the player's view.
    let mul = 1 + (RAMP_MUL - 1) * Math.max(0, 1 - this.losTime / RAMP_T);
    let offscreen = false;
    const view = this.deps.player.viewDir;
    if (view) {
      view(this._fwd);
      this._toPlayer.subVectors(this._eye, this._pEye).normalize(); // player → enemy
      offscreen = this._fwd.dot(this._toPlayer) < OFFSCREEN_COS;
      if (offscreen) mul *= OFFSCREEN_MUL;
    }
    const spread = this.arch.spread * dist * mul; // grows with range → fairer at distance
    this._aim.x += (Math.random() - 0.5) * spread;
    this._aim.y += (Math.random() - 0.5) * spread;
    this._aim.z += (Math.random() - 0.5) * spread;
    if (!aimed) {
      // Sideways (across the line of fire) and slightly high: audible, visible, harmless.
      this._toPlayer.subVectors(this._pEye, this._eye);
      const l = Math.hypot(this._toPlayer.x, this._toPlayer.z) || 1;
      const side = (Math.random() < 0.5 ? -1 : 1) * (SUPPRESS_OFFSET + Math.random() * 0.8);
      this._aim.x += (-this._toPlayer.z / l) * side;
      this._aim.z += (this._toPlayer.x / l) * side;
      this._aim.y += Math.random() * 0.5;
    }
    this._toPlayer.subVectors(this._aim, this._eye).normalize();

    const hit = this.deps.world.castRay(this.ray, this.arch.fireRange, true, undefined, undefined, this.collider);
    if (hit) {
      this._end.copy(this._eye).addScaledVector(this._toPlayer, hit.timeOfImpact);
      if (hit.collider.handle === this.deps.player.colliderHandle) {
        this.deps.player.applyDamage(this.arch.damage, this.pos);
      }
    } else {
      this._end.copy(this._eye).addScaledVector(this._toPlayer, this.arch.fireRange);
    }
    // A tracer that ends at — or flies past — the camera becomes a giant glowing spike across
    // the view: stop it NEAR_MISS short of its closest approach to the eye (damage unaffected).
    const len = this._eye.distanceTo(this._end);
    const tc = this._aim.subVectors(this._pEye, this._eye).dot(this._toPlayer); // closest approach
    const tq = Math.min(tc, len);
    const missSq = this._aim.addScaledVector(this._toPlayer, -tq).lengthSq(); // eye ↔ ray point
    if (tc > 0 && missSq < NEAR_MISS * NEAR_MISS) {
      this._end.copy(this._eye).addScaledVector(this._toPlayer, Math.max(0.3, tq - NEAR_MISS));
    }

    this.character.muzzleAnchor.getWorldPosition(this._muzzle);
    this.deps.tracers.spawn(this._muzzle, this._end);
    this.deps.sfx.gunshot(this._muzzle);
    this.muzzleFlash.fire(0.05);
    this.deps.fx.muzzleSmoke(this._muzzle, this._toPlayer);
    return offscreen;
  }

  /** Per-frame visual update (interpolated). Corpses persist until `dispose()`. */
  render(alpha: number, dt: number): void {
    this.character.play(this.animState);
    this.character.aim(this.state === 'engage' || this.state === 'alert', this.aimPitch);
    this.character.update(dt);

    this.group.position.set(
      this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha,
      this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha,
      this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha,
    );
    this.group.rotation.set(0, this.yaw, 0); // death is handled by the Death animation
  }

  /** Remove from scene + physics. Called on level reset / restart. */
  dispose(): void {
    this.deps.scene.remove(this.group);
    // Character + muzzle-flash geometry/materials are shared across enemies; the soldier only
    // releases its per-instance resources.
    this.character.dispose();
    this.dropToken();
    this.removePhysics();
  }

  /** QA/utility: current world position (capsule centre). */
  position(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos);
  }
}
