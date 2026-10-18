/**
 * The single shared PBR material every soldier renders with (TSL → WGSL/GLSL). Per-part
 * looks come from baked vertex attributes, so all archetypes and all body parts batch through
 * one shader program:
 *   albedo (vec3, linear)  — base colour (archetype tint + baked dust)
 *   surf   (vec4)          — x roughness, y metalness, z camo scale (0 = none), w pattern id
 *
 * Patterns are procedural on `positionGeometry` — the bind-pose vertex position, before skinning
 * — so they stay printed on the cloth while the skeleton animates:
 *   - Fabric:  original 4-colour blotch camouflage (layered MaterialX noise thresholds, derived
 *              from the base tint — generic, not any trademarked pattern) + fold wrinkles + weave.
 *   - Cordura: plate-carrier nylon — horizontal PALS/webbing rows + weave + mottling.
 *   - Knit / Leather / Rubber / Plain (hard polymer, helmet paint) / Gloss (goggle lens).
 * Micro-detail is height-only and converted to a normal with screen-space derivatives
 * (Mikkelsen bump), and fades out with pixel footprint so it never shimmers at range.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  dFdx,
  dFdy,
  float,
  fract,
  frontFacing,
  fwidth,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  normalWorld,
  positionGeometry,
  positionView,
  select,
  sin,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl';

/** Pattern ids stored in `surf.w`. */
export const PAT = {
  plain: 0,
  fabric: 1,
  cordura: 2,
  knit: 3,
  rubber: 4,
  gloss: 5,
  leather: 6,
} as const;

export type PatternId = (typeof PAT)[keyof typeof PAT];

export interface Surface {
  rough: number;
  metal: number;
  /** Camouflage print scale: 0 = plain base colour, 1 = standard, 2 = half-size blotches… */
  camo: number;
  pattern: PatternId;
}

type FloatNode = THREE.Node<'float'>;

/** 1 where `pat` equals `id` (ids are exact per part, so a 0.5 window is robust). */
function is(pat: FloatNode, id: number): FloatNode {
  return select(abs(pat.sub(id)).lessThan(0.5), float(1), float(0));
}

/** Anti-aliased threshold: a crisp edge that widens to the pixel footprint at range. */
function aaStep(edge: number, n: FloatNode): FloatNode {
  const w = fwidth(n).mul(0.75).add(0.004);
  return smoothstep(float(edge).sub(w), float(edge).add(w), n);
}

