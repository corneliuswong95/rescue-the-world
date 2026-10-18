/**
 * Enemy soldier: the skinned CC0 body + code-built kit (one skinned draw call, see
 * soldierAssets / soldierKit) driven by CC0 clips, holding the code-built rifle.
 *
 * Per frame (zero allocations):
 *  1. lower body — Idle / Walk / Jog / Sprint, weighted and phase-synced from the measured root
 *     speed (time-scaled to the clip's natural ground speed, so the feet don't skate); the pelvis
 *     turns toward the travel line when strafing / backpedalling;
 *  2. upper body — the locomotion clip's posture at ready, Pistol_Aim_Up/Neutral/Down (blended by
 *     aim pitch) when aiming; an additive Hit_Chest / Hit_Head flinch on top;
 *  3. torso aim — spine_02/03 are turned (closed loop) until the rifle's line points along the
 *     facing + aim pitch; the rifle is set ~20° off the chest so this blades the shooter;
 *  4. arms — two-bone IK: the right hand onto the pistol grip of a rifle pose held relative to
 *     the chest (butt in the shoulder pocket; low-ready vs shouldered), then the left hand onto
 *     the handguard of where the rifle actually is. The rifle is parented to the right hand, so
 *     it can never drift off the grip; fingers are curled round grip and handguard once;
 *  5. ground — the lowest sole (alive) or lowest hull point (dying) is pinned to the floor.
 * Death plays Death01 (rifle stays in the dead hand), then the corpse is frozen (no ticking).
 */
import * as THREE from 'three/webgpu';
import { createRifle } from '../weapons/rifle';
import { cloneSoldierRig, soldierClips, type AimName, type LocoName } from './soldierAssets';
import type { Kit } from './soldierKit';

export type AnimState = 'idle' | 'run' | 'dead';

export interface SoldierConfig {
  uniform: number;
  vest: number;
  helmet: number;
  scale: number;
  kit: Kit;
}

const GROUND = -0.9; // feet at the bottom of the 1.8 m capsule (root = capsule centre)
const AIM_BLEND = 0.2; // s, in and out
const DEATH_FADE = 0.15;
const PI = Math.PI;

// --- Rifle hold, authored in the body's bind space (T-pose, facing +Z, the body's right = −X) ---
const BUTT_LOCAL = new THREE.Vector3(0, -0.02, 0.287); // upper butt pad, rifle space
const BUTT_Z: Record<Kit, number> = { rifleman: 0.085, rusher: 0.075, heavy: 0.1 };
const RIFLE_YAW = 0.55; // rifle set left of the chest line → aiming blades the torso this much
const READY_DROP = 0.55; // muzzle-down angle of the low-ready carry (relative to the chest)
const READY_ELEV = -0.45; // barrel elevation the torso holds at low ready (rad)
const GRIP_LOCAL = new THREE.Vector3(0, -0.075, 0.062); // pistol-grip centre, rifle space
const GUARD_LOCAL = new THREE.Vector3(-0.004, -0.03, -0.14); // under the rear handguard, rifle space
// Grip centre relative to the hand bone (hand-local): palm side is −X (right) / +X (left).
const PALM_R = new THREE.Vector3(-0.035, 0.072, 0);
const PALM_L = new THREE.Vector3(0.024, 0.07, 0);

/** Finger curl (rad) per joint 01/02/03, per finger. */
const CURL_R: Record<string, [number, number, number]> = {
  index: [0.18, 0.12, 0.06], // straight along the receiver: trigger discipline
  middle: [1.15, 1.25, 0.9],
  ring: [1.2, 1.3, 0.9],
  pinky: [1.25, 1.3, 0.9],
  thumb: [0.35, 0.45, 0.3],
};
const CURL_L: Record<string, [number, number, number]> = {
  index: [0.85, 1.0, 0.75],
  middle: [0.95, 1.05, 0.8],
  ring: [1.0, 1.1, 0.8],
  pinky: [1.05, 1.1, 0.8],
  thumb: [0.15, 0.2, 0.1], // laid forward along the handguard (C-clamp)
};

