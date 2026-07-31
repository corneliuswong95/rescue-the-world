/**
 * Renderer bootstrap: `three/webgpu` WebGPURenderer with automatic WebGL2 fallback.
 * WebGPU requires `await renderer.init()` before the first render.
 */
import * as THREE from 'three/webgpu';

export interface RendererBundle {
  renderer: THREE.WebGPURenderer;
  /** 'WebGPU' | 'WebGL2 (fallback)' — resolved *after* init(), so it is truthful. */
  backendName: string;
}

export async function createRenderer(container: HTMLElement): Promise<RendererBundle> {
  // Headless Chromium's WebGPU device is unstable (device-loss mid-render). The QA harness
  // appends `?webgl=1` to force the (fully supported) WebGL2 backend for reliable captures;
  // real gameplay stays WebGPU-first with automatic fallback.
  const forceWebGL = new URLSearchParams(location.search).get('webgl') === '1';
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  // WebGPURenderer must init before first render; this is where the WebGL2 fallback is chosen.
  await renderer.init();

  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  const backendName = backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (fallback)';

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, backendName };
}
