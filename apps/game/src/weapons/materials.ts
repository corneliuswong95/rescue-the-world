/**
 * PBR materials for the code-built carbine + gloved hands (TSL node materials, no textures).
 *
 * Finishes are modelled the way they behave in sunlight:
 *  - anodised / phosphate / polymer coatings are *dielectric* (metalness 0) over a near-black
 *    albedo, with their specular (and so the environment reflection) scaled to ~0.55 — dark,
 *    satin, never grey plastic;
 *  - bare metal only shows where the coating has rubbed off: bevels/chamfers (the `mask` vertex
 *    attribute baked by geo.ts) broken into patches by noise → metalness 1, roughness ≈ 0.35;
 *  - roughness varies ±0.12 over two noise scales (finish blotching + handling marks);
 *  - micro-relief (bead blast, phosphate crystals, moulded stipple, fabric weave/ripstop) is a
 *    derivative-based bump sized to read at 0.3–0.8 m and faded by pixel footprint so it never
 *    sparkles.
 * All patterns are evaluated in object space (`positionLocal`) so they stick to moving parts.
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
  abs,
  sin,
  exp,
  dFdx,
  dFdy,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

const tint = attribute<'vec3'>('color', 'vec3');
const mask = attribute<'float'>('mask', 'float');
const P = positionLocal;

/** Specular scale for coated (dielectric) finishes: ~half the default reflection. */
const COATING_SPECULAR = 0.5;

/** World-space size of one pixel at the shaded point (metres). */
const footprint = (): F => max(positionView.dFdx().length(), positionView.dFdy().length());

/** Fade factor for detail of spatial `period` (m): 1 when resolved, 0 once it is sub-pixel. */
const resolve = (period: number): F => float(1).sub(smoothstep(period * 0.3, period * 0.75, footprint()));

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

/** Noise-broken edge wear (0 … 1) on masked bevels: long rubbed patches, never a dashed line. */
function edgeWear(scale: number): F {
  const n = mx_fractal_noise_float(P.mul(scale), 2, 2.0, 0.5);
  return mask.mul(smoothstep(-0.18, 0.22, n));
}

/** Roughness variation ≈ ±0.12: broad finish blotching + centimetre handling marks. */
function roughnessVariation(): F {
  const broad = mx_fractal_noise_float(P.mul(9), 2, 2, 0.5);
  const marks = mx_fractal_noise_float(P.mul(65), 2, 2.2, 0.55);
  return broad.mul(0.08).add(marks.mul(0.07));
}

// ---------------------------------------------------------------------------------------------
// Viewmodel (high detail)
// ---------------------------------------------------------------------------------------------

interface CoatingSpec {
  roughness: number;
  bare: V3;
  wearScale: number;
  relief: F;
}

/** Dielectric coating over metal (hard anodise, phosphate): near-black, satin, worn edges. */
function coatedMetal(spec: CoatingSpec): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const wear = edgeWear(spec.wearScale);
  const tone = mx_fractal_noise_float(P.mul(12), 2, 2, 0.5);
  m.colorNode = mix(tint.mul(tone.mul(0.12).add(1)), spec.bare, wear);
  m.roughnessNode = mix(roughnessVariation().add(spec.roughness), float(0.35), wear);
  m.metalnessNode = wear;
  m.specularIntensityNode = float(COATING_SPECULAR);
  m.normalNode = bumpNormal(spec.relief);
  return m;
}

function anodisedAluminium(): THREE.MeshPhysicalNodeMaterial {
  // Bead-blast texture (~2 mm) + faint machining waviness (~7 mm).
  const blast = mx_noise_float(P.mul(480)).mul(0.000032).mul(resolve(0.0021));
  const wave = mx_noise_float(P.mul(140)).mul(0.00005).mul(resolve(0.007));
  return coatedMetal({ roughness: 0.57, bare: vec3(0.46, 0.47, 0.5), wearScale: 22, relief: blast.add(wave) });
}

function phosphateSteel(): THREE.MeshPhysicalNodeMaterial {
  // Crystalline phosphate (~1.5 mm) over a slightly hammered forging.
  const crystals = mx_worley_noise_float(P.mul(650)).mul(0.000028).mul(resolve(0.0015));
  const forge = mx_noise_float(P.mul(120)).mul(0.00005).mul(resolve(0.008));
  return coatedMetal({ roughness: 0.62, bare: vec3(0.42, 0.42, 0.44), wearScale: 30, relief: crystals.add(forge) });
}

function texturedPolymer(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const tone = mx_fractal_noise_float(P.mul(13), 2, 2, 0.5);
  const polish = mask.mul(smoothstep(-0.1, 0.3, mx_noise_float(P.mul(60)))); // handled edges
  m.colorNode = tint.mul(tone.mul(0.08).add(1)).mul(polish.mul(0.3).add(1));
  m.roughnessNode = roughnessVariation().add(0.7).sub(polish.mul(0.2));
  m.metalnessNode = float(0);
  m.specularIntensityNode = float(0.6);
  // Moulded stipple: worley cells ~2.4 mm.
  m.normalNode = bumpNormal(mx_worley_noise_float(P.mul(420)).mul(0.00005).mul(resolve(0.0024)));
  return m;
}

