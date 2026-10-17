/**
 * Pooled impact/muzzle particles as instanced camera-facing billboards (SpriteNodeMaterial +
 * per-instance position / size / colour). Unlike `Points`, sprites have a real world-space size
 * on both the WebGPU and WebGL2 backends.
 *
 * Two pools, one draw call each:
 *   - additive: sparks (small, HDR-hot so bloom catches them, ballistic)
 *   - alpha:    dust puffs, muzzle smoke, blood mist + droplets (soft, grow, drift, fade)
 * CPU integration over fixed typed arrays — zero per-frame allocation (CLAUDE.md rule 1).
 */
import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute, texture, uv, vec4 } from 'three/tsl';

interface Spawn {
  speed: number;
  spread: number;
  life: number;
  size0: number;
  size1: number;
  gravity: number;
  drag: number;
  alpha: number;
}

function canvas(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  draw(ctx);
  return new THREE.CanvasTexture(c);
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.5, `rgba(255,255,255,${a * 0.5})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
}

/** Hot round core for sparks. */
const softDisc = (): THREE.CanvasTexture => canvas((ctx) => blob(ctx, 32, 32, 32, 1));

/** Lumpy, uneven puff (overlapping soft blobs) — reads as dust/smoke, not a perfect orb. */
const puff = (): THREE.CanvasTexture =>
  canvas((ctx) => {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const d = 6 + (i % 3) * 4;
      blob(ctx, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 13 + (i % 4) * 3, 0.32);
    }
    blob(ctx, 32, 32, 18, 0.4);
  });

class Pool {
  readonly sprite: THREE.Sprite;
  private readonly pos: Float32Array;
  private readonly rgba: Float32Array;
  private readonly size: Float32Array;
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly rgbaAttr: THREE.InstancedBufferAttribute;
  private readonly sizeAttr: THREE.InstancedBufferAttribute;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private cursor = 0;

  constructor(
    scene: THREE.Scene,
    private readonly n: number,
    additive: boolean,
    map: THREE.Texture,
  ) {
    this.pos = new Float32Array(n * 3);
    this.rgba = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.rgbaAttr = new THREE.InstancedBufferAttribute(this.rgba, 4);
    this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 1);
    for (const a of [this.posAttr, this.rgbaAttr, this.sizeAttr]) a.setUsage(THREE.DynamicDrawUsage);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.drag = new Float32Array(n);

    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const c = instancedDynamicBufferAttribute(this.rgbaAttr, 'vec4') as THREE.Node<'vec4'>; // typed as Node<string>
    const t = texture(map, uv());
    mat.positionNode = instancedDynamicBufferAttribute(this.posAttr, 'vec3');
    mat.scaleNode = instancedDynamicBufferAttribute(this.sizeAttr, 'float');
    mat.colorNode = vec4(c.rgb, 1);
    mat.opacityNode = t.a.mul(c.a);
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = n;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = additive ? 3 : 2;
    scene.add(this.sprite);
  }

  emit(origin: THREE.Vector3, dir: THREE.Vector3, count: number, color: THREE.Color, hdr: number, s: Spawn): void {
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      const i3 = i * 3;
      this.pos[i3] = origin.x;
      this.pos[i3 + 1] = origin.y;
      this.pos[i3 + 2] = origin.z;
      const v = s.speed * (0.5 + Math.random() * 0.8);
      this.vel[i3] = (dir.x + (Math.random() - 0.5) * s.spread) * v;
      this.vel[i3 + 1] = (dir.y + (Math.random() - 0.5) * s.spread) * v;
      this.vel[i3 + 2] = (dir.z + (Math.random() - 0.5) * s.spread) * v;
      const i4 = i * 4;
      const shade = 0.85 + Math.random() * 0.3;
      this.rgba[i4] = color.r * hdr * shade;
      this.rgba[i4 + 1] = color.g * hdr * shade;
      this.rgba[i4 + 2] = color.b * hdr * shade;
      const l = s.life * (0.7 + Math.random() * 0.6);
      this.life[i] = this.maxLife[i] = l;
      this.size0[i] = s.size0 * (0.75 + Math.random() * 0.5);
      this.size1[i] = s.size1 * (0.75 + Math.random() * 0.5);
      this.alpha0[i] = s.alpha;
      this.gravity[i] = s.gravity;
      this.drag[i] = s.drag;
    }
  }

  clear(): void {
    this.life.fill(0);
    this.rgba.fill(0);
    this.size.fill(0);
    this.posAttr.needsUpdate = this.rgbaAttr.needsUpdate = this.sizeAttr.needsUpdate = true;
  }

  update(dt: number): void {
    let alive = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      const i4 = i * 4;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.rgba[i4 + 3] = 0;
        this.size[i] = 0;
        alive = true;
        continue;
      }
      alive = true;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.gravity[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1 over life
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      this.rgba[i4 + 3] = this.alpha0[i] * (1 - t) * (1 - t);
    }
    if (alive) {
      this.posAttr.needsUpdate = true;
      this.rgbaAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
  }
}

const SPARK: Spawn = { speed: 7, spread: 1.3, life: 0.22, size0: 0.035, size1: 0.012, gravity: 9.8, drag: 1.5, alpha: 1 };
const CHIP: Spawn = { speed: 3.2, spread: 1.4, life: 0.5, size0: 0.03, size1: 0.025, gravity: 9.8, drag: 0.6, alpha: 1 };
const DUST: Spawn = { speed: 0.9, spread: 1.1, life: 1.1, size0: 0.12, size1: 0.75, gravity: -0.15, drag: 2.2, alpha: 0.38 };
const MIST: Spawn = { speed: 1.4, spread: 0.9, life: 0.38, size0: 0.08, size1: 0.42, gravity: 0.4, drag: 3.5, alpha: 0.75 };
const DROPS: Spawn = { speed: 3.4, spread: 0.8, life: 0.45, size0: 0.022, size1: 0.018, gravity: 9.8, drag: 0.4, alpha: 0.95 };
const KICK: Spawn = { speed: 2.2, spread: 0.7, life: 0.9, size0: 0.15, size1: 0.6, gravity: 2.5, drag: 1.8, alpha: 0.5 };
const PLUME: Spawn = { speed: 0.7, spread: 0.35, life: 11, size0: 1.4, size1: 7.5, gravity: -0.12, drag: 0.08, alpha: 0.2 };
const SMOKE: Spawn = { speed: 0.5, spread: 0.6, life: 0.9, size0: 0.05, size1: 0.32, gravity: -0.25, drag: 2.5, alpha: 0.18 };

const SPARK_COL = new THREE.Color(1.0, 0.62, 0.25);
const DUST_COL = new THREE.Color(0.34, 0.32, 0.29); // unlit: keep it below lit-concrete brightness
const CHIP_COL = new THREE.Color(0.26, 0.24, 0.22);
const BLOOD_COL = new THREE.Color(0.28, 0.02, 0.02);
const SMOKE_COL = new THREE.Color(0.62, 0.62, 0.6);
const PLUME_COL = new THREE.Color(0.55, 0.55, 0.56);

export class ParticleFx {
  private readonly hot: Pool;
  private readonly soft: Pool;
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _d = new THREE.Vector3();

  constructor(scene: THREE.Scene, hotCount = 256, softCount = 384) {
    this.hot = new Pool(scene, hotCount, true, softDisc());
    this.soft = new Pool(scene, softCount, false, puff());
  }

  /** Bullet into a hard surface: sparks + dark chips + a dust puff off the surface. */
  surfaceImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.hot.emit(point, normal, 6, SPARK_COL, 6, SPARK);
    this.soft.emit(point, normal, 5, CHIP_COL, 1, CHIP);
    this._d.copy(normal).multiplyScalar(0.6).add(this._up).normalize();
    this.soft.emit(point, this._d, 7, DUST_COL, 1, DUST);
    // Floor hits throw a visible dirt kick (otherwise strikes on dark asphalt vanish at range).
    if (normal.y > 0.7) this.soft.emit(point, this._up, 5, DUST_COL, 1, KICK);
  }

  /** Pre-simulate `seconds` of plume (after clear()) so it's already streaming. */
  warmPlume(top: THREE.Vector3, seconds: number): void {
    for (let t = 0; t < seconds; t += 0.35) {
      this.plume(top);
      this.update(0.35);
    }
  }

  /** One puff of the smokestack plume (call every ~0.35 s; drifts downwind and swells). */
  plume(top: THREE.Vector3): void {
    this._d.set(0.32, 1, 0.12).normalize();
    this.soft.emit(top, this._d, 1, PLUME_COL, 1, PLUME);
  }

  /** Bullet into a body: dark-red mist spray along the shot + falling droplets. */
  fleshImpact(point: THREE.Vector3, shotDir: THREE.Vector3): void {
    this.soft.emit(point, shotDir, 6, BLOOD_COL, 1, MIST);
    this.soft.emit(point, shotDir, 8, BLOOD_COL, 1, DROPS);
  }

  /** Faint grey wisp at a muzzle after a shot. */
  muzzleSmoke(point: THREE.Vector3, forward: THREE.Vector3): void {
    this.soft.emit(point, forward, 2, SMOKE_COL, 1, SMOKE);
  }

  clear(): void {
    this.hot.clear();
    this.soft.clear();
  }

  update(dt: number): void {
    this.hot.update(dt);
    this.soft.update(dt);
  }
}
