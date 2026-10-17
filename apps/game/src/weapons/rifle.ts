/**
 * Generic modern 5.56 carbine (AR-pattern silhouette, no brand names or markings), authored
 * entirely in code at real-world scale (~0.83 m overall, 14.5" barrel, 11.5" M-LOK handguard,
 * red dot with a flared objective on a low, absolute co-witness riser).
 *
 * Local convention: bore axis on y = 0 along −Z, pistol grip near the origin, metres.
 *
 * Two detail levels share one silhouette:
 *  - 'viewmodel': bevelled extrusions, lathed round parts, Picatinny teeth, see-through M-LOK
 *    slots, ported brake, pins/controls, optic with coated glass + collimated dot. Merged into
 *    one mesh per material (≈5 draws) plus a separate magazine mesh for the reload animation.
 *  - 'world' (default; every enemy carries one): unbevelled, low-segment, 2 draws, < 2.5k tris.
 */
import * as THREE from 'three/webgpu';
import {
  Batch,
  bakeInteriorAO,
  extrudeCentered,
  lathe,
  long,
  place,
  rrect,
  shape,
  side,
  top,
  type Corner,
  type ExtrudeOpts,
  type V2,
} from './geo';
import { getViewmodelMaterials, getWorldMaterials, KNURL } from './materials';

export type RifleDetail = 'viewmodel' | 'world';

export interface Rifle {
  group: THREE.Group;
  /** Muzzle tip in rifle-local space (flash / tracer origin). */
  muzzle: THREE.Vector3;
  /** Separately animatable magazine (viewmodel only); pivot = top of the mag well. */
  magazine: THREE.Object3D | null;
}

/** Key rifle-local anchor points shared with the hands + viewmodel animation. Read-only. */
export const RIFLE_POINTS = {
  muzzle: new THREE.Vector3(0, 0, -0.528),
  /** Centre of the optic window — the ADS pose puts the eye on this line. */
  opticCenter: new THREE.Vector3(0, 0.054, -0.032),
  magPivot: new THREE.Vector3(0, -0.006, -0.0995),
  /** Ejection port (right side, behind the dust cover) — brass leaves here. */
  ejectionPort: new THREE.Vector3(0.0145, 0.0, -0.068),
} as const;

const DEG = Math.PI / 180;

/** sRGB part tints (read by the materials through the vertex `color` attribute). */
const TINT = {
  alu: 0x1b1c1e,
  rail: 0x1a1b1d,
  steel: 0x232422,
  poly: 0x1e1f21,
  rubber: 0x141414,
  mag: 0x26272a,
  magPlate: 0x1d1e20,
};

interface Palette {
  alu: THREE.Material;
  steel: THREE.Material;
  poly: THREE.Material;
}

/** Shorthand for bevel options that collapse to sharp/low-poly in the world variant. */
interface Lod {
  hi: boolean;
  radial: number;
  o: (bevel: number, segments?: number) => ExtrudeOpts;
}

function makeLod(hi: boolean): Lod {
  return {
    hi,
    radial: hi ? 28 : 8,
    o: (bevel, segments = 1) =>
      hi ? { bevel, bevelSegments: segments, curveSegments: 6 } : { bevel: 0, curveSegments: 2 },
  };
}

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

/** Handguard outer octagon (x, y), counter-clockwise. */
const HG_OCT: V2[] = [
  [0.012, 0.0205],
  [-0.012, 0.0205],
  [-0.0205, 0.012],
  [-0.0205, -0.016],
  [-0.0105, -0.0265],
  [0.0105, -0.0265],
  [0.0205, -0.016],
  [0.0205, 0.012],
];
const HG_FRONT = -0.44;
const HG_REAR = -0.15;
const HG_WALL = 0.0025;
const MLOK_Z = [-0.19, -0.232, -0.274, -0.316, -0.358, -0.4];

const RAIL_BASE: Corner[] = [
  [-0.0078, 0.02],
  [0.0078, 0.02],
  [0.0078, 0.0228],
  [0.0106, 0.0254],
  [0.0106, 0.0262],
  [-0.0106, 0.0262],
  [-0.0106, 0.0254],
  [-0.0078, 0.0228],
];
const RAIL_TOOTH: Corner[] = [
  [-0.0106, 0.0261],
  [0.0106, 0.0261],
  [0.0077, 0.0292],
  [-0.0077, 0.0292],
];