/** Glove: coyote nylon back + synthetic-leather palm/knuckle panels (`mask` = 1). */
function gloveFabric(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const tone = mx_fractal_noise_float(P.mul(40), 2, 2, 0.5);
  const leather = mask;
  m.colorNode = tint.mul(tone.mul(0.12).add(1));
  m.roughnessNode = mix(float(0.86), float(0.55), leather).add(tone.mul(0.06));
  m.metalnessNode = float(0);
  const weave = mx_noise_float(P.mul(300)).mul(0.00004).mul(resolve(0.0033));
  const pebble = mx_worley_noise_float(P.mul(520)).mul(0.000035).mul(resolve(0.002));
  const wrinkle = mx_fractal_noise_float(P.mul(60), 2, 2, 0.5).mul(0.00035);
  m.normalNode = bumpNormal(mix(weave.add(wrinkle), pebble.add(wrinkle.mul(0.5)), leather));
  m.sheenNode = tint.mul(float(1).sub(leather).mul(0.6));
  m.sheenRoughnessNode = float(0.65);
  return m;
}

/** Combat-shirt sleeve: generic multi-scale four-tone camo on ripstop (no real-world pattern). */
function sleeveFabric(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const base = vec3(0.07, 0.074, 0.048);
  const brown = vec3(0.046, 0.035, 0.024);
  const tan = vec3(0.13, 0.118, 0.08);
  const green = vec3(0.05, 0.062, 0.036);
  const dark = vec3(0.022, 0.023, 0.018);
  const blotch = mx_fractal_noise_float(P.mul(52), 3, 2, 0.5);
  const patch = mx_fractal_noise_float(P.mul(68).add(vec3(7.1, 2.3, 4.7)), 3, 2, 0.5);
  const fleck = mx_fractal_noise_float(P.mul(110).add(vec3(3.7, 8.1, 1.9)), 2, 2, 0.5);
  const speck = mx_noise_float(P.mul(170).add(vec3(1.3, 9.2, 3.3)));
  const fade = mx_fractal_noise_float(P.mul(6), 2, 2, 0.5); // sun/wash fading over the arm
  let c: V3 = mix(base, brown, smoothstep(0.1, 0.15, blotch));
  c = mix(c, tan, smoothstep(0.2, 0.25, patch));
  c = mix(c, green, smoothstep(0.28, 0.33, fleck));
  c = mix(c, dark, smoothstep(0.5, 0.55, speck));
  // Ripstop: a ~5 mm grid of slightly raised, lighter reinforcement threads.
  const k = (Math.PI * 2) / 0.005;
  const g = abs(sin(P.mul(k)));
  const grid = smoothstep(0.93, 1.0, max(g.x, max(g.y, g.z))).mul(resolve(0.005));
  const fibre = mx_noise_float(P.mul(1200));
  m.colorNode = c.mul(fade.mul(0.14).add(1)).mul(fibre.mul(0.05).add(1)).mul(grid.mul(0.08).add(1)).mul(tint);
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0);
  const wrinkle = mx_fractal_noise_float(P.mul(45), 2, 2, 0.5).mul(0.0005);
  m.normalNode = bumpNormal(grid.mul(0.00002).add(wrinkle));
  m.sheenNode = c.mul(0.8);
  m.sheenRoughnessNode = float(0.7);
  return m;
}

/**
 * Optic window: thin coated glass + a parallax-free red dot. The dot is drawn where the view ray
 * is parallel to the optic axis (−Z of the rifle), exactly like a collimated sight — it sits on
 * the point of aim at ADS and drifts with the muzzle under recoil. HDR core so bloom catches it.
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
  const r = 0.0019; // dot radius (rad): a crisp ~5 px core at 1080p / 46° ADS
  const aa = max(off.fwidth(), 0.00004);
  const core = float(1).sub(smoothstep(float(r).sub(aa), float(r).add(aa), off)).mul(facing);
  const glow = exp(off.sub(r).max(0).mul(-1 / 0.0007)).mul(facing);
  m.colorNode = vec3(0.03, 0.05, 0.05);
  // #ff2a1a in linear. Kept below the level where ACES rolls saturated red over to orange; the
  // authored halo supplies the bloom-like bleed.
  m.emissiveNode = vec3(1.0, 0.016, 0.008).mul(core.mul(2.8).add(glow.mul(0.9)));
  m.opacityNode = max(float(0.16), max(core, glow.mul(0.7)));
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
// World (enemy-held) — cheap: tint only, constant roughness, coatings stay dielectric.
// ---------------------------------------------------------------------------------------------

export interface WorldMaterials {
  metal: THREE.Material;
  polymer: THREE.Material;
}

let worldMats: WorldMaterials | null = null;

export function getWorldMaterials(): WorldMaterials {
  if (!worldMats) {
    const metal = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0 });
    metal.colorNode = tint;
    const polymer = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0 });
    polymer.colorNode = tint;
    worldMats = { metal, polymer };
  }
  return worldMats;
}
