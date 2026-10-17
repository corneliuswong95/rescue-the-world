/**
 * Geometry authoring helpers for the code-built weapon + hands. Everything here runs once at
 * load time (allocation is fine); nothing is called per frame.
 *
 * Conventions (rifle-local space): x right, y up, barrel along -Z.
 *  - Side-profile parts are authored as 2D outlines in (z, y) and extruded across x.
 *  - Lengthwise parts are cross-sections in (x, y) extruded along z.
 *  - Top-view parts are outlines in (x, z) extruded along y.
 *  - Round parts are lathe profiles in (radius, z) around the bore axis (or any axis).
 *
 * Every part is normalised to the same non-indexed attribute layout — position, normal,
 * color (rgb tint × baked AO) and `mask` (edge-wear / panel mask read by the TSL materials) —
 * so a whole material batch merges into a single draw call.
 */
import * as THREE from 'three/webgpu';
import {
  mergeGeometries,
  toCreasedNormals,
} from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V2 = readonly [number, number];
/** Outline vertex with an optional fillet radius: [u, v, radius]. */
export type Corner = readonly [number, number, number?];

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// 2D outlines
// ---------------------------------------------------------------------------------------------

/**
 * Writes a closed polygon with per-corner fillets into `path` (a Shape or a hole Path).
 * Fillets are quadratic approximations of a circular arc — plenty at weapon scale.
 */
function roundedPoly<T extends THREE.Path>(path: T, pts: readonly Corner[]): T {
  const n = pts.length;
  const at = (i: number): Corner => pts[(i + n) % n];
  for (let i = 0; i < n; i++) {
    const [px, py, r = 0] = at(i);
    const [ax, ay] = at(i - 1);
    const [bx, by] = at(i + 1);
    if (r <= 0) {
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
      continue;
    }
    const la = Math.hypot(ax - px, ay - py);
    const lb = Math.hypot(bx - px, by - py);
    const ux = (ax - px) / la;
    const uy = (ay - py) / la;
    const vx = (bx - px) / lb;
    const vy = (by - py) / lb;
    const cos = THREE.MathUtils.clamp(ux * vx + uy * vy, -1, 1);
    const half = Math.acos(cos) / 2;
    const t = Math.min(r / Math.tan(half), la * 0.5, lb * 0.5);
    const sx = px + ux * t;
    const sy = py + uy * t;
    if (i === 0) path.moveTo(sx, sy);
    else path.lineTo(sx, sy);
    path.quadraticCurveTo(px, py, px + vx * t, py + vy * t);
  }
  path.closePath();
  return path;
}

export function shape(pts: readonly Corner[], holes: readonly (readonly Corner[])[] = []): THREE.Shape {
  const s = roundedPoly(new THREE.Shape(), pts);
  for (const h of holes) s.holes.push(roundedPoly(new THREE.Path(), h));
  return s;
}

/** Rounded rectangle outline centred at (cu, cv). */
export function rrect(cu: number, cv: number, w: number, h: number, r: number): Corner[] {
  const x0 = cu - w / 2;
  const x1 = cu + w / 2;
  const y0 = cv - h / 2;
  const y1 = cv + h / 2;
  return [
    [x0, y0, r],
    [x1, y0, r],
    [x1, y1, r],
    [x0, y1, r],
  ];
}

// ---------------------------------------------------------------------------------------------
// Solids
// ---------------------------------------------------------------------------------------------

export interface ExtrudeOpts {
  /** Chamfer/round size on every edge (0 = sharp). Outline stays at the authored size. */
  bevel?: number;
  bevelSegments?: number;
  curveSegments?: number;
}

/**
 * Extrudes a 2D shape symmetrically about z = 0 with total thickness `thickness`.
 * Bevel faces are flagged in the `mask` attribute (edge wear) and normals are creased so curved
 * walls shade smoothly while chamfers stay crisp.
 */
export function extrudeCentered(s: THREE.Shape, thickness: number, o: ExtrudeOpts): THREE.BufferGeometry {
  const bevel = Math.min(o.bevel ?? 0, thickness * 0.45);
  const depth = Math.max(thickness - 2 * bevel, 1e-5);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: o.bevelSegments ?? 1,
    curveSegments: o.curveSegments ?? 6,
  });
  geo.translate(0, 0, -depth / 2);
  flagEdges(geo, new THREE.Vector3(0, 0, 1), bevel > 0 ? 0.12 : 2);
  return creased(geo, 34);
}