function circle(r: number, n: number, cx = 0, cy = 0): Corner[] {
  const out: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Annular sector (x, y) between radii r0 < r1 over angles a0 → a1 (radians). */
function sector(r0: number, r1: number, a0: number, a1: number, n: number): Corner[] {
  const out: Corner[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([Math.cos(a) * r1, Math.sin(a) * r1]);
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([Math.cos(a) * r0, Math.sin(a) * r0]);
  }
  return out;
}

/**
 * One flat facet of the hollow handguard: a wall-thick slab whose outer face lies on the edge
 * p0→p1 of the (CCW) octagon, optionally pierced by M-LOK slots. Interior face gets baked AO.
 */
function facet(p0: V2, p1: V2, slots: boolean, lod: Lod): THREE.BufferGeometry {
  const ex = p1[0] - p0[0];
  const ey = p1[1] - p0[1];
  const len = Math.hypot(ex, ey);
  const zc = (HG_FRONT + HG_REAR) / 2;
  const outline = rrect(zc, len / 2, HG_REAR - HG_FRONT, len, 0);
  const holes = slots && lod.hi ? MLOK_Z.map((z) => rrect(z, len / 2, 0.032, 0.0072, 0.0035)) : [];
  const g = extrudeCentered(shape(outline, holes), HG_WALL, lod.o(0.00045));
  g.translate(0, 0, HG_WALL / 2);
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(ex / len, ey / len, 0),
    new THREE.Vector3(-ey / len, ex / len, 0),
  );
  m.setPosition(p0[0], p0[1], 0);
  g.applyMatrix4(m);
  bakeInteriorAO(g, new THREE.Vector3(0, -0.003, 0), new THREE.Vector3(0, 0, 1), 0.28);
  return g;
}

/** Picatinny rail from z0 (front) to z1 (rear): dovetail base + machined cross-slots. */
function rail(b: Batch, mat: THREE.Material, z0: number, z1: number, lod: Lod): void {
  if (!lod.hi) {
    b.add(mat, long([...RAIL_BASE.slice(0, 5), [0.0077, 0.0292], [-0.0077, 0.0292], ...RAIL_BASE.slice(5)], z0, z1), TINT.rail);
    return;
  }
  b.add(mat, long(RAIL_BASE, z0, z1, lod.o(0.0004)), TINT.rail);
  const tooth = long(RAIL_TOOTH, -0.0024, 0.0024, lod.o(0.00035));
  for (let z = z1 - 0.0045; z > z0 + 0.0025; z -= 0.01) {
    b.add(mat, tooth.clone().translate(0, 0, z), TINT.rail);
  }
  tooth.dispose();
}

/** Grip-local (a along the grip axis downward, b toward the rear) → rifle (z, y). */
const GRIP_ANGLE = 22 * DEG;
function gp(a: number, b: number, r = 0): Corner {
  const s = Math.sin(GRIP_ANGLE);
  const c = Math.cos(GRIP_ANGLE);
  return [0.046 + a * s + b * c, -0.033 - a * c + b * s, r];
}

// ---------------------------------------------------------------------------------------------
// Magazine — curved 30-round polymer box, authored with its pivot at the mag-well top.
// ---------------------------------------------------------------------------------------------

const MAG_LEN = 0.186;
const MAG_STRAIGHT = 0.072;
const MAG_R = 0.36;
const MAG_DEPTH = 0.0615;

/** Centre-line point and rear-pointing normal at arc length s (mag-local z, y). */
function magFrame(s: number): { c: V2; n: V2; t: V2 } {
  if (s <= MAG_STRAIGHT) return { c: [0, -s], n: [1, 0], t: [0, -1] };
  const phi = (s - MAG_STRAIGHT) / MAG_R;
  return {
    c: [-(MAG_R - MAG_R * Math.cos(phi)), -MAG_STRAIGHT - MAG_R * Math.sin(phi)],
    n: [Math.cos(phi), -Math.sin(phi)],
    t: [-Math.sin(phi), -Math.cos(phi)],
  };
}

