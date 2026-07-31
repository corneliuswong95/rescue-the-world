/**
 * Post-processing via the three/webgpu node pipeline (compiles to WGSL and GLSL, so it runs on
 * both the WebGPU and WebGL2-fallback backends). Scene pass + threshold bloom so muzzle flashes,
 * tracers and sky highlights glow. Tone mapping / output color transform is applied by the
 * PostProcessing output node. GTAO/TAA are a later addition (QUALITY_BACKLOG).
 */
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';

export interface Post {
  render: () => void;
  setSize: (w: number, h: number) => void;
}

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Post {
  const post = new THREE.RenderPipeline(renderer);

  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode();
  // strength, radius, threshold — subtle: only genuinely bright pixels bloom.
  const bloomPass = bloom(color, 0.5, 0.5, 0.82);
  post.outputNode = color.add(bloomPass);

  return {
    render: () => post.render(),
    setSize: (w, h) => renderer.setSize(w, h),
  };
}