function buildMaterial(): THREE.MeshStandardNodeMaterial {
  const albedo = attribute<'vec3'>('albedo', 'vec3');
  const surf = attribute<'vec4'>('surf', 'vec4');
  const pat = surf.w;
  const p = positionGeometry;

  const mFab = is(pat, PAT.fabric);
  const mCor = is(pat, PAT.cordura);
  const mKnit = is(pat, PAT.knit);
  const mRub = is(pat, PAT.rubber);
  const mGloss = is(pat, PAT.gloss);
  const mLea = is(pat, PAT.leather);
  const mPlain = float(1).sub(mFab).sub(mCor).sub(mKnit).sub(mRub).sub(mGloss).sub(mLea);

  // Pixel footprint in metres (segment space) — drives micro-detail fade-out.
  const fw = fwidth(p);
  const foot = max(max(fw.x, fw.y), fw.z);
  const fadeFine = float(1).sub(smoothstep(0.0012, 0.0026, foot)); // < ~1.5 m
  const fadeMid = float(1).sub(smoothstep(0.004, 0.009, foot)); // < ~6 m

  // --- Camouflage (original blotch pattern) ---------------------------------------------
  // Multi-scale: large dark masses, mid light blotches, small black shapes, then fine
  // speckle — so it still reads as a printed pattern up close and breaks the silhouette at range.
  const camoOn = smoothstep(0.25, 0.5, surf.z);
  const pc = p.mul(max(surf.z, 1));
  const warp = mx_noise_float(pc.mul(6.2).add(vec3(3.1, 1.7, 5.9))).mul(0.024);
  const q = pc.add(vec3(warp, warp.mul(0.6), warp.mul(-0.8)));
  const nA = float(mx_fractal_noise_float(q.mul(vec3(8.8, 6.2, 8.8)), 3, 2.1, 0.5));
  const nB = float(mx_fractal_noise_float(q.mul(vec3(11, 7.6, 11)).add(vec3(17.3, -4.2, 9.1)), 3, 2.1, 0.5));
  const nC = float(mx_fractal_noise_float(q.mul(vec3(17, 12.4, 17)).add(vec3(-9.1, 6.6, 2.3)), 2, 2.2, 0.45));
  const nD = mx_noise_float(q.mul(52).add(vec3(4.4, -2.2, 7.7)));
  const mDark = aaStep(0.04, nA);
  const mLight = aaStep(0.2, nB);
  const mBlack = aaStep(0.3, nC);
  const mSpeck = aaStep(0.55, nD).mul(0.6);
  const cMid = albedo;
  const cDark = albedo.mul(vec3(0.5, 0.48, 0.42));
  // Light blotches lift dark bases a lot but light (coyote) bases only a little — otherwise a
  // tan uniform turns into cream-spotted pyjamas.
  const lum = albedo.dot(vec3(0.3, 0.6, 0.1));
  const lift = float(1).sub(smoothstep(0.06, 0.2, lum).mul(0.65));
  const cLight = mix(albedo, mix(albedo.mul(1.4), vec3(0.2, 0.175, 0.12), 0.3), lift);
  const cBlack = albedo.mul(0.3);
  const camoBase = mix(mix(mix(cMid, cDark, mDark), cLight, mLight.mul(float(1).sub(mDark.mul(0.6)))), cBlack, mBlack);
  const camo = mix(camoBase, cDark.mul(0.8), mSpeck);

  // --- Height fields (metres) ------------------------------------------------------------
  // Fabric folds: horizontal-ish bunching along limbs (local Y is the limb axis).
  const fold = mx_noise_float(p.mul(vec3(9, 30, 9)));
  const fold2 = mx_noise_float(p.mul(vec3(4.5, 11, 4.5)).add(vec3(2.2, 0, 7.7)));
  const hFold = fold.mul(0.0022).add(fold2.mul(0.003)).mul(fadeMid.mul(0.6).add(0.4));
  // Weave: fine orthogonal threads (≈4 mm repeat), close-range only.
  const k = (Math.PI * 2) / 0.004;
  const weave = sin(p.x.add(p.z).mul(k)).mul(sin(p.y.mul(k))).mul(0.00008).mul(fadeFine);
  // PALS webbing rows on the plate carrier: 25 mm bands on a 38 mm pitch.
  const f = fract(p.y.div(0.0381).add(0.3));
  const band = smoothstep(0.03, 0.09, f).sub(smoothstep(0.62, 0.68, f));
  const hMolle = band.mul(0.0011).mul(fadeMid);
  const mott = mx_noise_float(p.mul(38));
  // Knit, leather grain + creases, rubber, hard-surface paint grain.
  const hKnit = mx_noise_float(p.mul(vec3(120, 40, 120))).mul(0.00025).mul(fadeFine.mul(0.7).add(0.3));
  const hLea = mx_noise_float(p.mul(85)).mul(0.00018).add(mx_noise_float(p.mul(vec3(16, 46, 16))).mul(0.0007));
  const hRub = sin(p.z.mul((Math.PI * 2) / 0.011)).mul(0.0006).mul(fadeMid);
  const hGrain = mx_noise_float(p.mul(140)).mul(0.00012).mul(fadeFine.mul(0.6).add(0.4));

  const h = mFab
    .mul(hFold.add(weave))
    .add(mCor.mul(hMolle.add(weave.mul(1.3)).add(mott.mul(0.00012))))
    .add(mKnit.mul(hKnit.add(hFold.mul(0.5))))
    .add(mLea.mul(hLea))
    .add(mRub.mul(hRub))
    .add(mPlain.mul(hGrain));

  // Mikkelsen derivative bump (unnormalised, so the strength is in true metres).
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1).mul(select(frontFacing, float(1), float(-1)));
  // Scalar derivatives via a vec2 (the TSL typings only declare vector dFdx/dFdy).
  const hv = vec2(h, 0);
  const grad = det.sign().mul(dFdx(hv).x.mul(r1).add(dFdy(hv).x.mul(r2)));
  const bumped = abs(det).mul(normalView).sub(grad).normalize();

  // --- Albedo -------------------------------------------------------------------------------
  const grime = mx_noise_float(p.mul(4.3).add(vec3(5, 9, 1)));
  let col = mix(albedo, camo, camoOn);
  // Cavity darkening in the webbing gaps and fold valleys; large-scale grime breakup.
  const gap = float(1).sub(band).mul(mCor).mul(fadeMid.mul(0.75).add(0.25));
  col = col.mul(float(1).sub(gap.mul(0.28)));
  col = col.mul(float(1).add(fold.mul(0.06).mul(mFab.add(mKnit))));
  col = col.mul(float(1).add(mott.mul(0.05).mul(mCor)));
  col = col.mul(float(0.93).add(grime.mul(0.07)).mul(float(1).sub(mGloss)).add(mGloss));

  // --- Roughness / metalness ----------------------------------------------------------------
  const rVar = mx_noise_float(p.mul(11).add(vec3(1.3, 4.4, 8.8)));
  const rough = surf.x
    .add(rVar.mul(0.06).mul(float(1).sub(mGloss)))
    .add(gap.mul(0.05))
    .clamp(0.04, 1);

  // --- Sky rim -------------------------------------------------------------------------------
  // Grazing-angle skylight (fabric sheen, roughly): a faint sky-tinted rim, stronger on
  // up-facing surfaces, so silhouettes still separate from dark brick in shade. Not an outline.
  const nv = normalView;
  const fres = float(1).sub(nv.dot(positionView.normalize().negate()).clamp(0, 1)).pow(3);
  const skyward = normalWorld.y.mul(0.5).add(0.5);
  const rim = vec3(0.5, 0.62, 0.8).mul(fres.mul(skyward).mul(0.15).mul(float(1).sub(mGloss)));

  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = col;
  m.roughnessNode = rough;
  m.metalnessNode = surf.y;
  m.normalNode = bumped;
  m.emissiveNode = rim;
  return m;
}

let shared: THREE.MeshStandardNodeMaterial | null = null;

/** The one material all soldiers share (never disposed by a Soldier). */
export function soldierMaterial(): THREE.MeshStandardNodeMaterial {
  shared ??= buildMaterial();
  return shared;
}