function magPoint(s: number, across: number, along = 0, r = 0): Corner {
  const f = magFrame(s);
  return [f.c[0] + f.n[0] * across + f.t[0] * along, f.c[1] + f.n[1] * across + f.t[1] * along, r];
}

/** Adds the magazine parts; `offset` = (z, y) of the mag-well pivot when baked into the rifle. */
function addMagazine(b: Batch, mat: THREE.Material, lod: Lod, offset: V2 = [0, 0]): void {
  const n = lod.hi ? 12 : 4;
  const half = MAG_DEPTH / 2;
  const front: Corner[] = [];
  const rear: Corner[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (MAG_LEN * i) / n;
    const r = i === n ? 0.003 : 0;
    front.push(magPoint(s, -half, 0, r));
    rear.push(magPoint(s, half, 0, r));
  }
  const body = side([...front, ...rear.reverse()], 0.0222, lod.o(0.0016, 2));
  b.add(mat, body.translate(0, offset[1], offset[0]), TINT.mag);

  // Flared floor plate.
  const L = MAG_LEN;
  const plate = side(
    [
      magPoint(L - 0.004, -half - 0.0035, 0, 0.002),
      magPoint(L + 0.0085, -half - 0.003, 0, 0.003),
      magPoint(L + 0.0085, half + 0.0025, 0, 0.003),
      magPoint(L - 0.004, half + 0.0025, 0, 0.002),
    ],
    0.0262,
    lod.o(0.0016, 2),
  );
  b.add(mat, plate.translate(0, offset[1], offset[0]), TINT.magPlate);

  if (!lod.hi) return;
  // Moulded grip ribs on both flanks near the base.
  for (const s of [L - 0.024, L - 0.034, L - 0.044, L - 0.054]) {
    const rib = side(
      [
        magPoint(s, -half + 0.009, -0.0013, 0.001),
        magPoint(s, half - 0.009, -0.0013, 0.001),
        magPoint(s, half - 0.009, 0.0013, 0.001),
        magPoint(s, -half + 0.009, 0.0013, 0.001),
      ],
      0.0232,
      lod.o(0.0004),
    );
    b.add(mat, rib.translate(0, offset[1], offset[0]), TINT.mag);
  }
}

// ---------------------------------------------------------------------------------------------
// Rifle
// ---------------------------------------------------------------------------------------------

