/**
 * Enemy bot (M2 combat core). Rapier kinematic capsule moved along a recast navmesh path, a
 * perception model (view cone + LOS raycast + hearing), and a combat FSM
 * (patrol → alert → engage → search → dead). Fair aim: reaction delay before the first shot,
 * a slower cadence than the player, and spread so it misses — not a hitscan aimbot.
 *
 * Registers its collider in the HitRegistry so the player's weapon damages it; headshots use a
 * height threshold. Death is a simple topple + sink (ragdoll is an M3 polish item).
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Navigation } from './navmesh';
import type { HitRegistry, Hittable } from '../combat/hittable';
import type { Tracers } from '../vfx/tracers';

export interface PlayerTarget {
  eye(out: THREE.Vector3): THREE.Vector3;
  isAlive(): boolean;
  applyDamage(amount: number, fromPos: THREE.Vector3): void;
  readonly colliderHandle: number;
}

export interface EnemyDeps {
  scene: THREE.Scene;
  world: RAPIER_NS.World;
  nav: Navigation;
  registry: HitRegistry;
  tracers: Tracers; // reddish enemy tracers
  player: PlayerTarget;
}

const RADIUS = 0.35;
const CYL_HALF = 0.55; // total capsule ≈ 1.8 m
const MAX_HP = 100;

const VIEW_DIST = 40;
const FOV_COS = Math.cos((100 * Math.PI) / 180 / 2); // 100° cone
const HEAR_DIST = 24;
const FIRE_RANGE = 34;
const REACTION = 0.34; // s before first shot
const FIRE_INTERVAL = 0.5;
const ENEMY_DAMAGE = 9;
const PATROL_SPEED = 2.2;
const ENGAGE_SPEED = 4.6;
const GRAVITY = 24;

type State = 'patrol' | 'alert' | 'engage' | 'search' | 'dead';

export class Enemy implements Hittable {
  private readonly group = new THREE.Group();
  private readonly body: RAPIER_NS.RigidBody;
  private readonly collider: RAPIER_NS.Collider;
  private readonly controller: RAPIER_NS.KinematicCharacterController;

  private readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private hp = MAX_HP;
  private state: State = 'patrol';

  private readonly path: THREE.Vector3[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private waitTimer = 0;
  private reactionTimer = 0;
  private fireTimer = 0;
  private searchTimer = 0;
  private deathTimer = 0;
  private readonly lastKnown = new THREE.Vector3();

  private readonly muzzleFlash: THREE.Mesh;
  private flashTimer = 0;

  // scratch
  private readonly _eye = new THREE.Vector3();
  private readonly _pEye = new THREE.Vector3();
  private readonly _toPlayer = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _wp = new THREE.Vector3();
  private readonly _muzzle = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _end = new THREE.Vector3();

  constructor(
    private readonly deps: EnemyDeps,
    spawn: THREE.Vector3,
  ) {
    this.pos.copy(spawn);
    this.prevPos.copy(spawn);

    this.buildMesh();
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

    this.controller = deps.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.4, 0.2, true);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.muzzleFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.25), flashMat);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.position.set(0.18, 0.15, -0.5);
    this.group.add(this.muzzleFlash);
  }

  get alive(): boolean {
    return this.state !== 'dead' || this.deathTimer > 0;
  }
  get isDead(): boolean {
    return this.state === 'dead';
  }

  private buildMesh(): void {
    const uniform = new THREE.MeshStandardMaterial({ color: 0x873f3a, roughness: 0.8, metalness: 0.05 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xb08a6a, roughness: 0.7 });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.72, 6, 12), uniform);
    torso.position.y = -0.06;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skin);
    head.position.y = 0.62;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.5), gunMat);
    gun.position.set(0.16, 0.12, -0.28);

    for (const m of [torso, head, gun]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
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
    // Getting shot alerts + reveals the player instantly.
    if (this.state === 'patrol') this.toAlert();
    this.deps.player.eye(this.lastKnown);
    return false;
  }

  private die(): void {
    this.state = 'dead';
    this.deathTimer = 1.8;
    this.vel.set(0, 0, 0);
    this.deps.registry.unregister(this.collider.handle);
    this.collider.setSensor(true); // no longer blocks shots/movement
    this.muzzleFlash.visible = false;
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
    this.reactionTimer = REACTION;
    this.path.length = 0;
  }

  // --- Perception ---
  private canSeePlayer(): boolean {
    if (!this.deps.player.isAlive()) return false;
    this.deps.player.eye(this._pEye);
    this._eye.copy(this.pos);
    this._eye.y += 0.55;
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
    const ray = new RAPIER.Ray(this._eye, this._toPlayer);
    const hit = this.deps.world.castRay(ray, dist + 0.5, true, undefined, undefined, this.collider);
    return hit !== null && hit.collider.handle === this.deps.player.colliderHandle;
  }

  // --- Fixed-step update ---
  integrate(dt: number): void {
    this.prevPos.copy(this.pos);

    if (this.state === 'dead') {
      this.deathTimer -= dt;
      return;
    }

    const seesPlayer = this.canSeePlayer();
    this.repathTimer -= dt;
    this.fireTimer -= dt;

    switch (this.state) {
      case 'patrol':
        this.tickPatrol(dt, seesPlayer);
        break;
      case 'alert':
        this.tickAlert(dt, seesPlayer);
        break;
      case 'engage':
        this.tickEngage(seesPlayer);
        break;
      case 'search':
        this.tickSearch(dt, seesPlayer);
        break;
    }

    this.applyMovement(dt);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleFlash.visible = false;
    }
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
    this.steerAlongPath(PATROL_SPEED);
  }

  private tickAlert(dt: number, sees: boolean): void {
    this.vel.x = 0;
    this.vel.z = 0;
    if (sees) this.deps.player.eye(this.lastKnown);
    this.faceToward(this.lastKnown);
    this.reactionTimer -= dt;
    if (this.reactionTimer <= 0) this.state = 'engage';
  }

  private tickEngage(sees: boolean): void {
    if (sees) {
      this.deps.player.eye(this.lastKnown);
      this.faceToward(this.lastKnown);
      const dist = this.pos.distanceTo(this.lastKnown);
      if (dist <= FIRE_RANGE) {
        // Hold position and fire.
        this.vel.x = 0;
        this.vel.z = 0;
        if (this.fireTimer <= 0) {
          this.shoot();
          this.fireTimer = FIRE_INTERVAL * (0.8 + Math.random() * 0.4);
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
      this.toEngage();
      return;
    }
    this.searchTimer -= dt;
    if (this.searchTimer <= 0 || this.pathIndex >= this.path.length) {
      this.state = 'patrol';
      this.path.length = 0;
      this.pathIndex = 0;
      return;
    }
    this.steerAlongPath(ENGAGE_SPEED);
    if (this.path.length) this.faceToward(this.path[Math.min(this.pathIndex, this.path.length - 1)]);
  }

  private toEngage(): void {
    this.state = 'engage';
  }

  private advanceTo(target: THREE.Vector3): void {
    if (this.repathTimer <= 0) {
      this.setPath(target);
      this.repathTimer = 0.5;
    }
    this.steerAlongPath(ENGAGE_SPEED);
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
    const move = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.controller.computeColliderMovement(this.collider, move);
    const c = this.controller.computedMovement();
    this.pos.x += c.x;
    this.pos.y += c.y;
    this.pos.z += c.z;
    if (this.controller.computedGrounded() && this.vel.y < 0) this.vel.y = 0;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  private shoot(): void {
    this._eye.copy(this.pos);
    this._eye.y += 0.5;
    this.deps.player.eye(this._pEye);
    this._aim.copy(this._pEye);
    const dist = this._eye.distanceTo(this._pEye);
    const spread = 0.03 * dist; // grows with range → fairer at distance
    this._aim.x += (Math.random() - 0.5) * spread;
    this._aim.y += (Math.random() - 0.5) * spread;
    this._aim.z += (Math.random() - 0.5) * spread;
    this._toPlayer.subVectors(this._aim, this._eye).normalize();

    const ray = new RAPIER.Ray(this._eye, this._toPlayer);
    const hit = this.deps.world.castRay(ray, FIRE_RANGE, true, undefined, undefined, this.collider);
    if (hit) {
      this._end.copy(this._eye).addScaledVector(this._toPlayer, hit.timeOfImpact);
      if (hit.collider.handle === this.deps.player.colliderHandle) {
        this.deps.player.applyDamage(ENEMY_DAMAGE, this.pos);
      }
    } else {
      this._end.copy(this._eye).addScaledVector(this._toPlayer, FIRE_RANGE);
    }

    this.group.localToWorld(this._muzzle.copy(this.muzzleFlash.position));
    this.deps.tracers.spawn(this._muzzle, this._end);
    this.muzzleFlash.visible = true;
    this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flashTimer = 0.05;
  }

  /** Per-frame visual update (interpolated). Returns false when fully cleaned up. */
  render(alpha: number): boolean {
    if (this.state === 'dead' && this.deathTimer <= 0) {
      this.cleanup();
      return false;
    }
    this.group.position.set(
      this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha,
      this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha,
      this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha,
    );
    if (this.state === 'dead') {
      // Topple forward and sink.
      const t = 1 - this.deathTimer / 1.8;
      this.group.rotation.x = Math.min(t * 2.2, Math.PI / 2);
      this.group.position.y -= t * 0.5;
    } else {
      this.group.rotation.set(0, this.yaw, 0);
    }
    // Keep the muzzle flash facing roughly the player for readability.
    this.muzzleFlash.quaternion.identity();
    return true;
  }

  private cleanup(): void {
    this.deps.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat.dispose();
      }
    });
    this.deps.world.removeCollider(this.collider, false);
    this.deps.world.removeRigidBody(this.body);
    this.deps.world.removeCharacterController(this.controller);
  }

  /** QA/utility: current world position (capsule centre). */
  position(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos);
  }
}
