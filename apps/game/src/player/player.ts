/**
 * First-person player: Rapier kinematic capsule + character controller for collision, with a
 * momentum-based movement model (acceleration/decel via exponential damping), sprint, crouch
 * (real capsule resize, feet stay planted), and a jump with arcade-military gravity.
 *
 * Split by rate (CLAUDE.md rule 5): `integrate()` runs at the fixed sim step; look and camera
 * placement run per render frame for sub-frame responsiveness, interpolating the capsule
 * position between the last two sim steps so movement is smooth on any refresh rate.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Input } from '../input/input';

const RADIUS = 0.35;
const STAND_HALF = 0.55; // capsule cylinder half-height standing (total ≈ 1.8 m)
const CROUCH_HALF = 0.22; // crouched (total ≈ 1.14 m)
const EYE_STAND = 1.62;
const EYE_CROUCH = 0.95;

const WALK = 5.2;
const SPRINT = 8.6;
const CROUCH_SPEED = 2.6;
const GRAVITY = 24;
const JUMP_SPEED = 7.2;
const SENS = 0.0022; // radians per mouse pixel

const MAX_HP = 100;
const REGEN_DELAY = 4; // s without damage before health starts coming back
const REGEN_RATE = 30; // HP/s

export class Player {
  readonly collider: RAPIER_NS.Collider;

  /** Called when the player takes damage, with the source direction relative to facing. */
  onDamaged?: (relAngle: number) => void;
  /** Called once when health reaches zero. */
  onDied?: () => void;
  /** Called each footstep while grounded and moving. */
  onFootstep?: () => void;

  private stepAccum = 0;

  /** Look-sensitivity multiplier (settings). */
  sensitivity = 1;
  /** Move-speed multiplier set each frame by the weapon (e.g. slower while aiming). */
  speedScale = 1;
  /** Whether sprint is allowed right now (no sprinting while aiming down sights). */
  sprintAllowed = true;
  private isSprinting = false;

  private hp = MAX_HP;
  private dead = false;

  private readonly body: RAPIER_NS.RigidBody;
  private readonly controller: RAPIER_NS.KinematicCharacterController;

  private readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3(); // world-space, y = vertical
  private yaw = 0; // yaw 0 looks down -Z (north, into the yard)
  private pitch = 0;
  private grounded = false;
  private crouchT = 0; // 0 stand → 1 crouch
  private curCyl = STAND_HALF;
  private jumpLatch = false;
  private bobPhase = 0;
  private bobAmt = 0;
  private sinceHit = REGEN_DELAY;
  // Camera punch when hit (radians), decayed in the fixed step.
  private punchPitch = 0;
  private punchRoll = 0;

  // scratch (no per-frame allocation)
  private readonly wish = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly eyeScratch = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    world: RAPIER_NS.World,
    private readonly input: Input,
    private readonly camera: THREE.PerspectiveCamera,
    spawn: THREE.Vector3,
  ) {
    this.pos.copy(spawn);
    this.prevPos.copy(spawn);

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      spawn.x,
      spawn.y,
      spawn.z,
    );
    this.body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.capsule(STAND_HALF, RADIUS);
    this.collider = world.createCollider(colDesc, this.body);

    this.controller = world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.4, 0.2, true);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((40 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setSlideEnabled(true);
  }

  /** Fixed-step simulation: movement, collision, gravity, crouch. */
  integrate(dt: number): void {
    this.prevPos.copy(this.pos);

    // --- Crouch: lerp capsule size, shift centre so the feet stay planted ---
    const wantCrouch = this.input.isDown('ControlLeft') || this.input.isDown('KeyC');
    this.crouchT = damp01(this.crouchT, wantCrouch ? 1 : 0, 12, dt);
    const targetCyl = STAND_HALF + (CROUCH_HALF - STAND_HALF) * this.crouchT;
    const deltaCyl = targetCyl - this.curCyl;
    if (Math.abs(deltaCyl) > 1e-6) {
      this.pos.y += deltaCyl; // keep capsule bottom fixed
      this.curCyl = targetCyl;
      this.collider.setHalfHeight(targetCyl);
    }

    // --- Wish direction from keys, relative to yaw ---
    let fwd = 0;
    let strafe = 0;
    if (this.input.isDown('KeyW')) fwd += 1;
    if (this.input.isDown('KeyS')) fwd -= 1;
    if (this.input.isDown('KeyD')) strafe += 1;
    if (this.input.isDown('KeyA')) strafe -= 1;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Forward is -Z rotated by yaw; right is +X rotated by yaw.
    this.wish.set(strafe * cos - fwd * sin, 0, -strafe * sin - fwd * cos);
    const hasInput = this.wish.lengthSq() > 1e-4;
    if (hasInput) this.wish.normalize();

    const sprinting = this.sprintAllowed && this.input.isDown('ShiftLeft') && fwd > 0 && this.crouchT < 0.3;
    this.isSprinting = sprinting && this.grounded;
    const speed = (this.crouchT > 0.3 ? CROUCH_SPEED : sprinting ? SPRINT : WALK) * this.speedScale;

    // Horizontal velocity damps toward desired — momentum in, momentum out.
    this.desired.set(this.wish.x * speed, 0, this.wish.z * speed);
    const k = this.grounded ? 14 : 2.5; // snappy on ground, floaty in air
    this.vel.x = damp(this.vel.x, this.desired.x, k, dt);
    this.vel.z = damp(this.vel.z, this.desired.z, k, dt);

    // --- Vertical: gravity + jump ---
    const jumpDown = this.input.isDown('Space');
    if (this.grounded && jumpDown && !this.jumpLatch && this.crouchT < 0.5) {
      this.vel.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpLatch = jumpDown;
    this.vel.y -= GRAVITY * dt;

    // --- Resolve movement against the world ---
    this.move.set(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt);
    this.controller.computeColliderMovement(this.collider, this.move);
    const corrected = this.controller.computedMovement();
    this.pos.x += corrected.x;
    this.pos.y += corrected.y;
    this.pos.z += corrected.z;

    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vel.y < 0) this.vel.y = 0;
    // If vertical motion was blocked from below (head bonk), kill upward velocity.
    if (this.vel.y > 0 && corrected.y < this.vel.y * dt * 0.5) this.vel.y = 0;

    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });

    // Health regen after a quiet spell; hit punch settles.
    this.sinceHit += dt;
    if (!this.dead && this.sinceHit > REGEN_DELAY && this.hp < MAX_HP) {
      this.hp = Math.min(MAX_HP, this.hp + REGEN_RATE * dt);
    }
    this.punchPitch = damp(this.punchPitch, 0, 10, dt);
    this.punchRoll = damp(this.punchRoll, 0, 10, dt);

    // Head-bob amount tracks grounded horizontal speed.
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded) this.bobPhase += hSpeed * dt * 1.1;
    this.bobAmt = damp(this.bobAmt, this.grounded ? Math.min(hSpeed / SPRINT, 1) : 0, 8, dt);

    // Footsteps: emit every stride's worth of grounded distance.
    if (this.grounded && hSpeed > 0.4) {
      this.stepAccum += hSpeed * dt;
      const stride = this.input.isDown('ShiftLeft') ? 2.5 : 1.9;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this.onFootstep?.();
      }
    } else {
      this.stepAccum = 0;
    }
  }

  /** Hard-place the player + aim (QA harness only). */
  setPose(x: number, y: number, z: number, yaw: number, pitch: number, crouchT = 0): void {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = pitch;
    this.crouchT = crouchT;
    this.curCyl = STAND_HALF + (CROUCH_HALF - STAND_HALF) * crouchT;
    this.collider.setHalfHeight(this.curCyl);
    this.body.setTranslation({ x, y, z }, true);
  }

  /** Read the authoritative capsule position back after world.step(). */
  sync(): void {
    const t = this.body.translation();
    this.pos.set(t.x, t.y, t.z);
  }

  // --- Combat / PlayerTarget ---
  get colliderHandle(): number {
    return this.collider.handle;
  }
  get health(): number {
    return this.hp;
  }
  /** Camera forward (bound, so AI can call it detached): bots outside it shoot worse. */
  readonly viewDir = (out: THREE.Vector3): THREE.Vector3 => this.camera.getWorldDirection(out);

  /** World height of the soles (brass bounces, ground effects). */
  get feetY(): number {
    return this.pos.y - (this.curCyl + RADIUS);
  }

  /** True while actually sprinting (weapon lowers, can't fire until it comes back up). */
  get sprinting(): boolean {
    return this.isSprinting;
  }

  /** Grounded horizontal speed, m/s (weapon move-inaccuracy, HUD). */
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }
  isAlive(): boolean {
    return !this.dead;
  }

  /** Physics-authoritative eye position (no head-bob) for AI perception + aim. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    const feetY = this.pos.y - (this.curCyl + RADIUS);
    const eyeHeight = EYE_STAND + (EYE_CROUCH - EYE_STAND) * this.crouchT;
    return out.set(this.pos.x, feetY + eyeHeight, this.pos.z);
  }

  applyDamage(amount: number, fromPos: THREE.Vector3): void {
    if (this.dead) return;
    this.hp -= amount;
    this.sinceHit = 0;
    // Camera punch: a small upward jolt with a random roll (1.5–2.5°).
    this.punchPitch += 0.026 + Math.random() * 0.016;
    this.punchRoll += (Math.random() - 0.5) * 0.05;
    const dx = fromPos.x - this.pos.x;
    const dz = fromPos.z - this.pos.z;
    const srcAngle = Math.atan2(dx, dz);
    const fwdAngle = Math.atan2(-Math.sin(this.yaw), -Math.cos(this.yaw));
    let rel = srcAngle - fwdAngle;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this.onDamaged?.(rel);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.onDied?.();
    }
  }

  respawn(spawn: THREE.Vector3, yaw = 0): void {
    this.hp = MAX_HP;
    this.dead = false;
    this.sinceHit = REGEN_DELAY;
    this.punchPitch = this.punchRoll = 0;
    this.setPose(spawn.x, spawn.y, spawn.z, yaw, 0, 0);
  }

  /**
   * Per-frame mouse-look (responsive; not gated on the sim step).
   * @param scale extra multiplier, e.g. lower sensitivity while aiming down sights
   */
  applyLook(lookX: number, lookY: number, scale = 1): void {
    const s = SENS * this.sensitivity * scale;
    this.yaw -= lookX * s;
    this.pitch -= lookY * s;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  /** Permanently displace aim (recoil that doesn't recover): pitch + = up, yaw + = left. */
  addAim(pitch: number, yaw: number): void {
    this.yaw += yaw;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + pitch));
  }

  /** Per-frame camera placement, interpolating between sim steps and adding recoil + bob. */
  updateCamera(alpha: number, recoilPitch: number, recoilYaw: number, recoilRoll = 0): void {
    // Interpolated capsule centre → feet → eye.
    const cy = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha;
    const cx = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
    const cz = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha;
    const feetY = cy - (this.curCyl + RADIUS);
    const eyeHeight = EYE_STAND + (EYE_CROUCH - EYE_STAND) * this.crouchT;
    this.eyeScratch.set(cx, feetY + eyeHeight, cz);

    // Head-bob: vertical + lateral along the camera's right vector.
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmt;
    const bobX = Math.cos(this.bobPhase) * 0.03 * this.bobAmt;
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.eyeScratch.addScaledVector(this.right, bobX);
    this.eyeScratch.y += bobY;

    this.camera.position.copy(this.eyeScratch);
    this.euler.set(this.pitch + recoilPitch + this.punchPitch, this.yaw + recoilYaw, recoilRoll + this.punchRoll);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}

/** Frame-rate-independent exponential approach toward `target`. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}
function damp01(current: number, target: number, lambda: number, dt: number): number {
  return damp(current, target, lambda, dt);
}
