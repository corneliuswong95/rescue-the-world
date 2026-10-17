/**
 * First-person tactical-gloved hands + combat-shirt sleeves, authored in code.
 *
 * A hand is modelled once as a right hand in hand-local space (+Y wrist→knuckles, +Z back of
 * the hand, +X toward the little finger, origin at the wrist joint): a sculpted palm block,
 * tapered lathe phalanges that overlap at the joints, a thenar pad, moulded knuckle armour and
 * leather palm/finger-tip panels. Fingers wrap their grip automatically — each bone flexes
 * until its end meets the gripped cylinder — so the same hand hugs a pistol grip or a
 * handguard. The left hand is the mirrored build.
 *
 * Placement is solved, not guessed: a hand spec names the rifle-space point and axis it grips
 * plus the direction the back of the hand faces; the wrist position and orientation follow.
 *
 * Glove cuff + sleeve are lathed along the forearm with cloth folds. Each arm is two meshes
 * (glove material, sleeve material), both pivoting at the wrist so the viewmodel can animate.
 */
import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Batch, bakeAO, creased, mirrorX, tintAll, tintByNormal } from './geo';
import { getViewmodelMaterials } from './materials';

const FABRIC = new THREE.Color(0x5b4b37); // coyote nylon
const LEATHER = new THREE.Color(0x2c2823); // synthetic palm / finger-tip leather
const ARMOUR = new THREE.Color(0x2a2824); // moulded knuckle guard, cuff neoprene

/** A cylinder the fingers wrap, in hand-local space: axis ∥ X through (y, z). */
export interface GripCylinder {
  y: number;
  z: number;
  radius: number;
}

export interface HandSpec {
  /** Build as a mirrored (left) hand. Hand-local +X then points to the thumb side. */
  mirror: boolean;
  /** Rifle-space point on the gripped axis, level with the hand's centre line (local x = 0). */
  gripPoint: THREE.Vector3;
  /** Rifle-space direction of hand-local +X (gripped axis; little finger for a right hand). */
  across: THREE.Vector3;
  /** Approximate rifle-space direction the back of the hand faces. */
  dorsal: THREE.Vector3;
  grip: GripCylinder;
  /** Posed (non-wrapping) fingers (0 index … 3 little): per-joint flexion + abduction (rad). */
  fingers?: Partial<Record<0 | 1 | 2 | 3, { flex: readonly [number, number, number]; spread: number }>>;
  /**
   * Thumb, rifle space: metacarpal direction, the direction it curls toward, and the flexion
   * (rad) at the two distal joints.
   */
  thumb: { dir: THREE.Vector3; curl: THREE.Vector3; flex: readonly [number, number] };
  /** Direction from the wrist toward the elbow, rifle space. */
  forearm: THREE.Vector3;
}

interface FingerSpec {
  x: number;
  knuckle: readonly [number, number];
  len: readonly [number, number, number];
  rad: readonly [number, number, number, number];
  /** Natural abduction (rad) — fingers fan slightly instead of lying in parallel. */
  splay: number;
}

// Gloved proportions (m): index, middle, ring, little. rad = MCP, PIP, DIP, tip.
const FINGERS: readonly FingerSpec[] = [
  { x: -0.026, knuckle: [0.088, -0.0015], len: [0.043, 0.025, 0.021], rad: [0.0086, 0.0079, 0.0073, 0.0067], splay: -0.05 },
  { x: -0.0075, knuckle: [0.092, -0.001], len: [0.047, 0.029, 0.022], rad: [0.0088, 0.0081, 0.0075, 0.0069], splay: 0 },
  { x: 0.0108, knuckle: [0.089, -0.0015], len: [0.044, 0.027, 0.021], rad: [0.0084, 0.0077, 0.0071, 0.0065], splay: 0.045 },
  { x: 0.0272, knuckle: [0.081, -0.003], len: [0.035, 0.021, 0.018], rad: [0.0075, 0.0069, 0.0063, 0.0058], splay: 0.1 },
];
const MAX_FLEX = [1.7, 1.85, 1.35];

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/** Solved hand placement: wrist position + orientation in rifle space. */
interface HandFrame {
  wrist: THREE.Vector3;
  rotation: THREE.Quaternion;
}

