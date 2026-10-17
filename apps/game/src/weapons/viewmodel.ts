/**
 * First-person viewmodel: detailed carbine + gloved hands/sleeves, posed procedurally.
 *
 * Hierarchy (camera child):
 *   root            hip ↔ ADS pose, idle breathing sway, fire kick, reload tilt
 *     rifle         createRifle('viewmodel'); muzzle anchor + separately-animated magazine
 *     right arm     static on the pistol grip
 *     left glove    pivots at the wrist; leaves the handguard to strip/seat the magazine
 *     left sleeve   follows the wrist, re-aimed at an elbow that trails the hand
 *
 * `update` is allocation-free (scratch vectors/quaternions only).
 */
import * as THREE from 'three/webgpu';
import { createRifle, RIFLE_POINTS } from './rifle';
import { createArm, handRotation, wristFor, type HandSpec } from './hands';

/** Eye → optic centre distance at full ADS (m). */
const EYE_RELIEF = 0.15;

const smooth = (t: number, a: number, b: number): number => {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

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
  thumb: { dir: v(-0.8, 0.15, -0.58), curl: v(0.3, -0.35, -0.85), flex: [0.45, 0.35] },
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
const MAG_GRAB = { point: v(0, -0.1, -0.004), across: v(0, 1, 0), dorsal: v(-1, 0, 0.15) };

export class Viewmodel {
  readonly root = new THREE.Group();
  /** Muzzle tip anchor (child of the rifle) — flash / tracer origin. */
  readonly muzzle = new THREE.Object3D();

  readonly hipPos = new THREE.Vector3(0.15, -0.135, -0.27);
  readonly hipRot = new THREE.Euler(0.03, 0.12, 0.06);
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
   * @param ads    0 hip … 1 aimed
   * @param kick   0 … 1 recoil impulse (decays in the weapon)
   * @param reload reload progress 0 … 1, or < 0 when not reloading
   */
  update(dt: number, ads: number, kick: number, reload: number): void {
    this.time += dt;
    const t = this.time;
    const hip = 1 - ads;

    // Idle breathing: slow figure-eight, mostly suppressed when aimed (held breath).
    const sway = 0.25 + 0.75 * hip;
    const bx = Math.sin(t * 0.9) * 0.0011 * sway;
    const by = Math.sin(t * 1.8) * 0.0009 * sway;
    const br = Math.sin(t * 0.9 + 0.7) * 0.004 * sway;

    // Reload choreography (progress r): tilt in, strip mag, new mag up, seat, tilt out.
    const r = reload >= 0 ? reload : 0;
    const active = reload >= 0 ? 1 : 0;
    const tilt = active * (smooth(r, 0.0, 0.16) - smooth(r, 0.8, 1.0));
    const seatJolt = active * (smooth(r, 0.7, 0.74) - smooth(r, 0.74, 0.84));

    const pos = this.root.position;
    pos.lerpVectors(this.hipPos, this.adsPos, ads);
    pos.x += bx - 0.05 * tilt;
    pos.y += by + 0.035 * tilt + 0.006 * seatJolt;
    pos.z += kick * 0.045 * (1 - 0.55 * ads) + 0.03 * tilt;

    this.root.rotation.set(
      this.hipRot.x * hip + kick * 0.16 * (1 - 0.6 * ads) + br * 0.5 + 0.22 * tilt - 0.03 * seatJolt,
      this.hipRot.y * hip + bx * 0.6 - 0.12 * tilt,
      this.hipRot.z * hip + br - 0.55 * tilt,
    );

    // Magazine: unseat, drop out of frame, come back up, seat.
    const out = smooth(r, 0.24, 0.31);
    const away = smooth(r, 0.31, 0.44) - smooth(r, 0.52, 0.66);
    const seat = smooth(r, 0.66, 0.73);
    const drop = active * (0.03 * out + 0.25 * away - 0.03 * seat);
    this.mag.position.set(
      RIFLE_POINTS.magPivot.x - 0.03 * away * active,
      RIFLE_POINTS.magPivot.y - drop,
      RIFLE_POINTS.magPivot.z + 0.05 * away * active,
    );
    this.mag.rotation.set(0.45 * away * active, 0, -0.3 * away * active);

    // Left hand: handguard → mag (rides it down and back up) → handguard.
    const grab = active * (smooth(r, 0.1, 0.24) - smooth(r, 0.76, 0.92));
    this._v.copy(this.grabWrist).applyQuaternion(this.mag.quaternion).add(this.mag.position);
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
