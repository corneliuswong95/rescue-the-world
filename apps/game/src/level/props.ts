/**
 * Photoscanned/authored CC0 props (PolyHaven — see CREDITS.md), shipped as meshopt-compressed
 * .glb with WebP textures (built offline by tools/assets). Loaded once, then drawn with GPU
 * instancing: every placement of the same prop shares one InstancedMesh per mesh part, so ten
 * jersey barriers cost the same draw calls as one.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { LevelColliders } from './colliders';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export async function loadGlb(name: string): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(`/assets/models/${name}.glb`);
  const root = gltf.scene as unknown as THREE.Group;
  root.updateMatrixWorld(true);
  return root;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Vector3();
const _size = new THREE.Vector3();

/**
 * Collects (source, sourceSceneToWorld) placements and emits one InstancedMesh per mesh under
 * each source. `sourceSceneToWorld` maps the source glTF's *scene* space to world space, so
 * meshes keep their authored offsets inside the asset.
 */
export class InstanceBatch {
  private readonly placements = new Map<THREE.Object3D, THREE.Matrix4[]>();

  add(source: THREE.Object3D, sceneToWorld: THREE.Matrix4): void {
    const list = this.placements.get(source) ?? [];
    list.push(sceneToWorld.clone());
    this.placements.set(source, list);
  }

  build(parent: THREE.Object3D, castShadow = true): void {
    for (const [source, mats] of this.placements) {
      source.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, mats.length);
        for (let i = 0; i < mats.length; i++) {
          inst.setMatrixAt(i, _m.multiplyMatrices(mats[i], mesh.matrixWorld));
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.castShadow = castShadow;
        inst.receiveShadow = true;
        parent.add(inst);
      });
    }
    this.placements.clear();
  }
}

export interface PropPlacement {
  x: number;
  z: number;
  y?: number;
  yaw?: number;
  scale?: number;
  /** Add a box collider from the prop's bounds (default true). */
  collide?: boolean;
  /** Include the collider in navmesh generation (default = collide). */
  walkable?: boolean;
}

/** Named prop library + placement → instancing + bounds colliders. */
export class PropSet {
  private readonly batch = new InstanceBatch();
  private readonly bounds = new Map<string, THREE.Box3>();

  constructor(
    private readonly assets: ReadonlyMap<string, THREE.Group>,
    private readonly colliders: LevelColliders,
  ) {}

  /** Bounds of a prop in its own (unplaced) space. */
  boundsOf(name: string): THREE.Box3 {
    let b = this.bounds.get(name);
    if (!b) {
      b = new THREE.Box3().setFromObject(this.asset(name));
      this.bounds.set(name, b);
    }
    return b;
  }

  place(name: string, p: PropPlacement): void {
    const yaw = p.yaw ?? 0;
    const s = p.scale ?? 1;
    const y = p.y ?? 0;
    _q.setFromEuler(_e.set(0, yaw, 0));
    _m.compose(_p.set(p.x, y, p.z), _q, _s.set(s, s, s));
    this.batch.add(this.asset(name), _m);

    if (p.collide ?? true) {
      const b = this.boundsOf(name);
      b.getCenter(_c).multiplyScalar(s).applyQuaternion(_q).add(_p);
      b.getSize(_size).multiplyScalar(s);
      this.colliders.box([_size.x, _size.y, _size.z], [_c.x, _c.y, _c.z], yaw, 0, p.walkable ?? true);
    }
  }

  build(parent: THREE.Object3D): void {
    this.batch.build(parent);
  }

  private asset(name: string): THREE.Group {
    const a = this.assets.get(name);
    if (!a) throw new Error(`prop not loaded: ${name}`);
    return a;
  }
}