/** Hull points for ground contact while dying: bone + radius. */
const HULL: [string, number][] = [
  ['Head', 0.11],
  ['spine_03', 0.13],
  ['spine_01', 0.12],
  ['pelvis', 0.11],
  ['upperarm_l', 0.06],
  ['upperarm_r', 0.06],
  ['lowerarm_l', 0.05],
  ['lowerarm_r', 0.05],
  ['hand_l', 0.04],
  ['hand_r', 0.04],
  ['calf_l', 0.06],
  ['calf_r', 0.06],
  ['foot_l', 0.05],
  ['foot_r', 0.05],
];
/** Sole contact while alive: bone + its height above the sole in the bind pose. */
const SOLES: [string, number][] = [
  ['foot_l', 0.086],
  ['foot_r', 0.086],
  ['ball_l', 0.015],
  ['ball_r', 0.015],
];

const LOCO: LocoName[] = ['idle', 'walk', 'jog', 'sprint'];
const AIMS: AimName[] = ['up', 'neutral', 'down'];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
}

export class Soldier {
  readonly root = new THREE.Group();
  readonly muzzleAnchor = new THREE.Object3D();

  private readonly model = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly lower: THREE.AnimationAction[] = [];
  private readonly upper: THREE.AnimationAction[] = [];
  private readonly aimActs: THREE.AnimationAction[] = [];
  private readonly death: THREE.AnimationAction;
  private readonly hits: THREE.AnimationAction[] = [];
  private readonly locoSpeed: number[];
  private readonly locoW = new Float32Array(4);

  private readonly bone: (n: string) => THREE.Object3D;
  private readonly spine2: THREE.Object3D;
  private readonly spine3: THREE.Object3D;
  private readonly pelvis: THREE.Object3D;
  private readonly head: THREE.Object3D;
  private readonly armR: Arm;
  private readonly armL: Arm;
  private readonly clavL: THREE.Object3D;
  private readonly rifle: THREE.Group;
  private readonly hull: THREE.Object3D[];
  private readonly hullR: number[];
  private readonly spines: THREE.Object3D[];
  // Bones this class overrides after the mixer. The mixer only writes a property when its value
  // changes, so each frame these are put back to the mixer's last output before it runs —
  // otherwise procedural offsets would accumulate on bones whose clip pose is static.
  private readonly modBones: THREE.Object3D[];
  private readonly modBase: THREE.Quaternion[];
  private readonly soles: THREE.Object3D[];
  private readonly soleH0: number[];

  // Rifle pose relative to spine_03 (ready / shouldered) and the hand ↔ rifle constants.
  private readonly relPosReady = new THREE.Vector3();
  private readonly relQuatReady = new THREE.Quaternion();
  private readonly relPosAim = new THREE.Vector3();
  private readonly relQuatAim = new THREE.Quaternion();
  private readonly basisR = new THREE.Quaternion(); // right hand orientation in rifle space
  private readonly basisL = new THREE.Quaternion();

  private state: AnimState = 'idle';
  private phase = 0;
  private idleTime = 0;
  private runW = 0;
  private deathT = 0;
  private settled = false;
  private deathYaw = 0;
  private vf = 0;
  private vr = 0;
  private hasPrev = false;
  private aimOn = false;
  private aimW = 0;
  private aimPitch = 0;
  private aimPitchGoal = 0;
  /** Sole height above the model origin, tracked as a slowly-relaxing minimum (keeps flight). */
  private soleH = 0;
  private hasSole = false;

  // scratch
  private readonly _wp = new THREE.Vector3();
  private readonly _prev = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _c = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _e = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _q3 = new THREE.Quaternion();
  private readonly _qT = new THREE.Quaternion();
  private readonly _m = new THREE.Matrix4();
  private readonly _m2 = new THREE.Matrix4();
  private readonly _m3 = new THREE.Matrix4();
  // IK-only scratch (setWorldQuat / rotateWorld use the general scratch above).
  private readonly _ikS = new THREE.Vector3();
  private readonly _ikE = new THREE.Vector3();
  private readonly _ikW = new THREE.Vector3();
  private readonly _ikDir = new THREE.Vector3();
  private readonly _ikQ = new THREE.Quaternion();
  private readonly _ikQ2 = new THREE.Quaternion();