function addReceivers(b: Batch, M: Palette, lod: Lod): void {
  const o = lod.o;
  // Upper receiver body + narrower rail riser (the classic flat-top step).
  b.add(
    M.alu,
    side(
      [
        [0.07, -0.0165],
        [0.07, 0.008, 0.002],
        [-0.15, 0.008, 0.0015],
        [-0.15, -0.01, 0.002],
        [-0.145, -0.0165],
      ],
      0.026,
      o(0.0012),
    ),
    TINT.alu,
  );
  b.add(
    M.alu,
    side(
      [
        [0.07, 0.006],
        [0.07, 0.0205, 0.0015],
        [-0.15, 0.0205, 0.001],
        [-0.15, 0.006],
      ],
      0.0215,
      o(0.0008),
    ),
    TINT.alu,
  );
  rail(b, M.alu, -0.149, 0.066, lod);

  // Charging handle (T-handle, latch on the left).
  b.add(
    M.alu,
    top(
      [
        [-0.0055, 0.06],
        [0.0055, 0.06],
        [0.0055, 0.079],
        [0.016, 0.081, 0.0015],
        [0.016, 0.0905, 0.002],
        [-0.0205, 0.0905, 0.002],
        [-0.0215, 0.083, 0.002],
        [-0.0055, 0.079],
      ],
      0.0172,
      0.0228,
      o(0.0007),
    ),
    TINT.alu,
  );

  // Lower receiver with buffer tower, mag well, and integral trigger guard.
  b.add(
    M.alu,
    side(
      [
        [0.07, 0.0165],
        [0.07, -0.0165],
        [-0.147, -0.0165],
        [-0.147, -0.026, 0.003],
        [-0.141, -0.031, 0.002],
        [-0.141, -0.06],
        [-0.058, -0.06],
        [-0.058, -0.034, 0.003],
        [0.066, -0.034, 0.004],
        [0.084, -0.02, 0.004],
        [0.084, 0.01, 0.004],
        [0.078, 0.0165, 0.003],
      ],
      0.0235,
      o(0.0012),
    ),
    TINT.alu,
  );
  b.add(
    M.alu,
    side(
      [
        [-0.1425, -0.026, 0.002],
        [-0.0565, -0.026, 0.002],
        [-0.0565, -0.069, 0.0015],
        [-0.1435, -0.069, 0.0015],
      ],
      0.0272,
      o(0.0011),
    ),
    TINT.alu,
  );
  b.add(
    M.alu,
    side(
      [
        [-0.057, -0.032],
        [0.025, -0.032],
        [0.025, -0.04, 0.004],
        [0.014, -0.0545, 0.006],
        [-0.05, -0.0545, 0.005],
        [-0.057, -0.046, 0.004],
      ],
      0.0125,
      o(0.0014),
      [
        [
          [-0.0505, -0.0355],
          [0.0165, -0.0355],
          [0.0165, -0.0405, 0.003],
          [0.0095, -0.0495, 0.004],
          [-0.0455, -0.0495, 0.004],
          [-0.0505, -0.0445, 0.003],
        ],
      ],
    ),
    TINT.alu,
  );
  if (lod.hi) {
    // Flared mag-well lip.
    b.add(
      M.alu,
      top(rrect(0, -0.0995, 0.031, 0.0905, 0.004), -0.0745, -0.067, o(0.001), [
        rrect(0, -0.0995, 0.0236, 0.065, 0.002),
      ]),
      TINT.alu,
    );
  }

  // Pistol grip (polymer, swept 22°, beavertail).
  b.add(
    M.poly,
    side(
      [
        gp(-0.012, -0.0205),
        gp(0.03, -0.0215, 0.02),
        gp(0.072, -0.0225, 0.02),
        gp(0.101, -0.0215, 0.008),
        gp(0.104, 0.0195, 0.008),
        gp(0.075, 0.0215, 0.02),
        gp(0.03, 0.0205, 0.012),
        gp(0.01, 0.024, 0.006),
        gp(0.0, 0.033, 0.004),
        gp(-0.01, 0.025),
      ],
      0.0305,
      o(0.0055, 3),
    ),
    TINT.poly,
  );

  // Trigger blade.
  b.add(
    M.steel,
    side(
      [
        [-0.0065, -0.031],
        [0.0005, -0.031],
        [-0.0015, -0.04, 0.004],
        [-0.0055, -0.0468, 0.0015],
        [-0.009, -0.0472, 0.001],
        [-0.0072, -0.0405, 0.004],
      ],
      0.0045,
      o(0.0006),
    ),
    TINT.steel,
  );
}

