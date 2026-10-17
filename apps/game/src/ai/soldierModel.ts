/**
 * Code-authored modern infantry soldier (original design — no ripped assets, patterns or
 * insignia). Builds the kit as rounded forms baked into one geometry per rigid segment:
 *
 *   hips ─┬─ chest (torso, armour/chest rig, collar) ─┬─ head (helmet, eyewear, gaiter…)
 *         │                                           └─ arms (sleeves, pads, gloves + rifle)
 *         ├─ thighL ── shinL ── footL
 *         └─ thighR ── shinR ── footR
 *
 * The arms + rifle are their own segment (pivot on the shoulder line) so the animation can
 * raise the weapon from the ready carry into a shouldered aim.
 *
 * Three kits read differently by SILHOUETTE, not just colour:
 *   rifleman — plate carrier, triple mag pouches, radio, low-profile back panel;
 *   rusher   — light chest rig on an X-harness, no plates/back panel/knee pads, slick helmet;
 *   heavy    — thick plates + side plates, high neck guard, groin flap, shoulder armour and a
 *              smoked ballistic visor.
 *
 * Proportions target a 1.80 m adult in kit: head ≈ 0.24 m (1/7.5), hip pivot ≈ 0.93 m,
 * shoulders ≈ 0.47 m across the deltoids with armour. Authored in model space (feet at y = 0,
 * forward -Z, right +X); the upper body is bladed ~18° toward the gun side, as a real shooter
 * stands, so the support arm reaches the handguard with the elbow bent and tucked. Geometry is cached per look and lives
 * for the session (bots are pooled, never rebuilt).
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

export type Kit = 'rifleman' | 'rusher' | 'heavy';

export interface Look {
  uniform: number;
  vest: number;
  helmet: number;
  kit: Kit;
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
  arms: 9,
} as const;
export const SEG_COUNT = 10;

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
  V(0, 1.43, -0.016), // shoulder line
];
/** Parent segment of each segment (-1 = attached to the model root). */
export const PARENT: readonly number[] = [-1, 0, 1, 0, 3, 4, 0, 6, 7, 1];

/**
 * Shouldered-aim layer, shared by the authoring below and the animation: the arms segment is
 * raised `armRX` about the shoulder line and lifted (`armY`, `armZ`), the chest leans `chestRX`.
 */
export const AIM = { armRX: 0.36, armY: 0.05, armZ: 0.0, chestRX: -0.08 } as const;

const RIFLE_BUTT_LOCAL = V(0, -0.02, 0.287); // upper butt pad
const MUZZLE_LOCAL = V(0, 0, -0.528);

/** Rifle pose in model space (ready carry) for a kit; bore along local -Z, grip near origin. */
export interface RiflePlacement {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/**
 * Authored where it matters — shouldered: butt in the shoulder pocket against the armour (plate
 * front for carriers, shirt for the chest rig), bore level once the chest leans in. The ready
 * carry is that pose rotated back down about the shoulder line, so the aim layer restores it.
 */
function riflePlacement(kit: Kit): RiflePlacement {
  const buttZ = kit === 'heavy' ? -0.155 : kit === 'rusher' ? -0.09 : -0.13;
  const butt = V(0.128, 1.475, buttZ);
  const qAim = new THREE.Quaternion().setFromEuler(new THREE.Euler(-AIM.chestRX, 0.04, 0.012));
  const aimPos = butt.sub(RIFLE_BUTT_LOCAL.clone().applyQuaternion(qAim));
  const pivot = PIVOT[SEG.arms];
  const down = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -AIM.armRX);
  const pos = aimPos.sub(V(0, AIM.armY, AIM.armZ)).sub(pivot).applyQuaternion(down).add(pivot);
  return { pos, quat: down.multiply(qAim) };
}
/** The neck was reading long: the whole head assembly sits this much lower on the neck pivot. */
const HEAD_DROP = 0.032;

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
  rifle: RiflePlacement;
}

// --- Surfaces ---------------------------------------------------------------------------
const S_CAMO_BASE: Surface = { rough: 0.9, metal: 0, camo: 1, pattern: PAT.fabric };
const S_FABRIC: Surface = { rough: 0.88, metal: 0, camo: 0, pattern: PAT.fabric };
const S_CORDURA: Surface = { rough: 0.8, metal: 0, camo: 0, pattern: PAT.cordura };
const S_POLY: Surface = { rough: 0.5, metal: 0.04, camo: 0, pattern: PAT.plain };
const S_METAL: Surface = { rough: 0.5, metal: 0.35, camo: 0, pattern: PAT.plain };
const S_HELMET: Surface = { rough: 0.74, metal: 0, camo: 0, pattern: PAT.plain };
const S_KNIT: Surface = { rough: 0.96, metal: 0, camo: 0, pattern: PAT.knit };
const S_GLOVE: Surface = { rough: 0.68, metal: 0, camo: 0, pattern: PAT.leather };
const S_BOOT: Surface = { rough: 0.62, metal: 0, camo: 0, pattern: PAT.leather };
const S_SOLE: Surface = { rough: 0.9, metal: 0, camo: 0, pattern: PAT.rubber };
// Smoked lens: half-mirrored so it picks up the environment probe; neutral, not a coloured glint.
const S_LENS: Surface = { rough: 0.07, metal: 0.4, camo: 0, pattern: PAT.gloss };
const S_SKIN: Surface = { rough: 0.5, metal: 0, camo: 0, pattern: PAT.plain };
const S_VISOR: Surface = { rough: 0.06, metal: 0.28, camo: 0, pattern: PAT.gloss };

