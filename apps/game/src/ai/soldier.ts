/**
 * Original stylized-realistic modern infantry soldier, authored in code (no ripped/mocap assets —
 * CS/CoD are *look* references only, per rule 3). The body is a pivot hierarchy of ten rigid
 * segments (see soldierModel.ts), each ONE draw call through a single shared TSL material
 * (soldierMaterial.ts); the arms segment carries the rifle from `createRifle()`.
 *
 * Procedural animation, zero allocations per frame:
 *   - idle:  breathing, slow weight shift between the feet, torso/head scanning;
 *   - run:   speed-adaptive gait (cadence + stride from measured root speed) with hip/knee/ankle
 *            phase offsets; the pelvis turns toward the travel direction (strafe / backpedal)
 *            while the shoulders stay on the facing, so sideways moves step instead of skate;
 *   - aim:   upper-body layer — rifle shouldered, torso + head pitched at the target, cheek weld;
 *            blends in/out in 0.2 s over idle or run;
 *   - flinch: ~150 ms additive hit reaction;
 *   - dead:  hit jolt → knees buckle → topple onto a side → small rebound → settle, then frozen.
 * Ground contact comes from hull probes: the lowest sole (alive) or lowest hull point (dying) is
 * pinned to the floor, so feet never float/sink and the body never sinks into the ground.
 */
import * as THREE from 'three/webgpu';
import { createRifle } from '../weapons/rifle';
import { PARENT, PIVOT, RIFLE_POS, RIFLE_QUAT, SEG, SEG_COUNT, soldierRig, type Kit } from './soldierModel';
import { soldierMaterial } from './soldierMaterial';

export type AnimState = 'idle' | 'run' | 'dead';

export interface SoldierConfig {
  uniform: number;
  vest: number;
  helmet: number;
  scale: number;
  kit: Kit;
}

/** Pose channels (radians / metres). */
const C = {
  hipX: 0,
  hipY: 1,
  hipZ: 2,
  hipRX: 3,
  hipRY: 4,
  hipRZ: 5,
  chRX: 6,
  chRY: 7,
  chRZ: 8,
  hdRX: 9,
  hdRY: 10,
  hdRZ: 11,
  tLX: 12,
  tLY: 13,
  tLZ: 14,
  sL: 15,
  fLX: 16,
  fLZ: 17,
  tRX: 18,
  tRY: 19,
  tRZ: 20,
  sR: 21,
  fRX: 22,
  fRZ: 23,
  mRX: 24,
  mRZ: 25,
  aRX: 26,
  aY: 27,
  aZ: 28,
} as const;
const NCH = 29;

const GROUND = -0.9; // feet at the bottom of the 1.8 m capsule (root = capsule centre)
const PI = Math.PI;
const TAU = PI * 2;
const AIM_BLEND = 0.2; // s, in and out
const FLINCH_T = 0.15; // s
const SETTLED_T = 1.7; // s after death: pose is final, stop evaluating

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
/** Raised-cosine window on a phase angle: 1 at `c`, 0 beyond ±`hw` (wraps). */
function bump(p: number, c: number, hw: number): number {
  let d = (p - c) % TAU;
  if (d > PI) d -= TAU;
  else if (d < -PI) d += TAU;
  const x = Math.abs(d);
  return x >= hw ? 0 : 0.5 + 0.5 * Math.cos((PI * x) / hw);
}

interface LiveProbe {
  seg: THREE.Object3D;
  local: THREE.Vector3;
  sole: boolean;
}

export class Soldier {
  readonly root = new THREE.Group();
  readonly muzzleAnchor = new THREE.Object3D();

  private readonly model = new THREE.Group();
  private readonly seg: THREE.Group[] = [];
  private readonly probes: LiveProbe[] = [];
  private readonly ownGeo: THREE.BufferGeometry[] = []; // per-instance (rifle); body is shared

  private readonly pose = new Float32Array(NCH);
  private readonly idleP = new Float32Array(NCH);
  private readonly runP = new Float32Array(NCH);
  private readonly deadP = new Float32Array(NCH);
  private readonly fromP = new Float32Array(NCH);