/** Orientation whose hand-local +X maps to `across` and +Z (back of hand) toward `dorsal`. */
export function handRotation(across: THREE.Vector3, dorsal: THREE.Vector3): THREE.Quaternion {
  const x = across.clone().normalize();
  const z = dorsal.clone().addScaledVector(x, -dorsal.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Wrist position that puts the hand's grip cylinder axis through `gripPoint`. */
export function wristFor(spec: HandSpec, rotation: THREE.Quaternion, gripPoint: THREE.Vector3): THREE.Vector3 {
  const offset = new THREE.Vector3(0, spec.grip.y, spec.grip.z).applyQuaternion(rotation);
  return gripPoint.clone().sub(offset);
}

function solveHand(spec: HandSpec): HandFrame {
  const rotation = handRotation(spec.across, spec.dorsal);
  return { wrist: wristFor(spec, rotation, spec.gripPoint), rotation };
}

/**
 * Tapered phalanx from a → b (hand-local): radius r0 at a, r1 at b, rounded ends that overlap
 * the neighbouring bones. Slightly flattened palm-to-back; palm side tinted leather.
 */
function bone(
  a: THREE.Vector3,
  b: THREE.Vector3,
  r0: number,
  r1: number,
  lateral: THREE.Vector3,
  tip: boolean,
): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const prof: THREE.Vector2[] = [];
  const crease = (y: number, r: number): number => 1 - 0.28 * Math.max(0, 1 - Math.abs(y) / (r * 0.9));
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const t = (-Math.PI / 2) * (1 - i / n);
    prof.push(new THREE.Vector2(Math.cos(t) * r0, Math.sin(t) * r0));
  }
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI / 2) * (i / n);
    prof.push(new THREE.Vector2(Math.cos(t) * r1 + 1e-5, len + Math.sin(t) * r1));
  }
  const g = new THREE.LatheGeometry(prof, 14);
  g.scale(1, 1, 0.87);
  const geo = creased(g.toNonIndexed(), 60);
  g.dispose();
  // Bone-local: +Y along the bone, −Z palm side. Darken the knuckle creases at the joints.
  bakeAO(geo, (p) => crease(p.y, r0) * (tip ? 1 : crease(p.y - len, r1)));
  tintByNormal(geo, new THREE.Vector3(0, 0, -1), 0.5, LEATHER, 1);
  if (tip) tintByNormal(geo, new THREE.Vector3(0, 1, 0), 0.45, LEATHER, 1);
  _y.subVectors(b, a).normalize();
  _z.crossVectors(lateral, _y).normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z).setPosition(a);
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Superellipsoid (|x|^p + |y|^p + |z|^p = 1 style) of the given extents: a soft padded block —
 * rounder than a rounded box, flatter than an ellipsoid. `k` < 1 squares it up.
 */
function superellipsoid(w: number, l: number, t: number, k: number, seg = 28): THREE.BufferGeometry {
  const sphere = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
  sphere.deleteAttribute('uv');
  sphere.deleteAttribute('normal');
  const g = mergeVertices(sphere); // weld the UV seam + poles so normals are seamless
  sphere.dispose();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const f = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), k);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, f(pos.getX(i)) * (w / 2), f(pos.getY(i)) * (l / 2), f(pos.getZ(i)) * (t / 2));
  }
  return g;
}

/** Moulded armour pad centred at p (lies in x/y, thickness z), arched across x, tilted about x. */
function plate(w: number, l: number, t: number, p: THREE.Vector3, rx: number, arch = 0): THREE.BufferGeometry {
  const g = superellipsoid(w, l, t, 0.45, 20);
  if (arch !== 0) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / (w / 2);
      pos.setZ(i, pos.getZ(i) - arch * u * u);
    }
  }
  g.computeVertexNormals();
  g.rotateX(rx).translate(p.x, p.y, p.z);
  const geo = g.toNonIndexed();
  g.dispose();
  tintAll(geo, ARMOUR, 1);
  return geo;
}

