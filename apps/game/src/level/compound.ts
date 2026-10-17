/**
 * "Foundry Yard" — the playable level: a 40 m × 40 m industrial courtyard enclosed by
 * three-storey brick factory buildings (FacadeKit), with an asphalt yard, raised concrete
 * sidewalks + curbs, two loading docks with ramps, and photoscanned CC0 cover/dressing props
 * (PolyHaven) — jersey barriers, military crates, barrels, a tarped car, dumpster, generator.
 *
 * Gameplay layout mirrors the M4 greybox (central L of cover, long low cover near the player
 * spawn, a raised vantage west and east) so AI/combat tuning carries over. Every blocker gets a
 * simple box collider + navmesh proxy (LevelColliders); visuals are merged (StaticGeometry) or
 * instanced (PropSet / FacadeKit).
 */
import * as THREE from 'three/webgpu';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { LevelMaterials } from './materials';
import { StaticGeometry } from './geometry';
import { LevelColliders } from './colliders';
import { FacadeKit, type BrickMaps } from './facade';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { float, mx_fractal_noise_float, normalMap, positionWorld, smoothstep, step, texture, uv, vec2, vec3 } from 'three/tsl';
import { PropSet, loadGlb } from './props';

export const PROP_NAMES = [
  'concrete_road_barrier',
  'concrete_road_barrier_02',
  'wooden_military_crate',
  'old_military_crate',
  'barrel_01',
  'barrel_03',
  'covered_car',
  'old_tyre',
  'exterior_aircon_unit',
  'utility_box_02',
  'metal_trash_can',
  'trashbag',
  'cardboard_box_01',
  'portable_generator',
  'propane_tank',
  'security_light',
  'water_manhole_cover',
  'metal_jerrycan_green',
  'modular_fire_escape',
] as const;

/**
 * Top of the foundry smokestack (the plume emitter sits here). 26 m tall, set back behind the
 * north block so its crown and plume sit inside a level gaze from most of the yard.
 */
export const STACK_TOP = new THREE.Vector3(-9, 26.2, -34);
/** Vertical scale from the 31 m authoring profile below to the placed stack. */
const STACK_K = STACK_TOP.y / 31.3;

/** Half-extent of the yard to the building wall planes. */
const WALL = 19.75;
const SIDEWALK_W = 2.5;
const SIDEWALK_H = 0.15;
const DOCK_H = 1.2;

export interface Level {
  /** Navmesh input geometry. */
  navMeshes: THREE.Mesh[];
}

export async function loadLevelAssets(): Promise<{ kit: THREE.Group; props: Map<string, THREE.Group> }> {
  const [kit, ...loaded] = await Promise.all([
    loadGlb('modular_factory_facade'),
    ...PROP_NAMES.map((n) => loadGlb(n)),
  ]);
  const props = new Map<string, THREE.Group>();
  PROP_NAMES.forEach((n, i) => props.set(n, loaded[i]));
  return { kit, props };
}