  constructor(cfg: SoldierConfig) {
    const clips = soldierClips();
    const rig = cloneSoldierRig(cfg);
    const byName = new Map<string, THREE.Object3D>();
    rig.traverse((o) => byName.set(o.name, o));
    this.bone = (n: string): THREE.Object3D => {
      const b = byName.get(n);
      if (!b) throw new Error(`soldier rig: missing bone ${n}`);
      return b;
    };
    this.spine2 = this.bone('spine_02');
    this.spine3 = this.bone('spine_03');
    this.pelvis = this.bone('pelvis');
    this.head = this.bone('Head');
    this.armR = { upper: this.bone('upperarm_r'), lower: this.bone('lowerarm_r'), hand: this.bone('hand_r') };
    this.armL = { upper: this.bone('upperarm_l'), lower: this.bone('lowerarm_l'), hand: this.bone('hand_l') };
    this.clavL = this.bone('clavicle_l');
    this.hull = HULL.map(([n]) => this.bone(n));
    this.hullR = HULL.map(([, r]) => r);
    this.soles = SOLES.map(([n]) => this.bone(n));
    this.soleH0 = SOLES.map(([, h]) => h);
    this.spines = [this.spine2, this.spine3];
    this.modBones = [this.pelvis, this.spine2, this.spine3, this.head, this.clavL];
    for (const a of [this.armR, this.armL]) this.modBones.push(a.upper, a.lower, a.hand);
    this.modBase = this.modBones.map((b) => b.quaternion.clone());

    // Bind-pose frames (the rig is still in its rest pose here).
    rig.updateMatrixWorld(true);
    this.setupRifleFrames(cfg.kit);
    this.curlFingers();

    // Rifle in the right hand: fixed so the grip sits in the palm.
    const rifle = createRifle();
    this.rifle = rifle.group;
    this.muzzleAnchor.position.copy(rifle.muzzle);
    this.rifle.add(this.muzzleAnchor);
    const inv = this._q.copy(this.basisR).invert();
    this.rifle.quaternion.copy(inv);
    this.rifle.position.copy(GRIP_LOCAL).applyQuaternion(inv).negate().add(PALM_R);
    this.armR.hand.add(this.rifle);

    // Animation layers.
    this.mixer = new THREE.AnimationMixer(rig);
    for (const k of LOCO) {
      this.lower.push(this.mixer.clipAction(clips.lower[k]));
      this.upper.push(this.mixer.clipAction(clips.upper[k]));
    }
    for (const k of AIMS) this.aimActs.push(this.mixer.clipAction(clips.aim[k]));
    this.death = this.mixer.clipAction(clips.death);
    this.death.setLoop(THREE.LoopOnce, 1);
    this.death.clampWhenFinished = true;
    for (const c of [clips.hitChest, clips.hitHead]) {
      const a = this.mixer.clipAction(c);
      a.blendMode = THREE.AdditiveAnimationBlendMode;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      this.hits.push(a);
    }
    this.locoSpeed = LOCO.map((k) => clips.speed[k]);
    for (const a of [...this.lower, ...this.upper, ...this.aimActs]) {
      a.play();
      a.timeScale = 0; // time is driven explicitly (phase-synced)
      a.setEffectiveWeight(0);
    }

    this.model.rotation.y = PI; // the body faces +Z; soldiers face −Z
    this.model.scale.setScalar(cfg.scale);
    this.model.add(rig);
    this.root.add(this.model);
    this.reset();
  }

