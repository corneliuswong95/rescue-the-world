/**
 * Code-built infantry kit (original design — no ripped assets, patterns or insignia), dressed
 * onto the skinned CC0 body. Every part is rigidly bound to one bone and merged into the body's
 * skinned geometry, so the whole soldier (body + gear) is ONE draw call.
 *
 * Coordinates: parts are authored either directly in the body's bind space (T-pose, feet at
 * y = 0, facing +Z, the body's left = +X) or — for the larger assemblies carried over from the
 * rigid soldier — in that older "design" space (facing −Z, slimmer proportions) and fitted onto
 * the body per bone group with a pre-transform (flip + scale + offset) solved from the body's
 * measured cloth surfaces (`BodyFit`), so armour stands 1–2 cm off the cloth. Straps are flat
 * webbing laid on the cloth surface and skinned like the cloth under them (`BODY_SKIN`), so they
 * follow the shoulders instead of floating or sinking as the arms move.
 *
 * Three kits read differently by SILHOUETTE, not just colour:
 *   rifleman — plate carrier, triple mag pouches, radio, low-profile back panel;
 *   rusher   — light chest rig on an X-harness, no plates / back panel / knee pads, slick helmet;
 *   heavy    — thick plates + side plates, high neck guard, groin flap, shoulder armour and a
 *              smoked ballistic visor.
 */
import * as THREE from 'three/webgpu';
import { PartSink, alongMatrix, curveZ, helmetShell, loft, rbox, sweep, trs, type Section } from './soldierGeometry';
import { PAT, type Surface } from './soldierMaterial';

export type Kit = 'rifleman' | 'rusher' | 'heavy';

export interface Look {
  uniform: number;
  vest: number;
  helmet: number;
  kit: Kit;
}

/** Cloth-surface measurements of the prepared body (bind space) + a surface snap. */
export interface BodyFit {
  chestFront: number;
  chestBack: number;
  chestSide: number;
  beltFront: number;
  beltBack: number;
  beltSide: number;
  kneeFront: number;
  thighOuter: number;
  elbowBack: number;
  /** `p` projected onto the cloth surface (tangent plane of the nearest cloth vertex) + `off` out. */
  snap: (p: THREE.Vector3, off: number, out: THREE.Vector3) => THREE.Vector3;
  /** Index of the cloth vertex nearest to `p`. */
  nearest: (p: THREE.Vector3) => number;
}

/** Pseudo-bone: the part's vertices take the skin weights of the nearest cloth vertex. */
export const BODY_SKIN = '*body';

/** One gear piece: geometry in bind space, bound rigidly to `bone` (or skinned: `BODY_SKIN`). */
export interface KitPart {
  bone: string;
  geo: THREE.BufferGeometry;
}

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

// --- Surfaces + palette ------------------------------------------------------------------
const S_CAMO_BASE: Surface = { rough: 0.9, metal: 0, camo: 1, pattern: PAT.fabric };
const S_FABRIC: Surface = { rough: 0.88, metal: 0, camo: 0, pattern: PAT.fabric };
const S_CORDURA: Surface = { rough: 0.8, metal: 0, camo: 0, pattern: PAT.cordura };
const S_POLY: Surface = { rough: 0.5, metal: 0.04, camo: 0, pattern: PAT.plain };
const S_METAL: Surface = { rough: 0.5, metal: 0.35, camo: 0, pattern: PAT.plain };
const S_HELMET: Surface = { rough: 0.74, metal: 0, camo: 0, pattern: PAT.plain };
export const S_KNIT: Surface = { rough: 0.96, metal: 0, camo: 0, pattern: PAT.knit };
export const S_GLOVE: Surface = { rough: 0.68, metal: 0, camo: 0, pattern: PAT.leather };
export const S_BOOT: Surface = { rough: 0.62, metal: 0, camo: 0, pattern: PAT.leather };
const S_SOLE: Surface = { rough: 0.9, metal: 0, camo: 0, pattern: PAT.rubber };
// Tinted lens: glossy and half-mirrored so it reflects the environment probe.
const S_LENS: Surface = { rough: 0.05, metal: 0.45, camo: 0, pattern: PAT.gloss };
const S_VISOR: Surface = { rough: 0.06, metal: 0.28, camo: 0, pattern: PAT.gloss };
export const S_SKIN: Surface = { rough: 0.5, metal: 0, camo: 0, pattern: PAT.skin };

const GEAR = 0x1c1d1e; // black nylon / polymer
const MAG = 0x26241f;
export const GLOVE = 0x2f2c27; // dark synthetic shooting gloves
export const BOOT = 0x463a2e;
const BOOT_DUST = 0.6; // one dust gradient over the whole boot (same as the trouser hems)
const SOLE = 0x1a1918;
const LENS = 0x2a2f33;
const VISOR = 0x1a1d20;
const TAN = 0x8a7c60;
/** Knit balaclava per kit — coyote or charcoal, contrasting the uniform (never black). */
export const KNIT: Record<Kit, number> = { rifleman: 0x6b5d4a, rusher: 0x3c3d3b, heavy: 0x6b5d4a };
/** Skin in the balaclava's eye opening (≈ 0.3 / 0.22 / 0.18 linear). */
export const SKIN: Record<Kit, number> = { rifleman: 0x948276, rusher: 0x8a7462, heavy: 0x948276 };