const GEAR = 0x1c1d1e; // black nylon / polymer
const MAG = 0x26241f;
const GLOVE = 0x40372d;
const BOOT = 0x463a2e;
const SOLE = 0x1a1918;
const LENS = 0x30343a;
/** Knit balaclava per kit — dark olive / coyote / charcoal-olive, never black (albedo ≈ 0.08–0.1). */
const KNIT: Record<Kit, number> = { rifleman: 0x55574a, rusher: 0x5f5446, heavy: 0x494c48 };
/** The strip of skin left between balaclava and goggles. */
const SKIN: Record<Kit, number> = { rifleman: 0xa08a7a, rusher: 0x7d6352, heavy: 0x9a8070 };
const VISOR = 0x1a1d20;
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

function sphere(r: number, w: number, h: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

/** Matrix placing a part at `c` with its local -Z facing `n` (outward) and +Y toward `up`. */
function facing(c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 {
  const m = new THREE.Matrix4().lookAt(c, c.clone().add(n), up);
  return m.setPosition(c);
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

/**
 * A padded protector (knee / elbow): soft cordura pad, a darker stitched binding peeking out
 * round the edge, and a hard polymer cap — reads as a sewn, layered pad rather than a block.
 */
function pad(sink: PartSink, m: THREE.Matrix4, w: number, h: number, padColor: number, dustTop = 0): void {
  sink.add(curveZ(rbox(w + 0.008, h + 0.008, 0.014, 0.006, 1), 3.2), m.clone().multiply(trs(0, 0, 0.006)), mixHex(padColor, GEAR, 0.55), S_FABRIC, dustTop);
  sink.add(curveZ(rbox(w, h, 0.026, 0.012, 1), 3.4), m, padColor, S_CORDURA, dustTop);
  sink.add(curveZ(rbox(w * 0.72, h * 0.62, 0.014, 0.0068, 1), 3.8), m.clone().multiply(trs(0, 0.004, -0.017)), GEAR, S_POLY, dustTop);
}

// --- The build ------------------------------------------------------------------------------
function build(t: Look): RigDef {
  const dust = new THREE.Color(DUST);
  const drop = new THREE.Matrix4().makeTranslation(0, -HEAD_DROP, 0);
  const sinks = Array.from({ length: SEG_COUNT }, (_, i) => new PartSink(dust, i === SEG.head ? drop : null));
  const probes: Probe[] = [];
  const probe = (seg: number, p: THREE.Vector3, sole = false): void => {
    probes.push({ seg, p, sole });
  };
  const kit = t.kit;
  const heavy = kit === 'heavy';
  const rusher = kit === 'rusher';

  const uni = t.uniform;
  const vest = t.vest;
  const vestLite = mixHex(vest, TAN, 0.18);
  const vestWarm = mixHex(vest, TAN, 0.08); // pouches vary slightly in dye lot
  const vestDark = mixHex(vest, GEAR, 0.3);
  const knit = KNIT[kit];
  const gaiter = mixHex(knit, uni, 0.3); // a separate knit layer, a touch different in tone
  const shells = mixHex(t.helmet, TAN, 0.35); // headset cups match the helmet, not black
  const frame = mixHex(mixHex(t.helmet, TAN, 0.3), GEAR, 0.35); // goggle frame, distinct from the knit
  const S_CAMO: Surface = { ...S_CAMO_BASE, camo: rusher ? 2 : 1 }; // rusher print at half size
  const rifle = riflePlacement(kit);
  const RIFLE_M = new THREE.Matrix4().compose(rifle.pos, rifle.quat, V(1, 1, 1));

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
      { y: 0.538, rx: 0.071, rz: 0.074, x: sx(0.099), z: -0.012, rip: 0.08, ripK: 5, ripP: 0.6 },
      { y: 0.556, rx: 0.067, rz: 0.07, x: sx(0.099), z: -0.011 },
      { y: 0.574, rx: 0.075, rz: 0.079, x: sx(0.099), z: -0.01, rip: 0.07, ripK: 6, ripP: 1.9 },
      { y: 0.6, rx: 0.073, rz: 0.077, x: sx(0.099), z: -0.01, rip: 0.05, ripK: 5, ripP: 1.3 },
      { y: 0.66, rx: 0.08, rz: 0.084, x: sx(0.099), z: -0.007, rip: 0.04, ripK: 7 },
      { y: 0.75, rx: 0.087, rz: 0.091, x: sx(0.099), z: -0.004, front: 1.04, rip: 0.02, ripK: 4 },
      { y: 0.84, rx: 0.092, rz: 0.096, x: sx(0.098), z: 0 },
      { y: 0.92, rx: 0.095, rz: 0.1, x: sx(0.097), z: 0.006 },
      { y: 0.985, rx: 0.088, rz: 0.094, x: sx(0.094), z: 0.006 },
    ];
    thigh.add(loft(thighSecs, 14), null, uni, S_CAMO, 0.6);
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
      { y: 0.445, rx: 0.066, rz: 0.069, x: sx(0.098), z: 0.002, rip: 0.07, ripK: 5, ripP: 2.4 },
      { y: 0.462, rx: 0.062, rz: 0.064, x: sx(0.098), z: -0.002 },
      { y: 0.48, rx: 0.067, rz: 0.068, x: sx(0.098), z: -0.006, rip: 0.06, ripK: 6, ripP: 0.9 },
      { y: 0.545, rx: 0.066, rz: 0.068, x: sx(0.098), z: -0.012 },
    ];
    shin.add(loft(shinSecs, 14), null, uni, S_CAMO, 0.6);
    if (!rusher) {
      // Knee pad (stitched pad + hard cap) and its strap round the calf.
      pad(shin, trs(sx(0.098), 0.5, -0.085, -0.1), 0.108, 0.13, vest, 0.6);
      shin.add(
        loft(
          [
            { y: 0.425, rx: 0.063, rz: 0.07, x: sx(0.099), z: 0.0, n: 2.2 },
            { y: 0.445, rx: 0.066, rz: 0.073, x: sx(0.099), z: 0.0, n: 2.2 },
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

    // Boot: the padded shaft rides with the shin (ankle flex happens below it); the leather
    // upper is lofted heel→toe on the foot, over a lugged rubber sole + midsole.
    const shaft: Section[] = [
      { y: 0.05, rx: 0.046, rz: 0.06, x: sx(0.102), z: 0.022 },
      { y: 0.12, rx: 0.05, rz: 0.059, x: sx(0.102), z: 0.02 },
      { y: 0.2, rx: 0.054, rz: 0.06, x: sx(0.102), z: 0.018 },
      { y: 0.232, rx: 0.058, rz: 0.064, x: sx(0.102), z: 0.018 },
      { y: 0.248, rx: 0.053, rz: 0.057, x: sx(0.102), z: 0.018 },
    ];
    shin.add(loft(shaft, 12), null, BOOT, S_BOOT, 0.07);
    // Foot body lofted along +Y, then rotated so +Y → -Z (forward); section z → height.
    // Sections run heel → toe (loft +Y becomes model -Z); section rz/z are height + centre.
    const footSecs: Section[] = [
      { y: -0.088, rx: 0.028, rz: 0.032, z: 0.062, n: 2.4 },
      { y: -0.075, rx: 0.037, rz: 0.052, z: 0.07, n: 2.4 },
      { y: -0.03, rx: 0.041, rz: 0.06, z: 0.076, n: 2.4 },
      { y: 0.03, rx: 0.043, rz: 0.055, z: 0.071, n: 2.5 },
      { y: 0.085, rx: 0.044, rz: 0.043, z: 0.061, n: 2.5 },
      { y: 0.135, rx: 0.043, rz: 0.035, z: 0.052, n: 2.4 },
      { y: 0.175, rx: 0.038, rz: 0.03, z: 0.048, n: 2.2 },
      { y: 0.2, rx: 0.029, rz: 0.024, z: 0.046, n: 2.1 },
      { y: 0.213, rx: 0.016, rz: 0.015, z: 0.046, n: 2 },
    ];
    foot.add(loft(footSecs, 12), trs(sx(0.102), 0, 0.02, -Math.PI / 2), BOOT, S_BOOT, 0.07);
    // One-piece lugged sole: bevelled edges, thicker heel, rounded toe with a little spring.
    const soleSecs: Section[] = [
      { y: -0.094, rx: 0.026, rz: 0.01, z: 0.015, n: 3.2 },
      { y: -0.086, rx: 0.036, rz: 0.016, z: 0.016, n: 3.6 },
      { y: -0.03, rx: 0.039, rz: 0.016, z: 0.016, n: 3.6 },
      { y: 0.0, rx: 0.037, rz: 0.012, z: 0.017, n: 3.6 },
      { y: 0.06, rx: 0.044, rz: 0.012, z: 0.014, n: 3.6 },
      { y: 0.13, rx: 0.046, rz: 0.012, z: 0.014, n: 3.6 },
      { y: 0.18, rx: 0.041, rz: 0.011, z: 0.018, n: 3.2 },
      { y: 0.207, rx: 0.03, rz: 0.009, z: 0.023, n: 2.8 },
      { y: 0.22, rx: 0.014, rz: 0.006, z: 0.026, n: 2.4 },
    ];
    foot.add(loft(soleSecs, 14), trs(sx(0.102), 0, 0.02, -Math.PI / 2), SOLE, S_SOLE);
    // Stiffened heel counter + lace panel down the instep.
    foot.add(curveZ(rbox(0.076, 0.046, 0.026, 0.01, 1), -3.4), trs(sx(0.102), 0.062, 0.098, 0.12), mixHex(BOOT, GEAR, 0.2), S_BOOT);
    foot.add(rbox(0.03, 0.01, 0.1, 0.004, 1), trs(sx(0.102), 0.112, -0.05, -0.4), mixHex(BOOT, GEAR, 0.45), S_FABRIC);

    // Probes: sole heel/toe/sides, toe cap, knee, calf, cargo pocket.
    const fs = side < 0 ? SEG.footL : SEG.footR;
    probe(fs, V(sx(0.102), 0.002, 0.108), true);
    probe(fs, V(sx(0.102), 0.006, -0.19), true);
    probe(fs, V(sx(0.148), 0.003, -0.11), true);
    probe(fs, V(sx(0.056), 0.003, -0.11), true);
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
      16,
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
  if (heavy) {
    // Groin protector hanging from the belt.
    hips.add(curveZ(rbox(0.15, 0.13, 0.024, 0.012, 1), 1.6), trs(0, 0.9, -0.15, 0.1), vest, S_CORDURA);
  }
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
    .multiply(new THREE.Matrix4().makeRotationY(-0.32))
    .multiply(new THREE.Matrix4().makeTranslation(-W.x, -W.y, -W.z));
  const B = (m: THREE.Matrix4 | null): THREE.Matrix4 => (m ? blade.clone().multiply(m) : blade.clone());
  const bp = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(blade);

  // Torso (combat shirt) — mostly under the armour; shoulders + armpits show.
  chest.add(
    loft(
      [
        { y: 1.02, rx: 0.146, rz: 0.1, n: 2.4 },
        { y: 1.1, rx: 0.15, rz: 0.104, n: 2.4 },
        { y: 1.2, rx: 0.16, rz: 0.11, z: -0.004, n: 2.4, rip: rusher ? 0.03 : 0, ripK: 9 },
        { y: 1.3, rx: 0.172, rz: 0.115, z: -0.008, n: 2.4, front: 1.05 },
        { y: 1.38, rx: 0.178, rz: 0.112, z: -0.006, n: 2.4 },
        { y: 1.43, rx: 0.166, rz: 0.1, n: 2.3 },
        { y: 1.47, rx: 0.13, rz: 0.08, n: 2.2 },
        { y: 1.5, rx: 0.08, rz: 0.064 },
        { y: 1.52, rx: 0.062, rz: 0.056 },
      ],
      14,
    ),
    B(null),
    uni,
    S_CAMO,
  );
  // Mandarin collar of the combat shirt, standing round the gaiter.
  chest.add(
    loft(
      [
        { y: 1.468, rx: 0.084, rz: 0.076, z: -0.008 },
        { y: 1.49, rx: 0.08, rz: 0.073, z: -0.01, rip: 0.04, ripK: 5 },
        { y: 1.522, rx: 0.077, rz: 0.071, z: -0.012 },
        { y: 1.528, rx: 0.071, rz: 0.065, z: -0.012 },
      ],
      14,
      false,
      false,
    ),
    null,
    uni,
    S_CAMO,
  );

  if (rusher) {
    // Light chest rig: a mag panel on an X-harness + waist strap. No plates, no back panel.
    chest.add(curveZ(rbox(0.29, 0.15, 0.03, 0.01, 1), 0.9), B(trs(0, 1.2, -0.13, 0.05)), vest, S_CORDURA);
    for (const x of [-0.105, -0.035, 0.035, 0.105]) {
      const zf = -0.145 + 0.9 * x * x;
      chest.add(rbox(0.062, 0.105, 0.03, 0.008, 1), B(trs(x, 1.2, zf - 0.015, 0.05)), vestWarm, S_FABRIC);
      chest.add(rbox(0.056, 0.06, 0.024, 0.006, 1), B(trs(x, 1.27, zf - 0.017, 0.12)), MAG, S_POLY);
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
      B(null),
      vestDark,
      S_FABRIC,
    );
    for (const s of [-1, 1]) {
      const strap = [
        V(s * 0.1, 1.27, -0.128),
        V(s * 0.108, 1.44, -0.095),
        V(s * 0.114, 1.505, -0.012),
        V(s * 0.1, 1.46, 0.092),
        V(0, 1.3, 0.122),
        V(-s * 0.1, 1.135, 0.118),
      ];
      chest.add(sweep(strap, 0.024, 0.006, V(1, 0, 0), 16, 4), B(null), vestDark, S_CORDURA);
    }
    // Radio rides on the left of the rig.
    chest.add(rbox(0.04, 0.12, 0.066, 0.009, 1), B(trs(-0.185, 1.21, 0.0, 0, 0, 0.06)), vestDark, S_FABRIC);
    chest.add(rbox(0.036, 0.04, 0.056, 0.007, 1), B(trs(-0.188, 1.29, 0.0, 0, 0, 0.06)), GEAR, S_POLY);
  } else {
    // Plate carrier: front + back plate bags (curved), cummerbund round the sides.
    const pw = heavy ? 0.33 : 0.3;
    const pd = heavy ? 0.078 : 0.056;
    const pz = heavy ? 0.163 : 0.152;
    chest.add(curveZ(rbox(pw, heavy ? 0.36 : 0.335, pd, 0.018, 2), 0.6), B(trs(0, 1.285, -pz, 0.07)), vest, S_CORDURA);
    chest.add(curveZ(rbox(pw + 0.005, heavy ? 0.37 : 0.35, pd, 0.018, 2), -0.6), B(trs(0, 1.3, pz - 0.008, -0.05)), vest, S_CORDURA);
    const cr = heavy ? 0.205 : 0.196;
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
      chest.add(sweep(strap, 0.031, 0.009, V(1, 0, 0), 12), B(null), vest, S_CORDURA);
      chest.add(sweep(strap.slice(1, 4), 0.034, 0.015, V(1, 0, 0), 6), B(null), vestLite, S_FABRIC);
    }
    // Triple open-top mag pouches with the magazines showing.
    const fz = -(pz + pd / 2) + 0.001;
    for (const x of [-0.083, 0, 0.083]) {
      const zf = fz + 0.6 * x * x;
      chest.add(curveZ(rbox(0.077, 0.112, 0.037, 0.009, 1), 0.6), B(trs(x, 1.195, zf - 0.017, 0.07)), vestWarm, S_FABRIC);
      chest.add(rbox(0.066, 0.07, 0.026, 0.006, 1), B(trs(x, 1.272, zf - 0.02, 0.16)), MAG, S_POLY);
    }
    // Admin pouch + blank hook-and-loop patch (no insignia).
    chest.add(curveZ(rbox(0.2, 0.086, 0.026, 0.009, 1), 0.6), B(trs(0, 1.358, fz - 0.012, 0.07)), vestWarm, S_FABRIC);
    chest.add(rbox(0.09, 0.05, 0.004, 0.002, 1), B(trs(-0.03, 1.36, fz - 0.027, 0.07)), vestLite, S_FABRIC);
    // Radio pouch + radio on the left cummerbund, utility pouch on the right.
    chest.add(rbox(0.046, 0.15, 0.078, 0.01, 1), B(trs(-(cr + 0.026), 1.2, 0.035, 0, 0, 0.04)), vestDark, S_FABRIC);
    chest.add(rbox(0.04, 0.05, 0.066, 0.008, 1), B(trs(-(cr + 0.028), 1.296, 0.035, 0, 0, 0.04)), GEAR, S_POLY);
    chest.add(rbox(0.05, 0.12, 0.09, 0.012, 1), B(trs(cr + 0.026, 1.18, 0.04)), vestDark, S_FABRIC);
    if (heavy) {
      // Side plates over the cummerbund, high neck guard (lower in front), heavier collar line.
      for (const s of [-1, 1]) chest.add(rbox(0.026, 0.17, 0.15, 0.01, 1), B(trs(s * (cr + 0.012), 1.205, -0.02)), vestDark, S_CORDURA);
      const g = loft(
        [
          { y: 1.45, rx: 0.115, rz: 0.1, z: 0.0, n: 2.2 },
          { y: 1.47, rx: 0.106, rz: 0.094, z: 0.0, n: 2.2 },
          { y: 1.55, rx: 0.094, rz: 0.088, z: 0.004, n: 2.2, rip: 0.03, ripK: 8 },
          { y: 1.565, rx: 0.088, rz: 0.082, z: 0.004, n: 2.2 },
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
      chest.add(g, null, vest, S_CORDURA);
    } else {
      // Low-profile assault pack on the back panel + drag handle.
      chest.add(curveZ(rbox(0.25, 0.3, 0.06, 0.022, 1), -0.8), B(trs(0, 1.29, pz + 0.048)), mixHex(vest, uni, 0.3), S_CORDURA);
      chest.add(sweep([bp(-0.045, 1.465, 0.165), bp(0, 1.5, 0.17), bp(0.045, 1.465, 0.165)], 0.012, 0.006, V(0, 0, 1), 6), null, GEAR, S_FABRIC);
    }
  }
  // Whip antenna + PTT cable from the radio (all kits carry a radio on the left).
  const rx = rusher ? -0.188 : -(heavy ? 0.233 : 0.224);
  const rz = rusher ? 0.0 : 0.035;
  chest.add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6), B(trs(rx - 0.002, 1.325, rz + 0.015)), GEAR, S_POLY);
  chest.add(
    sweep([bp(rx - 0.002, 1.335, rz + 0.015), bp(rx - 0.008, 1.45, rz + 0.045), bp(rx + 0.01, 1.57, rz + 0.077), bp(rx + 0.024, 1.7, rz + 0.09)], 0.0045, 0.0045, V(1, 0, 0), 8, 4),
    null,
    GEAR,
    S_POLY,
  );
  chest.add(
    sweep([bp(rx + 0.02, 1.27, rz - 0.035), bp(-0.17, 1.34, -0.09), bp(-0.12, 1.42, -0.14), bp(-0.1, 1.44, -0.15)], 0.004, 0.004, V(0, 1, 0), 6, 4),
    null,
    GEAR,
    S_POLY,
  );

  probe(SEG.chest, bp(0, 1.12, -0.21));
  probe(SEG.chest, bp(0, 1.3, -0.225));
  probe(SEG.chest, bp(0, 1.29, rusher ? 0.14 : 0.235));
  probe(SEG.chest, bp(0, 1.45, 0.17));
  probe(SEG.chest, bp(-0.24, 1.2, 0.04));
  probe(SEG.chest, bp(0.245, 1.18, 0.04));
  probe(SEG.chest, bp(rx + 0.024, 1.7, rz + 0.09));

  // ========================================================================= ARMS + RIFLE
  // Deltoid → elbow → wrist (IK onto the rifle grip / handguard); sleeves with folds + cuffs,
  // stitched elbow pads, gloves. Authored on the ready carry; the animation raises it to aim.
  const arms = sinks[SEG.arms];
  const toModel = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyMatrix4(RIFLE_M);
  const shoulderR = bp(0.178, 1.432, 0.0);
  const shoulderL = bp(-0.178, 1.428, -0.07); // support shoulder rolled forward
  const wristR = toModel(0.042, -0.074, 0.13);
  const wristL = toModel(-0.04, -0.07, -0.125);
  const elbowR = solveElbow(shoulderR, wristR, 0.31, 0.27, V(0.6, -0.75, 0.25));
  // Support elbow drops down and in, under the gun (not winged out with a straight arm).
  const elbowL = solveElbow(shoulderL, wristL, 0.31, 0.27, V(0.35, -1, 0.05));
  for (const [s, e, w, side] of [
    [shoulderR, elbowR, wristR, 1],
    [shoulderL, elbowL, wristL, -1],
  ] as const) {
    const upLen = s.distanceTo(e) + 0.02;
    arms.add(
      limb(upLen, [
        [0, 0.054, 0.054],
        [0.08, 0.064, 0.062],
        [0.28, 0.062, 0.059, 0, 0.03],
        [0.52, 0.057, 0.054, 0, 0.07],
        [0.72, 0.054, 0.051, 0, 0.09],
        [0.8, 0.056, 0.053, 0, 0.1],
        [0.86, 0.051, 0.048],
        [0.92, 0.054, 0.051, 0, 0.08],
        [1, 0.044, 0.044],
      ], 12),
      alongMatrix(s, e),
      uni,
      S_CAMO,
    );
    arms.add(sphere(0.064, 10, 7), trs(s.x, s.y, s.z), uni, S_CAMO);
    arms.add(sphere(0.048, 8, 6), trs(e.x, e.y, e.z), uni, S_CAMO);
    const foreLen = e.distanceTo(w) + 0.012;
    arms.add(
      limb(foreLen, [
        [0, 0.048, 0.048],
        [0.08, 0.053, 0.05, 0, 0.1],
        [0.13, 0.049, 0.046],
        [0.2, 0.055, 0.051, 0, 0.08],
        [0.42, 0.051, 0.047, 0, 0.09],
        [0.72, 0.044, 0.04, 0, 0.07],
        [0.8, 0.047, 0.044, 0, 0.1],
        [0.88, 0.046, 0.043],
        [0.9, 0.039, 0.035],
        [1, 0.03, 0.028],
      ], 12),
      alongMatrix(e, w),
      uni,
      S_CAMO,
    );
    // Glove cuff.
    const cuffA = w.clone().lerp(e, 0.12);
    arms.add(
      limb(cuffA.distanceTo(w) + 0.025, [
        [0, 0.037, 0.034],
        [0.3, 0.039, 0.036],
        [1, 0.032, 0.028],
      ], 10),
      alongMatrix(cuffA, w),
      GLOVE,
      S_GLOVE,
    );
    // Elbow pad on the point of the elbow (bisector of the bend).
    const u1 = e.clone().sub(s).normalize();
    const u2 = w.clone().sub(e).normalize();
    const n = u1.clone().sub(u2);
    if (n.lengthSq() < 1e-4) n.set(side * 0.6, -0.8, 0.2);
    n.normalize();
    pad(arms, facing(e.clone().addScaledVector(n, 0.044), n, u1.clone().negate()), 0.07, 0.085, vest);
    if (heavy) {
      // Shoulder armour draped over the deltoid.
      const c = s.clone().add(V(side * 0.035, 0.035, 0));
      arms.add(curveZ(rbox(0.11, 0.1, 0.022, 0.01, 1), 6), facing(c, V(side * 0.7, 0.7, 0).normalize(), V(0, 0, -1)), vest, S_CORDURA);
    }
    // Blank hook-and-loop patch on the upper sleeve.
    const patch = rbox(0.008, 0.07, 0.06, 0.003, 1);
    patch.translate(side * 0.058, 0.1, 0);
    arms.add(patch, alongMatrix(s, e), vestLite, S_FABRIC);
  }

  // Gloved hands, authored in rifle space so they wrap the createRifle() grip + handguard.
  const RM = (m: THREE.Matrix4): THREE.Matrix4 => RIFLE_M.clone().multiply(m);
  const fingerSweep = (pts: THREE.Vector3[], r: number): THREE.BufferGeometry => sweep(pts, r, r * 0.9, V(0, 1, 0), 4, 6);
  // Right (firing) hand on the 22°-swept pistol grip: back of hand outboard, three fingers
  // wrapped round the front strap, index straight along the receiver (trigger discipline).
  arms.add(rbox(0.03, 0.084, 0.08, 0.013, 1), RM(trs(0.029, -0.072, 0.083, -0.38, 0.22, 0)), GLOVE, S_GLOVE);
  for (let i = 0; i < 3; i++) {
    const y = -0.062 - i * 0.021;
    const zc = 0.046 + ((-0.033 - y) / 0.927) * 0.375; // grip centreline at this height
    arms.add(
      fingerSweep([V(0.03, y, zc + 0.006), V(0.025, y, zc - 0.019), V(0.0, y - 0.002, zc - 0.03), V(-0.022, y - 0.002, zc - 0.02), V(-0.025, y - 0.003, zc - 0.002)], 0.0102),
      RIFLE_M,
      GLOVE,
      S_GLOVE,
    );
  }
  {
    const [g, m] = capsuleAB(V(0.024, -0.036, 0.035), V(0.021, -0.03, -0.01), 0.0078);
    arms.add(g, RM(m), GLOVE, S_GLOVE);
  }
  {
    const [g, m] = capsuleAB(V(0.01, -0.045, 0.11), V(-0.021, -0.028, 0.05), 0.011);
    arms.add(g, RM(m), GLOVE, S_GLOVE);
  }
  // Left (support) hand under the handguard: palm cupped beneath, fingers up the far side,
  // thumb forward along the near side (C-clamp).
  arms.add(rbox(0.07, 0.028, 0.084, 0.012, 1), RM(trs(-0.01, -0.042, -0.18, 0, 0, 0.35)), GLOVE, S_GLOVE);
  for (let i = 0; i < 4; i++) {
    const z = -0.213 + i * 0.019;
    arms.add(fingerSweep([V(0.008, -0.044, z), V(0.027, -0.033, z), V(0.031, -0.012, z), V(0.027, 0.006, z)], 0.0093), RIFLE_M, GLOVE, S_GLOVE);
  }
  {
    const [g, m] = capsuleAB(V(-0.032, -0.028, -0.14), V(-0.03, 0.008, -0.223), 0.0102);
    arms.add(g, RM(m), GLOVE, S_GLOVE);
  }

  probe(SEG.arms, bp(0.24, 1.43, 0));
  probe(SEG.arms, bp(-0.24, 1.43, -0.03));
  probe(SEG.arms, elbowR.clone().add(V(0.04, -0.03, 0)));
  probe(SEG.arms, elbowL.clone().add(V(-0.04, -0.03, 0)));
  probe(SEG.arms, toModel(0, -0.06, -0.19));
  probe(SEG.arms, toModel(0.03, -0.1, 0.07));
  probe(SEG.arms, MUZZLE_LOCAL.clone().applyMatrix4(RIFLE_M));
  probe(SEG.arms, toModel(0, -0.16, -0.1));
  probe(SEG.arms, toModel(0, 0.1, -0.03));
  probe(SEG.arms, toModel(0, -0.1, 0.287));

  // ========================================================================= HEAD
  // (Head sink applies HEAD_DROP to everything below; coordinates are the undropped design.)
  const head = sinks[SEG.head];
  head.add(
    loft(
      [
        { y: 1.47, rx: 0.056, rz: 0.058, z: -0.006 },
        { y: 1.6, rx: 0.054, rz: 0.056, z: -0.01 },
      ],
      10,
    ),
    null,
    knit,
    S_KNIT,
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
  // Head under a balaclava: ellipsoid with a tapered jaw, chin, nose ridge and flatter back.
  {
    const g = new THREE.SphereGeometry(1, 18, 12);
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
    head.add(g, trs(0, 1.665, -0.014), knit, S_KNIT);
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
  } else {
    // Skin round the eyes (the balaclava's eye opening), then ballistic goggles: a visible
    // polymer frame, a smoked half-mirror lens, strap round the back.
    head.add(sweep(arc(0.083, 0.099, 1.674, -1.2, 1.2, 6), 0.046, 0.006, V(0, 1, 0), 10, 6), null, SKIN[kit], S_SKIN);
    head.add(sweep(arc(0.086, 0.101, 1.678, -1.38, 1.38, 8), 0.029, 0.012, V(0, 1, 0), 12, 8), null, frame, S_POLY);
    head.add(sweep(arc(0.088, 0.109, 1.679, -1.12, 1.12, 6), 0.022, 0.004, V(0, 1, 0), 10, 6), null, LENS, S_LENS);
    head.add(sweep(arc(0.088, 0.104, 1.685, 1.3, Math.PI * 2 - 1.3, 8), 0.012, 0.003, V(0, 1, 0), 8, 4), null, mixHex(frame, GEAR, 0.5), S_FABRIC);
  }

  // Helmet: high-cut shell with brow, ear cut-outs and a deeper nape.
  const hc = V(0, 1.705, 0.002);
  const HAX = 0.123;
  const HAY = 0.12;
  const HAZ = 0.138;
  const rim = (phi: number): number => {
    const d = phi <= Math.PI ? phi : Math.PI * 2 - phi; // angular distance from the front
    return 1.724 + 0.026 * bumpA(d, Math.PI * 0.5, Math.PI * 0.27) - 0.012 * bumpA(d, Math.PI * 0.24, Math.PI * 0.12) - 0.06 * smooth(Math.PI * 0.62, Math.PI * 0.95, d);
  };
  head.add(helmetShell(hc, HAX, HAY, HAZ, rim, 28, 10), null, t.helmet, S_HELMET);
  const onShell = (phi: number, y: number, out = 1.0): THREE.Vector3 => {
    const th = Math.acos(THREE.MathUtils.clamp((y - hc.y) / HAY, -0.99, 0.99));
    const fl = 1 + 0.045 * Math.pow(th / Math.acos(THREE.MathUtils.clamp((rim(phi) - hc.y) / HAY, -0.6, 0.98)), 3);
    return V(hc.x + HAX * Math.sin(th) * Math.sin(phi) * out * fl, y, hc.z - HAZ * Math.sin(th) * Math.cos(phi) * out * fl);
  };
  // Accessory rails along both sides, just above the rim.
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const d = THREE.MathUtils.lerp(Math.PI * 0.3, Math.PI * 0.74, i / 5);
      const phi = s > 0 ? d : Math.PI * 2 - d;
      pts.push(onShell(phi, rim(phi) + 0.022, 1.02));
    }
    head.add(sweep(pts, 0.012, 0.006, V(0, 1, 0), 8), null, GEAR, S_POLY);
  }
  if (!rusher) {
    // NVG shroud + folded mount at the brow, counterweight pouch at the nape, IR strobe on top.
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
      14,
    );
    head.add(cup, trs(s * 0.083, 1.655, 0.006, 0, 0, -s * Math.PI * 0.5), shells, S_POLY);
    head.add(rbox(0.012, 0.045, 0.022, 0.004, 1), trs(s * 0.118, 1.705, 0.008, 0, 0, s * 0.18), GEAR, S_POLY);
  }
  // Chin strap.
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
  const hy = -HEAD_DROP;
  probe(SEG.head, V(0, 1.83 + hy, 0));
  probe(SEG.head, V(0, 1.75 + hy, -0.155));
  probe(SEG.head, V(0, 1.7 + hy, 0.18));
  probe(SEG.head, V(0.135, 1.66 + hy, 0));
  probe(SEG.head, V(-0.135, 1.66 + hy, 0));
  probe(SEG.head, V(0.11, 1.75 + hy, 0.08));
  probe(SEG.head, V(-0.11, 1.75 + hy, 0.08));

  return { geos: sinks.map((s, i) => s.build(PIVOT[i])), probes, rifle };
}

const cache = new Map<string, RigDef>();

/** Shared (cached) rig for a look. Callers must not dispose the geometries. */
export function soldierRig(t: Look): RigDef {
  const key = `${t.kit}:${t.uniform}:${t.vest}:${t.helmet}`;
  let def = cache.get(key);
  if (!def) {
    def = build(t);
    cache.set(key, def);
  }
  return def;
}