  private state: AnimState = 'idle';
  private time = 0;
  private phase = 0;
  private runW = 0;
  private deathT = 0;
  private settled = false;
  // Smoothed root velocity in the facing frame (m/s): forward, right.
  private vf = 0;
  private vr = 0;
  private hasPrev = false;
  // Aim layer.
  private aimOn = false;
  private aimW = 0;
  private aimPitch = 0;
  private aimPitchGoal = 0;
  // Hit reaction.
  private flinchT = 1;
  private flinchDir = 1;
  private readonly seed = Math.random() * 10;
  private readonly fallSide = Math.random() < 0.5 ? 1 : -1;
  private readonly fallFwd = Math.random() * 2 - 1;

  private readonly _wp = new THREE.Vector3();
  private readonly _prev = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();

  constructor(cfg: SoldierConfig) {
    const rig = soldierRig(cfg);
    const mat = soldierMaterial();

    for (let i = 0; i < SEG_COUNT; i++) {
      const g = new THREE.Group();
      const parent = PARENT[i];
      const at = PIVOT[i];
      if (parent < 0) g.position.copy(at);
      else g.position.copy(at).sub(PIVOT[parent]);
      const mesh = new THREE.Mesh(rig.geos[i], mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      this.seg.push(g);
    }
    for (let i = 0; i < SEG_COUNT; i++) {
      const parent = PARENT[i];
      (parent < 0 ? this.model : this.seg[parent]).add(this.seg[i]);
    }
    for (const pr of rig.probes) {
      this.probes.push({ seg: this.seg[pr.seg], local: pr.p.clone().sub(PIVOT[pr.seg]), sole: pr.sole });
    }

    // Rifle in the hands (arms segment space), muzzle anchor at its tip.
    const rifle = createRifle();
    rifle.group.position.copy(RIFLE_POS).sub(PIVOT[SEG.arms]);
    rifle.group.quaternion.copy(RIFLE_QUAT);
    this.muzzleAnchor.position.copy(rifle.muzzle);
    rifle.group.add(this.muzzleAnchor);
    rifle.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) this.ownGeo.push(m.geometry);
    });
    this.seg[SEG.arms].add(rifle.group);

    this.model.position.y = GROUND;
    this.model.scale.setScalar(cfg.scale);
    this.root.add(this.model);

    this.idlePose(0, this.pose);
    this.apply(this.pose);
  }

  play(state: AnimState): void {
    if (state === this.state) return;
    if (state === 'dead') {
      this.deathT = 0;
      this.fromP.set(this.pose);
    }
    this.state = state;
  }

  /** Shoulder the rifle (`on`) and pitch the upper body `pitch` rad above the horizontal. */
  aim(on: boolean, pitch: number): void {
    this.aimOn = on;
    this.aimPitchGoal = Math.max(-0.9, Math.min(0.9, pitch));
  }

  /** Short (≈150 ms) hit reaction layered over whatever is playing. */
  flinch(): void {
    this.flinchT = 0;
    this.flinchDir = Math.random() < 0.5 ? -1 : 1;
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;

    if (this.state === 'dead') {
      if (this.settled) return; // corpse: final pose already applied
      this.deathT += dt;
      this.deathPose(this.deathT, this.deadP);
      const w = smooth(this.deathT / 0.16);
      for (let i = 0; i < NCH; i++) this.pose[i] = lerp(this.fromP[i], this.deadP[i], w);
      this.apply(this.pose);
      this.ground(false, 0);
      this.settled = this.deathT >= SETTLED_T;
      return;
    }

    this.measureVelocity(dt);
    this.runW += ((this.state === 'run' ? 1 : 0) - this.runW) * Math.min(1, dt * 7);
    this.aimW = clamp01(this.aimW + (this.aimOn ? dt : -dt) / AIM_BLEND);
    this.aimPitch += (this.aimPitchGoal - this.aimPitch) * Math.min(1, dt * 10);
    this.flinchT += dt;

    // Travel direction relative to facing: 0 = forward, ±π/2 = strafe, ±π = backpedal.
    const v = Math.hypot(this.vf, this.vr);
    const theta = Math.atan2(this.vr, this.vf);
    const back = Math.abs(theta) > 1.75;
    const k = clamp01((v - 1.5) / 4.5); // 0 = brisk walk … 1 = sprint
    if (this.runW > 0.001) {
      const dir = back ? -1 : 1;
      this.phase = (((this.phase + dir * TAU * (0.8 + 0.13 * v) * dt) % TAU) + TAU) % TAU;
    }
    // Pelvis turns toward the travel line (legs step along it); shoulders keep the facing.
    const travel = back ? theta - Math.sign(theta) * PI : theta;
    const legYaw = -Math.max(-0.95, Math.min(0.95, travel)) * (back ? 0.6 : 1) * smooth(v / 0.8);

    this.idlePose(this.time, this.idleP);
    this.runPose(this.phase, v, k, back, this.runP);
    const o = this.pose;
    for (let i = 0; i < NCH; i++) o[i] = lerp(this.idleP[i], this.runP[i], this.runW);
    o[C.hipRY] += legYaw * this.runW;
    o[C.chRY] -= legYaw * this.runW;
    this.aimLayer(o, smooth(this.aimW));
    this.flinchLayer(o);
    this.apply(o);
    // Brief flight phase before each foot strike at running pace.
    const flight = this.runW * k * 0.028 * bump((this.phase * 2) % TAU, 1.8 * PI, 0.3 * PI);
    this.ground(true, flight);
  }

  /** Root ground velocity, smoothed, expressed in the facing frame (no allocations). */
  private measureVelocity(dt: number): void {
    this.root.getWorldPosition(this._wp);
    if (this.hasPrev && dt > 0) {
      const dx = (this._wp.x - this._prev.x) / dt;
      const dz = (this._wp.z - this._prev.z) / dt;
      const e = this.root.matrixWorld.elements; // fresh: getWorldPosition just updated it
      let f = -(dx * e[8] + dz * e[10]);
      let r = dx * e[0] + dz * e[2];
      const sp = Math.hypot(f, r);
      if (sp > 9) {
        f *= 9 / sp; // teleports / spawn snaps
        r *= 9 / sp;
      }
      const a = Math.min(1, dt * 6);
      this.vf += (f - this.vf) * a;
      this.vr += (r - this.vr) * a;
    }
    this._prev.copy(this._wp);
    this.hasPrev = true;
  }

  // --- Poses -----------------------------------------------------------------------------
  private idlePose(t: number, o: Float32Array): void {
    o.fill(0);
    const s = this.seed;
    const breath = Math.sin(t * 1.45);
    const sway = Math.sin(t * 0.55 + s) * 0.7 + Math.sin(t * 0.23 + s * 2) * 0.3;
    const scan = Math.sin(t * 0.42 + s * 3) * 0.6 + Math.sin(t * 1.13 + s) * 0.25 + Math.sin(t * 0.17) * 0.15;
    o[C.hipX] = sway * 0.016;
    o[C.hipRZ] = -sway * 0.025;
    o[C.hipRY] = 0.06;
    o[C.chRX] = -0.05 + breath * 0.012;
    o[C.chRY] = scan * 0.06 - 0.06;
    o[C.chRZ] = sway * 0.02;
    o[C.hdRX] = -0.02 + Math.sin(t * 0.71 + s) * 0.035 + 0.025;
    o[C.hdRY] = scan * 0.3;
    o[C.hdRZ] = -o[C.chRZ] - o[C.hipRZ] * 0.5;
    o[C.aRX] = breath * 0.01;
    // Athletic stance: support foot forward, toes out, soft knees, soles flat on the ground.
    const comp = o[C.hipX] / 0.84;
    o[C.tLX] = 0.12;
    o[C.tLY] = 0.12;
    o[C.tLZ] = -0.05 - o[C.hipRZ] - comp;
    o[C.sL] = -0.2;
    o[C.fLX] = 0.08;
    o[C.fLZ] = -(o[C.tLZ] + o[C.hipRZ]);
    o[C.tRX] = -0.06;
    o[C.tRY] = -0.3;
    o[C.tRZ] = 0.06 - o[C.hipRZ] - comp;
    o[C.sR] = -0.14;
    o[C.fRX] = 0.2;
    o[C.fRZ] = -(o[C.tRZ] + o[C.hipRZ]);
  }

  private runPose(p: number, v: number, k: number, back: boolean, o: Float32Array): void {
    o.fill(0);
    const lean = back ? 0.02 : lerp(0.07, 0.26, k);
    const sw = lerp(0.38, 0.7, k) * Math.min(1, Math.max(0.35, v / 2)) * (back ? 0.75 : 1);
    const kneeSwing = lerp(0.8, 1.75, k);
    const hipYaw = lerp(0.09, 0.15, k);
    const cp = Math.cos(p + 0.2 * PI); // left thigh forward-most in late swing
    o[C.hipRX] = -lean * 0.45;
    o[C.hipRY] = -hipYaw * cp;
    o[C.hipRZ] = -0.04 * Math.sin(p);
    o[C.chRX] = -lean * 0.55 + 0.015 * Math.cos(2 * p);
    o[C.chRY] = (hipYaw + 0.035) * cp; // shoulders counter-rotate; rifle stays on line
    o[C.chRZ] = -o[C.hipRZ] * 0.7;
    o[C.hdRX] = lean * 0.8;
    o[C.hdRY] = -0.035 * cp;
    o[C.hdRZ] = -(o[C.hipRZ] + o[C.chRZ]) * 0.6;
    this.leg(p, sw, kneeSwing, k, lean, o, C.tLX, C.sL, C.fLX);
    this.leg(p + PI, sw, kneeSwing, k, lean, o, C.tRX, C.sR, C.fRX);
    o[C.tLZ] = -0.025 - o[C.hipRZ];
    o[C.tRZ] = 0.025 - o[C.hipRZ];
    o[C.fLZ] = -(o[C.tLZ] + o[C.hipRZ]);
    o[C.fRZ] = -(o[C.tRZ] + o[C.hipRZ]);
  }

  /** One leg of the gait. p = 0 at heel strike; stance ≈ [0, 0.75π], swing after toe-off. */
  private leg(p: number, sw: number, kneeSwing: number, k: number, lean: number, o: Float32Array, ti: number, si: number, fi: number): void {
    const thighW = sw * Math.cos(p + 0.2 * PI) + 0.08 * k; // relative to vertical, + = forward
    const absorb = 0.22 * bump(p, 0.3 * PI, 0.3 * PI) * (0.5 + 0.5 * k);
    const swing = kneeSwing * bump(p, 1.25 * PI, 0.55 * PI);
    const knee = -(0.1 + absorb + swing);
    o[ti] = thighW + lean * 0.45; // undo the pelvis tilt
    o[si] = knee;
    const flat = -(thighW + knee); // sole parallel to the ground
    const ws = bump(p, 0.3 * PI, 0.42 * PI);
    const toeOff = -lerp(0.35, 0.65, k) * bump(p, 0.78 * PI, 0.2 * PI);
    const swingFoot = 0.15 * bump(p, 1.4 * PI, 0.4 * PI) - 0.1;
    o[fi] = flat * ws + swingFoot * (1 - ws) + toeOff;
  }

  /**
   * Aim layer: rifle up into the shoulder (arms segment raised about the shoulder line), torso
   * leaning into the gun and pitched at the target, head down on the stock with a slight cant.
   * Scanning and gait counter-rotation are suppressed so the muzzle holds on target.
   */
  private aimLayer(o: Float32Array, w: number): void {
    if (w <= 0) return;
    const p = this.aimPitch;
    const faceYaw = -o[C.hipRY]; // chest yaw that cancels the pelvis → shoulders on the facing
    o[C.chRX] = lerp(o[C.chRX], -0.07 + p * 0.5, w);
    o[C.chRY] = lerp(o[C.chRY], faceYaw + 0.02, w);
    o[C.chRZ] = lerp(o[C.chRZ], 0, w);
    o[C.aRX] = lerp(o[C.aRX], 0.32 + p * 0.5, w);
    o[C.aY] = lerp(o[C.aY], 0.06, w);
    o[C.aZ] = lerp(o[C.aZ], -0.02, w);
    o[C.hdRX] = lerp(o[C.hdRX], -0.3 + p * 0.45, w);
    o[C.hdRY] = lerp(o[C.hdRY], 0.1, w);
    o[C.hdRZ] = lerp(o[C.hdRZ], -0.2, w);
  }

  /** Hit flinch: fast knock-back that peaks at ~60 ms and is gone by ~250 ms. */
  private flinchLayer(o: Float32Array): void {
    const t = this.flinchT;
    if (t >= 0.3) return;
    const env = t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) / (FLINCH_T * 0.45));
    o[C.chRX] += 0.2 * env;
    o[C.chRY] += this.flinchDir * 0.14 * env;
    o[C.hdRX] += 0.22 * env;
    o[C.hdRZ] += this.flinchDir * 0.1 * env;
    o[C.aRX] -= 0.12 * env;
    o[C.hipX] -= this.flinchDir * 0.015 * env;
  }

  private deathPose(t: number, o: Float32Array): void {
    o.fill(0);
    const s = this.fallSide;
    const jolt = t < 0.2 ? Math.sin(PI * (t / 0.2)) : 0; // hit reaction
    const a = smooth(t / 0.42); // knees buckle
    const u = clamp01((t - 0.3) / 0.62);
    const b = u * u; // topple accelerates under gravity
    const tau = t - 0.92;
    const rebound = tau > 0 ? -0.06 * Math.exp(-6 * tau) * Math.sin(13 * tau) : 0;
    o[C.hipY] = -0.05 * a;
    o[C.hipZ] = 0.04 * a;
    o[C.hipRX] = -0.3 * a - 0.1 * b;
    o[C.hipRY] = s * 0.1 * a;
    o[C.chRX] = 0.16 * jolt - 0.4 * a + 0.15 * b;
    o[C.chRY] = s * 0.18 * a;
    o[C.chRZ] = s * 0.18 * b;
    o[C.hdRX] = 0.28 * jolt - 0.45 * a + 0.25 * b;
    o[C.hdRY] = s * 0.3 * a;
    o[C.hdRZ] = s * (0.15 * a + 0.35 * b);
    o[C.tLX] = 0.05 + 1.1 * a - 0.3 * b;
    o[C.tLY] = 0.1 * a;
    o[C.tLZ] = -0.06 - s * 0.1 * b;
    o[C.sL] = -0.1 - 1.6 * a + 0.6 * b;
    o[C.fLX] = 0.4 * a - 0.6 * b;
    o[C.tRX] = -0.02 + 0.8 * a + 0.1 * b;
    o[C.tRY] = -0.1 * a;
    o[C.tRZ] = 0.06 - s * 0.05 * b;
    o[C.sR] = -0.1 - 1.3 * a + 0.2 * b;
    o[C.fRX] = 0.35 * a - 0.5 * b;
    o[C.aRX] = -0.25 * a; // rifle sags as the arms go limp
    o[C.mRX] = -0.14 * b * this.fallFwd;
    o[C.mRZ] = s * (0.1 * a + 1.36 * b + rebound);
  }

  private apply(o: Float32Array): void {
    const sg = this.seg;
    const H = PIVOT[SEG.hips];
    const A = PIVOT[SEG.arms];
    const W = PIVOT[SEG.chest];
    sg[SEG.hips].position.set(H.x + o[C.hipX], H.y + o[C.hipY], H.z + o[C.hipZ]);
    sg[SEG.hips].rotation.set(o[C.hipRX], o[C.hipRY], o[C.hipRZ]);
    sg[SEG.chest].rotation.set(o[C.chRX], o[C.chRY], o[C.chRZ]);
    sg[SEG.head].rotation.set(o[C.hdRX], o[C.hdRY], o[C.hdRZ]);
    sg[SEG.arms].position.set(A.x - W.x, A.y - W.y + o[C.aY], A.z - W.z + o[C.aZ]);
    sg[SEG.arms].rotation.set(o[C.aRX], 0, 0);
    sg[SEG.thighL].rotation.set(o[C.tLX], o[C.tLY], o[C.tLZ]);
    sg[SEG.shinL].rotation.set(o[C.sL], 0, 0);
    sg[SEG.footL].rotation.set(o[C.fLX], 0, o[C.fLZ]);
    sg[SEG.thighR].rotation.set(o[C.tRX], o[C.tRY], o[C.tRZ]);
    sg[SEG.shinR].rotation.set(o[C.sR], 0, 0);
    sg[SEG.footR].rotation.set(o[C.fRX], 0, o[C.fRZ]);
    this.model.rotation.set(o[C.mRX], 0, o[C.mRZ]);
  }

  /** Pins the lowest probe (soles only, or the whole hull) to the floor, plus `lift`. */
  private ground(solesOnly: boolean, lift: number): void {
    this.model.position.y = 0;
    this.model.updateMatrix();
    for (const g of this.seg) g.updateMatrix();
    let minY = Infinity;
    for (const pr of this.probes) {
      if (solesOnly && !pr.sole) continue;
      const v = this._v.copy(pr.local);
      let o: THREE.Object3D | null = pr.seg;
      while (o && o !== this.model) {
        v.applyMatrix4(o.matrix);
        o = o.parent;
      }
      v.applyMatrix4(this.model.matrix);
      if (v.y < minY) minY = v.y;
    }
    this.model.position.y = GROUND - minY + lift;
  }

  dispose(): void {
    // Body geometry + the soldier material are shared (cached per look); only the rifle's
    // geometry is per-instance. Rifle materials are shared by createRifle().
    for (const g of this.ownGeo) g.dispose();
  }
}
