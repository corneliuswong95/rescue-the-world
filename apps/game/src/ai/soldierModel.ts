/**
 * Code-authored modern infantry soldier (original design — no ripped assets, patterns or
 * insignia). Builds the kit as rounded forms baked into one geometry per rigid segment:
 *
 *   hips ─┬─ chest (torso, plate carrier, arms + gloves holding the rifle) ── head (helmet…)
 *         ├─ thighL ── shinL ── footL
 *         └─ thighR ── shinR ── footR
 *
 * Proportions target a 1.80 m adult in kit: head ≈ 0.24 m (1/7.5), hip pivot ≈ 0.93 m,
 * shoulders ≈ 0.47 m across the deltoids with armour. Authored in model space (feet at y = 0,
 * forward -Z, right +X); the upper body is bladed ~13° toward the gun side, as a real shooter
 * stands, so the support hand can reach the handguard.
 *
 * Geometry is cached per tint (archetype) and shared by every soldier of that look.
 */
import * as THREE from 'three/webgpu';
import {
  PartSink,
  alongMatrix,
  curveZ,
  helmetShell,
  limb,
  loft,
  rbox,
  sweep,
  trs,
  type Section,
} from './soldierGeometry';
import { PAT, type Surface } from './soldierMaterial';

export interface Tint {
  uniform: number;
  vest: number;
  helmet: number;
}

/** Segment ids (index into the geometry / pivot arrays). */
export const SEG = {
  hips: 0,
  chest: 1,
  head: 2,
  thighL: 3,
  shinL: 4,
  footL: 5,
  thighR: 6,
  shinR: 7,
  footR: 8,
} as const;
export const SEG_COUNT = 9;

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Joint pivots in model space (rest pose). */
export const PIVOT: readonly THREE.Vector3[] = [
  V(0, 0.96, 0),
  V(0, 1.06, 0),
  V(0, 1.5, -0.01),
  V(-0.092, 0.925, 0.005),
  V(-0.098, 0.505, -0.012),
  V(-0.102, 0.088, 0.018),
  V(0.092, 0.925, 0.005),
  V(0.098, 0.505, -0.012),
  V(0.102, 0.088, 0.018),
];
/** Parent segment of each segment (-1 = attached to the model root). */
export const PARENT: readonly number[] = [-1, 0, 1, 0, 3, 4, 0, 6, 7];

/** Rifle placement in model space: barrel along local -Z, grip near the origin. */
const RIFLE_EULER = new THREE.Euler(-0.2, 0.035, 0.02);
const RIFLE_BUTT_LOCAL = V(0, 0.006, 0.285);
const RIFLE_BUTT_AT = V(0.112, 1.372, -0.14);
export const RIFLE_QUAT = new THREE.Quaternion().setFromEuler(RIFLE_EULER);
export const RIFLE_POS = RIFLE_BUTT_AT.clone().sub(RIFLE_BUTT_LOCAL.clone().applyQuaternion(RIFLE_QUAT));
const RIFLE_M = new THREE.Matrix4().compose(RIFLE_POS, RIFLE_QUAT, V(1, 1, 1));
const MUZZLE_LOCAL = V(0, 0.012, -0.6);

/** A ground-contact probe: a point on a segment's outer hull (model space at rest). */
export interface Probe {
  seg: number;
  p: THREE.Vector3;
  /** Foot-sole probes drive ground contact while alive; all probes are used while dying. */
  sole: boolean;
}

export interface RigDef {
  geos: THREE.BufferGeometry[];
  probes: Probe[];
}

// --- Surfaces ---------------------------------------------------------------------------
const S_CAMO: Surface = { rough: 0.9, metal: 0, camo: 1, pattern: PAT.fabric };
const S_FABRIC: Surface = { rough: 0.88, metal: 0, camo: 0, pattern: PAT.fabric };
const S_CORDURA: Surface = { rough: 0.8, metal: 0, camo: 0, pattern: PAT.cordura };
const S_POLY: Surface = { rough: 0.5, metal: 0.04, camo: 0, pattern: PAT.plain };
const S_METAL: Surface = { rough: 0.5, metal: 0.35, camo: 0, pattern: PAT.plain };
const S_HELMET: Surface = { rough: 0.74, metal: 0, camo: 0, pattern: PAT.plain };
const S_KNIT: Surface = { rough: 0.96, metal: 0, camo: 0, pattern: PAT.knit };
const S_GLOVE: Surface = { rough: 0.68, metal: 0, camo: 0, pattern: PAT.leather };
const S_BOOT: Surface = { rough: 0.62, metal: 0, camo: 0, pattern: PAT.leather };
const S_SOLE: Surface = { rough: 0.9, metal: 0, camo: 0, pattern: PAT.rubber };
const S_LENS: Surface = { rough: 0.05, metal: 0.55, camo: 0, pattern: PAT.gloss };

const GEAR = 0x1c1d1e; // black nylon / polymer
const MAG = 0x26241f;
const GLOVE = 0x40372d;
const BOOT = 0x463a2e;
const SOLE = 0x1a1918;
const KNIT = 0x2b2c27;
const LENS = 0x2a2620;
const DUST = 0x8c7d64;
const TAN = 0x8a7c60;