/** Sculpted palm: padded block tapered toward the wrist, arched across the back, knuckle arc. */
function palm(): THREE.BufferGeometry {
  const W = 0.08;
  const L = 0.088;
  const T = 0.03;
  const g = superellipsoid(W, L, T, 0.42, 36);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const t = (y + L / 2) / L; // 0 wrist … 1 knuckles
    const u = x / (W / 2);
    x *= THREE.MathUtils.lerp(0.74, 1.0, Math.min(1, t * 1.5));
    z *= THREE.MathUtils.lerp(0.9, 0.84, t);
    if (z > 0) z += 0.0045 * (1 - u * u); // dorsal arch
    else z -= 0.003 * (1 - u * u) * (1 - t); // fleshy heel of the palm
    y -= 0.008 * u * u * t; // knuckle arc (middle finger longest)
    y -= 0.004 * Math.max(0, u) * t; // little-finger side shorter
    pos.setXYZ(i, x, y + L / 2 + 0.004, z);
  }
  g.computeVertexNormals();
  const geo = g.toNonIndexed();
  g.dispose();
  tintByNormal(geo, new THREE.Vector3(0, 0, -1), 0.3, LEATHER, 1);
  return geo;
}

/**
 * Bends a finger bone-by-bone until each joint lands on the grip cylinder surface (or uses the
 * fixed pose), then abducts the chain about the knuckle (rotation about the back-of-hand axis).
 */
function wrapFinger(
  f: FingerSpec,
  grip: GripCylinder,
  posed: { flex: readonly number[]; spread: number } | undefined,
): THREE.Vector3[] {
  const fixed = posed?.flex;
  const pts: THREE.Vector3[] = [new THREE.Vector3(f.x, f.knuckle[0], f.knuckle[1])];
  let ang = 0; // direction in the (y, z) plane; 0 = +Y, curling = decreasing
  let py = f.knuckle[0];
  let pz = f.knuckle[1];
  for (let j = 0; j < 3; j++) {
    const L = j === 2 ? f.len[j] - f.rad[3] : f.len[j];
    let flex = MAX_FLEX[j];
    if (fixed) {
      flex = fixed[j];
    } else {
      const rf = grip.radius + f.rad[j + 1];
      for (let a = 0; a <= MAX_FLEX[j]; a += 0.01) {
        const ey = py + Math.cos(ang - a) * L;
        const ez = pz + Math.sin(ang - a) * L;
        if (Math.hypot(ey - grip.y, ez - grip.z) <= rf) {
          flex = a;
          break;
        }
      }
    }
    ang -= flex;
    py += Math.cos(ang) * L;
    pz += Math.sin(ang) * L;
    pts.push(new THREE.Vector3(f.x, py, pz));
  }
  const spread = f.splay + (posed?.spread ?? 0);
  if (spread !== 0) {
    const k = pts[0];
    for (const p of pts) p.sub(k).applyAxisAngle(AXIS_Z, spread).add(k);
  }
  return pts;
}

/** All glove parts in right-hand-local space (pre-mirror). */
function handParts(spec: HandSpec, rotation: THREE.Quaternion): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [palm()];
  const lateral = new THREE.Vector3(1, 0, 0);

  FINGERS.forEach((f, i) => {
    const posed = spec.fingers?.[i as 0 | 1 | 2 | 3];
    const pts = wrapFinger(f, spec.grip, posed);
    const lat = lateral.clone().applyAxisAngle(AXIS_Z, f.splay + (posed?.spread ?? 0));
    for (let j = 0; j < 3; j++) out.push(bone(pts[j], pts[j + 1], f.rad[j], f.rad[j + 1], lat, j === 2));
    // Low knuckle pad moulded over the proximal phalanx.
    const d = pts[1].clone().sub(pts[0]).normalize();
    const nrm = new THREE.Vector3().crossVectors(lat, d).normalize();
    const mid = pts[0].clone().lerp(pts[1], 0.45).addScaledVector(nrm, f.rad[0] * 0.8);
    const pad = plate(f.rad[0] * 1.2, 0.012, 0.0028, new THREE.Vector3(), 0, 0.001);
    pad.applyMatrix4(new THREE.Matrix4().makeBasis(lat, d, nrm).setPosition(mid));
    out.push(pad);
  });

  // Moulded knuckle guard across the MCP row, following the dorsal arch.
  out.push(plate(0.064, 0.018, 0.0048, new THREE.Vector3(0.0, 0.078, 0.0158), 0.12, 0.0042));

  // Thumb: metacarpal + two phalanges curling in the plane of (dir, curl); thenar pad bridges
  // it into the palm. Rifle-space directions → pre-mirror hand-local.
  const t = spec.thumb;
  const inv = rotation.clone().invert();
  const toLocal = (d: THREE.Vector3): THREE.Vector3 => {
    const l = d.clone().applyQuaternion(inv);
    if (spec.mirror) l.x = -l.x;
    return l.normalize();
  };
  const dir = toLocal(t.dir);
  const curl = toLocal(t.curl);
  const axis = new THREE.Vector3().crossVectors(dir, curl).normalize(); // dir → curl
  const lens = [0.031, 0.027, 0.023];
  const rads = [0.0108, 0.0095, 0.0087, 0.0078];
  const tp = [new THREE.Vector3(-0.024, 0.018, -0.009)];
  const flexes = [0, t.flex[0], t.flex[1]];
  const palmSide = axis.clone().negate();
  for (let j = 0; j < 3; j++) {
    dir.applyAxisAngle(axis, flexes[j]);
    tp.push(tp[j].clone().addScaledVector(dir, j === 2 ? lens[j] - rads[3] : lens[j]));
  }
  for (let j = 0; j < 3; j++) out.push(bone(tp[j], tp[j + 1], rads[j], rads[j + 1], palmSide, j === 2));
  const thenar = new THREE.SphereGeometry(1, 18, 12).toNonIndexed();
  thenar.scale(0.016, 0.03, 0.0125).translate(-0.02, 0.038, -0.008);
  tintByNormal(thenar, new THREE.Vector3(0, 0, -1), -0.1, LEATHER, 1);
  out.push(thenar);
  return out;
}

