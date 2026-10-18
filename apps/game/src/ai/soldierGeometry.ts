/**
 * Geometry toolkit for the code-authored soldier: rounded, organic primitives (lofted
 * super-elliptic tubes for anatomy, swept bands for straps/cables, a parametric helmet shell)
 * and a PartSink that bakes many parts into ONE indexed geometry (one rigid gear piece), with the
 * per-vertex surface attributes the shared soldier material reads (`albedo`, `surf`).
 *
 * Build-time only — nothing here runs per frame.
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Surface } from './soldierMaterial';

/** One cross-section of a loft: a super-ellipse at height `y`. */
export interface Section {
  y: number;
  rx: number;
  rz: number;
  x?: number;
  z?: number;
  /** Super-ellipse exponent: 2 = ellipse, higher = squarer. */
  n?: number;
  /** Fold ripple amplitude (fraction of radius), lobe count and phase — suggests fabric folds. */
  rip?: number;
  ripK?: number;
  ripP?: number;
  /** Radius multiplier on the front (-Z) half — muscle/fabric bulge. */
  front?: number;
  /** Radius multiplier on the back (+Z) half. */
  back?: number;
}

/**
 * Lofts super-elliptic sections along +Y into a closed (optionally capped) tube. The workhorse
 * for limbs, torso, pelvis, boots and bands — anything that must read as a rounded form.
 */