export function buildLevel(
  scene: THREE.Scene,
  world: RAPIER_NS.World,
  mat: LevelMaterials,
  assets: { kit: THREE.Group; props: Map<string, THREE.Group> },
): Level {
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);

  const geo = new StaticGeometry();
  const col = new LevelColliders(world);
  const props = new PropSet(assets.props, col);
  const kit = new FacadeKit(assets.kit);

  /** Visual box + matching collider. */
  const solid = (m: THREE.Material, size: [number, number, number], pos: [number, number, number], tile = 2): void => {
    geo.box(m, size, pos, 0, tile);
    col.box(size, pos);
  };

  // --- Ground: asphalt yard, raised sidewalks with concrete curbs along every building. ---
  solid(mat.asphalt, [44, 0.4, 44], [0, -0.2, 0], 3.2);
  const inner = WALL - SIDEWALK_W;
  const sw = (cx: number, cz: number, sx: number, sz: number): void =>
    solid(mat.sidewalk, [sx, SIDEWALK_H, sz], [cx, SIDEWALK_H / 2, cz], 2.4);
  sw(0, -(WALL - SIDEWALK_W / 2), 2 * WALL, SIDEWALK_W);
  sw(0, WALL - SIDEWALK_W / 2, 2 * WALL, SIDEWALK_W);
  sw(-(WALL - SIDEWALK_W / 2), 0, SIDEWALK_W, 2 * inner);
  sw(WALL - SIDEWALK_W / 2, 0, SIDEWALK_W, 2 * inner);
  const CURB: [number, number] = [0.22, SIDEWALK_H + 0.02];
  geo.box(mat.concrete, [2 * inner + CURB[0], CURB[1], CURB[0]], [0, CURB[1] / 2, -inner], 0, 1.2);
  geo.box(mat.concrete, [2 * inner + CURB[0], CURB[1], CURB[0]], [0, CURB[1] / 2, inner], 0, 1.2);
  geo.box(mat.concrete, [CURB[0], CURB[1], 2 * inner], [-inner, CURB[1] / 2, 0], 0, 1.2);
  geo.box(mat.concrete, [CURB[0], CURB[1], 2 * inner], [inner, CURB[1] / 2, 0], 0, 1.2);

  // --- Buildings: four factory facades + thick colliders behind them. ---
  const floorY = SIDEWALK_H;
  kit.facade({
    origin: [0, floorY, -WALL],
    yaw: 0,
    floors: 3,
    ground: ['doorSmall', 'tallSmall', 'tallSmall', 'garage', 'tallSmall', 'doorLarge', 'tallSmall', 'tallSmall', 'blank', 'tallSmall', 'doorPlain'],
    upper: ['tallLarge', 'tallLarge', 'tallSmall'],
  });
  kit.facade({
    origin: [0, floorY, WALL],
    yaw: Math.PI,
    floors: 3,
    ground: ['blank', 'centeredLarge', 'doorLarge', 'centeredLarge', 'centeredLarge', 'garage', 'centeredLarge', 'doorSmall', 'centeredLarge', 'blank', 'doorPlain'],
    upper: ['centeredLarge', 'centeredMedium'],
  });
  kit.facade({
    origin: [WALL, floorY, 0],
    yaw: -Math.PI / 2,
    floors: 3,
    ground: ['tallSmall', 'doorPlain', 'tallSmall', 'tallSmall', 'tallSmall', 'tallSmall', 'garage', 'tallSmall', 'tallSmall', 'doorSmall', 'blank'],
    upper: ['double', 'centeredMedium'],
  });
  kit.facade({
    origin: [-WALL, floorY, 0],
    yaw: Math.PI / 2,
    floors: 3,
    ground: ['doorSmall', 'tallSmall', 'tallSmall', 'blank', 'tallSmall', 'tallSmall', 'doorLarge', 'tallSmall', 'garage', 'tallSmall', 'blank'],
    upper: ['tallLarge', 'tallSmall'],
  });
  const BH = 12;
  col.box([2 * WALL + 2, BH, 0.5], [0, BH / 2, -WALL - 0.25]);
  col.box([2 * WALL + 2, BH, 0.5], [0, BH / 2, WALL + 0.25]);
  col.box([0.5, BH, 2 * WALL + 2], [WALL + 0.25, BH / 2, 0]);
  col.box([0.5, BH, 2 * WALL + 2], [-WALL - 0.25, BH / 2, 0]);

  // --- Loading docks (west at the W garage, east at the E garage) + ramps. ---
  // Cast-concrete body with a worn grey deck, a steel angle on every exposed lip with a faded
  // yellow safety band under it, and black rubber bumpers on the truck face.
  const CAP = 0.06;
  const dock = (x0: number, x1: number, z0: number, z1: number): void => {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    geo.box(mat.concrete, [x1 - x0, DOCK_H - CAP, z1 - z0], [cx, (DOCK_H - CAP) / 2, cz], 0, 2.2);
    geo.box(mat.sidewalk, [x1 - x0, CAP, z1 - z0], [cx, DOCK_H - CAP / 2, cz], 0, 2.4);
    col.box([x1 - x0, DOCK_H, z1 - z0], [cx, DOCK_H / 2, cz]);
  };
  /** Steel lip + safety band along a dock edge; `out` is the outward face normal (±x or ±z). */
  const lip = (a: number, b: number, at: number, axis: 'x' | 'z', out: number): void => {
    const len = Math.abs(b - a);
    const mid = (a + b) / 2;
    const angle: [number, number, number] = axis === 'x' ? [len, 0.07, 0.07] : [0.07, 0.07, len];
    const band: [number, number, number] = axis === 'x' ? [len, 0.16, 0.012] : [0.012, 0.16, len];
    const o = at + out * 0.03;
    const ob = at + out * 0.004;
    geo.box(mat.steel, angle, axis === 'x' ? [mid, DOCK_H - 0.035, o] : [o, DOCK_H - 0.035, mid], 0, 1);
    geo.box(mat.safetyPaint, band, axis === 'x' ? [mid, DOCK_H - 0.15, ob] : [ob, DOCK_H - 0.15, mid], 0, 1);
  };
  const bumper = (x: number, z: number, axis: 'x' | 'z'): void => {
    geo.box(mat.rubber, axis === 'x' ? [0.28, 0.32, 0.11] : [0.11, 0.32, 0.28], [x, 0.82, z], 0, 0.5);
  };
  dock(-WALL, -14, -14, -6);
  dock(14.5, WALL, 0, 7);
  lip(-14, -6, -14, 'z', 1); // W dock, east face
  lip(-WALL, -14, -6, 'x', 1); // W dock, south face
  lip(0, 7, 14.5, 'z', -1); // E dock, west face
  lip(14.5, WALL, 0, 'x', -1); // E dock, north face
  lip(14.5, WALL, 7, 'x', 1); // E dock, south face
  for (const z of [-12.6, -9.6, -7.4]) bumper(-13.94, z, 'z');
  for (const z of [1.1, 5.9]) bumper(14.44, z, 'z');
  ramp(geo, col, mat.concrete, [-17, 0, -2], Math.PI, 3, DOCK_H, 4); // W dock, rising north
  ramp(geo, col, mat.concrete, [10.5, 0, 3.4], Math.PI / 2, 3, DOCK_H, 4); // E dock, rising east

  // --- Central cover: an L of checker-painted (low) and jersey barriers + a crate stack. ---
  const jit = (i: number): number => Math.sin(i * 12.9898) * 0.035; // deterministic tiny misalignment
  [-6.2, -4.6, -3.0, -1.4].forEach((z, i) => props.place('concrete_road_barrier', { x: 1 + jit(i) * 2, z, yaw: Math.PI / 2 + jit(i + 7) }));
  [2.6, 4.2, 5.8].forEach((x, i) => props.place('concrete_road_barrier_02', { x, z: -7.5 + jit(i + 3) * 2, yaw: jit(i + 11) }));
  crateStack(props, -1.2, -5.6, 0.15);

  // --- Spawn cover: 1.11 m jersey barriers — taller than crouched eye height (0.95 m), so
  // crouching behind them actually hides you; standing, you can fire over them. ---
  [0.8, 2.4, 4.0, 5.6, 7.2].forEach((x, i) => props.place('concrete_road_barrier_02', { x, z: 10 + jit(i + 5) * 3, yaw: jit(i + 17) }));

  // --- Scattered cover. ---
  crateStack(props, -5.6, -3.0, -0.2);
  crateStack(props, -3.4, -9.4, 0.5);
  crateStack(props, 6.2, -13.8, -0.1);
  [0, 0.3, 0.6].forEach((y, i) => props.place('old_military_crate', { x: 7.1 + jit(i) * 2, y, z: 4.6, yaw: 0.32 + jit(i + 2) * 3 }));
  barrels(props, -2.2, 6.1);
  barrels(props, 9.6, -6.2);
  barrels(props, -9.2, 2.2);
  props.place('covered_car', { x: -9.4, z: 9.6, yaw: 0.28 });

  // Equipment corner (NE yard): generator, propane, jerrycans.
  props.place('portable_generator', { x: 12.6, z: -12.2, yaw: -0.4 });
  props.place('propane_tank', { x: 13.6, z: -11.3 });
  props.place('propane_tank', { x: 13.95, z: -11.75 });
  props.place('metal_jerrycan_green', { x: 11.8, z: -11.2, yaw: 0.9 });
  props.place('metal_jerrycan_green', { x: 11.55, z: -11.55, yaw: 1.3 });

  // --- Dressing along the building bases (on the sidewalk). ---
  const sy = SIDEWALK_H;
  props.place('metal_trash_can', { x: -6.4, y: sy, z: -WALL + 0.38 });
  props.place('trashbag', { x: -4.7, y: sy, z: -WALL + 0.45, yaw: 0.6 });
  props.place('trashbag', { x: -4.2, y: sy, z: -WALL + 0.95, yaw: 2.1 });
  props.place('cardboard_box_01', { x: 5.8, y: sy, z: -WALL + 0.35, yaw: 0.1 });
  props.place('cardboard_box_01', { x: 6.3, y: sy, z: -WALL + 0.4, yaw: -0.3 });
  props.place('cardboard_box_01', { x: 6.05, y: sy + 0.34, z: -WALL + 0.38, yaw: 0.25 });
  props.place('utility_box_02', { x: 9.2, y: sy, z: -WALL + 0.22 });
  props.place('metal_trash_can', { x: WALL - 0.38, y: sy, z: 12.5, yaw: -Math.PI / 2 });
  props.place('trashbag', { x: WALL - 0.5, y: sy, z: 14.3, yaw: 1.1 });
  props.place('utility_box_02', { x: -6, y: sy, z: WALL - 0.22, yaw: Math.PI });
  props.place('barrel_03', { x: 2.5, y: sy, z: WALL - 0.45 });
  props.place('barrel_01', { x: 3.2, y: sy, z: WALL - 0.42 });
  props.place('old_tyre', { x: -13.5, y: sy + 0.3, z: WALL - 0.2, yaw: 0.15, collide: false });
  props.place('modular_fire_escape', { x: -12, y: sy + 2.65, z: -WALL + 0.78, collide: false }); // top rail under the cornice

  // AC condensers on the sidewalk against the walls (the scan's base sits 0.32 m below its
  // origin); security lights over doors (no colliders — above head height).
  const acY = sy + 0.32;
  for (const x of [-15.5, 5.2, 12.6]) props.place('exterior_aircon_unit', { x, y: acY, z: -WALL + 0.24 });
  props.place('exterior_aircon_unit', { x: WALL - 0.24, y: acY, z: -6, yaw: -Math.PI / 2 });
  props.place('exterior_aircon_unit', { x: 8, y: acY, z: WALL - 0.24, yaw: Math.PI });
  for (const x of [-18.1, 1.7]) props.place('security_light', { x, y: 3.1, z: -WALL + 0.03, collide: false });

  // Overhead service cables strung between the buildings (one merged draw).
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  geo.cable(mat.rubber, V(-14, 8.3, -WALL + 0.05), V(-8.5, 7.7, WALL - 0.05), 1.6, 0.016);
  geo.cable(mat.rubber, V(-13.6, 8.1, -WALL + 0.05), V(-8.1, 7.5, WALL - 0.05), 1.75, 0.011);
  geo.cable(mat.rubber, V(6.5, 8.0, -WALL + 0.05), V(11.5, 8.4, WALL - 0.05), 1.4, 0.016);
  geo.cable(mat.rubber, V(-WALL + 0.05, 7.9, 9.5), V(WALL - 0.05, 8.2, 4.5), 1.9, 0.014);
  for (const [x, y, z] of [[-14, 8.3, -WALL + 0.06], [-8.5, 7.7, WALL - 0.06], [6.5, 8.0, -WALL + 0.06], [11.5, 8.4, WALL - 0.06]]) {
    geo.box(mat.steel, [0.1, 0.16, 0.12], [x, y, z], 0, 1); // wall brackets
  }

  // Ground storytelling: oil stains under the car/generator, hatched keep-clear box at the dock.
  for (const [x, z, r] of [[-9.2, 9.4, 1.4], [12.4, -12.0, 0.9], [-6.2, -WALL + 1.4, 1.1], [11.2, 3.3, 1.2]]) {
    stain(root, x, z, r);
  }
  hatch(root, mat, -14, -11.4, -13.4, -6.6);

  // Landmark: a foundry smokestack rising behind the north block.
  smokestack(root, kit.brickMaps(), mat.steel, STACK_TOP.x, STACK_TOP.z);

  // Manhole covers in the asphalt.
  props.place('water_manhole_cover', { x: 3.4, y: 0.012, z: 2.8, collide: false });
  props.place('water_manhole_cover', { x: -7.8, y: 0.012, z: -12.6, collide: false });

  for (const [name, part] of [['ground', geo], ['facades', kit], ['props', props]] as const) {
    const g = new THREE.Group();
    g.name = name;
    part.build(g);
    root.add(g);
  }
  return { navMeshes: col.navMeshes };
}

