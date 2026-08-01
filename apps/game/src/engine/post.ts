/**
 * Post-processing via the three/webgpu node RenderPipeline (compiles to WGSL and GLSL, so it
 * runs on both the WebGPU and WebGL2-fallback backends):
 *   scene pass (MRT: colour + view normals) → GTAO contact shadows → threshold bloom.
 * GTAO grounds objects with soft contact occlusion; bloom makes muzzle flashes / tracers /
 * bright sky glow. Tone mapping / output transform is applied by the RenderPipeline output.
 * TAA/SMAA is a later addition (QUALITY_BACKLOG).
 */
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, vec3, vec4 } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';

export interface Post {
  render: () => void;
}

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Post {
  const post = new THREE.RenderPipeline(renderer);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView }));

  const color = scenePass.getTextureNode('output');
  const normal = scenePass.getTextureNode('normal');
  const depth = scenePass.getTextureNode('depth');

  // Ground-truth AO: soft contact occlusion.
  const aoPass = ao(depth, normal, camera);
  const aoOut = aoPass.getTextureNode();
  const lit = color.mul(vec4(vec3(aoOut.r), 1));

  // Threshold bloom — only genuinely bright pixels glow.
  const bloomPass = bloom(lit, 0.35, 0.5, 0.9);
  // FXAA as the final step (the offscreen pipeline bypasses MSAA).
  post.outputNode = fxaa(lit.add(bloomPass));

  return {
    render: () => post.render(),
  };
}