/** Side profile in (z, y), extruded across x and centred on `x`. */
export function side(
  pts: readonly Corner[],
  width: number,
  o: ExtrudeOpts = {},
  holes: readonly (readonly Corner[])[] = [],
  x = 0,
): THREE.BufferGeometry {
  const g = extrudeCentered(shape(pts, holes), width, o);
  g.rotateY(-Math.PI / 2); // shape x → +z, extrusion → x
  g.translate(x, 0, 0);
  return g;
}

/** Cross-section in (x, y), extruded along z from z0 to z1. */
export function long(
  pts: readonly Corner[],
  z0: number,
  z1: number,
  o: ExtrudeOpts = {},
  holes: readonly (readonly Corner[])[] = [],
): THREE.BufferGeometry {
  const g = extrudeCentered(shape(pts, holes), Math.abs(z1 - z0), o);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Top-view outline in (x, z), extruded along y from y0 to y1. */
export function top(
  pts: readonly Corner[],
  y0: number,
  y1: number,
  o: ExtrudeOpts = {},
  holes: readonly (readonly Corner[])[] = [],
): THREE.BufferGeometry {
  const g = extrudeCentered(shape(pts, holes), Math.abs(y1 - y0), o);
  g.rotateX(Math.PI / 2); // shape y → +z, extrusion → -y
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

export interface LatheOpts {
  segments?: number;
  /** Darken surfaces facing the axis (bores, tube interiors) by this factor. */
  interiorAO?: number;
  phiStart?: number;
  phiLength?: number;
}

/**
 * Lathe around the bore-parallel axis. Profile points are (radius, z) and must run from the
 * rear to the front (decreasing z) along outer surfaces so faces point outward.
 */
export function lathe(profile: readonly V2[], o: LatheOpts = {}): THREE.BufferGeometry {
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, -z));
  const geo = new THREE.LatheGeometry(pts, o.segments ?? 24, o.phiStart ?? 0, o.phiLength ?? Math.PI * 2);
  geo.rotateX(-Math.PI / 2); // lathe +y → -z (so profile z maps straight through)
  const g = creased(geo, 40);
  flagEdges(g, new THREE.Vector3(0, 0, 1), 0.15);
  if (o.interiorAO !== undefined) bakeInteriorAO(g, new THREE.Vector3(), new THREE.Vector3(0, 0, 1), o.interiorAO);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Attribute bakes
// ---------------------------------------------------------------------------------------------

/**
 * toCreasedNormals hashes vertex positions at 1e-2 precision — far too coarse for millimetre
 * parts — so run it at 1000× scale (0.01 mm precision) and scale back.
 */
export function creased(geo: THREE.BufferGeometry, angleDeg: number): THREE.BufferGeometry {
  geo.scale(1000, 1000, 1000);
  const out = toCreasedNormals(geo, angleDeg * DEG);
  if (out !== geo) geo.dispose();
  out.scale(0.001, 0.001, 0.001);
  return out;
}

/**
 * Flags faces whose normal is oblique to `axis` (|n·axis| in (lo, 0.97)) — i.e. the chamfers of
 * an extrusion or the stepped shoulders of a lathe — as edges in the `mask` attribute.
 */
function flagEdges(geo: THREE.BufferGeometry, axis: THREE.Vector3, lo: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const mask = new Float32Array(pos.count);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const idx = geo.index;
  const tri = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    nrm.subVectors(c, b).cross(a.sub(b)).normalize();
    const d = Math.abs(nrm.dot(axis));
    const e = d > lo && d < 0.97 ? 1 : 0;
    if (e) mask[i0] = mask[i1] = mask[i2] = 1;
  }
  geo.setAttribute('mask', new THREE.BufferAttribute(mask, 1));
}

/** Multiplies the baked `ao` of vertices whose normal faces an axis (interiors) by `factor`. */
export function bakeInteriorAO(
  geo: THREE.BufferGeometry,
  axisPoint: THREE.Vector3,
  axisDir: THREE.Vector3,
  factor: number,
): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const ao = aoAttr(geo);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).sub(axisPoint);
    p.addScaledVector(axisDir, -p.dot(axisDir));
    n.fromBufferAttribute(nor, i);
    if (n.dot(p) < -0.25 * p.length()) ao.setX(i, ao.getX(i) * factor);
  }
}

