/**
 * First-person viewmodel: detailed carbine + gloved hands/sleeves, posed procedurally.
 *
 * Hierarchy (camera child):
 *   root            hip ↔ ADS pose, idle breathing sway, fire kick + roll, reload tilt,
 *                   wall pull-back
 *     rifle         createRifle('viewmodel'); muzzle anchor + separately-animated magazine
 *     right arm     static on the pistol grip
 *     left glove    pivots at the wrist; leaves the handguard to strip/seat the magazine
 *     left sleeve   follows the wrist, re-aimed at an elbow that trails the hand
 *
 * Reload beats are authored in seconds (tactical 1.7 s / empty 2.2 s): reach, unseat, pull,
 * swap, insert, palm slap, then (empty only) a thumb on the bolt catch with the bolt jolt.
 * The magazine never drops more than ~0.12 m, so the hand stays in frame.
 *
 * `update` is allocation-free (scratch vectors/quaternions only).
 */
import * as THREE from 'three/webgpu';
import { createRifle, RIFLE_POINTS } from './rifle';
import { createArm, handRotation, wristFor, type HandSpec } from './hands';

/**
 * Eye → optic centre at full ADS (m): the rear-aperture window fills ~30% of screen height at
 * the ~46° ADS field of view, and the rear ring stays well beyond the 0.05 m near plane.
 */
const EYE_RELIEF = 0.104;

