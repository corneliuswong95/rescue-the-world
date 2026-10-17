/**
 * Industrial brick buildings assembled from PolyHaven's CC0 "Modular Factory Facade" kit.
 *
 * The kit ships as a sheet of named 3 m × 3 m bays (brick wall with openings), separate window
 * and door inserts sharing each bay's centre, brick piers, and trim rows (dado, band course,
 * cornice, crown) laid out at integer heights. A module's *anchor* is (bbox centre x, row
 * base y, wall plane z = 0); inserts reuse their bay's anchor so they land in the opening.
 *
 * A facade is a run of piers and bays along local +x, facing local +z, stacked `floors` high,
 * capped with cornice + crown. Everything is instanced through one InstanceBatch, so a whole
 * courtyard of buildings costs roughly one draw call per kit mesh used.
 */
import * as THREE from 'three/webgpu';
import { InstanceBatch } from './props';

const BAY = 3;
const PIER = 0.3;
const FLOOR = 3;

/** A bay type: wall module + inserts that share its anchor + the trim at its foot. */
interface BayKind {
  wall: string;
  inserts: string[];
  dado: string;
  /** Width in metres (6 for the double garage, which spans two bays). */
  width: number;
}

const kind = (wall: string, inserts: string[], dado: string, width = BAY): BayKind => ({ wall, inserts, dado, width });

export const BAYS = {
  blank: kind('wall_standard_standard_01', [], 'dado_standard_standard_01'),
  doorLarge: kind('wall_door_recessed_large_01', ['door_recessed_large_01'], 'dado_door_recessed_large_01'),
  doorSmall: kind('wall_door_recessed_small_01', ['door_recessed_small_01'], 'dado_door_recessed_small_01'),
  doorPlain: kind('wall_door_centered_small_01', ['door_centered_small_01'], 'dado_door_centered_small_01'),
  garage: kind('wall_door_garage_centered_01', ['door_garage_centered_01'], 'dado_garage_centered_01', 2 * BAY),
  tallLarge: kind('wall_window_tall_large_01', ['window_tall_large_01'], 'dado_standard_standard_01'),
  tallSmall: kind('wall_window_tall_small_01', ['window_tall_small_01'], 'dado_standard_standard_01'),
  centeredLarge: kind('wall_window_centered_large_01', ['window_centered_large_01'], 'dado_standard_standard_01'),
  centeredMedium: kind('wall_window_centered_medium_02', ['window_centered_medium_02'], 'dado_standard_standard_01'),
  double: kind('wall_window_centered_double_01', ['window_centered_double_01'], 'dado_standard_standard_01'),
} as const satisfies Record<string, BayKind>;

export type BayName = keyof typeof BAYS;

export interface FacadeSpec {
  /** World position of the facade's centre at the wall plane, ground level. */
  origin: [number, number, number];
  /** Rotation about +Y; 0 faces +z. */
  yaw: number;
  floors: number;
  /** Ground-floor bays, left → right (a garage consumes two bay slots of the floors above). */
  ground: BayName[];
  /** Upper-floor bay kinds, cycled across the bays of every upper floor. */
  upper: BayName[];
}

export class FacadeKit {
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly anchors = new Map<string, THREE.Vector3>();
  private readonly batch = new InstanceBatch();

  private readonly _m = new THREE.Matrix4();
  private readonly _t = new THREE.Matrix4();
  private readonly _r = new THREE.Matrix4();
  private readonly _s = new THREE.Matrix4();

  constructor(kitScene: THREE.Object3D) {
    kitScene.updateMatrixWorld(true);
    kitScene.traverse((o) => {
      if (o.name && !this.nodes.has(o.name)) this.nodes.set(o.name, o);
    });
    this.retintGlass(kitScene);
  }