/** Cloth fold displacement (m) at angle `th` around and `s` along a sleeve or cuff. */
type FoldFn = (th: number, s: number) => number;

/**
 * Lathed tube along `axis` from `start` with radius profile [(r, s)], an oval cross-section
 * aligned to `lateral` (minor axis scaled by `flatten`), displaced by `fold`. Fold valleys get
 * baked occlusion (`foldAO` = darkening per metre of inward fold) so creases read. Rifle space.
 */
function clothTube(
  start: THREE.Vector3,
  axis: THREE.Vector3,
  lateral: THREE.Vector3,
  flatten: number,
  profile: readonly (readonly [number, number])[],
  fold: FoldFn,
  foldAO = 0,
): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, s]) => new THREE.Vector2(r, s)),
    40,
  );
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const ao = new Float32Array(pos.count).fill(1);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const s = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const f = fold(Math.atan2(x, z), s);
    ao[i] = THREE.MathUtils.clamp(1 + f * foldAO, 0.55, 1.1);
    const k = (r + f) / r;
    pos.setXYZ(i, x * k, s, z * k * flatten);
  }
  if (foldAO > 0) g.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  g.computeVertexNormals();
  const geo = creased(g.toNonIndexed(), 70);
  g.dispose();
  const ay = axis.clone().normalize();
  const ax = lateral.clone().addScaledVector(ay, -lateral.dot(ay)).normalize();
  const az = new THREE.Vector3().crossVectors(ax, ay);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(ax, ay, az).setPosition(start));
  return geo;
}

const SLEEVE_LEN = 0.36;
const SLEEVE_WRIST_R = 0.045;
const SLEEVE_ELBOW_R = 0.06;
const CUFF_BAND = 0.045; // hemmed cuff band, ends in a seam

/** Sleeve radius profile: turned hem, cuff band + seam, then a steady taper to the elbow. */
function sleeveProfile(): [number, number][] {
  const prof: [number, number][] = [
    [SLEEVE_WRIST_R - 0.008, 0.007],
    [SLEEVE_WRIST_R - 0.002, 0.0],
    [SLEEVE_WRIST_R + 0.0015, 0.004],
  ];
  const n = 32;
  for (let i = 1; i <= n; i++) {
    const s = 0.004 + (SLEEVE_LEN * i) / n;
    let r = THREE.MathUtils.lerp(SLEEVE_WRIST_R, SLEEVE_ELBOW_R, s / SLEEVE_LEN);
    if (s < CUFF_BAND) r += 0.0015; // band sits proud of the sleeve
    if (Math.abs(s - CUFF_BAND) < 0.006) r -= 0.0012; // seam groove
    prof.push([r, s]);
  }
  return prof;
}

/**
 * Sleeve folds: compression rings bunched above the cuff, long diagonal drape folds along the
 * forearm and a twist toward the elbow. `seed` decorrelates left/right arms.
 */
