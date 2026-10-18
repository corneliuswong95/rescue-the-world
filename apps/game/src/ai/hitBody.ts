/**
 * Per-bone hit volumes for a skinned soldier, read live from the skeleton: a head sphere (helmet
 * and ear cups included), a neck capsule, a trunk capsule sized per kit (plates and pouches
 * included), a shoulder bar, pelvis / hip capsules and capsules down every arm and leg segment.
 * Fitted to the drawn mesh (bind-space extents of the body + kit). Rays are tested analytically — no physics objects,
 * no allocations — so a shot lands on what is actually drawn, not on a padded movement capsule.
 */
import * as THREE from 'three/webgpu';
import type { TraceHit } from '../combat/hittable';
import type { Kit } from './soldierKit';

interface Shape {
  a: THREE.Object3D;
  aOff: THREE.Vector3; // bone-local offset of endpoint A
  b: THREE.Object3D;
  bOff: THREE.Vector3;
  r: number; // bind-space radius (scaled by the soldier's scale)
  head: boolean;
  sphere: boolean;
}

const ZERO = new THREE.Vector3();
/** Trunk radius: covers the plate bags / chest rig front and back and the cummerbund pouches. */
const TORSO_R: Record<Kit, number> = { rifleman: 0.235, rusher: 0.205, heavy: 0.25 };

/** Ray (origin o, unit dir d) vs sphere; nearest t ≥ 0 or -1. */
function raySphere(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : -1;
}

/** Ray vs capsule (segment A–B, radius r); nearest t ≥ 0 or -1 (Quilez' closed form). */
function rayCapsule(
  o: THREE.Vector3,
  d: THREE.Vector3,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): number {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = o.x - ax;
  const oay = o.y - ay;
  const oaz = o.z - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  if (a < 1e-9) {
    // Ray along the axis: the nearer end cap decides.
    const t1 = raySphere(o, d, ax, ay, az, r);
    const t2 = raySphere(o, d, bx, by, bz, r);
    return t1 < 0 ? t2 : t2 < 0 ? t1 : Math.min(t1, t2);
  }
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  const h = b * b - a * c;
  if (h < 0) return -1;
  const t = (-b - Math.sqrt(h)) / a;
  const y = baoa + t * bard;
  if (y > 0 && y < baba) return t >= 0 ? t : -1;
  return y <= 0 ? raySphere(o, d, ax, ay, az, r) : raySphere(o, d, bx, by, bz, r);
}

export class HitBody {
  private readonly shapes: Shape[] = [];
  private readonly pelvis: THREE.Object3D;
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();

  constructor(
    bone: (n: string) => THREE.Object3D,
    kit: Kit,
    private readonly scale: number,
  ) {
    const add = (a: string, aOff: THREE.Vector3, b: string, bOff: THREE.Vector3, r: number, head = false, sphere = false): void => {
      this.shapes.push({ a: bone(a), aOff, b: bone(b), bOff, r, head, sphere });
    };
    // Bone-local offsets: spine / neck / head bones have +Y up the body and +Z forward.
    // Head + helmet: the Head bone sits at the skull base; helmet + ear cups centre ~11 cm above.
    add('Head', new THREE.Vector3(0, 0.112, -0.004), 'Head', ZERO, 0.135, true, true);
    add('neck_01', ZERO, 'Head', ZERO, 0.07);
    // Trunk: biased 2–4 cm forward (plates + pouches stand proud of the chest); its top cap stops
    // at the collar (bind y ≈ 1.29 + r), below the head sphere, so a face shot is never a body
    // shot. The shoulder bar covers the deltoids / straps; the radio sits out on the left side.
    add('spine_02', new THREE.Vector3(0, 0, 0.02), 'spine_03', new THREE.Vector3(0, -0.03, 0.025), TORSO_R[kit]);
    add('upperarm_l', ZERO, 'upperarm_r', ZERO, 0.09);
    add('spine_03', new THREE.Vector3(0.27, -0.13, 0.02), 'spine_03', new THREE.Vector3(0.27, 0.06, 0.02), 0.045);
    add('pelvis', ZERO, 'spine_01', ZERO, 0.17);
    add('thigh_l', ZERO, 'thigh_r', ZERO, 0.13);
    for (const s of ['l', 'r']) {
      add(`upperarm_${s}`, ZERO, `lowerarm_${s}`, ZERO, 0.068);
      add(`lowerarm_${s}`, ZERO, `hand_${s}`, ZERO, 0.056);
      add(`hand_${s}`, ZERO, `hand_${s}`, new THREE.Vector3(0, 0.09, 0), 0.045);
      add(`thigh_${s}`, ZERO, `calf_${s}`, ZERO, 0.105);
      add(`calf_${s}`, ZERO, `foot_${s}`, ZERO, 0.075);
      add(`foot_${s}`, ZERO, `ball_${s}`, ZERO, 0.058);
    }
    this.pelvis = bone('pelvis');
  }

  /** Nearest body hit along the unit ray within `maxT`; fills `out`. */
  trace(o: THREE.Vector3, d: THREE.Vector3, maxT: number, out: TraceHit): boolean {
    const s = this.scale;
    // Cheap reject: a sphere round the pelvis that contains every pose (incl. arms + head).
    const p = this.pelvis.matrixWorld.elements;
    if (raySphere(o, d, p[12], p[13], p[14], 1.3 * s) < 0 && this.outside(o, p, 1.3 * s)) return false;
    let best = maxT;
    let head = false;
    for (let i = 0; i < this.shapes.length; i++) {
      const sh = this.shapes[i];
      const A = this._a.copy(sh.aOff).applyMatrix4(sh.a.matrixWorld);
      let t: number;
      if (sh.sphere) t = raySphere(o, d, A.x, A.y, A.z, sh.r * s);
      else {
        const B = this._b.copy(sh.bOff).applyMatrix4(sh.b.matrixWorld);
        t = rayCapsule(o, d, A.x, A.y, A.z, B.x, B.y, B.z, sh.r * s);
      }
      if (t >= 0 && t < best) {
        best = t;
        head = sh.head;
      }
    }
    if (best >= maxT) return false;
    out.t = best;
    out.head = head;
    return true;
  }

  private outside(o: THREE.Vector3, p: ArrayLike<number>, r: number): boolean {
    const dx = o.x - p[12];
    const dy = o.y - p[13];
    const dz = o.z - p[14];
    return dx * dx + dy * dy + dz * dz > r * r;
  }
}
