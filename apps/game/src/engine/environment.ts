/**
 * Sky + image-based lighting from one captured HDRI (PolyHaven, CC0 — see CREDITS.md).
 *
 * The sun is *extracted* from the HDR so the whole frame agrees on one light: its brightest
 * region gives the key light's direction and colour, and it is then clamped out of the copy that
 * is PMREM-filtered for IBL. Without that, the (unshadowable) environment re-lights every cast
 * shadow with sun energy — the classic "everything looks flat and floaty" tell. The untouched
 * HDR stays as the visible skybox, so the sun disc and clouds still read in the sky.
 */
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const HDRI_URL = '/assets/hdri/kloofendal_38d_partly_cloudy_puresky_2k.hdr';

/** Luminance above this multiple of the bright-sky percentile counts as "sun". */
const SUN_THRESHOLD = 6;

export interface SkyLight {
  /** Unit vector pointing *towards* the sun, world space. */
  readonly sunDirection: THREE.Vector3;
  /** Linear sun chromaticity (max channel = 1). */
  readonly sunColor: THREE.Color;
  /** The sky with the sun clamped out — background for the local probe bake; disposed by it. */
  readonly iblSky: THREE.DataTexture;
}

/**
 * @param sunAzimuth where the sun should sit, as atan2(x, z) of its world direction (0 = +z,
 *                   π/2 = +x). The sky is yawed to put the HDRI's sun there; background, IBL
 *                   and the returned sun direction all share that rotation.
 */
export async function setupEnvironment(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  sunAzimuth: number,
): Promise<SkyLight> {
  const sky = await new HDRLoader().loadAsync(HDRI_URL); // RGBA half-float, flipY
  sky.mapping = THREE.EquirectangularReflectionMapping;
  const { width: w, height: h, data } = sky.image as { width: number; height: number; data: Uint16Array };
  const half = THREE.DataUtils;

  // 1) Luminance + a robust "bright sky" reference (99.5th percentile of a strided sample).
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    lum[i] =
      0.2126 * half.fromHalfFloat(data[o]) +
      0.7152 * half.fromHalfFloat(data[o + 1]) +
      0.0722 * half.fromHalfFloat(data[o + 2]);
  }
  const sample = new Float32Array(Math.ceil((w * h) / 7));
  for (let i = 0, j = 0; i < w * h; i += 7, j++) sample[j] = lum[i];
  sample.sort();
  const skyRef = sample[Math.floor(sample.length * 0.995)];
  const clampLum = skyRef * SUN_THRESHOLD;

  // 2) Sun = energy-weighted mean direction/colour of the over-threshold pixels; clamp them in
  //    an IBL-only copy.
  const ibl = new Uint16Array(data);
  const dir = new THREE.Vector3();
  const col = new THREE.Color(0, 0, 0);
  let weight = 0;
  for (let i = 0; i < w * h; i++) {
    const L = lum[i];
    if (L <= clampLum) continue;
    const x = i % w;
    const y = (i - x) / w;
    // three's equirect convention: u = atan2(z, x)/2π + 0.5, v = asin(y)/π + 0.5 (row 0 = top).
    const phi = ((x + 0.5) / w - 0.5) * Math.PI * 2;
    const el = (0.5 - (y + 0.5) / h) * Math.PI;
    const e = L - clampLum;
    dir.x += Math.cos(phi) * Math.cos(el) * e;
    dir.y += Math.sin(el) * e;
    dir.z += Math.sin(phi) * Math.cos(el) * e;
    const o = i * 4;
    const k = clampLum / L;
    col.r += (half.fromHalfFloat(data[o]) / L) * e;
    col.g += (half.fromHalfFloat(data[o + 1]) / L) * e;
    col.b += (half.fromHalfFloat(data[o + 2]) / L) * e;
    weight += e;
    ibl[o] = half.toHalfFloat(half.fromHalfFloat(data[o]) * k);
    ibl[o + 1] = half.toHalfFloat(half.fromHalfFloat(data[o + 1]) * k);
    ibl[o + 2] = half.toHalfFloat(half.fromHalfFloat(data[o + 2]) * k);
  }
  if (weight > 0) {
    dir.normalize();
    col.multiplyScalar(1 / weight);
    col.multiplyScalar(1 / Math.max(col.r, col.g, col.b));
  } else {
    dir.set(0.5, 0.6, 0.6).normalize(); // overcast fallback: soft high key
    col.setRGB(1, 0.96, 0.9);
  }
  // Rotating about +Y by θ adds θ to atan2(x, z).
  const yaw = sunAzimuth - Math.atan2(dir.x, dir.z);
  dir.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);

  const iblTex = new THREE.DataTexture(ibl, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  iblTex.mapping = THREE.EquirectangularReflectionMapping;
  iblTex.flipY = sky.flipY;
  iblTex.colorSpace = sky.colorSpace;
  iblTex.minFilter = iblTex.magFilter = THREE.LinearFilter;
  iblTex.generateMipmaps = false;
  iblTex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(iblTex);
  pmrem.dispose();

  scene.environment = env.texture;
  scene.environmentIntensity = 1.0;
  scene.environmentRotation.set(0, yaw, 0);
  scene.background = sky;
  scene.backgroundIntensity = 1.0;
  scene.backgroundRotation.set(0, yaw, 0);

  return { sunDirection: dir, sunColor: col, iblSky: iblTex };
}