const _ca = new THREE.Color();
const _cb = new THREE.Color();
function mixHex(a: number, b: number, t: number): number {
  return _ca.setHex(a).lerp(_cb.setHex(b), t).getHex();
}

// --- Small builders -------------------------------------------------------------------
function capsuleAB(a: THREE.Vector3, b: THREE.Vector3, r: number): [THREE.BufferGeometry, THREE.Matrix4] {
  const len = a.distanceTo(b);
  const g = new THREE.CapsuleGeometry(r, len, 2, 6, 1);
  g.translate(0, len / 2, 0);
  return [g, alongMatrix(a, b)];
}

function sphere(r: number, w = 12, h = 8): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

/** Two-bone IK at build time: elbow for shoulder `s` → wrist `w`, bending toward `pole`. */
function solveElbow(s: THREE.Vector3, w: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3): THREE.Vector3 {
  const d = w.clone().sub(s);
  const len = d.length();
  const dir = d.multiplyScalar(1 / len);
  const reach = (l1 + l2) * 0.995;
  if (len > reach) {
    const k = len / reach;
    l1 *= k;
    l2 *= k;
  }
  const a = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  return s.clone().addScaledVector(dir, a).addScaledVector(perp, h);
}

/** Smooth raised-cosine window on an angle (used for the helmet rim profile). */
function bumpA(d: number, c: number, hw: number): number {
  const x = Math.abs(d - c);
  return x >= hw ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / hw);
}