function addControls(b: Batch, M: Palette, lod: Lod): void {
  const o = lod.o;
  // Pins: front pivot, rear take-down, trigger, hammer (through the lower, proud both sides).
  for (const [z, y, r] of [
    [-0.14, -0.024, 0.0034],
    [0.06, -0.022, 0.0034],
    [-0.004, -0.025, 0.0024],
    [0.016, -0.023, 0.0024],
  ] as const) {
    b.add(M.steel, place(new THREE.CylinderGeometry(r, r, 0.0251, 24), 0, y, z, 0, 0, Math.PI / 2), TINT.steel);
  }

  // Selector (left): hub + lever in FIRE (pointing up-rear).
  b.add(M.steel, place(new THREE.CylinderGeometry(0.0062, 0.0062, 0.002, 24), -0.0128, -0.021, 0.033, 0, 0, Math.PI / 2), TINT.steel);
  {
    const c: V2 = [0.033, -0.021];
    const d: V2 = [0.26, 0.966];
    const p: V2 = [d[1], -d[0]];
    const pt = (along: number, across: number, r = 0): Corner => [
      c[0] + d[0] * along + p[0] * across,
      c[1] + d[1] * along + p[1] * across,
      r,
    ];
    b.add(M.steel, side([pt(0, 0.003), pt(0.0135, 0.0022, 0.002), pt(0.0135, -0.0022, 0.002), pt(0, -0.003)], 0.0022, o(0.0005), [], -0.0138), TINT.steel);
  }

  // Bolt catch paddle (left), mag release button (right).
  b.add(
    M.alu,
    side(
      [
        [-0.069, -0.021],
        [-0.059, -0.021],
        [-0.059, -0.03, 0.002],
        [-0.0695, -0.034, 0.002],
      ],
      0.003,
      o(0.0006),
      [],
      -0.0145,
    ),
    TINT.alu,
  );
  b.add(M.steel, place(new THREE.CylinderGeometry(0.0046, 0.0046, 0.0045, 24), 0.0135, -0.041, -0.051, 0, 0, Math.PI / 2), TINT.steel);

  // Right side: dust cover (closed) on its hinge rod, brass deflector, forward assist.
  b.add(
    M.alu,
    side(
      [
        [-0.106, -0.0085, 0.001],
        [-0.029, -0.0085, 0.001],
        [-0.029, 0.0072, 0.0012],
        [-0.106, 0.0072, 0.0012],
      ],
      0.0012,
      o(0.0003),
      [],
      0.0135,
    ),
    TINT.alu,
  );
  b.add(M.steel, place(new THREE.CylinderGeometry(0.0012, 0.0012, 0.079, 10), 0.0137, -0.0094, -0.0675, Math.PI / 2), TINT.steel);
  b.add(
    M.alu,
    side(
      [
        [-0.027, -0.004],
        [-0.009, -0.004],
        [-0.009, 0.0075, 0.003],
        [-0.021, 0.0075, 0.002],
      ],
      0.0065,
      o(0.0012),
      [],
      0.015,
    ),
    TINT.alu,
  );
  const fa = new THREE.Group();
  const housing = place(new THREE.CylinderGeometry(0.0072, 0.0078, 0.026, 24), 0, 0, 0, Math.PI / 2);
  const button = place(new THREE.CylinderGeometry(0.0062, 0.0062, 0.009, 24), 0, 0, 0.016, Math.PI / 2);
  fa.position.set(0.0128, 0.0012, 0.046);
  fa.rotation.y = 0.32;
  fa.updateMatrix();
  b.add(M.alu, housing.applyMatrix4(fa.matrix), TINT.alu);
  b.add(M.steel, button.applyMatrix4(fa.matrix), TINT.steel, KNURL);
}