/** Ramp wedge (visual) + a pitched cuboid (collider) whose top matches the slope. */
function ramp(
  geo: StaticGeometry,
  col: LevelColliders,
  m: THREE.Material,
  base: [number, number, number],
  yaw: number,
  width: number,
  height: number,
  length: number,
): void {
  geo.wedge(m, width, height, length, base, yaw, 2.2);
  const a = Math.atan2(height, length);
  const t = 0.3; // collider slab thickness
  // Slope midpoint pushed down half a thickness along the slope normal, in the ramp frame.
  const local = new THREE.Vector3(0, height / 2 - (t / 2) * Math.cos(a), length / 2 + (t / 2) * Math.sin(a));
  local.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).add(new THREE.Vector3(...base));
  col.box([width, t, Math.hypot(height, length)], [local.x, local.y, local.z], yaw, -a);
}

/** Two wooden military crates side by side with a third on top, slightly misaligned. */
function crateStack(props: PropSet, x: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const off = 0.28; // half crate depth
  props.place('wooden_military_crate', { x: x - s * off, z: z - c * off, yaw });
  props.place('wooden_military_crate', { x: x + s * off, z: z + c * off, yaw: yaw + 0.04 });
  props.place('wooden_military_crate', { x: x + s * 0.05, y: 0.46, z: z + c * 0.05, yaw: yaw - 0.09 });
}