const smooth = (t: number, a: number, b: number): number => {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
/** Up-then-down pulse: rises over [a, b], falls over [b, c]. */
const pulse = (t: number, a: number, b: number, c: number): number => smooth(t, a, b) - smooth(t, b, c);

// --- Hand specs (rifle space) ---------------------------------------------------------------

const GRIP_ANGLE = (22 * Math.PI) / 180;
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Right hand: power grip on the pistol grip, index finger on the trigger, thumb over the top. */
const RIGHT_HAND: HandSpec = {
  mirror: false,
  gripPoint: v(0, -0.033 - 0.03 * Math.cos(GRIP_ANGLE), 0.046 + 0.03 * Math.sin(GRIP_ANGLE)),
  across: v(0, -Math.cos(GRIP_ANGLE), Math.sin(GRIP_ANGLE)),
  dorsal: v(0.98, 0, 0.2),
  grip: { y: 0.068, z: -0.031, radius: 0.017 },
  fingers: { 0: { flex: [0.35, 1.05, 0.6], spread: 0.12 } },
  thumb: { dir: v(-0.8, 0.12, -0.58), curl: v(0.3, -0.4, -0.85), flex: [0.5, 0.4] },
  forearm: v(0.42, -0.5, 0.76),
};

/** Left hand: palm under the handguard, fingers wrapping up the far side, thumb along the near side. */
const LEFT_HAND: HandSpec = {
  mirror: true,
  gripPoint: v(0, -0.003, -0.29),
  across: v(0, 0, -1),
  dorsal: v(-0.6, -0.8, 0),
  grip: { y: 0.062, z: -0.04, radius: 0.024 },
  thumb: { dir: v(0.35, 0.12, -0.93), curl: v(0.9, 0.2, 0), flex: [0.12, 0.15] },
  forearm: v(-0.55, -0.55, 0.62),
};

const ELBOW_REACH = 0.3;
/** How much the (virtual) left elbow trails the wrist when the hand leaves the handguard. */
const ELBOW_FOLLOW = 0.6;
/** Left hand on the magazine: thumb up the mag spine, palm on its left flank (mag-local). */
const MAG_GRAB = { point: v(0, -0.085, -0.004), across: v(0, 1, 0), dorsal: v(-1, 0, 0.15) };
/** Wrist shift from the mag grip to the bolt catch (thumb on the paddle), rifle space. */
const BOLT_REACH = v(-0.006, 0.05, 0.028);

/** Reload beats (seconds). */
const BEAT = {
  tiltIn: [0, 0.25],
  reach: [0.12, 0.36],
  unseat: [0.36, 0.44],
  pull: [0.44, 0.6],
  swapIn: [0.56, 0.74],
  swapOut: [0.76, 0.94],
  lift: [0.84, 1.0],
  insert: [1.0, 1.1],
  slap: [1.1, 1.16, 1.21],
  slapJolt: [1.19, 1.22, 1.34],
} as const;
const TAC_BEAT = { release: [1.26, 1.52], tiltOut: [1.38, 1.7] } as const;
const EMPTY_BEAT = {
  boltReach: [1.28, 1.46],
  boltJolt: [1.5, 1.53, 1.66],
  release: [1.62, 1.92],
  tiltOut: [1.86, 2.2],
} as const;

export class Viewmodel {
  readonly root = new THREE.Group();
  /** Muzzle tip anchor (child of the rifle) — flash / tracer origin. */
  readonly muzzle = new THREE.Object3D();

  readonly hipPos = new THREE.Vector3(0.13, -0.15, -0.32);
  readonly hipRot = new THREE.Euler(0.025, 0.1, 0.05);
  readonly adsPos: THREE.Vector3;

  private readonly rifle: THREE.Group;
  private readonly mag: THREE.Object3D;
  private readonly leftGlove: THREE.Group;
  private readonly leftSleeve: THREE.Group;
  private readonly leftWrist: THREE.Vector3;
  private readonly leftElbow: THREE.Vector3;
  private readonly leftRestDir: THREE.Vector3;
  /** Rest → mag-grab rotation of the left hand, and its wrist in magazine space. */
  private readonly grabRot: THREE.Quaternion;
  private readonly grabWrist: THREE.Vector3;

  private time = 0;
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _id = new THREE.Quaternion();

  constructor() {
    const rifle = createRifle('viewmodel');
    this.rifle = rifle.group;
    if (!rifle.magazine) throw new Error('viewmodel rifle must expose its magazine');
    this.mag = rifle.magazine;
    this.muzzle.position.copy(rifle.muzzle);
    this.rifle.add(this.muzzle);
    this.root.add(this.rifle);

    const right = createArm(RIGHT_HAND);
    this.rifle.add(right.glove, right.sleeve);

    const left = createArm(LEFT_HAND);
    this.leftGlove = left.glove;
    this.leftSleeve = left.sleeve;
    this.leftWrist = left.wrist;
    this.rifle.add(this.leftGlove, this.leftSleeve);
    this.leftRestDir = LEFT_HAND.forearm.clone().normalize();
    this.leftElbow = left.wrist.clone().addScaledVector(this.leftRestDir, ELBOW_REACH);
    const restRot = handRotation(LEFT_HAND.across, LEFT_HAND.dorsal);
    const magRot = handRotation(MAG_GRAB.across, MAG_GRAB.dorsal);
    this.grabRot = magRot.clone().multiply(restRot.invert());
    this.grabWrist = wristFor(LEFT_HAND, magRot, MAG_GRAB.point);

    const o = RIFLE_POINTS.opticCenter;
    this.adsPos = new THREE.Vector3(-o.x, -o.y, -EYE_RELIEF - o.z);

    this.root.position.copy(this.hipPos);
    this.root.traverse((obj) => {
      obj.renderOrder = 5;
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = false;
    });
  }

  /**
   * @param ads      0 hip … 1 aimed
   * @param kick     0 … 1 recoil impulse (decays in the weapon)
   * @param roll     camera recoil roll (rad) — the gun rolls with it, a little more
   * @param reload   seconds into the current reload, or < 0 when not reloading
   * @param empty    the current reload is from empty (adds the bolt-release beat)
   * @param obstruct 0 clear … 1 muzzle against a wall (pull back + lower)
   */
  update(dt: number, ads: number, kick: number, roll: number, reload: number, empty: boolean, obstruct: number): void {
    this.time += dt;
    const t = this.time;
    const aim = ads * (1 - obstruct);
    const hip = 1 - aim;

    // Idle breathing: slow figure-eight, mostly suppressed when aimed (held breath).
    const sway = 0.25 + 0.75 * hip;
    const bx = Math.sin(t * 0.9) * 0.0011 * sway;
    const by = Math.sin(t * 1.8) * 0.0009 * sway;
    const br = Math.sin(t * 0.9 + 0.7) * 0.004 * sway;

    // --- Reload choreography (r = seconds into the reload) -----------------------------------
    const on = reload >= 0 ? 1 : 0;
    const r = reload >= 0 ? reload : -1;
    const e = empty ? 1 : 0;
    const out = empty ? EMPTY_BEAT.tiltOut : TAC_BEAT.tiltOut;
    const rel = empty ? EMPTY_BEAT.release : TAC_BEAT.release;
    const tilt = on * (smooth(r, BEAT.tiltIn[0], BEAT.tiltIn[1]) - smooth(r, out[0], out[1]));
    const jolt =
      on *
      (pulse(r, BEAT.slapJolt[0], BEAT.slapJolt[1], BEAT.slapJolt[2]) +
        e * pulse(r, EMPTY_BEAT.boltJolt[0], EMPTY_BEAT.boltJolt[1], EMPTY_BEAT.boltJolt[2]) * 1.4);

    const pos = this.root.position;
    pos.lerpVectors(this.hipPos, this.adsPos, aim);
    // Wall: pull back and dip the muzzle (dip leads the pull-back) so the part of the gun that
    // would meet the wall drops out of frame while the receiver and hands stay in view.
    const dip = Math.min(1, obstruct * 1.6);
    pos.x += bx - 0.045 * tilt - 0.01 * obstruct;
    pos.y += by + 0.08 * tilt + 0.006 * jolt + 0.01 * obstruct;
    pos.z += kick * 0.045 * (1 - 0.55 * aim) + 0.06 * tilt + 0.13 * obstruct;

    this.root.rotation.set(
      this.hipRot.x * hip + kick * 0.16 * (1 - 0.6 * aim) + br * 0.5 + 0.16 * tilt + 0.05 * jolt - 0.55 * dip,
      this.hipRot.y * hip + bx * 0.6 - 0.1 * tilt + 0.15 * dip,
      this.hipRot.z * hip + br - 0.42 * tilt + roll * 1.6 + 0.22 * dip,
    );

    // Magazine: unseat, pull ~0.12 m, twist for the swap, lift, insert.
    const drop =
      on *
      (0.03 * smooth(r, BEAT.unseat[0], BEAT.unseat[1]) +
        0.09 * smooth(r, BEAT.pull[0], BEAT.pull[1]) -
        0.09 * smooth(r, BEAT.lift[0], BEAT.lift[1]) -
        0.03 * smooth(r, BEAT.insert[0], BEAT.insert[1]));
    const swap = on * (smooth(r, BEAT.swapIn[0], BEAT.swapIn[1]) - smooth(r, BEAT.swapOut[0], BEAT.swapOut[1]));
    const mp = RIFLE_POINTS.magPivot;
    this.mag.position.set(mp.x - 0.022 * swap, mp.y - drop - 0.012 * swap, mp.z + 0.02 * swap);
    this.mag.rotation.set(0.3 * swap + 0.6 * drop, 0, -0.22 * swap);

    // Left hand: handguard → mag (rides it) → palm slap → [bolt catch] → handguard.
    const grab = on * (smooth(r, BEAT.reach[0], BEAT.reach[1]) - smooth(r, rel[0], rel[1]));
    const slap = pulse(r, BEAT.slap[0], BEAT.slap[1], BEAT.slap[2]);
    const bolt = e * smooth(r, EMPTY_BEAT.boltReach[0], EMPTY_BEAT.boltReach[1]);
    this._v.copy(this.grabWrist).applyQuaternion(this.mag.quaternion).add(this.mag.position);
    this._v.y -= 0.035 * slap;
    this._v.addScaledVector(BOLT_REACH, bolt);
    this.leftGlove.position.lerpVectors(this.leftWrist, this._v, grab);
    this._q.slerpQuaternions(this._id, this.grabRot, grab);
    this._q2.slerpQuaternions(this._id, this.mag.quaternion, grab);
    this.leftGlove.quaternion.multiplyQuaternions(this._q2, this._q);

    // Sleeve rides the wrist, aimed at an elbow that trails the hand.
    const wrist = this.leftGlove.position;
    this.leftSleeve.position.copy(wrist);
    this._w.subVectors(wrist, this.leftWrist).multiplyScalar(ELBOW_FOLLOW).add(this.leftElbow).sub(wrist).normalize();
    this.leftSleeve.quaternion.setFromUnitVectors(this.leftRestDir, this._w);
  }
}
