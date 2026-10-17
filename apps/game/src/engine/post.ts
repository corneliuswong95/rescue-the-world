/**
 * Post stack on the three/webgpu node RenderPipeline (TSL → WGSL and GLSL, so it runs on both
 * the WebGPU and WebGL2-fallback backends).
 *
 *  high:   scene pass (MRT: colour, 8-bit view normal, velocity)
 *            → GTAO contact occlusion (half-res, temporally filtered)
 *            → HDR threshold bloom (sun glints, muzzle flash, tracers)
 *            → TRAA temporal AA (stable edges in motion) → tone map → sharpen + grade
 *  medium: plain scene pass → bloom → tone map → FXAA → grade
 *          (MRT + TRAA are the dominant post cost on M1-class GPUs — measured ~16 ms at 1080p)
 *  low:    bypasses the pipeline entirely (see main.ts applyQuality).
 *
 * Grade (display space): S-curve contrast, split-tone, saturation, vignette, film grain.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  colorToDirection,
  directionToColor,
  float,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  rand,
  renderOutput,
  sample,
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
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
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

/** Grade an LDR display-space colour at screen uv `st` (call inside an Fn body). */
function grade(input: THREE.Node<'vec3'>, st: THREE.Node<'vec2'>): THREE.Node<'vec4'> {
  const c = input.toVar();
  const k = c.saturate();
  c.assign(mix(c, k.mul(k).mul(k.mul(-2).add(3)), GRADE.contrast)); // smoothstep S-curve
  const l = luminance(c);
  c.assign(c.mul(mix(GRADE.shadowTint, GRADE.highlightTint, smoothstep(0.15, 0.75, l))));
  c.assign(mix(vec3(luminance(c)), c, GRADE.saturation));

  // Lens vignette (aspect-aware) + animated, luminance-weighted grain.
  const uvc = st;
  const d = uvc.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1)).length();
  c.mulAssign(float(1).sub(smoothstep(0.35, 1.05, d).mul(GRADE.vignette)));
  const g = rand(uvc.mul(screenSize).add(time.mul(97.13).fract().mul(311.7))).sub(0.5);
  c.addAssign(g.mul(GRADE.grain).mul(l.mul(float(1).sub(l)).mul(4).add(0.25)));
  return vec4(c, 1);
}

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Post {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // tone mapping is applied explicitly before grading

  const buildHigh = (): THREE.Node => {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: directionToColor(normalView), velocity }));
    scenePass.getTexture('normal').type = THREE.UnsignedByteType; // 8-bit normals: half the bandwidth
    const color = scenePass.getTextureNode('output');
    const normalTex = scenePass.getTextureNode('normal');
    // GTAO samples normals at its own uvs, so decode through a sample() callback.
    const normal = sample((st) => colorToDirection(normalTex.sample(st)));
    const depth = scenePass.getTextureNode('depth');

    const aoPass = ao(depth, normal, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.useTemporalFiltering = true; // TRAA resolves the per-frame noise…
    aoPass.samples.value = 8; // …so half the default taps converge to the same result
    aoPass.radius.value = 0.55;
    aoPass.thickness.value = 0.8;
    aoPass.distanceExponent.value = 1.4;
    aoPass.scale.value = 1.15;
    const lit = vec4(color.rgb.mul(aoPass.getTextureNode().r), color.a);
    const hdr = lit.add(bloom(lit, 0.16, 0.45, 1.6)); // strength, radius, HDR threshold

    const aaPass = traa(hdr, depth, scenePass.getTextureNode('velocity'), camera);
    // @types/three omits TRAANode.getTextureNode() (present at runtime); we need the resolved
    // texture itself to take neighbour taps for the sharpen.
    const resolved = (aaPass as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode();

    return Fn(() => {
      const st = uv();
      const px = vec2(1).div(screenSize);
      const tap = (o: THREE.Node<'vec2'>) => renderOutput(resolved.sample(st.add(o))).rgb;
      // 4-tap sharpen on the TAA resolve (TAA softens texture detail slightly).
      const c = tap(vec2(0)).toVar();
      const ring = tap(vec2(0, px.y)).add(tap(vec2(0, px.y.negate()))).add(tap(vec2(px.x, 0))).add(tap(vec2(px.x.negate(), 0)));
      c.assign(c.add(c.mul(4).sub(ring).mul(GRADE.sharpen)).max(0));
      return grade(c, st);
    })();
  };

  const buildMedium = (): THREE.Node => {
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const hdr = color.add(bloom(color, 0.16, 0.45, 1.6));
    // FXAANode is a vec4 TempNode at runtime; its @types class lacks the node-extension typing.
    const aa = fxaa(renderOutput(hdr)) as unknown as THREE.Node<'vec4'>;
    return Fn(() => grade(aa.rgb, uv()))();
  };

  // One graph per tier, built on first use and reused (rebuilding would leak render targets);
  // only the active graph's passes render.
  const graphs = new Map<PostQuality, THREE.Node>();
  let quality: PostQuality | null = null;
  const setQuality = (q: PostQuality): void => {
    if (q === quality) return;
    quality = q;
    let node = graphs.get(q);
    if (!node) {
      node = q === 'high' ? buildHigh() : buildMedium();
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
