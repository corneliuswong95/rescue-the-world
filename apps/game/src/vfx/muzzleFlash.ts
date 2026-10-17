/**
 * Muzzle flash shared by the player viewmodel and enemy rifles.
 *
 * Three additive planes parented to a muzzle anchor (barrel along local -Z): a front-facing
 * star (the classic petal burst you see looking down the barrel) and two crossed side planes
 * carrying an elongated flame cone (what you see from the side — enemies in profile). Textures
 * are generated once on a canvas; the materials push the core into HDR so bloom catches it.
 * Each shot re-rolls rotation/scale and the flash lives ~1–2 frames, like a real flash.
 */
import * as THREE from 'three/webgpu';
import { texture, vec3 } from 'three/tsl';

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const STAR_VARIANTS = 3;

/** Atlas of STAR_VARIANTS stars side by side: hot core + 4–5 uneven tapered petals each. */
function starAtlas(): THREE.CanvasTexture {
  return canvasTexture(128 * STAR_VARIANTS, 128, (ctx) => {
    for (let v = 0; v < STAR_VARIANTS; v++) {
      ctx.save();
      drawStar(ctx, v + 1, 128 * v + 64);
      ctx.restore();
    }
  });
}

function drawStar(ctx: CanvasRenderingContext2D, seed: number, cx: number): void {
  let r = seed * 9301 + 49297;
  const rnd = (): number => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const petals = 4 + (seed % 2);
  {
    const s = 64;
    ctx.translate(cx, s);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < petals; i++) {
      ctx.save();
      ctx.rotate((i / petals) * Math.PI * 2 + (rnd() - 0.5) * 0.9);
      const len = 30 + rnd() * 32;
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,236,190,0.95)');
      g.addColorStop(0.45, 'rgba(255,170,70,0.55)');
      g.addColorStop(1, 'rgba(255,110,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.quadraticCurveTo(len * 0.45, -5, len, 0);
      ctx.quadraticCurveTo(len * 0.45, 5, 0, 7);
      ctx.fill();
      ctx.restore();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
    core.addColorStop(0, 'rgba(255,255,245,1)');
    core.addColorStop(0.35, 'rgba(255,214,140,0.85)');
    core.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = core;
    ctx.fillRect(-s, -s, 2 * s, 2 * s);
  }
}

/** Side-on flame cone: bright at the muzzle (left), ragged tongues toward the tip (right). */
function flameTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 64, (ctx) => {
    ctx.globalCompositeOperation = 'lighter';
    const tongues: [number, number, number][] = [[120, 0, 16], [92, -9, 9], [96, 10, 9], [70, -16, 6], [74, 15, 6]];
    for (const [len, dy, half] of tongues) {
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,245,215,0.95)');
      g.addColorStop(0.35, 'rgba(255,180,80,0.6)');
      g.addColorStop(1, 'rgba(255,100,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 32 - half);
      ctx.quadraticCurveTo(len * 0.5, 32 + dy - half * 0.6, len, 32 + dy);
      ctx.quadraticCurveTo(len * 0.5, 32 + dy + half * 0.6, 0, 32 + half);
      ctx.fill();
    }
  });
}

let shared: { star: THREE.Material; flame: THREE.Material; starGeos: THREE.PlaneGeometry[]; flameGeo: THREE.PlaneGeometry } | null = null;

function sharedResources(): NonNullable<typeof shared> {
  if (shared) return shared;
  const mat = (tex: THREE.Texture, hdr: number): THREE.MeshBasicNodeMaterial => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const t = texture(tex);
    m.colorNode = t.rgb.mul(vec3(hdr, hdr * 0.82, hdr * 0.6)); // HDR, warm → bloom picks the core
    m.opacityNode = t.a;
    return m;
  };
  const flameGeo = new THREE.PlaneGeometry(1, 0.5);
  flameGeo.translate(0.5, 0, 0); // base at the muzzle, extends along +x
  flameGeo.rotateY(Math.PI / 2); // +x → -z (down the barrel)
  // One material for every star; each variant is a plane whose UVs select its atlas cell, so
  // switching variants never compiles a new pipeline mid-fight.
  const starGeos = Array.from({ length: STAR_VARIANTS }, (_, v) => {
    const g = new THREE.PlaneGeometry(1, 1);
    const uvs = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uvs.count; i++) uvs.setX(i, (v + uvs.getX(i)) / STAR_VARIANTS);
    return g;
  });
  shared = { star: mat(starAtlas(), 3.2), flame: mat(flameTexture(), 2.6), starGeos, flameGeo };
  return shared;
}

export class MuzzleFlash {
  readonly root = new THREE.Group();
  private readonly star: THREE.Mesh;
  private readonly sides: THREE.Mesh[] = [];
  private readonly variants: THREE.PlaneGeometry[];
  private timer = 0;

  /** @param size approximate star diameter in metres (enemies exaggerate for readability). */
  constructor(private readonly size: number) {
    const r = sharedResources();
    this.variants = r.starGeos;
    this.star = new THREE.Mesh(r.starGeos[0], r.star);
    this.root.add(this.star);
    for (let i = 0; i < 2; i++) {
      const side = new THREE.Mesh(r.flameGeo, r.flame);
      side.rotation.z = (i * Math.PI) / 2; // crossed planes
      this.sides.push(side);
      this.root.add(side);
    }
    for (const m of [this.star, ...this.sides]) {
      m.renderOrder = 4;
      m.frustumCulled = false;
    }
    this.root.visible = false;
  }

  /** @param scale extra size multiplier (e.g. smaller through an optic so it can't white it out) */
  fire(duration = 0.045, scale = 1): void {
    const s = this.size * scale * (0.8 + Math.random() * 0.45);
    // Real flashes vary frame to frame: pick a petal variant, and ~40% of shots are core-only.
    const coreOnly = Math.random() < 0.4;
    this.star.geometry = this.variants[(Math.random() * this.variants.length) | 0];
    this.star.scale.setScalar(coreOnly ? s * 0.6 : s);
    this.star.rotation.z = Math.random() * Math.PI * 2;
    for (const side of this.sides) {
      side.visible = !coreOnly;
      side.scale.set(s, s * (0.7 + Math.random() * 0.5), s * (1.1 + Math.random() * 0.8));
    }
    this.root.rotation.z = Math.random() * Math.PI;
    this.root.visible = true;
    this.timer = duration;
  }

  hide(): void {
    this.root.visible = false;
    this.timer = 0;
  }

  update(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.root.visible = false;
  }
}