  /** Old factory glass: opaque, dark interior, grimy specular — there are no interiors behind. */
  private retintGlass(kitScene: THREE.Object3D): void {
    const glass = new THREE.MeshStandardMaterial({ color: 0x20262b, roughness: 0.18, metalness: 0.0 });
    kitScene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.name.includes('glass')) mesh.material = glass;
    });
  }

  private node(name: string): THREE.Object3D {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`facade kit module missing: ${name}`);
    return n;
  }

  private anchor(name: string): THREE.Vector3 {
    let a = this.anchors.get(name);
    if (!a) {
      const b = new THREE.Box3().setFromObject(this.node(name));
      a = new THREE.Vector3((b.min.x + b.max.x) / 2, Math.round(b.min.y), 0);
      this.anchors.set(name, a);
    }
    return a;
  }

  /**
   * Place kit module `name` with its anchor at local (x, y) of the facade frame `frame`,
   * optionally stretched along x. `anchorOf` lets inserts borrow their bay's anchor.
   */
  private put(frame: THREE.Matrix4, name: string, x: number, y: number, sx = 1, anchorOf = name): void {
    const a = this.anchor(anchorOf);
    this._t.makeTranslation(x, y, 0);
    this._s.makeScale(sx, 1, 1);
    this._r.makeTranslation(-a.x, -a.y, -a.z);
    this._m.multiplyMatrices(frame, this._t).multiply(this._s).multiply(this._r);
    this.batch.add(this.node(name), this._m);
  }

  facade(spec: FacadeSpec): void {
    const frame = new THREE.Matrix4().compose(
      new THREE.Vector3(...spec.origin),
      new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, spec.yaw),
      new THREE.Vector3(1, 1, 1),
    );

    // Lay out ground-floor bays with piers between; a garage spans two upper bays plus the
    // pier between them, so it is stretched to 2·BAY + PIER to keep piers vertically aligned.
    const slots: { x: number; kind: BayKind; span: number }[] = [];
    let total = PIER;
    for (const b of spec.ground) total += BAYS[b].width + (BAYS[b].width > BAY ? PIER : 0) + PIER;
    let x = -total / 2 + PIER;
    const piers: number[] = [x - PIER / 2];
    for (const name of spec.ground) {
      const k = BAYS[name];
      const span = k.width > BAY ? 2 * BAY + PIER : BAY;
      slots.push({ x: x + span / 2, kind: k, span });
      x += span + PIER;
      piers.push(x - PIER / 2);
    }
    const upperBays: number[] = [];
    const upperPiers: number[] = []; // over the middle of each garage
    for (const s of slots) {
      if (s.span > BAY) {
        upperBays.push(s.x - (BAY + PIER) / 2, s.x + (BAY + PIER) / 2);
        upperPiers.push(s.x);
      } else upperBays.push(s.x);
    }

    // Ground floor.
    for (const s of slots) {
      const sx = s.span / s.kind.width;
      this.put(frame, s.kind.wall, s.x, 0, sx);
      for (const ins of s.kind.inserts) this.put(frame, ins, s.x, 0, sx, s.kind.wall);
      this.put(frame, s.kind.dado, s.x, 0, sx);
    }
    // Upper floors: one window type per column, like a real elevation.
    for (let f = 1; f < spec.floors; f++) {
      upperBays.forEach((bx, i) => {
        const k = BAYS[spec.upper[i % spec.upper.length]];
        this.put(frame, k.wall, bx, f * FLOOR);
        for (const ins of k.inserts) this.put(frame, ins, bx, f * FLOOR, 1, k.wall);
      });
    }
    // Piers on every floor (pedestal at the foot); garage mid-piers start at the first floor.
    const top = spec.floors * FLOOR;
    for (const px of piers) {
      for (let f = 0; f < spec.floors; f++) this.put(frame, 'wall_pier_standard_01', px, f * FLOOR);
      this.put(frame, 'dado_pier_pedestal_01', px, 0);
    }
    for (const px of upperPiers) {
      for (let f = 1; f < spec.floors; f++) this.put(frame, 'wall_pier_standard_01', px, f * FLOOR);
    }
    for (const px of [...piers, ...upperPiers]) {
      this.put(frame, 'cornice01_pier_standard_01', px, top);
      this.put(frame, 'crown_pier_pedestal_01', px, top + 0.15);
    }
    // Band courses between floors, cornice + crown on top (3 m segments over every bay).
    for (const bx of upperBays) {
      for (let f = 1; f < spec.floors; f++) this.put(frame, 'cornice03_standard_standard_01', bx, f * FLOOR - 0.02);
      this.put(frame, 'cornice01_standard_standard_01', bx, top);
      this.put(frame, 'crown_standard_standard_01', bx, top + 0.15);
    }
  }

  build(parent: THREE.Object3D): void {
    this.batch.build(parent);
  }
}