function sleeveFolds(seed: number): FoldFn {
  return (th, s) => {
    const bunch = THREE.MathUtils.smoothstep(s, 0.04, 0.07) * (1 - THREE.MathUtils.smoothstep(s, 0.13, 0.21));
    const ring = Math.max(0, Math.sin(s * 85 + th * 0.6 + seed));
    // Sharp-crested drape folds (|sin| creases) read as cloth, not a smooth sausage.
    const drape = 1 - 2 * Math.abs(Math.sin(th * 1.5 + s * 11 + seed));
    return (
      0.006 * bunch * ring * ring +
      0.0042 * Math.sin(th * 3 + s * 22 + seed) +
      0.0026 * drape +
      0.0016 * Math.sin(th * 5 - s * 40 + seed * 2.1) +
      0.0009 * Math.sin(th * 9 + s * 70 + seed * 0.7) +
      0.003 * THREE.MathUtils.smoothstep(s, 0.22, 0.36) * Math.sin(th * 2 + s * 30 + seed * 1.3)
    );
  };
}

export interface Arm {
  /** Hand + glove cuff; origin at the wrist joint. */
  glove: THREE.Group;
  /** Sleeve; origin at the wrist joint, built along `spec.forearm`. */
  sleeve: THREE.Group;
  /** Solved wrist position (rifle space) — the rest pose of both groups. */
  wrist: THREE.Vector3;
}

/** Builds one gloved hand + sleeve (one mesh each), both pivoting at the wrist. */
export function createArm(spec: HandSpec): Arm {
  const mats = getViewmodelMaterials();
  const { wrist, rotation } = solveHand(spec);
  const handToLocal = new THREE.Matrix4().compose(new THREE.Vector3(), rotation, new THREE.Vector3(1, 1, 1));
  const toLocal = new THREE.Matrix4().makeTranslation(-wrist.x, -wrist.y, -wrist.z);
  const glove = new THREE.Group();
  const sleeve = new THREE.Group();
  glove.position.copy(wrist);
  sleeve.position.copy(wrist);
  const gb = new Batch();
  const sb = new Batch();

  for (const part of handParts(spec, rotation)) {
    const g = spec.mirror ? mirrorX(part) : part;
    gb.add(mats.glove, g.applyMatrix4(handToLocal), FABRIC);
  }

  const fa = spec.forearm.clone().normalize();
  const lateral = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
  // Neoprene glove cuff bridging hand → sleeve.
  const cuff = clothTube(
    wrist.clone().addScaledVector(fa, -0.014),
    fa,
    lateral,
    0.72,
    [
      [0.0, -0.001],
      [0.02, -0.001],
      [0.0255, 0.006],
      [0.027, 0.03],
      [0.0285, 0.062],
    ],
    (th, s) => 0.0006 * Math.sin(th * 4 + s * 60 + 1.7),
  );
  gb.add(mats.glove, cuff.applyMatrix4(toLocal), ARMOUR, 1);

  // Sleeve: turned hem over the cuff, cuff band + seam, tapering out to the elbow.
  const start = wrist.clone().addScaledVector(fa, 0.03);
  const tube = clothTube(start, fa, lateral, 0.82, sleeveProfile(), sleeveFolds(spec.mirror ? 4.2 : 0.6), 60);
  sb.add(mats.sleeve, tube.applyMatrix4(toLocal), 0xffffff);

  // Hook-and-loop cuff tab on the back of the wrist.
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
  back.addScaledVector(fa, -back.dot(fa)).normalize();
  const side = new THREE.Vector3().crossVectors(fa, back);
  const tab = superellipsoid(0.026, 0.03, 0.0032, 0.4, 16);
  tab.computeVertexNormals();
  const tabPos = start
    .clone()
    .addScaledVector(fa, 0.022)
    .addScaledVector(back, (SLEEVE_WRIST_R + 0.0015) * 0.82 + 0.0028);
  tab.applyMatrix4(new THREE.Matrix4().makeBasis(side, fa, back).setPosition(tabPos));
  sb.add(mats.sleeve, tab.applyMatrix4(toLocal), 0xd8d8d8);

  for (const mesh of [...gb.build(glove), ...sb.build(sleeve)]) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
  }
  return { glove, sleeve, wrist };
}
