/**
 * Post stack on the three/webgpu node RenderPipeline (TSL → WGSL and GLSL, so it runs on both
 * the WebGPU and WebGL2-fallback backends):
 *
 *   scene pass (MRT: colour, view normal, velocity)
 *     → GTAO contact occlusion (half-res, temporally filtered)
 *     → HDR threshold bloom (only genuinely hot pixels: sun, muzzle flash, tracers)
 *     → TRAA temporal anti-aliasing (stable edges in motion; replaces FXAA)
 *     → tone map + sRGB (explicit, so grading happens in display space)
 *     → grade: contrast curve, split-tone, saturation, sharpen, vignette, film grain.
 *
 * 'medium' drops GTAO; 'low' bypasses the pipeline entirely (see main.ts applyQuality).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  rand,
  renderOutput,
  screenSize,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { traa } from 'three/examples/jsm/tsl/display/TRAANode.js';

export type PostQuality = 'medium' | 'high';

export interface Post {
  render: () => void;
  setQuality: (q: PostQuality) => void;
}

/** Display-space grade tunables (uniforms so they can be adjusted live). */
const GRADE = {
  contrast: uniform(0.22), // blend toward a smoothstep S-curve
  saturation: uniform(0.92),
  shadowTint: uniform(new THREE.Vector3(0.86, 0.95, 1.06)), // cool shadows
  highlightTint: uniform(new THREE.Vector3(1.05, 1.0, 0.92)), // warm highlights
  sharpen: uniform(0.28),
  vignette: uniform(0.32),
  grain: uniform(0.035),
};

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Post {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // tone mapping is applied explicitly before grading

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
  const color = scenePass.getTextureNode('output');
  const normal = scenePass.getTextureNode('normal');
  const depth = scenePass.getTextureNode('depth');
  const vel = scenePass.getTextureNode('velocity');

  const aoPass = ao(depth, normal, camera);
  aoPass.resolutionScale = 0.5;
  aoPass.useTemporalFiltering = true; // TRAA resolves the per-frame noise
  aoPass.radius.value = 0.55;
  aoPass.thickness.value = 0.8;
  aoPass.distanceExponent.value = 1.4;
  aoPass.scale.value = 1.15;
  const aoTerm = aoPass.getTextureNode().r;

  const build = (q: PostQuality): THREE.Node => {
    const lit = q === 'high' ? vec4(color.rgb.mul(aoTerm), color.a) : color;
    const glow = bloom(lit, 0.16, 0.45, 1.6); // strength, radius, HDR threshold
    const hdr = lit.add(glow);

    const aaPass = traa(hdr, depth, vel, camera);
    // @types/three omits TRAANode.getTextureNode() (present at runtime); we need the resolved
    // texture itself to take neighbour taps for the sharpen.
    const resolved = (aaPass as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode();

    const graded = Fn(() => {
      const st = uv();
      const px = vec2(1).div(screenSize);
      // Cheap 4-tap sharpen on the TAA resolve (TAA softens texture detail slightly).
      const c = renderOutput(resolved.sample(st)).rgb.toVar();
      const n = renderOutput(resolved.sample(st.add(vec2(0, px.y)))).rgb;
      const s = renderOutput(resolved.sample(st.sub(vec2(0, px.y)))).rgb;
      const e = renderOutput(resolved.sample(st.add(vec2(px.x, 0)))).rgb;
      const w = renderOutput(resolved.sample(st.sub(vec2(px.x, 0)))).rgb;
      c.assign(c.add(c.mul(4).sub(n.add(s).add(e).add(w)).mul(GRADE.sharpen)).max(0));

      // Filmic contrast + split-tone + saturation, all in display space.
      const k = c.saturate();
      c.assign(mix(c, k.mul(k).mul(k.mul(-2).add(3)), GRADE.contrast)); // smoothstep S-curve
      const l = luminance(c);
      const tint = mix(GRADE.shadowTint, GRADE.highlightTint, smoothstep(0.15, 0.75, l));
      c.assign(c.mul(tint));
      c.assign(mix(vec3(luminance(c)), c, GRADE.saturation));

      // Lens vignette (elliptical, aspect-aware) + animated luminance-weighted grain.
      const d = st.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1)).length();
      c.mulAssign(float(1).sub(smoothstep(0.35, 1.05, d).mul(GRADE.vignette)));
      const g = rand(st.mul(screenSize).add(time.mul(97.13).fract().mul(311.7))).sub(0.5);
      const midtone = l.mul(float(1).sub(l)).mul(4);
      c.addAssign(g.mul(GRADE.grain).mul(midtone.add(0.25)));
      return vec4(c, 1);
    });

    return graded();
  };

  // One graph per tier, built on first use and reused (rebuilding would leak render targets).
  const graphs = new Map<PostQuality, THREE.Node>();
  let quality: PostQuality | null = null;
  const setQuality = (q: PostQuality): void => {
    if (q === quality) return;
    quality = q;
    let node = graphs.get(q);
    if (!node) {
      node = build(q);
      graphs.set(q, node);
    }
    pipeline.outputNode = node;
    pipeline.needsUpdate = true;
  };
  setQuality('high');

  return {
    render: () => pipeline.render(),
    setQuality,
  };
}
