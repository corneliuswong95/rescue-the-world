/**
 * Static level geometry with world-scaled UVs, merged per material.
 *
 * Every face gets UVs in metres / `tile`, so a 40 m slab and a 0.3 m curb show the same texel
 * density (no stretched textures), with a random per-piece offset so neighbouring pieces don't
 * repeat in lock-step. Pieces are baked into world space and merged into one mesh per material
 * at `build()` — the whole code-built level costs one draw call per material.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Box (size in metres) whose UVs are world-scaled per face. */
function worldUvBox(sx: number, sy: number, sz: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each). u/v span per face:
  const spans: [number, number][] = [
    [sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy],
  ];
  const ou = Math.random();
  const ov = Math.random();
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * su) / tile + ou, (uv.getY(i) * sv) / tile + ov);
    }
  }
  return g;
}

/**
 * Ramp wedge: a right-triangle prism rising along +z from y=0 (z=0) to y=height (z=length),
 * width along x, centred on x. World-scaled UVs on the slope, sides and back.
 */
function worldUvWedge(width: number, height: number, length: number, tile: number): THREE.BufferGeometry {
  const hw = width / 2;
  const slope = Math.hypot(height, length);
  // prettier-ignore
  const pos = [
    // slope (normal up/back)
    -hw, 0, 0,   hw, 0, 0,   hw, height, length,   -hw, height, length,
    // back face (z = length, facing +z)
    -hw, 0, length,   -hw, height, length,   hw, height, length,   hw, 0, length,
    // left side (x = -hw)
    -hw, 0, 0,   -hw, height, length,   -hw, 0, length,
    // right side (x = +hw)
    hw, 0, 0,   hw, 0, length,   hw, height, length,
  ];
  // prettier-ignore
  const uv = [
    0, 0,   width, 0,   width, slope,   0, slope,
    0, 0,   0, height,   width, height,   width, 0,
    0, 0,   length, height,   length, 0,
    0, 0,   length, 0,   length, height,
  ].map((v) => v / tile);
  const index = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12]; // CCW outward
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export class StaticGeometry {
  private readonly pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** Axis-aligned (optionally Y-rotated) box; `pos` is the box centre. */
  box(
    material: THREE.Material,
    size: [number, number, number],
    pos: [number, number, number],
    yaw = 0,
    tile = 2,
  ): void {
    const g = worldUvBox(size[0], size[1], size[2], tile);
    this.push(material, g, pos, yaw);
  }

  /** Ramp wedge; `base` is the centre of its low front edge, rising toward local +z. */
  wedge(
    material: THREE.Material,
    width: number,
    height: number,
    length: number,
    base: [number, number, number],
    yaw = 0,
    tile = 2,
  ): void {
    this.push(material, worldUvWedge(width, height, length, tile), base, yaw);
  }

  /** Hanging cable between two world points with a parabolic sag (m) at mid-span. */
  cable(material: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, sag: number, radius = 0.014): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)));
    }
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, radius, 5, false);
    this.push(material, g, [0, 0, 0], 0);
  }

  private push(material: THREE.Material, g: THREE.BufferGeometry, pos: [number, number, number], yaw: number): void {
    _q.setFromEuler(_e.set(0, yaw, 0));
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s);
    g.applyMatrix4(_m);
    const list = this.pieces.get(material) ?? [];
    list.push(g.index ? g.toNonIndexed() : g);
    if (g.index) g.dispose();
    this.pieces.set(material, list);
  }

  /** Merge into one shadow-casting mesh per material and add them to `parent`. */
  build(parent: THREE.Object3D): void {
    for (const [material, list] of this.pieces) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.pieces.clear();
  }
}