function addFrontEnd(b: Batch, M: Palette, lod: Lod): void {
  const o = lod.o;
  const seg = lod.radial;

  // Barrel: thick section under the handguard, stepped to the 0.75" muzzle journal.
  b.add(
    M.steel,
    lathe(
      [
        [0.0118, -0.14],
        [0.0118, -0.3],
        [0.01, -0.3015],
        [0.0095, -0.303],
        [0.0095, -0.4665],
        [0.008, -0.468],
        [0.008, -0.476],
      ],
      { segments: seg },
    ),
    TINT.steel,
  );

  // Hollow free-float handguard (8 facets; sides + bottom carry M-LOK slots).
  if (lod.hi) {
    for (let i = 0; i < HG_OCT.length; i++) {
      const p0 = HG_OCT[i];
      const p1 = HG_OCT[(i + 1) % HG_OCT.length];
      const slotted = i === 2 || i === 4 || i === 6;
      b.add(M.alu, facet(p0, p1, slotted, lod), TINT.alu);
    }
    b.add(M.alu, long(HG_OCT.map(([x, y]) => [x, y, 0.001] as Corner), HG_REAR - 0.006, HG_REAR, o(0.0006), [circle(0.0125, 20)]), TINT.alu);
    // Gas block + gas tube, visible through the slots.
    b.add(
      M.steel,
      lathe(
        [
          [0.0, -0.383],
          [0.0128, -0.383],
          [0.0138, -0.384],
          [0.0138, -0.404],
          [0.0128, -0.405],
          [0.0, -0.405],
        ],
        { segments: 24 },
      ),
      TINT.steel,
    );
    b.add(M.steel, lathe([[0.0024, -0.15], [0.0024, -0.388]], { segments: 8 }).translate(0, 0.0118, 0), TINT.steel);
    // Front QD sling socket (left side, ahead of the slots).
    b.add(
      M.steel,
      place(
        lathe(
          [
            [0.0056, 0.002],
            [0.0056, -0.0018],
            [0.005, -0.0025],
            [0.0034, -0.0025],
            [0.0034, -0.0012],
            [0.0, -0.0012],
          ],
          { segments: 24, interiorAO: 0.35 },
        ),
        -0.0205,
        -0.002,
        -0.428,
        0,
        Math.PI / 2,
      ),
      TINT.steel,
    );
  } else {
    b.add(M.alu, long(HG_OCT.map(([x, y]) => [x, y] as Corner), HG_FRONT, HG_REAR), TINT.alu);
  }
  rail(b, M.alu, HG_FRONT + 0.002, HG_REAR - 0.003, lod);

  // Muzzle brake: collar, two-baffle side-port body (top/bottom bridges), crown.
  if (lod.hi) {
    const ring = (z0: number, z1: number): V2[] => [
      [0.0062, z0],
      [0.0104, z0],
      [0.0108, z0 - 0.0004],
      [0.0108, z1 + 0.0004],
      [0.0104, z1],
      [0.0062, z1],
      [0.0062, z0],
    ];
    const brake: V2[][] = [
      [
        [0.0062, -0.4655],
        [0.0098, -0.4655],
        [0.0108, -0.4667],
        [0.0108, -0.4765],
        [0.0062, -0.4765],
        [0.0062, -0.4655],
      ],
      ring(-0.4895, -0.4925),
      ring(-0.5035, -0.5065),
      [
        [0.0062, -0.5185],
        [0.0108, -0.5185],
        [0.0108, -0.5262],
        [0.0096, -0.528],
        [0.0058, -0.528],
        [0.005, -0.5272],
        [0.005, -0.5185],
        [0.0062, -0.5185],
      ],
    ];
    for (const prof of brake) b.add(M.steel, lathe(prof, { segments: 28, interiorAO: 0.25 }), TINT.steel);
    for (const a of [Math.PI / 2, -Math.PI / 2]) {
      const bridge = long(sector(0.0062, 0.0108, a - 0.75, a + 0.75, 8), -0.5185, -0.4765, o(0.0003));
      bakeInteriorAO(bridge, new THREE.Vector3(), new THREE.Vector3(0, 0, 1), 0.25);
      b.add(M.steel, bridge, TINT.steel);
    }
  } else {
    b.add(M.steel, lathe([[0.0, -0.4655], [0.0108, -0.4655], [0.0108, -0.528], [0.0, -0.528]], { segments: seg }), TINT.steel);
  }

  // Folded front BUIS on the rail.
  if (lod.hi) {
    b.add(M.alu, side([[-0.436, 0.0262], [-0.416, 0.0262], [-0.418, 0.034, 0.002], [-0.433, 0.0345, 0.002]], 0.025, o(0.001)), TINT.alu);
    b.add(M.alu, side([[-0.431, 0.0296], [-0.407, 0.0296], [-0.407, 0.0325, 0.0012], [-0.431, 0.0328, 0.0012]], 0.012, o(0.0006)), TINT.alu);
  }
}

