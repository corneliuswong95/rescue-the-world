/**
 * Pooled bullet-impact decals. A fixed ring buffer of reused meshes — CLAUDE.md rule 1: no
 * per-frame allocation, dispose nothing at runtime. Oldest decal is recycled when the pool
 * wraps. Each decal is a small camera-independent quad oriented to the surface normal and
 * nudged off the surface to avoid z-fighting.
 */
import * as THREE from 'three/webgpu';

const UP = new THREE.Vector3(0, 0, 1);

function makeHoleTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(10,10,12,1)');
  g.addColorStop(0.55, 'rgba(20,20,24,0.85)');
  g.addColorStop(0.8, 'rgba(40,40,46,0.35)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DecalPool {
  private readonly meshes: THREE.Mesh[] = [];
  private cursor = 0;
  private readonly q = new THREE.Quaternion();
  private readonly n = new THREE.Vector3();

  constructor(scene: THREE.Scene, size = 96, quadSize = 0.16) {
    const geo = new THREE.PlaneGeometry(quadSize, quadSize);
    const mat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    for (let i = 0; i < size; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.meshes.push(m);
    }
  }

  /** Place the next decal at a world hit point, oriented to the surface normal. */
  spawn(point: THREE.Vector3, normal: THREE.Vector3): void {
    const m = this.meshes[this.cursor];
    this.cursor = (this.cursor + 1) % this.meshes.length;

    this.n.copy(normal).normalize();
    this.q.setFromUnitVectors(UP, this.n);
    m.quaternion.copy(this.q);
    // Nudge slightly off the surface along the normal, plus a tiny random spin for variety.
    m.position.copy(point).addScaledVector(this.n, 0.012);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.visible = true;
  }
}
