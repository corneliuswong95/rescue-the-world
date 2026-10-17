/**
 * PBR materials for the code-built carbine + gloved hands (TSL node materials, no textures).
 *
 * Surfaces get procedural micro-detail evaluated in object space (`positionLocal`), so the
 * pattern sticks to the part as it moves:
 *  - roughness / albedo variation from low-frequency fractal noise (no flat "plastic" read),
 *  - a derivative-based bump (Mikkelsen surface-gradient) from high-frequency noise, faded out
 *    by pixel footprint so it never sparkles,
 *  - edge wear on bevels/chamfers (the `mask` vertex attribute baked by geo.ts) broken up by
 *    noise: bare, brighter, shinier metal where the finish has rubbed off.
 *
 * Every part tint arrives through the `color` vertex attribute, so one material = one draw.
 * Materials are module singletons, shared by every rifle instance.
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  positionLocal,
  positionView,
  normalView,
  modelViewMatrix,
  mx_noise_float,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  smoothstep,
  cross,
  max,
  exp,
  dFdx,
  dFdy,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

const tint = attribute<'vec3'>('color', 'vec3');
const mask = attribute<'float'>('mask', 'float');
const P = positionLocal;

/** World-space size of one pixel at the shaded point (metres). */
const footprint = (): F => max(positionView.dFdx().length(), positionView.dFdy().length());

/** Fade factor for detail of spatial `period` (m): 1 when well resolved, 0 when sub-pixel. */
const resolve = (period: number): F => float(1).sub(smoothstep(period * 0.18, period * 0.5, footprint()));

/** Screen-space derivatives of a scalar (@types/three only types the vector overloads). */
const dHdx = (h: F): F => dFdx(vec2(h, 0)).x;
const dHdy = (h: F): F => dFdy(vec2(h, 0)).x;

/**
 * Perturbs the view-space normal by the screen-space gradient of a height field (metres).
 * Same maths as three's BumpMapNode (Mikkelsen surface gradient), but on any procedural float.
 * All weapon materials are single-sided, so the face-direction term is 1 and omitted.
 */
function bumpNormal(height: F): V3 {
  const dpx = positionView.dFdx();
  const dpy = positionView.dFdy();
  const n = normalView;
  const r1 = cross(dpy, n);
  const r2 = cross(n, dpx);
  const det = dpx.dot(r1);
  const grad = det.sign().mul(r1.mul(dHdx(height)).add(r2.mul(dHdy(height))));
  return det.abs().mul(n).sub(grad).normalize();
}

/** Noise-broken edge-wear factor (0 … 1) on masked bevel faces: patchy, never a dashed line. */
function edgeWear(scale: number, bias: number): F {
  const n = mx_fractal_noise_float(P.mul(scale), 2, 2.0, 0.5);
  return mask.mul(smoothstep(-0.15, 0.45, n.add(bias)));
}

// ---------------------------------------------------------------------------------------------
// Viewmodel (high detail)
// ---------------------------------------------------------------------------------------------

function anodisedAluminium(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const broad = mx_fractal_noise_float(P.mul(11), 3, 2, 0.5); // satin blotching ~10 cm
  const grain = mx_noise_float(P.mul(1500)); // sub-mm machining grain (roughness only)
  const smudge = smoothstep(0.1, 0.5, mx_fractal_noise_float(P.mul(38), 3, 2.2, 0.55)); // handling
  const wear = edgeWear(24, 0.0).mul(0.7);
  const bare = vec3(0.2, 0.205, 0.21);
  m.colorNode = mix(tint.mul(broad.mul(0.08).add(1)), bare, wear);
  m.roughnessNode = mix(broad.mul(0.06).add(grain.mul(0.04)).add(0.58).sub(smudge.mul(0.16)), float(0.4), wear);
  m.metalnessNode = mix(float(0.22), float(0.8), wear);
  // Very fine orange-peel of the anodised finish (breaks up reflections, never reads as bumps).
  m.normalNode = bumpNormal(mx_noise_float(P.mul(520)).mul(0.000005).mul(resolve(0.0019)));
  return m;
}

function phosphateSteel(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const broad = mx_fractal_noise_float(P.mul(16), 2, 2, 0.5);
  const crystals = mx_noise_float(P.mul(1100));
  const wear = edgeWear(30, 0.0).mul(0.75);
  const bare = vec3(0.24, 0.245, 0.25);
  m.colorNode = mix(tint.mul(broad.mul(0.1).add(1)), bare, wear);
  m.roughnessNode = mix(broad.mul(0.06).add(crystals.mul(0.05)).add(0.6), float(0.36), wear);
  m.metalnessNode = mix(float(0.45), float(0.9), wear);
  m.normalNode = bumpNormal(mx_noise_float(P.mul(700)).mul(0.000008).mul(resolve(0.0014)));
  return m;
}

function texturedPolymer(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const broad = mx_fractal_noise_float(P.mul(13), 2, 2, 0.5);
  const polish = mask.mul(smoothstep(-0.1, 0.3, mx_noise_float(P.mul(120)))); // handled edges
  m.colorNode = tint.mul(broad.mul(0.07).add(1)).mul(polish.mul(0.25).add(1));
  m.roughnessNode = broad.mul(0.05).add(0.72).sub(polish.mul(0.18));
  m.metalnessNode = float(0);
  // Moulded stipple: fine worley cells ~1.1 mm.
  const stipple = mx_worley_noise_float(P.mul(900)).mul(0.000018).mul(resolve(0.0011));
  m.normalNode = bumpNormal(stipple);
  return m;
}

