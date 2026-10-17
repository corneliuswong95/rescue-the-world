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
import { FacadeKit } from './facade';
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
  'street_lamp_01',
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
  const dock = (x0: number, x1: number, z0: number, z1: number): void =>
    solid(mat.concrete, [x1 - x0, DOCK_H, z1 - z0], [(x0 + x1) / 2, DOCK_H / 2, (z0 + z1) / 2], 2.2);
  dock(-WALL, -14, -14, -6);
  dock(14.5, WALL, 0, 7);
  ramp(geo, col, mat.concrete, [-17, 0, -2], Math.PI, 3, DOCK_H, 4); // W dock, rising north
  ramp(geo, col, mat.concrete, [10.5, 0, 3.4], Math.PI / 2, 3, DOCK_H, 4); // E dock, rising east
  for (const z of [-12.5, -9.5, -7.5]) props.place('old_tyre', { x: -13.92, y: 0.62, z, yaw: Math.PI / 2, collide: false });
  for (const z of [1.2, 5.8]) props.place('old_tyre', { x: 14.42, y: 0.62, z, yaw: Math.PI / 2, collide: false });

  // --- Central cover: an L of jersey barriers + a crate stack. ---
  const jit = (i: number): number => Math.sin(i * 12.9898) * 0.035; // deterministic tiny misalignment
  [-6.2, -4.6, -3.0, -1.4].forEach((z, i) => props.place('concrete_road_barrier_02', { x: 1 + jit(i) * 2, z, yaw: Math.PI / 2 + jit(i + 7) }));
  [2.6, 4.2, 5.8].forEach((x, i) => props.place('concrete_road_barrier_02', { x, z: -7.5 + jit(i + 3) * 2, yaw: jit(i + 11) }));
  crateStack(props, -1.2, -5.6, 0.15);

  // --- Long low cover near the player spawn: checker-painted road barriers. ---
  [0.8, 2.4, 4.0, 5.6, 7.2].forEach((x, i) => props.place('concrete_road_barrier', { x, z: 10 + jit(i + 5) * 3, yaw: jit(i + 17) }));

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
  props.place('street_lamp_01', { x: -WALL + 0.3, y: sy, z: 8, yaw: Math.PI / 2 });
  props.place('street_lamp_01', { x: WALL - 0.3, y: sy, z: -10, yaw: -Math.PI / 2 });
  props.place('modular_fire_escape', { x: -12, y: sy + 3.65, z: -WALL + 0.78, collide: false });

  // Wall-mounted: AC units over the ground floor, security lights over doors (no colliders —
  // above head height).
  for (const x of [-15.5, 2.2, 12.6]) props.place('exterior_aircon_unit', { x, y: 3.9, z: -WALL + 0.22, collide: false });
  props.place('exterior_aircon_unit', { x: WALL - 0.22, y: 3.9, z: -6, yaw: -Math.PI / 2, collide: false });
  props.place('exterior_aircon_unit', { x: 8, y: 3.9, z: WALL - 0.22, yaw: Math.PI, collide: false });
  for (const x of [-18.1, 1.7]) props.place('security_light', { x, y: 3.1, z: -WALL + 0.03, collide: false });

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