const _ca = new THREE.Color();
const _cb = new THREE.Color();
function mixHex(a: number, b: number, t: number): number {
  return _ca.setHex(a).lerp(_cb.setHex(b), t).getHex();
}

/** The camouflage surface for a look (the rusher's print is half size). */
export function camoSurface(t: Look): Surface {
  return { ...S_CAMO_BASE, camo: t.kit === 'rusher' ? 2 : 1 };
}

// --- Small builders -----------------------------------------------------------------------
/** Matrix placing a part at `c` with its local −Z facing `n` (outward) and +Y toward `up`. */
function facing(c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().lookAt(c, c.clone().add(n), up).setPosition(c);
}

/** Smooth raised-cosine window on an angle (helmet rim profile). */
function bumpA(d: number, c: number, hw: number): number {
  const x = Math.abs(d - c);
  return x >= hw ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / hw);
}

function smooth(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Padded protector (knee / elbow): stitched binding, cordura pad, hard polymer cap. */
function pad(sink: PartSink, m: THREE.Matrix4, w: number, h: number, padColor: number): void {
  sink.add(curveZ(rbox(w + 0.008, h + 0.008, 0.014, 0.006, 1), 3.2), m.clone().multiply(trs(0, 0, 0.006)), mixHex(padColor, GEAR, 0.55), S_FABRIC);
  sink.add(curveZ(rbox(w, h, 0.026, 0.012, 1), 3.4), m, padColor, S_CORDURA);
  sink.add(curveZ(rbox(w * 0.72, h * 0.62, 0.014, 0.0068, 1), 3.8), m.clone().multiply(trs(0, 0.004, -0.017)), GEAR, S_POLY);
}

/** Design space → body bind space: flip to face +Z, then per-axis scale, then offset. */
function fit(sx: number, sy: number, sz: number, ox: number, oy: number, oz: number, pivot = V(0, 0, 0)): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(ox + pivot.x, oy + pivot.y, oz + pivot.z)
    .multiply(new THREE.Matrix4().makeScale(sx, sy, sz))
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

// --- The build ------------------------------------------------------------------------------
export function buildKit(t: Look, body: BodyFit): KitPart[] {
  const dust = new THREE.Color(0x8c7d64);
  const parts: { bone: string; sink: PartSink }[] = [];
  const sink = (bone: string, pre: THREE.Matrix4 | null = null): PartSink => {
    const s = new PartSink(dust, pre);
    parts.push({ bone, sink: s });
    return s;
  };
  const kit = t.kit;
  const heavy = kit === 'heavy';
  const rusher = kit === 'rusher';
  const uni = t.uniform;
  const vest = t.vest;
  const vestLite = mixHex(vest, TAN, 0.18);
  const vestWarm = mixHex(vest, TAN, 0.08); // pouches vary slightly in dye lot
  const vestDark = mixHex(vest, GEAR, 0.3);
  const gaiter = mixHex(KNIT[kit], uni, 0.3);
  const shells = mixHex(t.helmet, TAN, 0.35); // headset cups match the helmet, not black
  const frame = mixHex(mixHex(t.helmet, TAN, 0.3), GEAR, 0.35); // goggle frame, distinct from the knit
  const camo = camoSurface(t);
  const _p = V(0, 0, 0);
  /** Flat webbing (≈44 × 3 mm) along a bind-space path, lying on the cloth surface. */
  const webbing = (sinkTo: PartSink, pathBind: THREE.Vector3[], color: number, surf: Surface, width = 0.022, lift = 0.004): void => {
    const curve = new THREE.CatmullRomCurve3(pathBind, false, 'centripetal');
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 14; i++) pts.push(body.snap(curve.getPointAt(i / 14, _p), lift, V(0, 0, 0)));
    // Side direction = across the strap, roughly perpendicular to path and surface normal.
    sinkTo.add(sweep(pts, width, 0.0016, V(1, 0, 0), 20, 4), null, color, surf);
  };

  // ===================================================================== LEGS (bind space)
  for (const side of [1, -1] as const) {
    const L = side > 0; // body's left is +X
    const sx = (x: number): number => x * side;
    // Cargo pocket + flap on the outer thigh.
    const thigh = sink(L ? 'thigh_l' : 'thigh_r');
    const px = body.thighOuter + 0.01;
    thigh.add(rbox(0.026, 0.16, 0.13, 0.011, 1), trs(sx(px), 0.72, -0.04, 0, 0, sx(-0.06)), uni, camo, 0.6);
    thigh.add(rbox(0.03, 0.036, 0.138, 0.009, 1), trs(sx(px + 0.004), 0.798, -0.04, 0, 0, sx(-0.06)), uni, camo, 0.6);

    const calf = sink(L ? 'calf_l' : 'calf_r');
    if (!rusher) {
      // Knee pad on the front of the knee and its strap round the calf.
      pad(calf, facing(V(sx(0.118), 0.528, body.kneeFront + 0.016), V(0, 0.1, 1).normalize(), V(0, 1, 0)), 0.11, 0.13, vest);
      calf.add(
        loft(
          [
            { y: 0.455, rx: 0.07, rz: 0.088, x: sx(0.124), z: -0.055, n: 2.2 },
            { y: 0.475, rx: 0.072, rz: 0.09, x: sx(0.124), z: -0.055, n: 2.2 },
          ],
          12,
          false,
          false,
        ),
        null,
        GEAR,
        S_FABRIC,
      );
    }
    // Trousers bloused over the boot top.
    calf.add(
      loft(
        [
          { y: 0.19, rx: 0.052, rz: 0.06, x: sx(0.12), z: -0.078 },
          { y: 0.215, rx: 0.066, rz: 0.074, x: sx(0.12), z: -0.078, rip: 0.11, ripK: 6 },
          { y: 0.245, rx: 0.068, rz: 0.077, x: sx(0.121), z: -0.079, rip: 0.1, ripK: 7, ripP: 2 },
          { y: 0.275, rx: 0.062, rz: 0.07, x: sx(0.122), z: -0.08, rip: 0.05, ripK: 5 },
          { y: 0.3, rx: 0.056, rz: 0.064, x: sx(0.124), z: -0.082 },
        ],
        14,
        false,
        false,
      ),
      null,
      uni,
      camo,
      0.6,
    );

    // Boot (design space, fitted round the body's foot): padded shaft on the shin, leather upper
    // + one-piece lugged sole on the foot, heel counter, lace panel.
    const bootFit = fit(1, 1, 1, sx(0.017), 0, -0.05);
    const ds = (x: number): number => -x * side; // design-space x for this side (pre-flip)
    const shaft: Section[] = [
      { y: 0.05, rx: 0.046, rz: 0.06, x: ds(0.102), z: 0.022 },
      { y: 0.11, rx: 0.041, rz: 0.05, x: ds(0.102), z: 0.02 },
      { y: 0.16, rx: 0.045, rz: 0.053, x: ds(0.102), z: 0.018 },
      { y: 0.21, rx: 0.05, rz: 0.057, x: ds(0.102), z: 0.018 },
      { y: 0.235, rx: 0.052, rz: 0.058, x: ds(0.102), z: 0.018 },
      { y: 0.248, rx: 0.048, rz: 0.054, x: ds(0.102), z: 0.018 },
    ];
    sink(L ? 'calf_l' : 'calf_r', bootFit).add(loft(shaft, 12), null, BOOT, S_BOOT, BOOT_DUST);
    const foot = sink(L ? 'foot_l' : 'foot_r', bootFit);
    const footSecs: Section[] = [
      { y: -0.088, rx: 0.03, rz: 0.034, z: 0.062, n: 2.4 },
      { y: -0.075, rx: 0.04, rz: 0.054, z: 0.07, n: 2.4 },
      { y: -0.03, rx: 0.044, rz: 0.062, z: 0.076, n: 2.4 },
      { y: 0.03, rx: 0.046, rz: 0.057, z: 0.071, n: 2.5 },
      { y: 0.085, rx: 0.045, rz: 0.04, z: 0.056, n: 2.4 },
      { y: 0.135, rx: 0.043, rz: 0.03, z: 0.046, n: 2.3 },
      { y: 0.175, rx: 0.038, rz: 0.025, z: 0.041, n: 2.1 },
      { y: 0.2, rx: 0.029, rz: 0.02, z: 0.039, n: 2 },
      { y: 0.213, rx: 0.016, rz: 0.013, z: 0.039, n: 2 },
    ];
    foot.add(loft(footSecs, 12), trs(ds(0.102), 0, 0.02, -Math.PI / 2), BOOT, S_BOOT, BOOT_DUST);
    const soleSecs: Section[] = [
      { y: -0.094, rx: 0.028, rz: 0.01, z: 0.015, n: 3.2 },
      { y: -0.086, rx: 0.038, rz: 0.016, z: 0.016, n: 3.6 },
      { y: -0.03, rx: 0.041, rz: 0.016, z: 0.016, n: 3.6 },
      { y: 0.0, rx: 0.039, rz: 0.012, z: 0.017, n: 3.6 },
      { y: 0.06, rx: 0.046, rz: 0.012, z: 0.014, n: 3.6 },
      { y: 0.13, rx: 0.048, rz: 0.012, z: 0.014, n: 3.6 },
      { y: 0.18, rx: 0.043, rz: 0.011, z: 0.018, n: 3.2 },
      { y: 0.207, rx: 0.032, rz: 0.009, z: 0.023, n: 2.8 },
      { y: 0.22, rx: 0.015, rz: 0.006, z: 0.026, n: 2.4 },
    ];
    foot.add(loft(soleSecs, 14), trs(ds(0.102), 0, 0.02, -Math.PI / 2), SOLE, S_SOLE);
    foot.add(curveZ(rbox(0.078, 0.046, 0.026, 0.01, 1), -3.4), trs(ds(0.102), 0.062, 0.098, 0.12), mixHex(BOOT, GEAR, 0.2), S_BOOT, BOOT_DUST);
    // Laced tongue: a low panel of the same leather (the woven surface reads as laces close up).
    foot.add(rbox(0.032, 0.006, 0.09, 0.003, 1), trs(ds(0.102), 0.112, -0.048, -0.4), mixHex(BOOT, GEAR, 0.12), S_FABRIC, BOOT_DUST);
  }

  // ===================================================================== PELVIS (design space)
  const beltA = (body.beltFront - body.beltBack + 0.012) / 0.262;
  const beltC = body.beltFront + 0.006 - 0.127 * beltA;
  const hips = sink('pelvis', fit((body.beltSide + 0.006) / 0.17, 1, beltA, 0, 0, beltC));
  hips.add(
    loft(
      [
        { y: 0.97, rx: 0.168, rz: 0.114, n: 2.6, back: 1.08 },
        { y: 0.978, rx: 0.182, rz: 0.127, n: 2.6, back: 1.08 },
        { y: 1.036, rx: 0.182, rz: 0.127, n: 2.6, back: 1.06 },
        { y: 1.044, rx: 0.17, rz: 0.116, n: 2.6, back: 1.06 },
      ],
      18,
      false,
      false,
    ),
    null,
    vest,
    S_CORDURA,
  );
  hips.add(rbox(0.062, 0.044, 0.018, 0.006, 1), trs(0, 1.008, -0.132), GEAR, S_METAL);
  // Pistol-mag pouches + a belt holster on the gun side; IFAK + dump pouch on the back.
  hips.add(rbox(0.03, 0.078, 0.045, 0.007, 1), trs(-0.178, 1.0, -0.062, 0, 0.35), vest, S_FABRIC);
  hips.add(rbox(0.03, 0.078, 0.045, 0.007, 1), trs(-0.19, 1.0, -0.012, 0, 0.12), vest, S_FABRIC);
  hips.add(rbox(0.036, 0.17, 0.078, 0.012, 1), trs(0.2, 0.935, 0.03, 0, 0, -0.06), GEAR, S_POLY);
  hips.add(rbox(0.03, 0.05, 0.034, 0.008, 1), trs(0.198, 1.04, 0.052, 0.25), GEAR, S_POLY);
  if (!rusher) {
    hips.add(curveZ(rbox(0.15, 0.1, 0.06, 0.016, 1), -1.2), trs(0, 0.985, 0.168), vest, S_FABRIC);
    hips.add(rbox(0.1, 0.075, 0.055, 0.02, 1), trs(-0.125, 0.985, 0.135, 0, 0.55), mixHex(vest, GEAR, 0.4), S_FABRIC);
  }
  if (heavy) hips.add(curveZ(rbox(0.15, 0.13, 0.024, 0.012, 1), 1.6), trs(0, 0.9, -0.112, 0.1), vest, S_CORDURA);

  // ===================================================================== CHEST (design space)
  // Solve the chest pre-transform so the armour's inner faces sit 1–2 cm off the cloth:
  // design z → bind z = −a·z + c (flip), design x → −sx·x.
  const pd = heavy ? 0.062 : 0.046; // plate bag thickness
  const pz = heavy ? 0.163 : 0.152;
  const zF = rusher ? -0.115 : -(pz - pd / 2); // design z of the front inner face
  const zB = rusher ? 0.115 : pz - 0.008 - pd / 2; // design z of the back inner face
  const gap = 0.014;
  const chA = (body.chestFront - body.chestBack + 2 * gap) / (zB - zF);
  const chC = body.chestFront + gap + chA * zF;
  const cr = heavy ? 0.205 : 0.196;
  const chSx = (body.chestSide + gap) / (rusher ? 0.16 : cr - 0.01);
  const chestFit = fit(chSx, 1, chA, 0, 0.03, chC);
  const chest = sink('spine_03', chestFit); // cummerbund + side pouches: wraps the measured girth
  // Plates + front pouches keep their design depth; each face sits `gap` off the cloth.
  const front = sink('spine_03', fit(1.05, 1, 1, 0, 0.03, body.chestFront + gap + zF));
  const back = sink('spine_03', fit(1.05, 1, 1, 0, 0.03, body.chestBack - gap + zB));
  const neck = sink('spine_03', fit(1, 1, 1.2, 0, 0.03, -0.012)); // collar / neck guard
  const straps = sink(BODY_SKIN); // bind space: webbing laid on the cloth, skinned with it
  const toBind = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(chestFit);
  // Shirt collar standing round the neck.
  neck.add(
    loft(
      [
        { y: 1.47, rx: 0.104, rz: 0.088, z: 0.0 },
        { y: 1.495, rx: 0.1, rz: 0.084, z: 0.0, rip: 0.04, ripK: 5 },
        { y: 1.525, rx: 0.097, rz: 0.082, z: 0.0 },
        { y: 1.53, rx: 0.091, rz: 0.076, z: 0.0 },
      ],
      14,
      false,
      false,
    ),
    null,
    uni,
    camo,
  );
  const strapPath = (s: number): THREE.Vector3[] => [
    toBind(s * 0.095, 1.44, -0.15),
    toBind(s * 0.104, 1.5, -0.1),
    toBind(s * 0.11, 1.545, -0.02),
    toBind(s * 0.106, 1.52, 0.06),
    toBind(s * 0.1, 1.47, 0.13),
  ];
  // X-harness of the light chest rig: up from the mag panel, over the shoulder, across the back.
  const harnessPath = (s: number): THREE.Vector3[] => [
    toBind(s * 0.1, 1.27, -0.14),
    toBind(s * 0.11, 1.46, -0.1),
    toBind(s * 0.112, 1.545, -0.012),
    toBind(s * 0.095, 1.47, 0.12),
    toBind(0, 1.3, 0.14),
    toBind(-s * 0.1, 1.14, 0.125),
  ];
  if (rusher) {
    // Light chest rig: a mag panel on an X-harness + waist strap. No plates, no back panel.
    front.add(curveZ(rbox(0.29, 0.15, 0.03, 0.01, 1), 0.9), trs(0, 1.2, -0.13, 0.05), vest, S_CORDURA);
    for (const x of [-0.105, -0.035, 0.035, 0.105]) {
      const zf = -0.145 + 0.9 * x * x;
      front.add(rbox(0.062, 0.105, 0.03, 0.008, 1), trs(x, 1.2, zf - 0.015, 0.05), vestWarm, S_FABRIC);
      front.add(rbox(0.056, 0.06, 0.024, 0.006, 1), trs(x, 1.27, zf - 0.017, 0.12), MAG, S_POLY);
    }
    chest.add(
      loft(
        [
          { y: 1.105, rx: 0.157, rz: 0.11, n: 2.5 },
          { y: 1.11, rx: 0.162, rz: 0.115, n: 2.5 },
          { y: 1.135, rx: 0.163, rz: 0.116, n: 2.5 },
          { y: 1.14, rx: 0.158, rz: 0.111, n: 2.5 },
        ],
        16,
        false,
        false,
      ),
      null,
      vestDark,
      S_FABRIC,
    );
    for (const s of [-1, 1]) webbing(straps, harnessPath(s), vestDark, S_FABRIC, 0.02);
    chest.add(rbox(0.04, 0.12, 0.066, 0.009, 1), trs(-0.185, 1.21, 0.0, 0, 0, 0.06), vestDark, S_FABRIC);
    chest.add(rbox(0.036, 0.04, 0.056, 0.007, 1), trs(-0.188, 1.29, 0.0, 0, 0, 0.06), GEAR, S_POLY);
  } else {
    // Plate carrier: front + back plate bags (curved), cummerbund round the sides.
    const pw = heavy ? 0.33 : 0.3;
    const plate = heavy ? mixHex(vest, 0x5a5e60, 0.25) : vest; // heavy plates read a step lighter
    front.add(curveZ(rbox(pw, heavy ? 0.36 : 0.335, pd, 0.018, 2), 0.6), trs(0, 1.285, -pz, 0.07), plate, S_CORDURA);
    back.add(curveZ(rbox(pw + 0.005, heavy ? 0.37 : 0.35, pd, 0.018, 2), -0.6), trs(0, 1.3, pz - 0.008, -0.05), plate, S_CORDURA);
    chest.add(
      loft(
        [
          { y: 1.1, rx: 0.17, rz: 0.12, n: 2.7 },
          { y: 1.11, rx: cr - 0.01, rz: 0.134, n: 2.7 },
          { y: 1.265, rx: cr, rz: 0.134, n: 2.7 },
          { y: 1.275, rx: cr - 0.01, rz: 0.124, n: 2.7 },
        ],
        18,
        false,
        false,
      ),
      null,
      vest,
      S_CORDURA,
    );
    for (const s of [-1, 1]) {
      const strap = strapPath(s);
      webbing(straps, strap, vest, S_FABRIC, 0.024);
      webbing(straps, strap.slice(1, 4), vestLite, S_FABRIC, 0.027, 0.008); // shoulder pad
    }
    // Triple open-top mag pouches with the magazines showing.
    const fz = -(pz + pd / 2) + 0.001;
    for (const x of [-0.083, 0, 0.083]) {
      const zf = fz + 0.6 * x * x;
      front.add(curveZ(rbox(0.077, 0.112, 0.037, 0.009, 1), 0.6), trs(x, 1.195, zf - 0.017, 0.07), vestWarm, S_FABRIC);
      front.add(rbox(0.066, 0.07, 0.026, 0.006, 1), trs(x, 1.272, zf - 0.02, 0.16), MAG, S_POLY);
    }
    // Admin pouch + blank hook-and-loop patch (no insignia).
    front.add(curveZ(rbox(0.2, 0.086, 0.026, 0.009, 1), 0.6), trs(0, 1.358, fz - 0.012, 0.07), vestWarm, S_FABRIC);
    front.add(rbox(0.09, 0.05, 0.004, 0.002, 1), trs(-0.03, 1.36, fz - 0.027, 0.07), vestLite, S_FABRIC);
    // Radio pouch + radio on the left cummerbund, utility pouch on the right.
    chest.add(rbox(0.046, 0.15, 0.078, 0.01, 1), trs(-(cr + 0.026), 1.2, 0.035, 0, 0, 0.04), vestDark, S_FABRIC);
    chest.add(rbox(0.04, 0.05, 0.066, 0.008, 1), trs(-(cr + 0.028), 1.296, 0.035, 0, 0, 0.04), GEAR, S_POLY);
    chest.add(rbox(0.05, 0.12, 0.09, 0.012, 1), trs(cr + 0.026, 1.18, 0.04), vestDark, S_FABRIC);
    if (heavy) {
      // Side plates over the cummerbund + a high neck guard (lower in front).
      for (const s of [-1, 1]) chest.add(rbox(0.026, 0.17, 0.15, 0.01, 1), trs(s * (cr + 0.012), 1.205, -0.02), vestDark, S_CORDURA);
      const g = loft(
        [
          { y: 1.45, rx: 0.128, rz: 0.1, n: 2.2 },
          { y: 1.47, rx: 0.12, rz: 0.094, n: 2.2 },
          { y: 1.56, rx: 0.108, rz: 0.088, z: 0.004, n: 2.2, rip: 0.03, ripK: 8 },
          { y: 1.575, rx: 0.102, rz: 0.082, z: 0.004, n: 2.2 },
        ],
        16,
        false,
        false,
      );
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (y > 1.46) p.setY(i, y - 0.055 * smooth(0.0, -0.09, p.getZ(i)));
      }
      g.computeVertexNormals();
      neck.add(g, null, vest, S_CORDURA);
    } else {
      // Low-profile assault pack on the back panel + drag handle.
      back.add(curveZ(rbox(0.25, 0.3, 0.06, 0.022, 1), -0.8), trs(0, 1.29, pz + 0.048), mixHex(vest, uni, 0.3), S_CORDURA);
      back.add(sweep([V(-0.045, 1.465, pz + 0.013), V(0, 1.5, pz + 0.018), V(0.045, 1.465, pz + 0.013)], 0.012, 0.006, V(0, 0, 1), 6), null, GEAR, S_FABRIC);
    }
  }
  // Whip antenna + PTT cable from the radio (all kits carry a radio on the left).
  const rx = rusher ? -0.188 : -(heavy ? 0.233 : 0.224);
  const rz = rusher ? 0.0 : 0.035;
  chest.add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6), trs(rx - 0.002, 1.325, rz + 0.015), GEAR, S_POLY);
  chest.add(new THREE.CylinderGeometry(0.0035, 0.005, 0.25, 5), trs(rx - 0.002, 1.335 + 0.125, rz + 0.02, -0.08), GEAR, S_POLY);
  {
    // PTT cable: from the radio forward, then up along the left shoulder strap, lying on the cloth.
    const radio = toBind(rx + 0.02, 1.27, rz - 0.035);
    const strap = rusher ? harnessPath(-1) : strapPath(-1);
    const curve = new THREE.CatmullRomCurve3([radio, body.snap(strap[0], 0.012, V(0, 0, 0)), body.snap(strap[1], 0.012, V(0, 0, 0))], false, 'centripetal');
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const c = curve.getPointAt(i / 8, V(0, 0, 0));
      pts.push(i < 2 ? c : body.snap(c, 0.01, c));
    }
    straps.add(sweep(pts, 0.0035, 0.0035, V(1, 0, 0), 10, 4), null, GEAR, S_POLY);
  }

  // ===================================================================== ARMS (bind space)
  // T-pose: arms along ±X at y ≈ 1.45, palms down, elbow points back (−Z).
  for (const side of [1, -1] as const) {
    const L = side > 0;
    const sx = (x: number): number => x * side;
    const upper = sink(L ? 'upperarm_l' : 'upperarm_r');
    const lower = sink(L ? 'lowerarm_l' : 'lowerarm_r');
    // Elbow pad on the point of the elbow.
    pad(lower, facing(V(sx(0.47), 1.44, body.elbowBack - 0.016), V(0, 0, -1), V(1, 0, 0)), 0.075, 0.09, vest);
    // Blank hook-and-loop patch on the outside of the upper sleeve.
    upper.add(rbox(0.07, 0.006, 0.06, 0.003, 1), trs(sx(0.33), 1.516, -0.07), mixHex(vest, TAN, 0.18), S_FABRIC);
    // Glove gauntlet over the cuff.
    const cuff = loft(
      [
        { y: 0, rx: 0.044, rz: 0.044, z: 0 },
        { y: 0.012, rx: 0.05, rz: 0.048 },
        { y: 0.045, rx: 0.049, rz: 0.046 },
        { y: 0.052, rx: 0.044, rz: 0.042 },
      ],
      12,
      false,
      false,
    );
    lower.add(cuff, alongMatrix(V(sx(0.652), 1.448, -0.072), V(sx(0.75), 1.448, -0.072)), GLOVE, S_GLOVE);
    // Sleeve cuff: a turned band of the shirt just above the glove.
    const sleeve = loft(
      [
        { y: 0, rx: 0.05, rz: 0.048 },
        { y: 0.008, rx: 0.058, rz: 0.055, rip: 0.05, ripK: 5 },
        { y: 0.036, rx: 0.057, rz: 0.054 },
        { y: 0.042, rx: 0.05, rz: 0.048 },
      ],
      12,
      false,
      false,
    );
    lower.add(sleeve, alongMatrix(V(sx(0.6), 1.448, -0.072), V(sx(0.7), 1.448, -0.072)), new THREE.Color(uni).multiplyScalar(1.05).getHex(), { ...camo, camo: camo.camo * 1.08 });
    if (heavy) {
      // Shoulder armour draped over the deltoid.
      upper.add(curveZ(rbox(0.12, 0.1, 0.022, 0.01, 1), 6), facing(V(sx(0.255), 1.54, -0.07), V(sx(0.55), 0.84, 0).normalize(), V(0, 0, 1)), vest, S_CORDURA);
    }
  }

  // ===================================================================== HEAD (design space)
  const headFit = fit(1.15, 1, 1.05, 0, 1.695 - 1.665, -0.004 + 0.014, V(0, 1.665, -0.014));
  const head = sink('Head', headFit);
  // Helmet group: shell 8% smaller, seated 1.5 cm lower (design space, about the shell centre).
  const hc = V(0, 1.705, 0.002);
  const helm = sink(
    'Head',
    headFit
      .clone()
      .multiply(new THREE.Matrix4().makeTranslation(hc.x, hc.y - 0.015, hc.z))
      .multiply(new THREE.Matrix4().makeScale(0.92, 0.92, 0.92))
      .multiply(new THREE.Matrix4().makeTranslation(-hc.x, -hc.y, -hc.z)),
  );
  // Neck gaiter pulled up over nose and mouth to the eyewear; drops lower at the nape.
  {
    const g = loft(
      [
        { y: 1.488, rx: 0.068, rz: 0.07, z: -0.004 },
        { y: 1.505, rx: 0.077, rz: 0.08, z: -0.006, rip: 0.08, ripK: 5 },
        { y: 1.535, rx: 0.083, rz: 0.086, z: -0.01, rip: 0.11, ripK: 6, ripP: 1 },
        { y: 1.568, rx: 0.077, rz: 0.088, z: -0.018, front: 1.08, rip: 0.07, ripK: 7, ripP: 2.2 },
        { y: 1.6, rx: 0.071, rz: 0.092, z: -0.022, front: 1.12, rip: 0.04, ripK: 5 },
        { y: 1.622, rx: 0.08, rz: 0.1, z: -0.018, front: 1.08, rip: 0.03, ripK: 6, ripP: 0.7 },
        { y: 1.64, rx: 0.082, rz: 0.1, z: -0.016, front: 1.04 },
      ],
      18,
      false,
      false,
    );
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y <= 1.56) continue;
      const back = Math.max(0, Math.min(1, (p.getZ(i) + 0.015) / 0.09));
      p.setY(i, 1.56 + (y - 1.56) * (1 - 0.75 * back));
    }
    g.computeVertexNormals();
    head.add(g, null, gaiter, S_KNIT);
  }
  const arc = (ax: number, az: number, y: number, a0: number, a1: number, n: number, cz = -0.014): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = THREE.MathUtils.lerp(a0, a1, i / n);
      pts.push(V(ax * Math.sin(a), y, cz - az * Math.cos(a)));
    }
    return pts;
  };
  if (heavy) {
    // Smoked ballistic visor hinged on the helmet, covering the whole face.
    head.add(sweep(arc(0.104, 0.122, 1.635, -1.32, 1.32, 8), 0.08, 0.004, V(0, 1, 0), 12, 6), null, VISOR, S_VISOR);
    head.add(sweep(arc(0.106, 0.124, 1.713, -1.32, 1.32, 8), 0.007, 0.006, V(0, 1, 0), 12, 4), null, GEAR, S_POLY);
  } else if (rusher) {
    // Thin ballistic glasses: 8 mm frame bar, tinted wrap lens, temple arms.
    head.add(sweep(arc(0.087, 0.106, 1.693, -1.2, 1.2, 8), 0.004, 0.004, V(0, 1, 0), 12, 4), null, GEAR, S_POLY);
    head.add(sweep(arc(0.088, 0.108, 1.677, -1.1, 1.1, 6), 0.015, 0.0025, V(0, 1, 0), 10, 6), null, LENS, S_LENS);
    for (const sgn of [1, -1]) {
      head.add(sweep(arc(0.087, 0.104, 1.693, sgn * 1.2, sgn * 1.75, 3), 0.003, 0.002, V(0, 1, 0), 4, 4), null, GEAR, S_POLY);
    }
  }
  // Helmet: high-cut shell with brow, deep ear cut-outs (headset cups inside) and nape.
  const HAX = 0.123;
  const HAY = 0.12;
  const HAZ = 0.138;
  const rim = (phi: number): number => {
    const d = phi <= Math.PI ? phi : Math.PI * 2 - phi; // angular distance from the front
    return 1.724 + 0.042 * bumpA(d, Math.PI * 0.5, Math.PI * 0.27) - 0.012 * bumpA(d, Math.PI * 0.24, Math.PI * 0.12) - 0.06 * smooth(Math.PI * 0.62, Math.PI * 0.95, d);
  };
  const FLARE = 0.018; // brim overhang (was 0.045: −60%)
  helm.add(helmetShell(hc, HAX, HAY, HAZ, rim, 28, 10, FLARE), null, t.helmet, S_HELMET);
  const onShell = (phi: number, y: number, out = 1.0): THREE.Vector3 => {
    const th = Math.acos(THREE.MathUtils.clamp((y - hc.y) / HAY, -0.99, 0.99));
    const fl = 1 + FLARE * Math.pow(th / Math.acos(THREE.MathUtils.clamp((rim(phi) - hc.y) / HAY, -0.6, 0.98)), 3);
    return V(hc.x + HAX * Math.sin(th) * Math.sin(phi) * out * fl, y, hc.z - HAZ * Math.sin(th) * Math.cos(phi) * out * fl);
  };
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const d = THREE.MathUtils.lerp(Math.PI * 0.3, Math.PI * 0.74, i / 5);
      const phi = s > 0 ? d : Math.PI * 2 - d;
      pts.push(onShell(phi, rim(phi) + 0.022, 1.02));
    }
    helm.add(sweep(pts, 0.012, 0.006, V(0, 1, 0), 8), null, GEAR, S_POLY);
  }
  if (!rusher) {
    // NVG shroud + folded mount at the brow, counterweight pouch at the nape, IR strobe on top.
    const f = onShell(0, 1.752, 1.0);
    helm.add(rbox(0.062, 0.044, 0.014, 0.005, 1), trs(f.x, f.y, f.z - 0.006, 0.4), GEAR, S_METAL);
    helm.add(rbox(0.036, 0.03, 0.034, 0.006, 1), trs(f.x, f.y - 0.022, f.z - 0.018, 0.2), GEAR, S_METAL);
    const b = onShell(Math.PI, 1.705, 1.0);
    helm.add(curveZ(rbox(0.1, 0.06, 0.034, 0.012, 1), -1.6), trs(b.x, b.y, b.z + 0.014, -0.15), mixHex(t.helmet, GEAR, 0.4), S_FABRIC);
    const top = onShell(Math.PI, 1.815, 1.0);
    helm.add(rbox(0.026, 0.016, 0.03, 0.005, 1), trs(top.x, top.y + 0.004, top.z, -0.5), GEAR, S_POLY);
  }
  if (kit === 'rifleman') {
    // Goggles pushed up onto the helmet front: frame + tinted lens, strap round the shell.
    const y = 1.775;
    const th = Math.acos((y - hc.y) / HAY);
    const gx = HAX * Math.sin(th) + 0.011;
    const gz = HAZ * Math.sin(th) + 0.011;
    const ga = (a0: number, a1: number, n: number, grow: number): THREE.Vector3[] => arc(gx + grow, gz + grow, y, a0, a1, n, hc.z);
    helm.add(sweep(ga(-1.15, 1.15, 8, 0), 0.02, 0.009, V(0, 1, 0), 12, 8), null, frame, S_POLY);
    helm.add(sweep(ga(-0.95, 0.95, 6, 0.008), 0.015, 0.003, V(0, 1, 0), 10, 6), null, LENS, S_LENS);
    helm.add(sweep(ga(1.1, Math.PI * 2 - 1.1, 10, -0.004), 0.011, 0.003, V(0, 1, 0), 12, 4), null, mixHex(frame, GEAR, 0.5), S_FABRIC);
  }
  // Electronic ear protection on rail arms.
  for (const s of [1, -1]) {
    const cup = loft(
      [
        { y: 0, rx: 0.042, rz: 0.036, n: 2.3 },
        { y: 0.012, rx: 0.05, rz: 0.044, n: 2.3 },
        { y: 0.03, rx: 0.05, rz: 0.044, n: 2.3 },
        { y: 0.042, rx: 0.04, rz: 0.034, n: 2.3 },
        { y: 0.047, rx: 0.024, rz: 0.02, n: 2.2 },
      ],
      14,
    );
    head.add(cup, trs(s * 0.083, 1.655, 0.006, 0, 0, -s * Math.PI * 0.5), shells, S_POLY);
    head.add(rbox(0.012, 0.04, 0.022, 0.004, 1), trs(s * 0.114, 1.7, 0.008, 0, 0, s * 0.18), GEAR, S_POLY);
  }
  head.add(
    sweep(
      [V(-0.098, 1.705, -0.01), V(-0.084, 1.625, -0.028), V(-0.05, 1.57, -0.07), V(0, 1.56, -0.088), V(0.05, 1.57, -0.07), V(0.084, 1.625, -0.028), V(0.098, 1.705, -0.01)],
      0.009,
      0.003,
      V(0, 0, 1),
      10,
      4,
    ),
    null,
    GEAR,
    S_FABRIC,
  );

  const origin = V(0, 0, 0);
  return parts.filter((p) => p.sink.triangles > 0).map((p) => ({ bone: p.bone, geo: p.sink.build(origin) }));
}