  /** Back to a fresh, standing, alive soldier (pooled reuse across rounds — no rebuild). */
  reset(): void {
    this.state = 'idle';
    this.phase = Math.random();
    this.idleTime = Math.random() * 2;
    this.runW = 0;
    this.deathT = 0;
    this.settled = false;
    this.vf = 0;
    this.vr = 0;
    this.hasPrev = false;
    this.aimOn = false;
    this.aimW = 0;
    this.aimPitch = 0;
    this.aimPitchGoal = 0;
    this.hasSole = false;
    this.model.rotation.y = PI;
    this.death.stop();
    for (const h of this.hits) h.stop();
    this.model.position.set(0, GROUND, 0);
    this.update(0);
  }

  play(state: AnimState): void {
    if (state === this.state) return;
    if (state === 'dead') {
      this.deathT = 0;
      this.deathYaw = (Math.random() * 2 - 1) * 0.9;
      this.death.reset();
      this.death.setEffectiveWeight(0);
      this.death.play();
      for (const h of this.hits) h.stop();
    }
    this.state = state;
  }

  /** Shoulder the rifle (`on`) and pitch the aim `pitch` rad above the horizontal. */
  aim(on: boolean, pitch: number): void {
    this.aimOn = on;
    this.aimPitchGoal = Math.max(-0.9, Math.min(0.9, pitch));
  }

  /** Short hit reaction (additive upper-body Hit_Chest / Hit_Head). */
  flinch(): void {
    if (this.state === 'dead') return;
    const a = this.hits[Math.random() < 0.7 ? 0 : 1];
    a.reset();
    a.setEffectiveWeight(0.9);
    a.play();
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    if (this.state === 'dead') {
      if (this.settled) return; // frozen corpse: no ticking
      this.updateDeath(dt);
      return;
    }

    this.measureVelocity(dt);
    this.runW += ((this.state === 'run' ? 1 : 0) - this.runW) * Math.min(1, dt * 7);
    this.aimW = clamp01(this.aimW + (this.aimOn ? dt : -dt) / AIM_BLEND);
    this.aimPitch += (this.aimPitchGoal - this.aimPitch) * Math.min(1, dt * 10);
    const aw = smooth(this.aimW);

    // --- Locomotion weights (speed bands) + phase-synced time ---
    const v = Math.hypot(this.vf, this.vr);
    const theta = Math.atan2(this.vr, this.vf); // 0 fwd, ±π/2 strafe, ±π back
    const back = Math.abs(theta) > 1.75;
    const sp = this.locoSpeed;
    let wWalk = 0;
    let wJog = 0;
    let wSprint = 0;
    if (v < sp[1]) wWalk = v / sp[1];
    else if (v < sp[2]) {
      wJog = (v - sp[1]) / (sp[2] - sp[1]);
      wWalk = 1 - wJog;
    } else if (v < sp[3]) {
      wSprint = (v - sp[2]) / (sp[3] - sp[2]);
      wJog = 1 - wSprint;
    } else wSprint = 1;
    const moving = this.runW * Math.min(1, wWalk + wJog + wSprint);
    const w = this.locoW;
    w[0] = 1 - moving;
    w[1] = this.runW * wWalk;
    w[2] = this.runW * wJog;
    w[3] = this.runW * wSprint;
    // Cycle rate at this speed for each loop, blended; backpedal plays the cycle in reverse.
    let rate = 0;
    let wsum = 0;
    for (let i = 1; i < 4; i++) {
      if (w[i] <= 0) continue;
      rate += w[i] * (Math.max(v, 0.6) / sp[i]) / this.lower[i].getClip().duration;
      wsum += w[i];
    }
    if (wsum > 0) this.phase = (((this.phase + (back ? -1 : 1) * (rate / wsum) * dt) % 1) + 1) % 1;
    this.idleTime += dt;
    for (let i = 0; i < 4; i++) {
      const dur = this.lower[i].getClip().duration;
      const t = i === 0 ? this.idleTime % dur : this.phase * dur;
      this.lower[i].time = t;
      this.upper[i].time = t;
      this.lower[i].setEffectiveWeight(w[i]);
      this.upper[i].setEffectiveWeight(w[i] * (1 - aw));
    }
    // Aim posture: Up / Neutral / Down blended by pitch.
    const p = this.aimPitch / 0.6;
    const up = clamp01(p);
    const down = clamp01(-p);
    this.aimActs[0].setEffectiveWeight(aw * up);
    this.aimActs[1].setEffectiveWeight(aw * (1 - up - down));
    this.aimActs[2].setEffectiveWeight(aw * down);

    this.runMixer(dt);
    this.frame();

    // Pelvis turns toward the travel line (the torso aim below turns the shoulders back).
    const travel = back ? theta - Math.sign(theta) * PI : theta;
    const legYaw = -Math.max(-0.6, Math.min(0.6, travel)) * (back ? 0.6 : 1) * smooth(v / 0.8) * this.runW;
    if (legYaw !== 0) {
      this.rotateWorld(this.pelvis, this._up, legYaw);
      this.pelvis.updateMatrixWorld(true);
    }

    this.aimTorso(aw);
    this.lookHead(aw);
    this.solveArms(aw);
    this.pinSoles(dt);
  }