function smooth(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- The build ------------------------------------------------------------------------------
function build(t: Tint): RigDef {
  const dust = new THREE.Color(DUST);
  const sinks = Array.from({ length: SEG_COUNT }, () => new PartSink(dust));
  const probes: Probe[] = [];
  const probe = (seg: number, p: THREE.Vector3, sole = false): void => {
    probes.push({ seg, p, sole });
  };

  const uni = t.uniform;
  const vest = t.vest;
  const vestLite = mixHex(vest, TAN, 0.18);
  const vestWarm = mixHex(vest, TAN, 0.08); // pouches vary slightly in dye lot
  const vestDark = mixHex(vest, GEAR, 0.3);
  const scarf = mixHex(uni, 0x5e5747, 0.55); // muted knit gaiter, reads as fabric not skin

  // ========================================================================= LEGS
  for (const side of [-1, 1] as const) {
    const thigh = sinks[side < 0 ? SEG.thighL : SEG.thighR];
    const shin = sinks[side < 0 ? SEG.shinL : SEG.shinR];
    const foot = sinks[side < 0 ? SEG.footL : SEG.footR];
    const sx = (x: number): number => x * side;

    // Thigh — quads forward, hamstrings back, tapering into the knee, trouser folds above it.
    const thighSecs: Section[] = [
      { y: 0.47, rx: 0.063, rz: 0.064, x: sx(0.099), z: -0.012 },
      { y: 0.52, rx: 0.067, rz: 0.069, x: sx(0.099), z: -0.012, rip: 0.06, ripK: 6 },
      { y: 0.585, rx: 0.073, rz: 0.077, x: sx(0.099), z: -0.01, rip: 0.07, ripK: 5, ripP: 1.3 },
      { y: 0.66, rx: 0.08, rz: 0.084, x: sx(0.099), z: -0.007, rip: 0.04, ripK: 7 },
      { y: 0.75, rx: 0.087, rz: 0.091, x: sx(0.099), z: -0.004, front: 1.04, rip: 0.02, ripK: 4 },
      { y: 0.84, rx: 0.092, rz: 0.096, x: sx(0.098), z: 0 },
      { y: 0.92, rx: 0.095, rz: 0.1, x: sx(0.097), z: 0.006 },
      { y: 0.985, rx: 0.088, rz: 0.094, x: sx(0.094), z: 0.006 },
    ];
    thigh.add(loft(thighSecs, 16), null, uni, S_CAMO, 0.6);
    // Cargo pocket + flap on the outer thigh.
    thigh.add(rbox(0.028, 0.16, 0.13, 0.011, 1), trs(sx(0.19), 0.725, 0.004, 0, 0, sx(-0.06)), uni, S_CAMO, 0.6);
    thigh.add(rbox(0.032, 0.036, 0.138, 0.009, 1), trs(sx(0.195), 0.803, 0.004, 0, 0, sx(-0.06)), uni, S_CAMO, 0.6);

    // Shin — calf bulge behind, trousers bloused over the boot top.
    const shinSecs: Section[] = [
      { y: 0.17, rx: 0.05, rz: 0.055, x: sx(0.102), z: 0.018 },
      { y: 0.225, rx: 0.063, rz: 0.068, x: sx(0.102), z: 0.017, rip: 0.11, ripK: 6 },
      { y: 0.255, rx: 0.065, rz: 0.07, x: sx(0.102), z: 0.015, rip: 0.1, ripK: 7, ripP: 2 },
      { y: 0.29, rx: 0.057, rz: 0.062, x: sx(0.101), z: 0.013, rip: 0.05, ripK: 5 },
      { y: 0.345, rx: 0.059, rz: 0.066, x: sx(0.1), z: 0.014, back: 1.08 },
      { y: 0.4, rx: 0.062, rz: 0.068, x: sx(0.099), z: 0.008, back: 1.05, rip: 0.03, ripK: 6 },
      { y: 0.47, rx: 0.064, rz: 0.066, x: sx(0.098), z: -0.004, rip: 0.05, ripK: 5 },
      { y: 0.545, rx: 0.066, rz: 0.068, x: sx(0.098), z: -0.012 },
    ];
    shin.add(loft(shinSecs, 16), null, uni, S_CAMO, 0.6);
    // Knee pad: curved shell over a soft pad, with a strap round the calf.
    shin.add(curveZ(rbox(0.112, 0.135, 0.032, 0.015, 2), 3.6), trs(sx(0.098), 0.5, -0.088, -0.1), vest, S_CORDURA, 0.6);
    shin.add(curveZ(rbox(0.08, 0.088, 0.016, 0.0075, 1), 4.0), trs(sx(0.098), 0.505, -0.11, -0.1), GEAR, S_POLY, 0.6);
    shin.add(
      loft(
        [
          { y: 0.425, rx: 0.063, rz: 0.07, x: sx(0.099), z: 0.0, n: 2.2 },
          { y: 0.445, rx: 0.066, rz: 0.073, x: sx(0.099), z: 0.0, n: 2.2 },
        ],
        14,
        false,
        false,
      ),
      null,
      GEAR,
      S_FABRIC,
    );

    // Boot: the padded shaft rides with the shin (ankle flex happens below it); the leather
    // upper is lofted heel→toe on the foot, over a lugged rubber sole + midsole.
    const shaft: Section[] = [
      { y: 0.05, rx: 0.051, rz: 0.064, x: sx(0.102), z: 0.022 },
      { y: 0.12, rx: 0.054, rz: 0.062, x: sx(0.102), z: 0.02 },
      { y: 0.2, rx: 0.057, rz: 0.062, x: sx(0.102), z: 0.018 },
      { y: 0.232, rx: 0.061, rz: 0.066, x: sx(0.102), z: 0.018 },
      { y: 0.248, rx: 0.055, rz: 0.059, x: sx(0.102), z: 0.018 },
    ];
    shin.add(loft(shaft, 14), null, BOOT, S_BOOT, 0.14);
    // Foot body lofted along +Y, then rotated so +Y → -Z (forward); section z → height.
    const footSecs: Section[] = [
      { y: -0.088, rx: 0.032, rz: 0.032, z: 0.062, n: 2.4 },
      { y: -0.075, rx: 0.043, rz: 0.052, z: 0.07, n: 2.4 },
      { y: -0.03, rx: 0.048, rz: 0.06, z: 0.076, n: 2.4 },
      { y: 0.03, rx: 0.05, rz: 0.055, z: 0.071, n: 2.5 },
      { y: 0.085, rx: 0.052, rz: 0.043, z: 0.061, n: 2.6 },
      { y: 0.135, rx: 0.051, rz: 0.034, z: 0.051, n: 2.6 },
      { y: 0.178, rx: 0.046, rz: 0.029, z: 0.046, n: 2.5 },
      { y: 0.202, rx: 0.038, rz: 0.023, z: 0.043, n: 2.3 },
      { y: 0.214, rx: 0.024, rz: 0.014, z: 0.043, n: 2.2 },
    ];
    foot.add(loft(footSecs, 16), trs(sx(0.102), 0, 0.02, -Math.PI / 2), BOOT, S_BOOT, 0.14);
    foot.add(rbox(0.104, 0.024, 0.31, 0.009, 1), trs(sx(0.102), 0.014, -0.05), SOLE, S_SOLE);
    foot.add(rbox(0.1, 0.014, 0.298, 0.005, 1), trs(sx(0.102), 0.03, -0.05), mixHex(SOLE, BOOT, 0.3), S_SOLE);
    foot.add(rbox(0.094, 0.016, 0.08, 0.006, 1), trs(sx(0.102), 0.008, 0.058), SOLE, S_SOLE);
    // Stiffened heel counter + lace panel down the instep.
    foot.add(curveZ(rbox(0.09, 0.048, 0.028, 0.01, 1), -3), trs(sx(0.102), 0.062, 0.1, 0.12), mixHex(BOOT, GEAR, 0.2), S_BOOT);
    foot.add(rbox(0.036, 0.01, 0.1, 0.004, 1), trs(sx(0.102), 0.112, -0.05, -0.4), mixHex(BOOT, GEAR, 0.45), S_FABRIC);

    // Probes: sole heel/toe/sides, toe cap, knee pad, calf, cargo pocket.
    const fs = side < 0 ? SEG.footL : SEG.footR;
    probe(fs, V(sx(0.102), 0, 0.105), true);
    probe(fs, V(sx(0.102), 0, -0.205), true);
    probe(fs, V(sx(0.16), 0.004, -0.12), true);
    probe(fs, V(sx(0.045), 0.004, -0.12), true);
    probe(fs, V(sx(0.102), 0.06, -0.21));
    const ss = side < 0 ? SEG.shinL : SEG.shinR;
    probe(ss, V(sx(0.102), 0.22, 0.085));
    probe(ss, V(sx(0.098), 0.5, -0.112));
    probe(ss, V(sx(0.1), 0.33, 0.075));
    probe(ss, V(sx(0.155), 0.4, 0));
    const ts = side < 0 ? SEG.thighL : SEG.thighR;
    probe(ts, V(sx(0.19), 0.73, 0));
    probe(ts, V(sx(0.098), 0.75, -0.09));
    probe(ts, V(sx(0.098), 0.75, 0.1));
  }

  // ========================================================================= PELVIS
  const hips = sinks[SEG.hips];
  hips.add(
    loft(
      [
        { y: 0.8, rx: 0.13, rz: 0.095, n: 2.3 },
        { y: 0.86, rx: 0.172, rz: 0.116, n: 2.3, back: 1.16, rip: 0.02, ripK: 7 },
        { y: 0.925, rx: 0.18, rz: 0.12, n: 2.3, back: 1.18 },
        { y: 0.98, rx: 0.172, rz: 0.114, n: 2.3, back: 1.08 },
        { y: 1.04, rx: 0.153, rz: 0.104, n: 2.3 },
        { y: 1.09, rx: 0.145, rz: 0.1, n: 2.3 },
      ],
      18,
    ),
    null,
    uni,
    S_CAMO,
    0.6,
  );
  // Battle belt (PALS rows) + buckle.
  hips.add(
    loft(
      [
        { y: 0.97, rx: 0.168, rz: 0.114, n: 2.6, back: 1.08 },
        { y: 0.978, rx: 0.182, rz: 0.127, n: 2.6, back: 1.08 },
        { y: 1.036, rx: 0.182, rz: 0.127, n: 2.6, back: 1.06 },
        { y: 1.044, rx: 0.17, rz: 0.116, n: 2.6, back: 1.06 },
      ],
      20,
      false,
      false,
    ),
    null,
    vest,
    S_CORDURA,
  );
  hips.add(rbox(0.062, 0.044, 0.018, 0.006, 1), trs(0, 1.008, -0.132), GEAR, S_METAL);
  // IFAK at the back, dump pouch, pistol-mag pouches, a belt holster on the gun side.
  hips.add(curveZ(rbox(0.15, 0.1, 0.06, 0.016, 1), -1.2), trs(0, 0.985, 0.168), vest, S_FABRIC);
  hips.add(rbox(0.1, 0.075, 0.055, 0.02, 1), trs(-0.125, 0.985, 0.135, 0, 0.55), mixHex(vest, GEAR, 0.4), S_FABRIC);
  hips.add(rbox(0.03, 0.078, 0.045, 0.007, 1), trs(-0.178, 1.0, -0.062, 0, 0.35), vest, S_FABRIC);
  hips.add(rbox(0.03, 0.078, 0.045, 0.007, 1), trs(-0.19, 1.0, -0.012, 0, 0.12), vest, S_FABRIC);
  hips.add(rbox(0.036, 0.17, 0.078, 0.012, 1), trs(0.2, 0.935, 0.03, 0, 0, -0.06), GEAR, S_POLY);
  hips.add(rbox(0.03, 0.05, 0.034, 0.008, 1), trs(0.198, 1.04, 0.052, 0.25), GEAR, S_POLY);
  probe(SEG.hips, V(0.21, 0.95, 0.03));
  probe(SEG.hips, V(-0.2, 0.98, -0.03));
  probe(SEG.hips, V(0, 0.985, 0.19));
  probe(SEG.hips, V(0, 0.9, -0.12));
  probe(SEG.hips, V(-0.15, 0.985, 0.17));

  // ========================================================================= CHEST
  const chest = sinks[SEG.chest];
  const W = PIVOT[SEG.chest];
  const blade = new THREE.Matrix4()
    .makeTranslation(W.x, W.y, W.z)
    .multiply(new THREE.Matrix4().makeRotationY(-0.22))
    .multiply(new THREE.Matrix4().makeTranslation(-W.x, -W.y, -W.z));
  const B = (m: THREE.Matrix4 | null): THREE.Matrix4 => (m ? blade.clone().multiply(m) : blade.clone());
  const bp = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(blade);

  // Torso (combat shirt) — mostly under the armour; shoulders + armpits show.
  chest.add(
    loft(
      [
        { y: 1.02, rx: 0.146, rz: 0.1, n: 2.4 },
        { y: 1.1, rx: 0.15, rz: 0.104, n: 2.4 },
        { y: 1.2, rx: 0.16, rz: 0.11, z: -0.004, n: 2.4 },
        { y: 1.3, rx: 0.172, rz: 0.115, z: -0.008, n: 2.4, front: 1.05 },
        { y: 1.38, rx: 0.178, rz: 0.112, z: -0.006, n: 2.4 },
        { y: 1.43, rx: 0.166, rz: 0.1, n: 2.3 },
        { y: 1.47, rx: 0.13, rz: 0.08, n: 2.2 },
        { y: 1.5, rx: 0.08, rz: 0.064 },
        { y: 1.52, rx: 0.062, rz: 0.056 },
      ],
      18,
    ),
    B(null),
    uni,
    S_CAMO,
  );
  // Plate carrier: front + back plate bags (curved), cummerbund round the sides.
  chest.add(curveZ(rbox(0.3, 0.335, 0.056, 0.016, 2), 0.6), B(trs(0, 1.285, -0.152, 0.07)), vest, S_CORDURA);
  chest.add(curveZ(rbox(0.305, 0.35, 0.058, 0.016, 2), -0.6), B(trs(0, 1.3, 0.144, -0.05)), vest, S_CORDURA);
  chest.add(
    loft(
      [
        { y: 1.1, rx: 0.17, rz: 0.12, n: 2.7 },
        { y: 1.11, rx: 0.186, rz: 0.134, n: 2.7 },
        { y: 1.265, rx: 0.196, rz: 0.134, n: 2.7 },
        { y: 1.275, rx: 0.186, rz: 0.124, n: 2.7 },
      ],
      20,
      false,
      false,
    ),
    B(null),
    vest,
    S_CORDURA,
  );
  // Shoulder straps with pads.
  for (const s of [-1, 1]) {
    const strap = [
      V(s * 0.095, 1.44, -0.135),
      V(s * 0.105, 1.492, -0.086),
      V(s * 0.112, 1.516, -0.02),
      V(s * 0.106, 1.505, 0.05),
      V(s * 0.098, 1.47, 0.122),
    ];
    chest.add(sweep(strap, 0.031, 0.009, V(1, 0, 0), 14), B(null), vest, S_CORDURA);
    chest.add(sweep(strap.slice(1, 4), 0.034, 0.015, V(1, 0, 0), 8), B(null), vestLite, S_FABRIC);
  }
  // Triple open-top mag pouches with the magazines showing.
  for (const x of [-0.083, 0, 0.083]) {
    const zf = -0.177 + 0.6 * x * x;
    chest.add(curveZ(rbox(0.077, 0.112, 0.037, 0.009, 1), 0.6), B(trs(x, 1.195, zf - 0.017, 0.07)), vestWarm, S_FABRIC);
    chest.add(rbox(0.066, 0.07, 0.026, 0.006, 1), B(trs(x, 1.272, zf - 0.02, 0.16)), MAG, S_POLY);
  }
  // Admin pouch + blank hook-and-loop patch (no insignia).
  chest.add(curveZ(rbox(0.2, 0.086, 0.026, 0.009, 1), 0.6), B(trs(0, 1.358, -0.19, 0.07)), vestWarm, S_FABRIC);
  chest.add(rbox(0.09, 0.05, 0.004, 0.002, 1), B(trs(-0.03, 1.36, -0.205, 0.07)), vestLite, S_FABRIC);
  // Radio pouch + radio + whip antenna (left side), utility pouch (right side).
  chest.add(rbox(0.046, 0.15, 0.078, 0.01, 1), B(trs(-0.222, 1.2, 0.035, 0, 0, 0.04)), vestDark, S_FABRIC);
  chest.add(rbox(0.04, 0.05, 0.066, 0.008, 1), B(trs(-0.224, 1.296, 0.035, 0, 0, 0.04)), GEAR, S_POLY);
  chest.add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8), B(trs(-0.226, 1.33, 0.05)), GEAR, S_POLY);
  chest.add(
    sweep([bp(-0.226, 1.34, 0.05), bp(-0.232, 1.45, 0.08), bp(-0.215, 1.57, 0.112), bp(-0.2, 1.7, 0.125)], 0.0045, 0.0045, V(1, 0, 0), 10, 5),
    null,
    GEAR,
    S_POLY,
  );
  chest.add(
    sweep([bp(-0.205, 1.27, 0.0), bp(-0.17, 1.34, -0.09), bp(-0.12, 1.42, -0.14), bp(-0.1, 1.44, -0.15)], 0.004, 0.004, V(0, 1, 0), 8, 5),
    null,
    GEAR,
    S_POLY,
  );
  chest.add(rbox(0.05, 0.12, 0.09, 0.012, 1), B(trs(0.222, 1.18, 0.04)), vestDark, S_FABRIC);
  // Low-profile assault pack on the back panel + drag handle.
  chest.add(curveZ(rbox(0.25, 0.3, 0.06, 0.022, 2), -0.8), B(trs(0, 1.29, 0.2)), mixHex(vest, uni, 0.3), S_CORDURA);
  chest.add(
    sweep([bp(-0.045, 1.465, 0.165), bp(0, 1.5, 0.17), bp(0.045, 1.465, 0.165)], 0.012, 0.006, V(0, 0, 1), 8),
    null,
    GEAR,
    S_FABRIC,
  );

  // Arms: deltoid → elbow → wrist (IK onto the rifle grip / handguard), sleeves with folds.
  const toModel = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(RIFLE_M);
  const shoulderR = bp(0.178, 1.432, 0.0);
  const shoulderL = bp(-0.178, 1.428, -0.032);
  const wristR = toModel(0.036, -0.085, 0.118);
  const wristL = toModel(-0.046, -0.068, -0.19);
  const elbowR = solveElbow(shoulderR, wristR, 0.31, 0.27, V(0.55, -0.8, 0.25));
  const elbowL = solveElbow(shoulderL, wristL, 0.31, 0.27, V(-0.7, -0.7, 0.1));
  for (const [s, e, w] of [
    [shoulderR, elbowR, wristR],
    [shoulderL, elbowL, wristL],
  ] as const) {
    const upLen = s.distanceTo(e) + 0.02;
    chest.add(
      limb(upLen, [
        [0, 0.054, 0.054],
        [0.08, 0.064, 0.062],
        [0.28, 0.062, 0.059, 0, 0.03],
        [0.52, 0.057, 0.054, 0, 0.07],
        [0.76, 0.053, 0.05, 0, 0.09],
        [0.92, 0.05, 0.048, 0, 0.06],
        [1, 0.044, 0.044],
      ]),
      alongMatrix(s, e),
      uni,
      S_CAMO,
    );
    chest.add(sphere(0.064, 10, 7), trs(s.x, s.y, s.z), uni, S_CAMO);
    chest.add(sphere(0.048, 8, 6), trs(e.x, e.y, e.z), uni, S_CAMO);
    const foreLen = e.distanceTo(w) + 0.012;
    chest.add(
      limb(foreLen, [
        [0, 0.048, 0.048],
        [0.18, 0.055, 0.051, 0, 0.08],
        [0.42, 0.051, 0.047, 0, 0.09],
        [0.72, 0.044, 0.04, 0, 0.07],
        [0.93, 0.039, 0.035],
        [1, 0.03, 0.028],
      ]),
      alongMatrix(e, w),
      uni,
      S_CAMO,
    );
    // Glove cuff.
    const cuffA = w.clone().lerp(e, 0.12);
    chest.add(
      limb(cuffA.distanceTo(w) + 0.025, [
        [0, 0.037, 0.034],
        [0.3, 0.039, 0.036],
        [1, 0.032, 0.028],
      ], 10),
      alongMatrix(cuffA, w),
      GLOVE,
      S_GLOVE,
    );
  }
  // Velcro shoulder patches (blank) on the sleeves.
  {
    const m = alongMatrix(shoulderL, elbowL);
    const patch = rbox(0.008, 0.07, 0.06, 0.003, 1);
    patch.translate(-0.058, 0.1, 0);
    chest.add(patch, m, vestLite, S_FABRIC);
  }

  // Gloved hands, authored in rifle space so they wrap whatever grip/handguard createRifle() makes.
  const RM = (m: THREE.Matrix4): THREE.Matrix4 => RIFLE_M.clone().multiply(m);
  const fingerSweep = (pts: THREE.Vector3[], r: number): THREE.BufferGeometry =>
    sweep(pts, r, r * 0.9, V(0, 1, 0), 5, 6);
  // Right (firing) hand on the pistol grip: back of hand outboard, fingers wrapped round the
  // front, index finger indexed straight along the receiver (trigger discipline), thumb over.
  chest.add(rbox(0.031, 0.082, 0.082, 0.013, 1), RM(trs(0.029, -0.078, 0.068, 0, 0.28, 0)), GLOVE, S_GLOVE);
  for (let i = 0; i < 3; i++) {
    const y = -0.064 - i * 0.021;
    chest.add(
      fingerSweep([V(0.034, y, 0.032), V(0.022, y, 0.012), V(0.0, y - 0.002, 0.008), V(-0.019, y - 0.002, 0.022), V(-0.022, y - 0.003, 0.04)], 0.0105),
      RIFLE_M,
      GLOVE,
      S_GLOVE,
    );
  }
  {
    const [g, m] = capsuleAB(V(0.027, -0.042, 0.026), V(0.024, -0.034, -0.016), 0.0078);
    chest.add(g, RM(m), GLOVE, S_GLOVE);
  }
  {
    const [g, m] = capsuleAB(V(0.006, -0.05, 0.1), V(-0.024, -0.03, 0.045), 0.011);
    chest.add(g, RM(m), GLOVE, S_GLOVE);
  }
  // Left (support) hand under the handguard: palm cupped beneath, fingers up the far side,
  // thumb forward along the near side (C-clamp).
  chest.add(rbox(0.072, 0.03, 0.086, 0.013, 1), RM(trs(-0.012, -0.046, -0.245, 0, 0, 0.35)), GLOVE, S_GLOVE);
  for (let i = 0; i < 4; i++) {
    const z = -0.278 + i * 0.019;
    chest.add(
      fingerSweep([V(0.012, -0.055, z), V(0.032, -0.04, z), V(0.038, -0.018, z), V(0.034, 0.002, z)], 0.0095),
      RIFLE_M,
      GLOVE,
      S_GLOVE,
    );
  }
  {
    const [g, m] = capsuleAB(V(-0.038, -0.035, -0.205), V(-0.034, 0.006, -0.288), 0.0105);
    chest.add(g, RM(m), GLOVE, S_GLOVE);
  }

  probe(SEG.chest, bp(0, 1.12, -0.21));
  probe(SEG.chest, bp(0, 1.3, -0.225));
  probe(SEG.chest, bp(0, 1.29, 0.235));
  probe(SEG.chest, bp(0, 1.45, 0.17));
  probe(SEG.chest, bp(0.24, 1.43, 0));
  probe(SEG.chest, bp(-0.24, 1.43, -0.03));
  probe(SEG.chest, bp(-0.24, 1.2, 0.04));
  probe(SEG.chest, bp(0.245, 1.18, 0.04));
  probe(SEG.chest, elbowR.clone().add(V(0.04, -0.03, 0)));
  probe(SEG.chest, elbowL.clone().add(V(-0.04, -0.03, 0)));
  probe(SEG.chest, toModel(0, -0.06, -0.25));
  probe(SEG.chest, toModel(0.03, -0.1, 0.06));
  probe(SEG.chest, MUZZLE_LOCAL.clone().applyMatrix4(RIFLE_M));
  probe(SEG.chest, toModel(0, -0.16, -0.04));
  probe(SEG.chest, toModel(0, 0.1, -0.06));
  probe(SEG.chest, bp(-0.2, 1.7, 0.125));

  // ========================================================================= HEAD
  const head = sinks[SEG.head];
  // Neck (balaclava knit) + bunched scarf / neck gaiter.
  head.add(
    loft(
      [
        { y: 1.47, rx: 0.056, rz: 0.058, z: -0.006 },
        { y: 1.6, rx: 0.054, rz: 0.056, z: -0.01 },
      ],
      12,
    ),
    null,
    KNIT,
    S_KNIT,
  );
  // Neck gaiter pulled up over nose and mouth to the goggles; drops lower at the nape.
  {
    const g = loft(
      [
        { y: 1.488, rx: 0.068, rz: 0.07, z: -0.004 },
        { y: 1.505, rx: 0.077, rz: 0.08, z: -0.006, rip: 0.07, ripK: 5 },
        { y: 1.535, rx: 0.083, rz: 0.086, z: -0.01, rip: 0.1, ripK: 6, ripP: 1 },
        { y: 1.568, rx: 0.077, rz: 0.088, z: -0.018, front: 1.08, rip: 0.06, ripK: 7, ripP: 2.2 },
        { y: 1.6, rx: 0.071, rz: 0.092, z: -0.022, front: 1.12, rip: 0.04, ripK: 5 },
        { y: 1.632, rx: 0.08, rz: 0.1, z: -0.018, front: 1.08, rip: 0.03, ripK: 6, ripP: 0.7 },
        { y: 1.658, rx: 0.083, rz: 0.1, z: -0.015, front: 1.03 },
      ],
      20,
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
    head.add(g, null, scarf, S_KNIT);
  }
  // Head under a balaclava: ellipsoid with a tapered jaw, chin, nose ridge and flatter back.
  {
    const g = new THREE.SphereGeometry(1, 20, 14);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      let X = x * 0.079;
      const Y = y * 0.114;
      let Z = z * 0.098;
      if (y < 0) X *= 1 - 0.24 * Math.pow(-y, 1.6);
      if (z > 0) Z *= 0.94;
      if (z < 0 && y < 0.1) Z -= 0.01 * smooth(0.1, -0.6, y) * -z;
      const dn = Math.hypot(x, (y + 0.08) * 1.3, z + 1);
      Z -= 0.018 * Math.exp(-(dn * dn) / 0.05);
      p.setXYZ(i, X, Y, Z);
    }
    g.computeVertexNormals();
    head.add(g, trs(0, 1.665, -0.014), KNIT, S_KNIT);
  }
  // Ballistic goggles: wrap frame, mirrored lens, strap round the back.
  const arc = (rx: number, rz: number, y: number, a0: number, a1: number, n: number, cz = -0.014): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = THREE.MathUtils.lerp(a0, a1, i / n);
      pts.push(V(rx * Math.sin(a), y, cz - rz * Math.cos(a)));
    }
    return pts;
  };
  head.add(sweep(arc(0.085, 0.1, 1.678, -1.35, 1.35, 8), 0.026, 0.011, V(0, 1, 0), 14, 8), null, GEAR, S_POLY);
  head.add(sweep(arc(0.087, 0.107, 1.678, -1.05, 1.05, 6), 0.02, 0.004, V(0, 1, 0), 12, 8), null, LENS, S_LENS);
  head.add(sweep(arc(0.088, 0.104, 1.685, 1.3, Math.PI * 2 - 1.3, 8), 0.012, 0.003, V(0, 1, 0), 10, 4), null, GEAR, S_FABRIC);

  // Helmet: high-cut shell with brow, ear cut-outs and a deeper nape.
  const hc = V(0, 1.705, 0.002);
  const HAX = 0.123;
  const HAY = 0.12;
  const HAZ = 0.138;
  const rim = (phi: number): number => {
    const d = phi <= Math.PI ? phi : Math.PI * 2 - phi; // angular distance from the front
    return 1.724 + 0.026 * bumpA(d, Math.PI * 0.5, Math.PI * 0.27) - 0.012 * bumpA(d, Math.PI * 0.24, Math.PI * 0.12) - 0.06 * smooth(Math.PI * 0.62, Math.PI * 0.95, d);
  };
  head.add(helmetShell(hc, HAX, HAY, HAZ, rim, 32, 11), null, t.helmet, S_HELMET);
  const onShell = (phi: number, y: number, out = 1.0): THREE.Vector3 => {
    const th = Math.acos(THREE.MathUtils.clamp((y - hc.y) / HAY, -0.99, 0.99));
    const fl = 1 + 0.045 * Math.pow(th / Math.acos(THREE.MathUtils.clamp((rim(phi) - hc.y) / HAY, -0.6, 0.98)), 3);
    return V(
      hc.x + HAX * Math.sin(th) * Math.sin(phi) * out * fl,
      y,
      hc.z - HAZ * Math.sin(th) * Math.cos(phi) * out * fl,
    );
  };
  // Accessory rails along both sides, just above the rim.
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const d = THREE.MathUtils.lerp(Math.PI * 0.3, Math.PI * 0.74, i / 5);
      const phi = s > 0 ? d : Math.PI * 2 - d;
      pts.push(onShell(phi, rim(phi) + 0.022, 1.02));
    }
    head.add(sweep(pts, 0.012, 0.006, V(0, 1, 0), 10), null, GEAR, S_POLY);
  }
  // NVG shroud + folded mount at the brow, counterweight pouch at the nape, IR strobe on top.
  {
    const f = onShell(0, 1.752, 1.0);
    head.add(rbox(0.062, 0.044, 0.014, 0.005, 1), trs(f.x, f.y, f.z - 0.006, 0.4), GEAR, S_METAL);
    head.add(rbox(0.036, 0.03, 0.034, 0.006, 1), trs(f.x, f.y - 0.022, f.z - 0.018, 0.2), GEAR, S_METAL);
    const b = onShell(Math.PI, 1.705, 1.0);
    head.add(curveZ(rbox(0.1, 0.06, 0.034, 0.012, 1), -1.6), trs(b.x, b.y, b.z + 0.014, -0.15), mixHex(t.helmet, GEAR, 0.4), S_FABRIC);
    const top = onShell(Math.PI, 1.815, 1.0);
    head.add(rbox(0.026, 0.016, 0.03, 0.005, 1), trs(top.x, top.y + 0.004, top.z, -0.5), GEAR, S_POLY);
  }
  // Electronic ear protection: cups on rail arms.
  for (const s of [1, -1]) {
    const cup = loft(
      [
        { y: 0, rx: 0.042, rz: 0.036, n: 2.3 },
        { y: 0.012, rx: 0.05, rz: 0.044, n: 2.3 },
        { y: 0.03, rx: 0.05, rz: 0.044, n: 2.3 },
        { y: 0.042, rx: 0.04, rz: 0.034, n: 2.3 },
        { y: 0.047, rx: 0.024, rz: 0.02, n: 2.2 },
      ],
      16,
    );
    head.add(cup, trs(s * 0.083, 1.655, 0.006, 0, 0, -s * Math.PI * 0.5), GEAR, S_POLY);
    head.add(rbox(0.012, 0.045, 0.022, 0.004, 1), trs(s * 0.118, 1.705, 0.008, 0, 0, s * 0.18), GEAR, S_POLY);
  }
  // Chin strap.
  head.add(
    sweep(
      [V(-0.098, 1.705, -0.01), V(-0.084, 1.625, -0.028), V(-0.05, 1.57, -0.07), V(0, 1.56, -0.088), V(0.05, 1.57, -0.07), V(0.084, 1.625, -0.028), V(0.098, 1.705, -0.01)],
      0.009,
      0.003,
      V(0, 0, 1),
      12,
      4,
    ),
    null,
    GEAR,
    S_FABRIC,
  );
  probe(SEG.head, V(0, 1.83, 0));
  probe(SEG.head, V(0, 1.75, -0.155));
  probe(SEG.head, V(0, 1.7, 0.18));
  probe(SEG.head, V(0.135, 1.66, 0));
  probe(SEG.head, V(-0.135, 1.66, 0));
  probe(SEG.head, V(0.11, 1.75, 0.08));
  probe(SEG.head, V(-0.11, 1.75, 0.08));

  return { geos: sinks.map((s, i) => s.build(PIVOT[i])), probes };
}

const cache = new Map<string, RigDef>();

/** Shared (cached) rig for a tint. Callers must not dispose the geometries. */
export function soldierRig(t: Tint): RigDef {
  const key = `${t.uniform}:${t.vest}:${t.helmet}`;
  let def = cache.get(key);
  if (!def) {
    def = build(t);
    cache.set(key, def);
  }
  return def;
}