export function loft(sections: Section[], radial: number, capBottom = true, capTop = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const ringPoint = (s: Section, j: number, out: number[]): void => {
    const th = (j / radial) * Math.PI * 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const e = 2 / (s.n ?? 2);
    const cx = Math.sign(c) * Math.pow(Math.abs(c), e);
    const sz = Math.sign(sn) * Math.pow(Math.abs(sn), e);
    const rip = 1 + (s.rip ?? 0) * Math.sin((s.ripK ?? 5) * th + (s.ripP ?? 0));
    const fb = sz < 0 ? (s.front ?? 1) : (s.back ?? 1);
    out.push((s.x ?? 0) + s.rx * cx * rip, s.y, (s.z ?? 0) + s.rz * sz * rip * fb);
  };

  for (const s of sections) for (let j = 0; j < radial; j++) ringPoint(s, j, pos);
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + ((j + 1) % radial);
      const d = (i + 1) * radial + j;
      idx.push(a, d, b, b, d, c);
    }
  }
  // Flat caps on duplicated rim vertices so the side normals stay smooth.
  const cap = (s: Section, top: boolean): void => {
    const base = pos.length / 3;
    pos.push(s.x ?? 0, s.y, s.z ?? 0);
    for (let j = 0; j < radial; j++) ringPoint(s, j, pos);
    for (let j = 0; j < radial; j++) {
      const a = base + 1 + j;
      const b = base + 1 + ((j + 1) % radial);
      if (top) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  };
  if (capBottom) cap(sections[0], false);
  if (capTop) cap(sections[sections.length - 1], true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

/** Matrix placing a +Y-authored geometry so its origin sits at `a` and its +Y points to `b`. */
export function alongMatrix(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  _dir.subVectors(b, a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  return new THREE.Matrix4().compose(a, _q, _s);
}

/** Matrix from position + Euler (XYZ) rotation. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    _s,
  );
}

export function rbox(w: number, h: number, d: number, r: number, seg = 1): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, seg, r);
}

/** Curves a geometry around the vertical axis: z += k·x² (wraps plates/pouches round a torso). */
export function curveZ(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + k * p.getX(i) * p.getX(i));
  g.computeVertexNormals();
  return g;
}

/**
 * Sweeps an elliptical section (half-extents `hw` along `side`, `ht` along the binormal) along a
 * smooth curve through `pts` — straps, cords, cables, the antenna.
 */
export function sweep(
  pts: THREE.Vector3[],
  hw: number,
  ht: number,
  side: THREE.Vector3,
  samples = 16,
  radial = 6,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const pos: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const S = new THREE.Vector3();
  const N = new THREE.Vector3();
  const rings = samples + 1;
  for (let i = 0; i < rings; i++) {
    const u = i / samples;
    curve.getPointAt(u, P);
    curve.getTangentAt(u, T);
    S.copy(side).addScaledVector(T, -side.dot(T)).normalize();
    N.crossVectors(T, S).normalize();
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const c = Math.cos(th) * hw;
      const s = Math.sin(th) * ht;
      pos.push(P.x + S.x * c + N.x * s, P.y + S.y * c + N.y * s, P.z + S.z * c + N.z * s);
    }
  }
  for (let i = 0; i < samples; i++) {
    const i1 = i + 1;
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + j1;
      const c = i1 * radial + j1;
      const d = i1 * radial + j;
      idx.push(a, b, d, b, c, d);
    }
  }
  // End caps (fans), so strap ends and fingertips are closed.
  for (const [ring, u, dir] of [
    [0, 0, -1],
    [samples, 1, 1],
  ] as const) {
    curve.getPointAt(u, P);
    const c = pos.length / 3;
    pos.push(P.x, P.y, P.z);
    for (let j = 0; j < radial; j++) {
      const a = ring * radial + j;
      const b = ring * radial + ((j + 1) % radial);
      if (dir > 0) idx.push(c, a, b);
      else idx.push(c, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals(); // (a, b, d) winding is outward by construction: N × T = S
  return g;
}

/**
 * Parametric ballistic-helmet shell with real thickness (outer skin → rolled edge → inner skin)
 * and a rim height that varies with azimuth: brow at the front, high-cut over the ears, deeper
 * at the nape. φ = 0 is the front (-Z), increasing toward the character's right (+X).
 */
export function helmetShell(
  c: THREE.Vector3,
  ax: number,
  ay: number,
  az: number,
  rimY: (phi: number) => number,
  radial = 36,
  rows = 11,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  // Rows: (fraction of the rim polar angle, radial scale, drop below the rim). Outer skin from
  // the crown down, a rolled edge, then the inner skin back up (hidden, but closes the shell).
  const rowsDesc: Array<[number, number, number]> = [];
  for (let i = 0; i <= rows; i++) rowsDesc.push([Math.sqrt(i / rows) * 0.35 + (i / rows) * 0.65, 1, 0]);
  rowsDesc.push([1, 0.97, 0.005], [1, 0.92, 0.002], [0.8, 0.92, 0], [0.45, 0.92, 0], [0.02, 0.92, 0]);
  for (const [f, sc, drop] of rowsDesc) {
    for (let j = 0; j < radial; j++) {
      const phi = (j / radial) * Math.PI * 2;
      const cosMax = THREE.MathUtils.clamp((rimY(phi) - c.y) / ay, -0.6, 0.98);
      const th = Math.acos(cosMax) * Math.max(f, 0.02);
      const flare = 1 + 0.045 * f * f * f; // the edge stands slightly proud of the head
      const r = Math.sin(th) * sc * flare;
      pos.push(c.x + ax * r * Math.sin(phi), c.y + ay * Math.cos(th) * sc - drop, c.z - az * r * Math.cos(phi));
    }
  }
  for (let i = 0; i < rowsDesc.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + j1;
      const d = (i + 1) * radial + j;
      const e = (i + 1) * radial + j1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Collects parts (each with its own transform + surface) and bakes them into one indexed
 * geometry with `position`, `normal`, `albedo` (linear RGB) and `surf` (rough, metal, camo,
 * pattern) attributes — one draw call per rigid segment.
 */
export class PartSink {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly alb: number[] = [];
  private readonly srf: number[] = [];
  private readonly idx: number[] = [];
  private readonly _v = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _nm = new THREE.Matrix3();
  private readonly _c = new THREE.Color();
  private readonly _m = new THREE.Matrix4();

  /** `pre` (optional) is applied after every part transform, e.g. to drop a whole segment. */
  constructor(
    private readonly dust: THREE.Color,
    private readonly pre: THREE.Matrix4 | null = null,
  ) {}

  /**
   * Adds `geo` transformed by `m`. `dustTop` (model-space metres) fades a dust/grime layer onto
   * the part below that height — trousers and boots pick up dirt from the ground.
   */
  add(geo: THREE.BufferGeometry, part: THREE.Matrix4 | null, color: number, surf: Surface, dustTop = 0): void {
    const m = this.pre ? (part ? this._m.multiplyMatrices(this.pre, part) : this.pre) : part;
    const p = geo.getAttribute('position');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const n = geo.getAttribute('normal');
    const base = this.pos.length / 3;
    if (m) this._nm.getNormalMatrix(m);
    this._c.setHex(color); // converted to the linear working space
    for (let i = 0; i < p.count; i++) {
      this._v.set(p.getX(i), p.getY(i), p.getZ(i));
      this._n.set(n.getX(i), n.getY(i), n.getZ(i));
      if (m) {
        this._v.applyMatrix4(m);
        this._n.applyMatrix3(this._nm).normalize();
      }
      this.pos.push(this._v.x, this._v.y, this._v.z);
      this.nrm.push(this._n.x, this._n.y, this._n.z);
      let r = this._c.r;
      let g = this._c.g;
      let b = this._c.b;
      if (dustTop > 0 && this._v.y < dustTop) {
        const t = Math.min(1, (dustTop - this._v.y) / dustTop) * 0.4;
        r += (this.dust.r - r) * t;
        g += (this.dust.g - g) * t;
        b += (this.dust.b - b) * t;
      }
      this.alb.push(r, g, b);
      this.srf.push(surf.rough, surf.metal, surf.camo, surf.pattern);
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  /** Bakes everything relative to `pivot`. */
  build(pivot: THREE.Vector3): THREE.BufferGeometry {
    for (let i = 0; i < this.pos.length; i += 3) {
      this.pos[i] -= pivot.x;
      this.pos[i + 1] -= pivot.y;
      this.pos[i + 2] -= pivot.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('albedo', new THREE.Float32BufferAttribute(this.alb, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.srf, 4));
    const vcount = this.pos.length / 3;
    g.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