  // --- Internals -------------------------------------------------------------------------
  /** Mixer step on the un-overridden pose, then world matrices. */
  private runMixer(dt: number): void {
    for (let i = 0; i < this.modBones.length; i++) this.modBones[i].quaternion.copy(this.modBase[i]);
    this.mixer.update(dt);
    for (let i = 0; i < this.modBones.length; i++) this.modBase[i].copy(this.modBones[i].quaternion);
    this.model.updateMatrixWorld(true);
  }

  /** Character axes in world: forward (−Z of the root), right (+X). */
  private frame(): void {
    const e = this.root.matrixWorld.elements;
    this._fwd.set(-e[8], -e[9], -e[10]).normalize();
    this._right.set(e[0], e[1], e[2]).normalize();
  }

  /** Root ground velocity, smoothed, in the facing frame (no allocations). */
  private measureVelocity(dt: number): void {
    this.root.getWorldPosition(this._wp);
    if (this.hasPrev && dt > 0) {
      const dx = (this._wp.x - this._prev.x) / dt;
      const dz = (this._wp.z - this._prev.z) / dt;
      const e = this.root.matrixWorld.elements;
      let f = -(dx * e[8] + dz * e[10]);
      let r = dx * e[0] + dz * e[2];
      const sp = Math.hypot(f, r);
      if (sp > 9) {
        f *= 9 / sp;
        r *= 9 / sp;
      }
      const a = Math.min(1, dt * 6);
      this.vf += (f - this.vf) * a;
      this.vr += (r - this.vr) * a;
    }
    this._prev.copy(this._wp);
    this.hasPrev = true;
  }