function addRearEnd(b: Batch, M: Palette, lod: Lod): void {
  const o = lod.o;
  // Receiver extension (buffer tube) with castle nut + end plate.
  b.add(
    M.alu,
    lathe(
      lod.hi
        ? [
            [0.0, 0.258],
            [0.0125, 0.258],
            [0.0146, 0.2562],
            [0.0146, 0.0965],
            [0.017, 0.096],
            [0.0175, 0.095],
            [0.0175, 0.089],
            [0.0168, 0.0885],
            [0.0196, 0.088],
            [0.0196, 0.085],
            [0.0168, 0.0846],
            [0.0168, 0.08],
          ]
        : [
            [0.0, 0.258],
            [0.0146, 0.258],
            [0.0146, 0.08],
          ],
      { segments: lod.radial },
    ),
    TINT.alu,
  );

  // Collapsible stock: body with lightening cut, round tube housing, rubber butt pad.
  b.add(
    M.poly,
    side(
      [
        [0.15, 0.0205, 0.004],
        [0.276, 0.0235, 0.006],
        [0.2855, 0.0225, 0.003],
        [0.2895, -0.098, 0.006],
        [0.272, -0.1005, 0.006],
        [0.196, -0.04, 0.014],
        [0.16, -0.0215, 0.006],
        [0.15, -0.0205, 0.004],
      ],
      0.029,
      o(0.004, 2),
      lod.hi
        ? [
            [
              [0.214, -0.0262, 0.006],
              [0.2665, -0.0262, 0.006],
              [0.2665, -0.0815, 0.006],
            ],
          ]
        : [],
    ),
    TINT.poly,
  );
  b.add(
    M.poly,
    side(
      [
        [0.284, 0.024, 0.003],
        [0.299, 0.0245, 0.004],
        [0.303, -0.0995, 0.004],
        [0.288, -0.102, 0.003],
      ],
      0.0335,
      o(0.003, 2),
    ),
    TINT.rubber,
  );
  if (lod.hi) {
    b.add(
      M.poly,
      lathe(
        [
          [0.0, 0.262],
          [0.017, 0.262],
          [0.019, 0.26],
          [0.019, 0.154],
          [0.0176, 0.15],
          [0.015, 0.15],
        ],
        { segments: 28 },
      ),
      TINT.poly,
    );
    // Adjustment lever under the stock nose.
    b.add(M.poly, side([[0.158, -0.019], [0.19, -0.03, 0.002], [0.192, -0.0345, 0.002], [0.166, -0.027, 0.002]], 0.012, o(0.0012)), TINT.poly);
  }

  // Folded rear BUIS behind the optic.
  if (lod.hi) {
    b.add(M.alu, side([[0.04, 0.0262], [0.064, 0.0262], [0.062, 0.0345, 0.002], [0.042, 0.0345, 0.002]], 0.025, o(0.001)), TINT.alu);
    b.add(M.alu, side([[0.018, 0.0296], [0.046, 0.0296], [0.046, 0.0332, 0.0012], [0.018, 0.0328, 0.0012]], 0.017, o(0.0006)), TINT.alu);
  }
}

/**
 * Red dot with a rear-aperture window: the bore flares gently from the rear lip to the
 * objective so the bore wall is seen edge-on from the ADS eye point. Turret caps and the
 * brightness dial are smooth cylinders flagged as knurled (`mask` = KNURL) — the material
 * draws the knurl as a footprint-faded bump instead of geometric stripes.
 */