/** A loose cluster of three drums. */
function barrels(props: PropSet, x: number, z: number): void {
  props.place('barrel_01', { x, z, yaw: 0.4 });
  props.place('barrel_03', { x: x + 0.62, z: z + 0.18, yaw: 1.7 });
  props.place('barrel_01', { x: x + 0.24, z: z + 0.6, yaw: 2.9 });
}

const STAIN_MAT = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const d = uv().sub(0.5).length().mul(2);
  const edge = d.add(mx_fractal_noise_float(positionWorld.xz.mul(2.2), 3, 2.0, 0.5).mul(0.35));
  m.colorNode = vec3(0.025, 0.022, 0.02);
  m.roughnessNode = float(0.2); // oily sheen catches the sky
  m.metalnessNode = float(0);
  m.opacityNode = float(1).sub(smoothstep(0.3, 1.0, edge)).mul(0.78);
  return m;
})();

/** Flat oil stain decal on the asphalt (radius r). */
function stain(parent: THREE.Object3D, x: number, z: number, r: number): void {
  const g = new THREE.PlaneGeometry(2 * r, 2 * r).rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, STAIN_MAT);
  m.position.set(x, 0.004, z);
  m.rotation.y = x * 1.7 + z; // vary the noise footprint
  m.receiveShadow = true;
  parent.add(m);
}