  /** Rotates `bone` by `angle` about a WORLD axis (its matrixWorld + parent's must be current). */
  private rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
    const parent = bone.parent as THREE.Object3D;
    bone.matrixWorld.decompose(this._s, this._q, this._t);
    this._q2.setFromAxisAngle(axis, angle).multiply(this._q); // new world rotation
    parent.matrixWorld.decompose(this._s, this._q3, this._t);
    bone.quaternion.copy(this._q3.invert().multiply(this._q2));
  }

  /** Sets a bone's WORLD rotation (parent matrixWorld must be current). */
  private setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion): void {
    (bone.parent as THREE.Object3D).matrixWorld.decompose(this._s, this._q3, this._t);
    bone.quaternion.copy(this._q3.invert().multiply(q));
  }

  /** World rifle pose the chest is holding (ready ↔ shouldered by aim weight) → _m. */
  private rifleTarget(aw: number): THREE.Matrix4 {
    this._a.lerpVectors(this.relPosReady, this.relPosAim, aw);
    this._q.slerpQuaternions(this.relQuatReady, this.relQuatAim, aw);
    this._m2.compose(this._a, this._q, this._s.set(1, 1, 1));
    return this._m.multiplyMatrices(this.spine3.matrixWorld, this._m2);
  }

  /** Barrel elevation the hold aims for: a steady low-ready droop, or the aim pitch. */
  private goalElevation(aw: number): number {
    return READY_ELEV + (this.aimPitch - READY_ELEV) * aw;
  }

  /**
   * Final held rifle pose → _m: the chest-relative hold, swung about the butt (the arms do this,
   * not the torso) so the barrel sits exactly at the goal elevation whatever the clip's lean.
   */
  private heldRifle(aw: number): THREE.Matrix4 {
    const m = this.rifleTarget(aw);
    m.decompose(this._t, this._q, this._s);
    const f = this._b.set(0, 0, -1).applyQuaternion(this._q);
    const delta = this.goalElevation(aw) - Math.asin(Math.max(-1, Math.min(1, f.y)));
    const axis = this._c.crossVectors(f, this._up).normalize(); // + raises the barrel
    const butt = this._d.copy(BUTT_LOCAL).applyMatrix4(m);
    this._m3.makeRotationAxis(axis, delta);
    const rb = this._e.copy(butt).applyMatrix4(this._m3);
    this._m3.setPosition(butt.x - rb.x, butt.y - rb.y, butt.z - rb.z);
    return m.premultiply(this._m3);
  }

  /**
   * Turn spine_02/03 (closed loop) so the held rifle points along the facing, at the aim pitch
   * when shouldered or a steady low-ready droop otherwise — whatever the clip's posture.
   */
  private aimTorso(aw: number): void {
    for (let pass = 0; pass < 2; pass++) {
      const m = this.rifleTarget(aw);
      m.decompose(this._t, this._q, this._s);
      const f = this._b.set(0, 0, -1).applyQuaternion(this._q); // barrel direction
      // Yaw: horizontal angle from the barrel to the facing direction (torso turns fully).
      const yaw = Math.atan2(f.x * this._fwd.z - f.z * this._fwd.x, f.x * this._fwd.x + f.z * this._fwd.z);
      const yawC = -Math.max(-1.3, Math.min(1.3, yaw));
      for (let i = 0; i < 2; i++) {
        this.rotateWorld(this.spines[i], this._up, yawC * 0.5);
        this.spines[i].updateMatrixWorld(true);
      }
      if (aw > 0) {
        // Shouldered: the torso takes half the pitch to the target, the arms the rest.
        const pitch = this.goalElevation(aw) - Math.asin(Math.max(-1, Math.min(1, f.y)));
        const axis = this._c.crossVectors(f, this._up).normalize();
        const pitchC = Math.max(-0.5, Math.min(0.5, pitch)) * 0.5 * aw;
        for (let i = 0; i < 2; i++) {
          this.rotateWorld(this.spines[i], axis, pitchC * 0.5);
          this.spines[i].updateMatrixWorld(true);
        }
      }
    }
  }

  /**
   * Head looks where the rifle points (a full head frame, independent of the clip's head pose);
   * shouldered, it drops a little and cants toward the stock.
   */
  private lookHead(aw: number): void {
    const e = -0.12 + (this.aimPitch - 0.08 + 0.12) * aw;
    const z = this._c.copy(this._fwd).multiplyScalar(Math.cos(e)).addScaledVector(this._up, Math.sin(e));
    // Up, canted toward the right shoulder (stock side) when aiming.
    const y = this._d.copy(this._up).addScaledVector(this._right, 0.18 * aw);
    y.addScaledVector(z, -y.dot(z)).normalize();
    const x = this._e.crossVectors(y, z);
    this._q2.setFromRotationMatrix(this._m2.makeBasis(x, y, z));
    this.setWorldQuat(this.head, this._q2);
    this.head.updateMatrixWorld(true);
  }

  private solveArms(aw: number): void {
    const s = this.model.scale.x;
    // Right hand onto the grip of the rifle pose the chest is holding.
    const m = this.heldRifle(aw);
    m.decompose(this._t, this._q, this._s);
    this._qT.copy(this._q).multiply(this.basisR); // hand world rotation
    const grip = this._c.copy(GRIP_LOCAL).applyMatrix4(m);
    const target = grip.sub(this._d.copy(PALM_R).multiplyScalar(s).applyQuaternion(this._qT));
    const poleR = this._e.copy(this._right).multiplyScalar(0.6).addScaledVector(this._up, -0.8).addScaledVector(this._fwd, -0.2);
    this.ik(this.armR, target, this._qT, poleR);

    // Left hand onto the rifle where it actually is (it rides the right hand); the support
    // shoulder rolls forward when shouldered to reach it.
    this.rotateWorld(this.clavL, this._up, -0.3 * aw);
    this.clavL.updateMatrixWorld(true);
    this.rifle.updateMatrixWorld(true);
    this.rifle.matrixWorld.decompose(this._t, this._q, this._s);
    this._qT.copy(this._q).multiply(this.basisL);
    const guard = this._c.copy(GUARD_LOCAL).applyMatrix4(this.rifle.matrixWorld);
    const targetL = guard.sub(this._d.copy(PALM_L).multiplyScalar(s).applyQuaternion(this._qT));
    // Support elbow tucked: down and slightly in, under the gun.
    const poleL = this._e.copy(this._right).multiplyScalar(0.3).addScaledVector(this._up, -1);
    this.ik(this.armL, targetL, this._qT, poleL);
  }

  /** Analytic two-bone IK in world space, then the hand's world rotation. */
  private ik(arm: Arm, target: THREE.Vector3, handQuat: THREE.Quaternion, pole: THREE.Vector3): void {
    const S = this._ikS.setFromMatrixPosition(arm.upper.matrixWorld);
    const E = this._ikE.setFromMatrixPosition(arm.lower.matrixWorld);
    const W = this._ikW.setFromMatrixPosition(arm.hand.matrixWorld);
    const l1 = S.distanceTo(E);
    const l2 = E.distanceTo(W);
    const dir = this._ikDir.subVectors(target, S);
    let len = dir.length();
    dir.multiplyScalar(1 / Math.max(len, 1e-5));
    len = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(len, (l1 + l2) * 0.999));
    const a = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    // Desired elbow (into `pole`), as a direction from the shoulder.
    const elbowDir = pole.multiplyScalar(h).addScaledVector(dir, a).normalize();
    E.sub(S).normalize();
    this._ikQ2.setFromUnitVectors(E, elbowDir);
    arm.upper.matrixWorld.decompose(W, this._ikQ, W);
    this.setWorldQuat(arm.upper, this._ikQ2.multiply(this._ikQ));
    arm.upper.updateMatrixWorld(true);
    // Forearm: from the (new) elbow toward the clamped target.
    E.setFromMatrixPosition(arm.lower.matrixWorld);
    W.setFromMatrixPosition(arm.hand.matrixWorld).sub(E).normalize();
    const goal = pole.copy(S).addScaledVector(dir, len).sub(E).normalize();
    this._ikQ2.setFromUnitVectors(W, goal);
    arm.lower.matrixWorld.decompose(E, this._ikQ, E);
    this.setWorldQuat(arm.lower, this._ikQ2.multiply(this._ikQ));
    arm.lower.updateMatrixWorld(true);
    this.setWorldQuat(arm.hand, handQuat);
    arm.hand.updateMatrixWorld(true);
  }

  /**
   * Feet on the floor (alive): the lowest sole is pinned at contact, but the pin only relaxes
   * upward slowly, so a running stride keeps its flight phase instead of being pulled down.
   */
  private pinSoles(dt: number): void {
    const s = this.model.scale.x;
    let low = Infinity;
    for (let i = 0; i < this.soles.length; i++) low = Math.min(low, this.soles[i].matrixWorld.elements[13] - this.soleH0[i] * s);
    const h = low - this.model.matrixWorld.elements[13];
    this.soleH = this.hasSole ? Math.min(h, this.soleH + dt * 0.35) : h;
    this.hasSole = true;
    this.model.position.y = GROUND - this.soleH;
  }

  private updateDeath(dt: number): void {
    this.deathT += dt;
    const fade = smooth(this.deathT / DEATH_FADE);
    for (let i = 0; i < 4; i++) {
      this.lower[i].setEffectiveWeight(this.lower[i].getEffectiveWeight() * (1 - fade));
      this.upper[i].setEffectiveWeight(this.upper[i].getEffectiveWeight() * (1 - fade));
    }
    for (let i = 0; i < 3; i++) this.aimActs[i].setEffectiveWeight(this.aimActs[i].getEffectiveWeight() * (1 - fade));
    this.death.setEffectiveWeight(fade);
    this.model.rotation.y = PI + this.deathYaw * smooth(this.deathT / 0.9); // twist as he falls
    this.runMixer(dt);
    // Lowest hull point on the floor: the body never sinks, and never hovers.
    const s = this.model.scale.x;
    let low = Infinity;
    for (let i = 0; i < this.hull.length; i++) low = Math.min(low, this.hull[i].matrixWorld.elements[13] - this.hullR[i] * s);
    this.model.position.y = GROUND - (low - this.model.matrixWorld.elements[13]);
    this.settled = this.deathT > this.death.getClip().duration + 0.2;
  }

  // --- One-time setup ----------------------------------------------------------------------
  /** Rifle poses relative to spine_03 + hand bases, from the bind (rest) pose. */
  private setupRifleFrames(kit: Kit): void {
    const spineInv = this._m2.copy(this.spine3.matrixWorld).invert();
    const pose = (butt: THREE.Vector3, q: THREE.Quaternion, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void => {
      const origin = butt.sub(BUTT_LOCAL.clone().applyQuaternion(q));
      const m = new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1)).premultiply(spineInv);
      m.decompose(outPos, outQuat, new THREE.Vector3());
    };
    // Shouldered: butt in the right shoulder pocket, barrel level, RIFLE_YAW left of the chest.
    const qAim = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), PI + RIFLE_YAW);
    pose(new THREE.Vector3(-0.17, 1.455, BUTT_Z[kit]), qAim, this.relPosAim, this.relQuatAim);
    // Low ready: same line, muzzle dropped about the rifle's own horizontal axis.
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(qAim);
    const axis = new THREE.Vector3(0, 1, 0).cross(d).normalize();
    const qReady = new THREE.Quaternion().setFromAxisAngle(axis, READY_DROP).multiply(qAim);
    pose(new THREE.Vector3(-0.15, 1.4, BUTT_Z[kit] - 0.01), qReady, this.relPosReady, this.relQuatReady);

    // Hand orientations in rifle space (rifle: X right, Y up, −Z muzzle). Hand bones: +Y along
    // the fingers; palm normal −X (right hand) / +X (left hand).
    const basis = (x: THREE.Vector3, y: THREE.Vector3, out: THREE.Quaternion): void => {
      y.normalize();
      x.addScaledVector(y, -x.dot(y)).normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    };
    // Right: back of the hand outboard (+X), fingers forward + down the 22° grip, wrapping left.
    basis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-0.3, -0.375, -0.927), this.basisR);
    // Left: palm up under the handguard (local +X → up), fingers across to the right.
    basis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0.25, 0), this.basisL);
  }

  /** Curl the fingers round grip and handguard once (finger channels aren't animated). */
  private curlFingers(): void {
    const hands: [string, Record<string, [number, number, number]>, THREE.Vector3][] = [
      ['r', CURL_R, new THREE.Vector3(-1, 0, 0)],
      ['l', CURL_L, new THREE.Vector3(1, 0, 0)],
    ];
    for (const [side, curl, palmLocal] of hands) {
      // Flexion axis, fixed in the hand frame: rotates the finger line (+Y) toward the palm.
      const handQ = this.bone(`hand_${side}`).getWorldQuaternion(new THREE.Quaternion());
      const axisWorld = new THREE.Vector3(0, 1, 0).cross(palmLocal).applyQuaternion(handQ).normalize();
      for (const [finger, angles] of Object.entries(curl)) {
        for (let j = 0; j < 3; j++) {
          const b = this.bone(`${finger}_0${j + 1}_${side}`);
          const inv = b.getWorldQuaternion(new THREE.Quaternion()).invert();
          const axis = axisWorld.clone().applyQuaternion(inv).normalize();
          b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angles[j]));
          b.updateMatrixWorld(true);
        }
      }
    }
  }
}
