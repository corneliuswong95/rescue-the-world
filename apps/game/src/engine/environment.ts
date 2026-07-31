/**
 * Image-based lighting + sky. A PMREM-prefiltered RoomEnvironment gives soft, directionally
 * varied ambient + reflections on the PBR materials (a big step up from a flat hemisphere),
 * and a procedural gradient sky replaces the flat clear colour. No external HDRI asset yet —
 * PolyHaven HDRI IBL is an M3 asset item (CREDITS.md) once we commit to a look.
 */
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export function setupEnvironment(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.32;

  scene.background = makeGradientSky();
  scene.backgroundIntensity = 1.0;
}

/** 2:1 equirectangular vertical gradient used as the sky background. */
function makeGradientSky(): THREE.Texture {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, '#2a3a52'); // zenith
  g.addColorStop(0.45, '#3f5570');
  g.addColorStop(0.5, '#5c7086'); // horizon band
  g.addColorStop(0.55, '#4a5a6e');
  g.addColorStop(1.0, '#20262e'); // nadir
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