/** Multiplies the baked `ao` of every vertex by `factor(position)` (creases, seams). */
export function bakeAO(geo: THREE.BufferGeometry, factor: (p: THREE.Vector3) => number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const ao = aoAttr(geo);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) ao.setX(i, ao.getX(i) * factor(p.fromBufferAttribute(pos, i)));
}

/** Per-vertex tint by normal direction (e.g. palm-side leather vs. back-of-hand fabric). */
export function tintByNormal(
  geo: THREE.BufferGeometry,
  dir: THREE.Vector3,
  threshold: number,
  color: THREE.Color,
  mask: number,
): void {
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const tint = tintAttr(geo);
  const m = maskAttr(geo);
  for (let i = 0; i < nor.count; i++) {
    n.fromBufferAttribute(nor, i);
    if (n.dot(dir) < threshold) continue;
    tint.setXYZ(i, color.r, color.g, color.b);
    m.setX(i, mask);
  }
}

/** Per-vertex tint for a whole part (overrides the batch colour for it). */
export function tintAll(geo: THREE.BufferGeometry, color: THREE.Color, mask: number): void {
  const tint = tintAttr(geo);
  const m = maskAttr(geo);
  for (let i = 0; i < tint.count; i++) {
    tint.setXYZ(i, color.r, color.g, color.b);
    m.setX(i, mask);
  }
}

function aoAttr(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  let a = geo.getAttribute('ao') as THREE.BufferAttribute | undefined;
  if (!a) {
    const n = geo.getAttribute('position').count;
    a = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute('ao', a);
  }
  return a;
}

function maskAttr(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  let a = geo.getAttribute('mask') as THREE.BufferAttribute | undefined;
  if (!a) {
    a = new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1);
    geo.setAttribute('mask', a);
  }
  return a;
}

/** Optional per-vertex tint override (`tint`), consumed by Batch.add instead of the part colour. */
function tintAttr(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  let a = geo.getAttribute('tint') as THREE.BufferAttribute | undefined;
  if (!a) {
    const n = geo.getAttribute('position').count;
    a = new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1), 3);
    geo.setAttribute('tint', a);
  }
  return a;
}

/** Mirror across x (left hand from right), fixing triangle winding. */
export function mirrorX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.scale(-1, 1, 1);
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute;
    const s = attr.itemSize;
    const arr = attr.array as Float32Array;
    for (let t = 0; t < attr.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------------------------

const KEEP = new Set(['position', 'normal', 'mask', 'ao', 'tint']);

/**
 * Collects parts per material and merges each material's parts into one mesh (one draw).
 */
export class Batch {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly tmp = new THREE.Color();

  /** Adds a part with a uniform tint; `mask` overrides the baked edge mask when given. */
  add(
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    mask?: number,
  ): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.clearGroups();
    for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count;

    const m = maskAttr(g);
    if (mask !== undefined) for (let i = 0; i < n; i++) m.setX(i, Math.max(m.getX(i), mask));

    const base = this.tmp.set(color);
    const ao = g.getAttribute('ao') as THREE.BufferAttribute | undefined;
    const tint = g.getAttribute('tint') as THREE.BufferAttribute | undefined;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = ao ? ao.getX(i) : 1;
      const own = tint !== undefined && tint.getX(i) >= 0;
      col[i * 3] = (own ? tint.getX(i) : base.r) * k;
      col[i * 3 + 1] = (own ? tint.getY(i) : base.g) * k;
      col[i * 3 + 2] = (own ? tint.getZ(i) : base.b) * k;
    }
    if (ao) g.deleteAttribute('ao');
    if (tint) g.deleteAttribute('tint');
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }

  /** Merges and adds one mesh per material to `parent`; returns the created meshes. */
  build(parent: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, geos] of this.parts) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      if (!merged) throw new Error('weapon batch merge failed (attribute mismatch)');
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      parent.add(mesh);
      out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}

/** Applies a placement matrix built from a position and a rotation (Euler XYZ, radians). */
export function place(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
  geo.applyMatrix4(m);
  return geo;
}