/** Glove: coyote fabric back + synthetic-leather palm/knuckle panels (`mask` = 1). */
function gloveFabric(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const broad = mx_fractal_noise_float(P.mul(40), 2, 2, 0.5);
  const leather = mask;
  m.colorNode = tint.mul(broad.mul(0.1).add(1));
  m.roughnessNode = mix(float(0.86), float(0.52), leather).add(broad.mul(0.05));
  m.metalnessNode = float(0);
  const weave = mx_noise_float(P.mul(900)).mul(0.000012).mul(resolve(0.0012));
  const pebble = mx_worley_noise_float(P.mul(700)).mul(0.00002).mul(resolve(0.0015));
  const wrinkle = mx_fractal_noise_float(P.mul(70), 2, 2, 0.5).mul(0.0003);
  m.normalNode = bumpNormal(mix(weave.add(wrinkle), pebble.add(wrinkle.mul(0.4)), leather));
  m.sheenNode = tint.mul(float(1).sub(leather).mul(0.6));
  m.sheenRoughnessNode = float(0.65);
  return m;
}

/** Combat-shirt sleeve: muted generic three-tone camo on ripstop. */
function sleeveFabric(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const base = vec3(0.07, 0.074, 0.048);
  const brown = vec3(0.048, 0.037, 0.025);
  const tan = vec3(0.13, 0.118, 0.08);
  const dark = vec3(0.024, 0.025, 0.019);
  const n1 = mx_fractal_noise_float(P.mul(26), 3, 2, 0.5);
  const n2 = mx_fractal_noise_float(P.mul(34).add(vec3(7.1, 2.3, 4.7)), 3, 2, 0.5);
  const n3 = mx_noise_float(P.mul(80).add(vec3(1.3, 9.2, 3.3)));
  let c: V3 = mix(base, brown, smoothstep(0.1, 0.16, n1));
  c = mix(c, tan, smoothstep(0.22, 0.28, n2));
  c = mix(c, dark, smoothstep(0.5, 0.56, n3));
  const fibre = mx_noise_float(P.mul(1200));
  m.colorNode = c.mul(tint).mul(fibre.mul(0.06).add(1));
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0);
  const ripstop = mx_noise_float(P.mul(800)).mul(0.000012).mul(resolve(0.0014));
  const wrinkle = mx_fractal_noise_float(P.mul(45), 2, 2, 0.5).mul(0.0004);
  m.normalNode = bumpNormal(ripstop.add(wrinkle));
  m.sheenNode = c.mul(0.8);
  m.sheenRoughnessNode = float(0.7);
  return m;
}

/**
 * Optic window: thin coated glass + a parallax-free red dot. The dot is drawn where the view ray
 * is parallel to the optic axis (−Z of the rifle), exactly like a collimated sight — it sits on
 * the point of aim at ADS and drifts with the muzzle under recoil.
 */
function opticGlass(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    transparent: true,
    depthWrite: false,
    roughness: 0.03,
    metalness: 0,
    ior: 1.52,
    iridescence: 0.85,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [260, 420],
  });
  const viewDir = positionView.normalize();
  const axis = modelViewMatrix.mul(vec4(0, 0, -1, 0)).xyz.normalize();
  const off = cross(viewDir, axis).length(); // sin(angle) — precise at tiny angles
  const facing = smoothstep(0.9, 0.95, viewDir.dot(axis));
  const r = 0.0021; // dot radius (rad) ≈ 7 MOA — readable at 1080p
  const aa = max(off.fwidth(), 0.00005);
  const core = float(1).sub(smoothstep(float(r).sub(aa), float(r).add(aa), off)).mul(facing);
  const glow = exp(off.mul(-1 / 0.0016)).mul(facing);
  m.colorNode = vec3(0.03, 0.05, 0.05);
  m.emissiveNode = vec3(1.0, 0.09, 0.05).mul(core.mul(9).add(glow.mul(1.6)));
  m.opacityNode = max(float(0.2), max(core, glow.mul(0.6)));
  return m;
}

export interface ViewmodelMaterials {
  aluminium: THREE.Material;
  steel: THREE.Material;
  polymer: THREE.Material;
  glass: THREE.Material;
  glove: THREE.Material;
  sleeve: THREE.Material;
}

let viewmodelMats: ViewmodelMaterials | null = null;

export function getViewmodelMaterials(): ViewmodelMaterials {
  viewmodelMats ??= {
    aluminium: anodisedAluminium(),
    steel: phosphateSteel(),
    polymer: texturedPolymer(),
    glass: opticGlass(),
    glove: gloveFabric(),
    sleeve: sleeveFabric(),
  };
  return viewmodelMats;
}

// ---------------------------------------------------------------------------------------------
// World (enemy-held) — cheap: tint only, constant roughness/metalness.
// ---------------------------------------------------------------------------------------------

export interface WorldMaterials {
  metal: THREE.Material;
  polymer: THREE.Material;
}

let worldMats: WorldMaterials | null = null;

export function getWorldMaterials(): WorldMaterials {
  if (!worldMats) {
    const metal = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.6 });
    metal.colorNode = tint;
    const polymer = new THREE.MeshStandardNodeMaterial({ roughness: 0.68, metalness: 0 });
    polymer.colorNode = tint;
    worldMats = { metal, polymer };
  }
  return worldMats;
}
