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
  iblTex.dispose();
  pmrem.dispose();

  scene.environment = env.texture;
  scene.environmentIntensity = 1.0;
  scene.environmentRotation.set(0, yaw, 0);
  scene.background = sky;
  scene.backgroundIntensity = 1.0;
  scene.backgroundRotation.set(0, yaw, 0);

  return { sunDirection: dir, sunColor: col };
}