/** Hatched yellow "keep clear" box painted on the asphalt over [x0,x1]×[z0,z1]. */
function hatch(parent: THREE.Object3D, mat: LevelMaterials, x0: number, x1: number, z0: number, z1: number): void {
  const w = x1 - x0;
  const d = z1 - z0;
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  m.colorNode = mat.safetyPaint.colorNode;
  m.roughnessNode = mat.safetyPaint.roughnessNode;
  m.metalnessNode = float(0);
  const st = uv();
  const border = float(1).sub(
    step(0.1 / w, st.x).mul(step(st.x, 1 - 0.1 / w)).mul(step(0.1 / d, st.y)).mul(step(st.y, 1 - 0.1 / d)),
  );
  const stripes = step(0.62, positionWorld.x.add(positionWorld.z).mul(1.2).fract());
  const scuffed = smoothstep(0.1, 0.55, mx_fractal_noise_float(positionWorld.xz.mul(1.6), 3, 2.0, 0.55));
  m.opacityNode = border.max(stripes).mul(float(1).sub(scuffed)).mul(0.85);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m);
  plane.position.set((x0 + x1) / 2, 0.005, (z0 + z1) / 2);
  plane.receiveShadow = true;
  parent.add(plane);
}

/** Smokestack radius at height y (matches the lathe profile below). */
const stackRadius = (y: number): number => {
  const a = y / STACK_K; // back to authoring height
  return a < 8 ? 1.75 - (0.15 * a) / 8 : 1.6 - (0.28 * (a - 8)) / 21.6;
};