function addOptic(b: Batch, M: Palette, glass: THREE.Material | null, lod: Lod): void {
  const o = lod.o;
  const y = RIFLE_POINTS.opticCenter.y;
  // Low clamp base gripping the rail.
  b.add(
    M.alu,
    side(
      [
        [-0.05, 0.0244, 0.001],
        [-0.008, 0.0244, 0.001],
        [-0.008, 0.0335, 0.002],
        [-0.05, 0.0335, 0.002],
      ],
      0.0262,
      o(0.0009),
    ),
    TINT.alu,
  );
  if (!lod.hi) {
    b.add(
      M.alu,
      lathe([[0.0, -0.0135], [0.014, -0.0135], [0.014, -0.03], [0.016, -0.045], [0.016, -0.0507], [0.0, -0.0507]], {
        segments: 8,
      }).translate(0, y, 0),
      TINT.alu,
    );
    b.add(M.alu, long([[-0.008, 0.033], [0.008, 0.033], [0.008, 0.042], [-0.008, 0.042]], -0.036, -0.016), TINT.alu);
    return;
  }

  // Short riser neck (its front slopes away under the objective bell), then a saddle whose
  // concave top is embedded in the tube wall (no gap, no intrusion into the bore).
  b.add(
    M.alu,
    side(
      [
        [-0.04, 0.033],
        [-0.014, 0.033],
        [-0.017, 0.0405, 0.0015],
        [-0.03, 0.0405, 0.0015],
        [-0.036, 0.036],
      ],
      0.015,
      o(0.0008),
    ),
    TINT.alu,
  );
  const saddle: Corner[] = [
    [-0.0075, 0.0395, 0.001],
    [0.0075, 0.0395, 0.001],
  ];
  const rs = 0.0132;
  const a0 = Math.asin(0.0075 / rs);
  for (let i = 0; i <= 10; i++) {
    const a = a0 - (2 * a0 * i) / 10;
    saddle.push([Math.sin(a) * rs, y - Math.cos(a) * rs]);
  }
  b.add(M.alu, long(saddle, -0.029, -0.0165, o(0.0006)), TINT.alu);

  // Housing: slim rear ring, body, gently flared objective; conical bore (interior darkened).
  b.add(
    M.alu,
    lathe(
      [
        [0.0116, -0.0135],
        [0.013, -0.0135],
        [0.014, -0.0145],
        [0.014, -0.0175],
        [0.0136, -0.018],
        [0.0136, -0.03],
        [0.0152, -0.04],
        [0.0157, -0.0445],
        [0.016, -0.045],
        [0.016, -0.0497],
        [0.0153, -0.0507],
        [0.0142, -0.0507],
        [0.0118, -0.0145],
        [0.0116, -0.0135],
      ],
      { segments: 64, interiorAO: 0.05 },
    ).translate(0, y, 0),
    TINT.alu,
  );

  // Turrets on the body (×0.6 of a full-size sight): elevation (top), windage (right),
  // brightness dial (left). Smooth 48-segment cylinders; knurl comes from the material.
  const tz = -0.024;
  const R = 0.0136;
  const boss = (): THREE.BufferGeometry => new THREE.CylinderGeometry(0.0045, 0.0045, 0.0036, 48);
  const cap = (): THREE.BufferGeometry => new THREE.CylinderGeometry(0.0039, 0.0039, 0.0027, 48);
  b.add(M.alu, boss().translate(0, y + R + 0.0008, tz), TINT.alu);
  b.add(M.alu, cap().translate(0, y + R + 0.004, tz), TINT.alu, KNURL);
  b.add(M.alu, place(boss(), R + 0.0008, y, tz, 0, 0, -Math.PI / 2), TINT.alu);
  b.add(M.alu, place(cap(), R + 0.004, y, tz, 0, 0, -Math.PI / 2), TINT.alu, KNURL);
  b.add(M.alu, place(new THREE.CylinderGeometry(0.0041, 0.0041, 0.0024, 48), -R - 0.0004, y, tz, 0, 0, Math.PI / 2), TINT.alu);
  b.add(M.alu, place(new THREE.CylinderGeometry(0.0053, 0.0053, 0.0033, 48), -R - 0.0031, y, tz, 0, 0, Math.PI / 2), TINT.alu, KNURL);

  // Cross-bolt: hex nut left, round head right.
  b.add(M.steel, place(new THREE.CylinderGeometry(0.0046, 0.0046, 0.004, 6), -0.0151, 0.0288, -0.029, 0, 0, Math.PI / 2), TINT.steel);
  b.add(M.steel, place(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0025, 24), 0.0143, 0.0288, -0.029, 0, 0, Math.PI / 2), TINT.steel);

  if (glass) b.add(glass, new THREE.CircleGeometry(0.0138, 64).translate(0, y, -0.046), 0xffffff);
}

export function createRifle(detail: RifleDetail = 'world'): Rifle {
  const lod = makeLod(detail === 'viewmodel');
  const group = new THREE.Group();
  group.name = `rifle-${detail}`;
  const b = new Batch();

  let M: Palette;
  let glass: THREE.Material | null = null;
  if (lod.hi) {
    const vm = getViewmodelMaterials();
    M = { alu: vm.aluminium, steel: vm.steel, poly: vm.polymer };
    glass = vm.glass;
  } else {
    const wm = getWorldMaterials();
    M = { alu: wm.metal, steel: wm.metal, poly: wm.polymer };
  }

  addReceivers(b, M, lod);
  addFrontEnd(b, M, lod);
  addRearEnd(b, M, lod);
  addOptic(b, M, glass, lod);
  if (lod.hi) addControls(b, M, lod);

  const mp = RIFLE_POINTS.magPivot;
  let magazine: THREE.Object3D | null = null;
  if (lod.hi) {
    // Separate mesh so the reload can pull it; pivot at the top of the mag well.
    magazine = new THREE.Group();
    magazine.name = 'magazine';
    magazine.position.copy(mp);
    const mb = new Batch();
    addMagazine(mb, M.poly, lod);
    mb.build(magazine);
    group.add(magazine);
  } else {
    addMagazine(b, M.poly, lod, [mp.z, mp.y]);
  }

  for (const mesh of b.build(group)) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  return { group, muzzle: RIFLE_POINTS.muzzle.clone(), magazine };
}