/**
 * Bake a local light probe once the level is built: render a cube map from inside the yard
 * (sunlit brick, shadowed walls, asphalt, with the sun-clamped sky above) and PMREM it into
 * `scene.environment`. Shade then picks up warm bounce from the lit facades, and glass/damp
 * asphalt reflect the buildings instead of open sky — at zero per-frame cost. The HDRI stays as
 * the visible background. Hide anything that shouldn't appear in the probe before calling.
 */
export function bakeLocalProbe(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  sky: SkyLight,
  at: THREE.Vector3,
): THREE.RenderTarget {
  const cubeRT = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType }); // ample for bounce + rough reflections
  const cubeCam = new THREE.CubeCamera(0.3, 300, cubeRT);
  cubeCam.position.copy(at);
  cubeCam.updateMatrixWorld();

  const background = scene.background;
  scene.background = sky.iblSky;
  cubeCam.update(renderer, scene);
  scene.background = background;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(cubeRT.texture);
  pmrem.dispose();
  cubeRT.dispose();
  sky.iblSky.dispose();

  useProbe(scene, env.texture);
  return env;
}

/** Make a pre-filtered (PMREM / cube-UV) probe the scene's environment; captured in world space. */
function useProbe(scene: THREE.Scene, probe: THREE.Texture): void {
  scene.environment?.dispose();
  scene.environment = probe;
  scene.environmentRotation.set(0, 0, 0);
}

/*
 * Baked probe file: the PMREM cube-UV atlas exactly as three generated it (so no face/axis
 * conventions to get wrong), as RGBA half floats. Layout: 'OPRB' magic, u32 width, u32 height,
 * u32 reserved, then width*height*4 Uint16. Re-bake (tools/assets/bake-probe.mjs) whenever the
 * level, lighting or the three.js version changes.
 */
const PROBE_MAGIC = 0x4252504f; // 'OPRB' little-endian

/** Read back a baked probe (bakeLocalProbe's result) into the shippable file format. */
export async function exportProbe(renderer: THREE.WebGPURenderer, probe: THREE.RenderTarget): Promise<Uint8Array> {
  const { width, height } = probe;
  const px = (await renderer.readRenderTargetPixelsAsync(probe, 0, 0, width, height)) as Uint16Array;
  const out = new Uint8Array(16 + px.byteLength);
  new Uint32Array(out.buffer, 0, 4).set([PROBE_MAGIC, width, height, 0]);
  out.set(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), 16);
  return out;
}

/** Use the shipped baked probe if present; returns false (caller bakes live) if it's missing/stale. */
export async function loadBakedProbe(scene: THREE.Scene, url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const [magic, width, height] = new Uint32Array(buf, 0, 4);
    if (magic !== PROBE_MAGIC || buf.byteLength !== 16 + width * height * 8) return false;
    const tex = new THREE.DataTexture(new Uint16Array(buf, 16), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.CubeUVReflectionMapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    // Mark as already pre-filtered so the PMREM node samples it directly.
    Object.assign(tex, { isPMREMTexture: true });
    useProbe(scene, tex);
    return true;
  } catch {
    return false;
  }
}