/**
 * Tapered brick chimney with a corbelled, soot-blackened crown (outside the playable yard),
 * plus iron hoop bands, a service ladder and a lightning rod (one merged steel mesh).
 */
function smokestack(parent: THREE.Object3D, maps: BrickMaps, steel: THREE.Material, x: number, z: number): void {
  const parts: THREE.BufferGeometry[] = [];
  for (const y of [12, 17, 22, 27].map((h) => h * STACK_K)) {
    parts.push(new THREE.TorusGeometry(stackRadius(y) + 0.03, 0.04, 6, 48).rotateX(Math.PI / 2).translate(0, y, 0));
  }
  const rail = (sx: number): THREE.BufferGeometry => {
    const top = 29.4 * STACK_K;
    const a = new THREE.Vector3(sx, 1.4, stackRadius(1.4) + 0.14);
    const b = new THREE.Vector3(sx, top, stackRadius(top) + 0.14);
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(0.02, 0.02, len, 6);
    g.rotateX(Math.asin((b.z - a.z) / len)); // lean with the taper: +y axis → (0, dy, dz)
    return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  };
  parts.push(rail(-0.22), rail(0.22));
  for (let y = 1.6; y < 29.4 * STACK_K; y += 0.36) {
    parts.push(new THREE.BoxGeometry(0.44, 0.025, 0.025).translate(0, y, stackRadius(y) + 0.14));
  }
  parts.push(new THREE.CylinderGeometry(0.012, 0.012, 2.6, 5).translate(stackRadius(29.6 * STACK_K) - 0.1, STACK_TOP.y + 1.0, 0));
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    g.deleteAttribute('uv');
    return g;
  }));
  if (merged) {
    const iron = new THREE.Mesh(merged, steel);
    iron.position.set(x, 0, z);
    iron.rotation.y = Math.atan2(-x, -z); // local +z (ladder side) → toward the yard centre
    iron.castShadow = true;
    parent.add(iron);
  }

  // prettier-ignore
  const profile = [[1.75, 0], [1.6, 8], [1.32, 29.6], [1.5, 29.9], [1.5, 31.1], [1.18, 31.1], [1.12, 30.4]]
    .map(([r, y]) => new THREE.Vector2(r, y * STACK_K));
  const g = new THREE.LatheGeometry(profile, 40);
  const uvs = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 3.2, uvs.getY(i) * 10.4 * STACK_K); // ≈3 m brick tiles
  const tile = (t: THREE.Texture | null): THREE.Texture | null => {
    if (!t) return null;
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.needsUpdate = true;
    return c;
  };
  const m = new THREE.MeshStandardNodeMaterial();
  const map = tile(maps.map);
  const nrm = tile(maps.normalMap);
  const rough = tile(maps.roughnessMap);
  const soot = smoothstep(STACK_TOP.y * 0.72, STACK_TOP.y, positionWorld.y).mul(0.75);
  const streaks = mx_fractal_noise_float(vec2(positionWorld.x.add(positionWorld.z).mul(3), positionWorld.y.mul(0.15)), 3, 2.0, 0.5);
  const base = map ? texture(map).rgb : vec3(0.35, 0.18, 0.12);
  m.colorNode = base.mul(float(1).sub(soot.mul(streaks.mul(0.3).add(0.85)))).mul(0.92);
  if (nrm) m.normalNode = normalMap(texture(nrm));
  m.roughnessNode = rough ? texture(rough).g : float(0.85);
  m.metalnessNode = float(0);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, 0, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
}
