/**
 * Pooled blood pools under corpses: one InstancedMesh (≤1 draw for all of them), each pool
 * growing from 0 to ~0.6 m over 3 s with an irregular, world-space-noise edge so no two match.
 * Glossy dark red, depth-write off and lifted a hair above the floor (no z-fighting).
 * Allocation-free after construction.
 */
import * as THREE from 'three/webgpu';
import { float, length, mx_noise_float, positionWorld, smoothstep, uv, vec2, vec3 } from 'three/tsl';

const MAX = 8;
const GROW_T = 3; // s
const SIZE = 0.74; // m, final quad size: the visible pool reaches ~0.6–0.65 m (noisy edge)

export class BloodPools {
  private readonly mesh: THREE.InstancedMesh;
  private readonly age = new Float32Array(MAX).fill(-1); // < 0 = free
  private readonly px = new Float32Array(MAX);
  private readonly py = new Float32Array(MAX);
  private readonly pz = new Float32Array(MAX);
  private readonly rot = new Float32Array(MAX);
  private next = 0;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _y = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(vec2(0.5, 0.5))).mul(2); // 0 centre … 1 edge
    const edge = mx_noise_float(positionWorld.mul(9)).mul(0.13).add(mx_noise_float(positionWorld.mul(23)).mul(0.05));
    mat.opacityNode = float(1).sub(smoothstep(0.8, 0.88, r.add(edge))).mul(0.92);
    mat.colorNode = vec3(0.07, 0.004, 0.004).mul(float(1).sub(r.mul(0.35)));
    mat.roughnessNode = float(0.12).add(r.mul(0.15));
    mat.metalnessNode = float(0);
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false; // instances are spread over the level
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.clear();
    scene.add(this.mesh);
  }

  /** Start a pool at `p` (on the floor). Recycles the oldest when all are in use. */
  spawn(p: THREE.Vector3): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.age[i] = 0;
    this.px[i] = p.x;
    this.py[i] = p.y + 0.008;
    this.pz[i] = p.z;
    this.rot[i] = Math.random() * Math.PI * 2;
  }

  update(dt: number): void {
    let visible = false;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] < 0) continue;
      visible = true;
      if (this.age[i] >= GROW_T) continue; // fully grown: matrix already final
      this.age[i] = Math.min(GROW_T, this.age[i] + dt);
      const k = 1 - Math.pow(1 - this.age[i] / GROW_T, 2.2); // fast start, slow spread
      this._q.setFromAxisAngle(this._y, this.rot[i]);
      this._p.set(this.px[i], this.py[i], this.pz[i]);
      const d = Math.max(1e-3, SIZE * k);
      this._s.set(d, 1, d * 0.85);
      this.mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this.mesh.visible = visible;
  }

  /** Remove every pool (round reset). */
  clear(): void {
    this._s.set(0, 0, 0);
    this._m.compose(this._p.set(0, -100, 0), this._q.identity(), this._s);
    for (let i = 0; i < MAX; i++) {
      this.age[i] = -1;
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
    this.next = 0;
  }
}
