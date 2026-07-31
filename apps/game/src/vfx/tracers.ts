/**
 * Pooled hitscan tracers: thin fading beams from a muzzle to an impact point. Shared by the
 * player weapon and enemy fire so shots are readable. Ring-buffer pool, no per-shot allocation.
 */
import * as THREE from 'three/webgpu';

export class Tracers {
  private readonly items: { mesh: THREE.Mesh; life: number }[] = [];
  private cursor = 0;

  private static readonly _dir = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);
  private static readonly _q = new THREE.Quaternion();

  constructor(scene: THREE.Scene, count = 32, color: THREE.ColorRepresentation = 0xffd27a) {
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
    geo.translate(0, 0.5, 0); // origin at one end → scale length outward from the muzzle
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.renderOrder = 3;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    const dir = Tracers._dir.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.multiplyScalar(1 / len);
    it.mesh.position.copy(from);
    it.mesh.quaternion.copy(Tracers._q.setFromUnitVectors(Tracers._up, dir));
    it.mesh.scale.set(1, len, 1);
    it.life = 1;
    it.mesh.visible = true;
    (it.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt / 0.05; // ~50 ms lifetime
      if (it.life <= 0) {
        it.mesh.visible = false;
        it.life = 0;
      } else {
        (it.mesh.material as THREE.MeshBasicMaterial).opacity = it.life * 0.9;
      }
    }
  }
}
