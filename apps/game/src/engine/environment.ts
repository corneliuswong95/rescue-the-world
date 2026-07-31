/**
 * Image-based lighting + sky from a real captured HDRI (PolyHaven, CC0 — see CREDITS.md).
 * PMREM-prefilters the equirectangular HDR for soft, directionally varied ambient + reflections
 * on the PBR materials, and uses the same HDR as the skybox background.
 */
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const HDRI_URL = '/assets/hdri/kloofendal_puresky_1k.hdr';

export async function setupEnvironment(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): Promise<void> {
  const hdr = await new HDRLoader().loadAsync(HDRI_URL);
  hdr.mapping = THREE.EquirectangularReflectionMapping;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(hdr);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.5;

  scene.background = hdr;
  scene.backgroundIntensity = 0.35; // dim the bright sky so the room reads
  scene.backgroundBlurriness = 0.0;
}
