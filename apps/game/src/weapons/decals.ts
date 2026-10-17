/**
 * Pooled bullet-impact decals. A fixed ring buffer of reused meshes — CLAUDE.md rule 1: no
 * per-frame allocation, dispose nothing at runtime. Oldest decal is recycled when the pool
 * wraps. Each decal is a small camera-independent quad oriented to the surface normal and
 * nudged off the surface to avoid z-fighting.
 */
import * as THREE from 'three/webgpu';

const UP = new THREE.Vector3(0, 0, 1);

/** Bullet strike: dark puncture, chipped crater ring, radial spall chips and a soft scorch. */
function makeHoleTexture(): THREE.CanvasTexture {
  const s = 128;
  const h = s / 2;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const scorch = ctx.createRadialGradient(h, h, 4, h, h, h);
  scorch.addColorStop(0, 'rgba(30,28,26,0.55)');
  scorch.addColorStop(1, 'rgba(30,28,26,0)');
  ctx.fillStyle = scorch;
  ctx.fillRect(0, 0, s, s);
  // Spall: irregular chips flaking outward from the crater.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.5;
    const r0 = 10 + Math.random() * 4;
    const r1 = 20 + Math.random() * 22;
    const w = 0.12 + Math.random() * 0.14;
    ctx.fillStyle = `rgba(${60 + Math.random() * 30},${56 + Math.random() * 26},${50 + Math.random() * 20},0.8)`;
    ctx.beginPath();
    ctx.moveTo(h + Math.cos(a - w) * r0, h + Math.sin(a - w) * r0);
    ctx.lineTo(h + Math.cos(a) * r1, h + Math.sin(a) * r1);
    ctx.lineTo(h + Math.cos(a + w) * r0, h + Math.sin(a + w) * r0);
    ctx.fill();
  }
  const crater = ctx.createRadialGradient(h, h, 2, h, h, 15);
  crater.addColorStop(0, 'rgba(6,6,7,1)');
  crater.addColorStop(0.45, 'rgba(18,17,17,0.95)');
  crater.addColorStop(1, 'rgba(70,64,58,0.7)');
  ctx.fillStyle = crater;
  ctx.beginPath();
  ctx.arc(h, h, 15, 0, Math.PI * 2);
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
    // Lit (not basic) so spall chips sit in the scene's light instead of glowing in shadow.
    const mat = new THREE.MeshStandardMaterial({
      map: makeHoleTexture(),
      roughness: 0.95,
      metalness: 0,
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
    m.scale.setScalar(0.75 + Math.random() * 0.5);
    m.visible = true;
  }
}
