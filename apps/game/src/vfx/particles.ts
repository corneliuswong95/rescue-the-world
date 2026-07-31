/**
 * Pooled GPU particle bursts in a single `Points` draw call. One fixed buffer of N points;
 * bursts activate a slice, integrate cheap ballistic motion on the CPU, and fade via
 * per-vertex colour (additive → colour 0 reads as invisible). No per-frame allocation.
 * Used for blood and impact sparks in M2; a fuller VFX pass (subsystem #7) comes in M3.
 */
import * as THREE from 'three/webgpu';

export class ParticleBursts {
  private readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly col: Float32Array; // current (faded) colour uploaded to the GPU
  private readonly baseCol: Float32Array; // colour at full brightness
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private cursor = 0;
  private readonly n: number;

  private readonly _c = new THREE.Color();

  constructor(scene: THREE.Scene, count = 512) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.baseCol = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.09,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  /**
   * Emit `n` particles from `origin`, biased along `dir`, with the given colour and speed.
   */
  burst(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    n: number,
    color: THREE.ColorRepresentation,
    speed: number,
    spread: number,
    life: number,
  ): void {
    this._c.set(color);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      const i3 = i * 3;
      this.pos[i3] = origin.x;
      this.pos[i3 + 1] = origin.y;
      this.pos[i3 + 2] = origin.z;
      this.vel[i3] = (dir.x + (Math.random() - 0.5) * spread) * speed;
      this.vel[i3 + 1] = (dir.y + (Math.random() - 0.5) * spread) * speed + speed * 0.3;
      this.vel[i3 + 2] = (dir.z + (Math.random() - 0.5) * spread) * speed;
      this.baseCol[i3] = this.col[i3] = this._c.r;
      this.baseCol[i3 + 1] = this.col[i3 + 1] = this._c.g;
      this.baseCol[i3 + 2] = this.col[i3 + 2] = this._c.b;
      const l = life * (0.7 + Math.random() * 0.6);
      this.life[i] = l;
      this.maxLife[i] = l;
    }
  }

  update(dt: number): void {
    let anyAlive = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      anyAlive = true;
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0;
        continue;
      }
      this.vel[i3 + 1] -= 9.8 * dt; // gravity
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      // Brightness tracks remaining life (additive blend → fades to invisible).
      const f = this.life[i] / this.maxLife[i];
      this.col[i3] = this.baseCol[i3] * f;
      this.col[i3 + 1] = this.baseCol[i3 + 1] * f;
      this.col[i3 + 2] = this.baseCol[i3 + 2] * f;
    }
    if (anyAlive) {
      const geo = this.points.geometry;
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
