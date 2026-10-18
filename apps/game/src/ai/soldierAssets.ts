/**
 * Skinned soldier assets: the CC0 Quaternius body (65-joint UE-style rig) and its CC0 animation
 * library (see CREDITS.md), prepared once at boot.
 *
 * Body prep (once):
 *  - the meshopt/quantized positions are re-baked to real metres in the bind pose and the
 *    skeleton's inverses recomputed, so `positionGeometry` is a stable, unit-correct pattern
 *    space for the procedural camo (it never swims with the animation);
 *  - each vertex gets a zone from its dominant joint: hands → gloves, head/neck → knit
 *    balaclava with an eye band (darkened sockets), feet → tucked inside the code-built boots,
 *    the rest → combat shirt / trousers;
 *  - superhero anatomy is toned down: arms ×0.9 thick, waist ×1.08, hips ×1.05, then the
 *    clothing shell is Taubin-smoothed (muscle definition gone) and grown 2–3 cm along the new
 *    normals (cloth slack), so it reads as a uniform, not a wetsuit;
 *  - body measurements (chest / belt / knee / elbow surfaces) and a surface snap are handed to
 *    the kit so armour sits 1–2 cm off the cloth and straps lie flat on it.
 * Per look (kit + tint) a template is built: body + all kit parts merged into ONE skinned
 * geometry (each gear vertex rigidly weighted to its bone) — one draw call per soldier.
 *
 * Clips (once): translation channels are stripped except the pelvis (scaled to this body's
 * leg length) so the clips keep the body's proportions; then split into lower-body (locomotion)
 * and upper-body (aim / posture) sets, plus an additive upper-body flinch; Death01 also gets a
 * left/right mirrored copy (resampled in model space).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  BODY_SKIN,
  BOOT,
  GLOVE,
  KNIT,
  SKIN,
  S_BOOT,
  S_GLOVE,
  S_KNIT,
  S_SKIN,
  buildKit,
  camoSurface,
  type BodyFit,
  type Look,
} from './soldierKit';
import { soldierMaterial } from './soldierMaterial';

const BODY_URL = '/assets/characters/soldier_body.glb';
const ANIMS_URL = '/assets/characters/soldier_anims.glb';

export type LocoName = 'idle' | 'walk' | 'jog' | 'sprint';
export type AimName = 'up' | 'neutral' | 'down';

const LOCO_CLIPS: Record<LocoName, string> = { idle: 'Idle_Loop', walk: 'Walk_Loop', jog: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop' };
const AIM_CLIPS: Record<AimName, string> = { up: 'Pistol_Aim_Up', neutral: 'Pistol_Aim_Neutral', down: 'Pistol_Aim_Down' };

/** Bones driven by the locomotion (lower-body) layer; everything else is the upper layer. */
const LOWER = new Set(['root', 'pelvis', 'spine_01', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']);
const UPPER = new Set(['spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r']);
/** The pistol clips only lend their torso/neck posture: the shoulders are a one-handed pistol
 *  stance (support shoulder pulled back) and the arms are IK'd onto the rifle anyway. */
const AIM_POSTURE = new Set(['spine_02', 'spine_03', 'neck_01', 'Head']);

export interface SoldierClips {
  lower: Record<LocoName, THREE.AnimationClip>;
  upper: Record<LocoName, THREE.AnimationClip>;
  aim: Record<AimName, THREE.AnimationClip>;
  death: THREE.AnimationClip;
  deathMirror: THREE.AnimationClip;
  hitChest: THREE.AnimationClip;
  hitHead: THREE.AnimationClip;
  /** Natural ground speed of each locomotion loop (m/s): the planted foot's sweep speed. */
  speed: Record<LocoName, number>;
  /** Normalised time at which each loop's left foot is furthest forward: loops are blended
   *  phase-aligned on it, so walk + jog strides add up instead of cancelling. */
  phase: Record<LocoName, number>;
}

interface BodyBase {
  scene: THREE.Object3D; // prepared body (bind pose), used as the clone source per look
  mesh: THREE.SkinnedMesh;
  boneIndex: Map<string, number>;
  zone: Uint8Array;
  shade: Float32Array; // albedo multiplier (eye sockets)
  position: Float32Array; // reshaped / smoothed / inflated / tucked, real metres
  normal: Float32Array;
  fit: BodyFit;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
}

const Z_SHIRT = 0;
const Z_GLOVE = 1;
const Z_KNIT = 2;
const Z_SKIN = 3;
const Z_FOOT = 4;
const Z_TROUSER = 5;
const isCloth = (z: number): boolean => z === Z_SHIRT || z === Z_TROUSER;
/** Cloth slack (m) by dominant bone; other zones by zone. */
function inflation(zone: number, bone: string): number {
  if (zone === Z_GLOVE) return 0.004;
  if (zone === Z_KNIT) return 0.006;
  if (zone === Z_SKIN) return 0.003;
  if (bone.startsWith('upperarm')) return 0.02;
  if (bone.startsWith('lowerarm')) return 0.016;
  if (bone.startsWith('calf')) return 0.02;
  return 0.027; // torso, hips, thighs
}
/** Eye centres on this body's head (bind space) — the balaclava's eye opening is shaded here. */
const EYES = [new THREE.Vector3(0.032, 1.703, 0.08), new THREE.Vector3(-0.032, 1.703, 0.08)];

let base: BodyBase | null = null;
let clips: SoldierClips | null = null;
const templates = new Map<string, THREE.Object3D>();

/** Load + prepare the body and clips. Await once at boot, before any Soldier is built. */
export async function loadSoldierAssets(): Promise<void> {
  if (base) return;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [body, anims] = await Promise.all([loader.loadAsync(BODY_URL), loader.loadAsync(ANIMS_URL)]);
  base = prepareBody(body.scene);
  clips = prepareClips(anims.animations, base);
}

export function soldierClips(): SoldierClips {
  if (!clips) throw new Error('loadSoldierAssets() must be awaited first');
  return clips;
}

/** A fresh, independent skinned rig for `look` (cloned bones, shared geometry + material). */
export function cloneSoldierRig(look: Look): THREE.Object3D {
  if (!base) throw new Error('loadSoldierAssets() must be awaited first');
  const key = `${look.kit}:${look.uniform}:${look.vest}:${look.helmet}`;
  let tpl = templates.get(key);
  if (!tpl) {
    tpl = buildTemplate(base, look);
    templates.set(key, tpl);
  }
  return cloneSkinned(tpl);
}

// ------------------------------------------------------------------------------------------
function findSkinned(root: THREE.Object3D): THREE.SkinnedMesh {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  if (!found) throw new Error('soldier body: no skinned mesh');
  return found;
}

function prepareBody(scene: THREE.Object3D): BodyBase {
  const mesh = findSkinned(scene);
  scene.updateMatrixWorld(true);
  const sk = mesh.skeleton;
  sk.update();
  const boneMatrices = sk.boneMatrices;
  if (!boneMatrices) throw new Error('soldier body: skeleton has no bone matrices');
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const n = pos.count;
  const boneIndex = new Map<string, number>();
  sk.bones.forEach((b, i) => boneIndex.set(b.name, i));
  const idx = g.getIndex();
  if (!idx) throw new Error('soldier body: expected indexed geometry');
  const index = new Uint32Array(idx.count);
  for (let i = 0; i < idx.count; i++) index[i] = idx.getX(i);

  // 1) Bake bind-pose skinned positions in real metres; zone + reshape by joint weights.
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const zone = new Uint8Array(n);
  const shade = new Float32Array(n).fill(1);
  const domBone: string[] = new Array<string>(n);
  const blend = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const weightOf = (i: number, test: (name: string) => boolean): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (test(sk.bones[skinIndex[i * 4 + k]].name)) w += skinWeight[i * 4 + k];
    return w;
  };
  for (let i = 0; i < n; i++) {
    blend.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let best = 0;
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      const b = si.getComponent(i, k);
      skinIndex[i * 4 + k] = b;
      skinWeight[i * 4 + k] = w;
      if (w <= 0) continue;
      tmp.fromArray(boneMatrices, b * 16);
      for (let e = 0; e < 16; e++) blend.elements[e] += tmp.elements[e] * w;
      if (w > bestW) {
        bestW = w;
        best = b;
      }
    }
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix).applyMatrix4(blend).applyMatrix4(mesh.bindMatrixInverse);
    const name = sk.bones[best].name;
    domBone[i] = name;
    let z = Z_SHIRT;
    if (/^(hand_|index_|middle_|ring_|pinky_|thumb_)/.test(name)) z = Z_GLOVE;
    else if (name === 'Head' || name === 'neck_01') {
      z = v.y > 1.672 && v.y < 1.728 && v.z > 0.03 && Math.abs(v.x) < 0.08 ? Z_SKIN : Z_KNIT;
    } else if (/^(foot_|ball_)/.test(name) || (name.startsWith('calf_') && v.y < 0.2)) z = Z_FOOT;
    else if (/^(thigh_|calf_)/.test(name) || (name === 'pelvis' && v.y < 1.02)) z = Z_TROUSER;
    zone[i] = z;
    // Tone down the superhero build: thinner upper arms + traps, wider waist and hips.
    const wArm = weightOf(i, (b) => b.startsWith('upperarm')) + 0.6 * weightOf(i, (b) => b.startsWith('clavicle'));
    if (wArm > 0 && Math.abs(v.x) > 0.12) {
      const k = 1 - 0.1 * Math.min(1, wArm);
      v.y = 1.455 + (v.y - 1.455) * k;
      v.z = -0.065 + (v.z + 0.065) * k;
    }
    v.x *= 1 + 0.08 * weightOf(i, (b) => b === 'spine_01' || b === 'spine_02');
    const wHip = weightOf(i, (b) => b === 'pelvis');
    v.x *= 1 + 0.05 * wHip;
    v.z = -0.02 + (v.z + 0.02) * (1 + 0.05 * wHip);
    if (z === Z_FOOT) {
      // Tuck the bare foot / ankle inside the boot shell.
      const cx = Math.sign(v.x) * 0.118;
      v.x = cx + (v.x - cx) * 0.62;
      v.y = 0.055 + (v.y - 0.055) * 0.7;
      v.z = -0.02 + (v.z + 0.02) * 0.86;
    }
    v.toArray(position, i * 3);
    if (z === Z_SKIN) {
      // Darkened eye sockets inside the balaclava's eye opening.
      let dark = 0;
      for (const e of EYES) {
        const dx = (v.x - e.x) / 0.017;
        const dy = (v.y - e.y) / 0.013;
        dark = Math.max(dark, Math.exp(-(dx * dx + dy * dy)));
      }
      shade[i] = 1 - 0.7 * dark;
    }
  }

  // 2) Weld UV-seam duplicates so smoothing / normals are seamless.
  const weld = new Int32Array(n);
  const keyOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(position[i * 3] * 2e4)},${Math.round(position[i * 3 + 1] * 2e4)},${Math.round(position[i * 3 + 2] * 2e4)}`;
    const w = keyOf.get(k);
    if (w === undefined) {
      keyOf.set(k, i);
      weld[i] = i;
    } else weld[i] = w;
  }
  const nbrs: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = weld[index[t + e]];
      const b = weld[index[t + ((e + 1) % 3)]];
      if (a !== b) {
        nbrs[a].add(b);
        nbrs[b].add(a);
      }
    }
  }

  // 3) Taubin smoothing (no shrink) of the cloth shell: muscle definition goes.
  const canon: number[] = [];
  for (let i = 0; i < n; i++) if (weld[i] === i && isCloth(zone[i])) canon.push(i);
  const scratch = new Float32Array(n * 3);
  const pass = (lambda: number): void => {
    for (const i of canon) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      const nb = nbrs[i];
      for (const j of nb) {
        ax += position[j * 3];
        ay += position[j * 3 + 1];
        az += position[j * 3 + 2];
      }
      const m = nb.size || 1;
      scratch[i * 3] = position[i * 3] + lambda * (ax / m - position[i * 3]);
      scratch[i * 3 + 1] = position[i * 3 + 1] + lambda * (ay / m - position[i * 3 + 1]);
      scratch[i * 3 + 2] = position[i * 3 + 2] + lambda * (az / m - position[i * 3 + 2]);
    }
    for (const i of canon) {
      position[i * 3] = scratch[i * 3];
      position[i * 3 + 1] = scratch[i * 3 + 1];
      position[i * 3 + 2] = scratch[i * 3 + 2];
    }
  };
  for (let it = 0; it < 6; it++) {
    pass(0.55);
    pass(-0.58);
  }
  const spread = (): void => {
    for (let i = 0; i < n; i++) {
      const w = weld[i];
      if (w !== i) {
        position[i * 3] = position[w * 3];
        position[i * 3 + 1] = position[w * 3 + 1];
        position[i * 3 + 2] = position[w * 3 + 2];
      }
    }
  };
  spread();

  // 4) Grow the cloth along the smoothed normals, then final normals.
  computeNormals(position, index, weld, normal);
  for (let i = 0; i < n; i++) {
    if (zone[i] === Z_FOOT || weld[i] !== i) continue;
    const d = inflation(zone[i], domBone[i]);
    position[i * 3] += normal[i * 3] * d;
    position[i * 3 + 1] += normal[i * 3 + 1] * d;
    position[i * 3 + 2] += normal[i * 3 + 2] * d;
  }
  spread();
  computeNormals(position, index, weld, normal);

  const fit = measureBody(position, normal, zone, domBone);

  // The bind pose is now the real-unit geometry: recompute inverses for it.
  sk.calculateInverses();
  mesh.bind(sk, mesh.matrixWorld);
  return { scene, mesh, boneIndex, zone, shade, position, normal, skinIndex, skinWeight, index, fit };
}

/** Area-weighted vertex normals on welded vertices (copied back to seam duplicates). */
function computeNormals(position: Float32Array, index: Uint32Array, weld: Int32Array, out: Float32Array): void {
  out.fill(0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < index.length; t += 3) {
    const i0 = weld[index[t]];
    const i1 = weld[index[t + 1]];
    const i2 = weld[index[t + 2]];
    a.fromArray(position, i0 * 3);
    b.fromArray(position, i1 * 3).sub(a);
    c.fromArray(position, i2 * 3).sub(a);
    b.cross(c); // area-weighted face normal
    for (const i of [i0, i1, i2]) {
      out[i * 3] += b.x;
      out[i * 3 + 1] += b.y;
      out[i * 3 + 2] += b.z;
    }
  }
  for (let i = 0; i < weld.length; i++) {
    const w = weld[i];
    a.fromArray(out, w * 3).normalize();
    a.toArray(out, i * 3);
  }
}

/** Cloth-surface measurements the kit is fitted to (bind space, facing +Z, left = +X). */
function measureBody(position: Float32Array, normal: Float32Array, zone: Uint8Array, bone: string[]): BodyFit {
  const n = zone.length;
  const fit: BodyFit = {
    chestFront: -1,
    chestBack: 1,
    chestSide: 0,
    beltFront: -1,
    beltBack: 1,
    beltSide: 0,
    kneeFront: -1,
    thighOuter: 0,
    elbowBack: 1,
    nearest: (p) => {
      let best = Infinity;
      let bi = 0;
      for (let i = 0; i < n; i++) {
        if (!isCloth(zone[i])) continue;
        const dx = position[i * 3] - p.x;
        const dy = position[i * 3 + 1] - p.y;
        const dz = position[i * 3 + 2] - p.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      return bi;
    },
    snap: (p, off, out) => {
      // Project onto the nearest vertex's tangent plane: keeps the path's own lateral position
      // (smooth) instead of jumping vertex to vertex.
      const i = fit.nearest(p) * 3;
      const nx = normal[i];
      const ny = normal[i + 1];
      const nz = normal[i + 2];
      const d = off - ((p.x - position[i]) * nx + (p.y - position[i + 1]) * ny + (p.z - position[i + 2]) * nz);
      return out.set(p.x + nx * d, p.y + ny * d, p.z + nz * d);
    },
  };
  for (let i = 0; i < n; i++) {
    if (!isCloth(zone[i])) continue;
    const x = position[i * 3];
    const y = position[i * 3 + 1];
    const z = position[i * 3 + 2];
    const b = bone[i];
    const trunk = b.startsWith('spine') || b === 'pelvis';
    if (trunk && y > 1.2 && y < 1.4 && Math.abs(x) < 0.1) {
      fit.chestFront = Math.max(fit.chestFront, z);
      fit.chestBack = Math.min(fit.chestBack, z);
    }
    if (trunk && y > 1.12 && y < 1.28) fit.chestSide = Math.max(fit.chestSide, Math.abs(x));
    if (trunk && y > 0.97 && y < 1.05) {
      if (Math.abs(x) < 0.08) {
        fit.beltFront = Math.max(fit.beltFront, z);
        fit.beltBack = Math.min(fit.beltBack, z);
      }
      fit.beltSide = Math.max(fit.beltSide, Math.abs(x));
    }
    if (b.startsWith('calf') && y > 0.47 && y < 0.56) fit.kneeFront = Math.max(fit.kneeFront, z);
    if (b.startsWith('thigh') && y > 0.66 && y < 0.78) fit.thighOuter = Math.max(fit.thighOuter, Math.abs(x));
    if (b.startsWith('lowerarm') && Math.abs(x) > 0.44 && Math.abs(x) < 0.5) fit.elbowBack = Math.min(fit.elbowBack, z);
  }
  return fit;
}

/** Body + kit, merged into one skinned geometry, on a clone of the prepared body. */
function buildTemplate(b: BodyBase, look: Look): THREE.Object3D {
  const parts = buildKit(look, b.fit);
  const nBody = b.position.length / 3;
  let nVerts = nBody;
  let nIdx = b.index.length;
  for (const p of parts) {
    nVerts += p.geo.getAttribute('position').count;
    nIdx += (p.geo.getIndex() as THREE.BufferAttribute).count;
  }
  const position = new Float32Array(nVerts * 3);
  const normal = new Float32Array(nVerts * 3);
  const albedo = new Float32Array(nVerts * 3);
  const surf = new Float32Array(nVerts * 4);
  const skinIndex = new Uint16Array(nVerts * 4);
  const skinWeight = new Float32Array(nVerts * 4);
  const index = new Uint32Array(nIdx);

  // Body vertices: zone colours.
  position.set(b.position);
  normal.set(b.normal);
  skinIndex.set(b.skinIndex);
  skinWeight.set(b.skinWeight);
  index.set(b.index);
  const camo = camoSurface(look);
  // Shirt and trousers are separate garments: a slightly different dye lot and print scale.
  const shirtCamo = { ...camo, camo: camo.camo * 1.08 };
  const c = new THREE.Color();
  const dust = new THREE.Color(0x8c7d64);
  const shirt = new THREE.Color(look.uniform).multiplyScalar(1.05).getHex();
  const zoneLook: [number, typeof camo][] = [
    [shirt, shirtCamo],
    [GLOVE, S_GLOVE],
    [KNIT[look.kit], S_KNIT],
    [SKIN[look.kit], S_SKIN],
    [BOOT, S_BOOT],
    [look.uniform, camo],
  ];
  for (let i = 0; i < nBody; i++) {
    const [hex, s] = zoneLook[b.zone[i]];
    c.setHex(hex);
    const y = b.position[i * 3 + 1];
    if ((b.zone[i] === Z_TROUSER || b.zone[i] === Z_FOOT) && y < 0.6) c.lerp(dust, ((0.6 - y) / 0.6) * 0.4); // same as kit dust
    c.multiplyScalar(b.shade[i]);
    c.toArray(albedo, i * 3);
    surf[i * 4] = s.rough;
    surf[i * 4 + 1] = s.metal;
    surf[i * 4 + 2] = s.camo;
    surf[i * 4 + 3] = s.pattern;
  }

  // Gear vertices: rigid to their bone, or (straps) skinned like the cloth beneath them.
  let vo = nBody;
  let io = b.index.length;
  const pv = new THREE.Vector3();
  for (const p of parts) {
    const g = p.geo;
    const cnt = g.getAttribute('position').count;
    position.set(g.getAttribute('position').array as Float32Array, vo * 3);
    normal.set(g.getAttribute('normal').array as Float32Array, vo * 3);
    albedo.set(g.getAttribute('albedo').array as Float32Array, vo * 3);
    surf.set(g.getAttribute('surf').array as Float32Array, vo * 4);
    if (p.bone === BODY_SKIN) {
      for (let i = 0; i < cnt; i++) {
        const j = b.fit.nearest(pv.fromArray(position, (vo + i) * 3)) * 4;
        for (let k = 0; k < 4; k++) {
          skinIndex[(vo + i) * 4 + k] = b.skinIndex[j + k];
          skinWeight[(vo + i) * 4 + k] = b.skinWeight[j + k];
        }
      }
    } else {
      const bone = b.boneIndex.get(p.bone);
      if (bone === undefined) throw new Error(`soldier kit: unknown bone ${p.bone}`);
      for (let i = 0; i < cnt; i++) {
        skinIndex[(vo + i) * 4] = bone;
        skinWeight[(vo + i) * 4] = 1;
      }
    }
    const gi = g.getIndex() as THREE.BufferAttribute;
    for (let i = 0; i < gi.count; i++) index[io + i] = vo + gi.getX(i);
    vo += cnt;
    io += gi.count;
    g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('albedo', new THREE.BufferAttribute(albedo, 3));
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Generous bounds: covers every pose incl. a body lying full length from the feet.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.1);

  const tpl = cloneSkinned(b.scene);
  const mesh = findSkinned(tpl);
  mesh.geometry = geo;
  // SkinnedMesh culls with its own (otherwise lazily computed, pose-specific) sphere.
  mesh.boundingSphere = geo.boundingSphere.clone();
  mesh.material = soldierMaterial();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return tpl;
}

// ------------------------------------------------------------------------------------------
function trackBone(t: THREE.KeyframeTrack): string {
  return t.name.slice(0, t.name.lastIndexOf('.'));
}

function subClip(src: THREE.AnimationClip, name: string, keep: (bone: string) => boolean): THREE.AnimationClip {
  return new THREE.AnimationClip(name, src.duration, src.tracks.filter((t) => keep(trackBone(t))).map((t) => t.clone()));
}

function prepareClips(raw: THREE.AnimationClip[], b: BodyBase): SoldierClips {
  // Leg length of this body vs the animation library's mannequin (calf + foot bone offsets).
  const bone = (n: string): THREE.Object3D => b.scene.getObjectByName(n) as THREE.Object3D;
  const bodyLeg = bone('calf_l').position.length() + bone('foot_l').position.length();
  const byName = new Map(raw.map((c) => [c.name, c]));
  const get = (n: string): THREE.AnimationClip => {
    const c = byName.get(n);
    if (!c) throw new Error(`soldier anims: missing clip ${n}`);
    return c;
  };
  const sample = get('Idle_Loop');
  const legTrack = (n: string): number => {
    const t = sample.tracks.find((x) => x.name === `${n}.position`);
    return t ? Math.hypot(t.values[0], t.values[1], t.values[2]) : 0;
  };
  const mannequinLeg = legTrack('calf_l') + legTrack('foot_l');
  const legScale = mannequinLeg > 0 ? bodyLeg / mannequinLeg : 1;

  // Keep the body's own proportions: only the pelvis (scaled) and root may translate.
  const clean = (c: THREE.AnimationClip): THREE.AnimationClip => {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const t of c.tracks) {
      const bn = trackBone(t);
      if (t.name.endsWith('.position')) {
        if (bn === 'pelvis') {
          const s = t.clone();
          for (let i = 0; i < s.values.length; i++) s.values[i] *= legScale;
          tracks.push(s);
        } else if (bn === 'root') tracks.push(t);
      } else tracks.push(t);
    }
    return new THREE.AnimationClip(c.name, c.duration, tracks);
  };

  const lower = {} as Record<LocoName, THREE.AnimationClip>;
  const upper = {} as Record<LocoName, THREE.AnimationClip>;
  for (const k of Object.keys(LOCO_CLIPS) as LocoName[]) {
    const c = clean(get(LOCO_CLIPS[k]));
    lower[k] = subClip(c, `${c.name}_lower`, (n) => LOWER.has(n));
    upper[k] = subClip(c, `${c.name}_upper`, (n) => UPPER.has(n));
  }
  const aim = {} as Record<AimName, THREE.AnimationClip>;
  for (const k of Object.keys(AIM_CLIPS) as AimName[]) {
    const c = clean(get(AIM_CLIPS[k]));
    aim[k] = subClip(c, `${c.name}_upper`, (n) => AIM_POSTURE.has(n));
  }
  const additiveUpper = (n: string): THREE.AnimationClip => {
    const c = subClip(clean(get(n)), `${n}_add`, (bn) => UPPER.has(bn));
    return THREE.AnimationUtils.makeClipAdditive(c);
  };
  const out: SoldierClips = {
    lower,
    upper,
    aim,
    death: clean(get('Death01')),
    deathMirror: mirrorClip(clean(get('Death01')), b.scene),
    hitChest: additiveUpper('Hit_Chest'),
    hitHead: additiveUpper('Hit_Head'),
    speed: { idle: 0, walk: 0, jog: 0, sprint: 0 },
    phase: { idle: 0, walk: 0, jog: 0, sprint: 0 },
  };
  // Guard rails only: these clips stride long (the jog's planted foot sweeps at ~6.3 m/s).
  const range: Record<'walk' | 'jog' | 'sprint', [number, number]> = { walk: [0.8, 1.8], jog: [2.6, 7.0], sprint: [5.0, 10.0] };
  for (const k of ['walk', 'jog', 'sprint'] as const) {
    const g = measureGait(b.scene, lower[k]);
    out.speed[k] = THREE.MathUtils.clamp(g.speed, range[k][0], range[k][1]);
    out.phase[k] = g.phase;
  }
  return out;
}

/**
 * Left/right mirror of a clip on this rig, resampled at 30 Hz: model-space bone rotations are
 * reflected across the body's sagittal plane and swapped _l ↔ _r (with a rest-pose correction,
 * as left and right bones have different local frames), then converted back to local rotations.
 */
function mirrorClip(src: THREE.AnimationClip, scene: THREE.Object3D): THREE.AnimationClip {
  const rig = cloneSkinned(scene);
  const byName = new Map<string, THREE.Object3D>();
  rig.traverse((o) => byName.set(o.name, o));
  const node = (nm: string): THREE.Object3D => byName.get(nm) as THREE.Object3D;
  const names = [...new Set(src.tracks.filter((t) => t.name.endsWith('.quaternion')).map(trackBone))];
  const partner = (nm: string): string => (nm.endsWith('_l') ? `${nm.slice(0, -2)}_r` : nm.endsWith('_r') ? `${nm.slice(0, -2)}_l` : nm);
  const mirror = (q: THREE.Quaternion): THREE.Quaternion => q.set(q.x, -q.y, -q.z, q.w);
  rig.updateMatrixWorld(true);
  const rest = new Map(names.map((nm) => [nm, node(nm).getWorldQuaternion(new THREE.Quaternion())]));
  // correction C_b = mirror(rest_partner)⁻¹ · rest_b, so a mirrored rest pose stays the rest pose
  const corr = new Map(names.map((nm) => [nm, mirror((rest.get(partner(nm)) as THREE.Quaternion).clone()).invert().multiply(rest.get(nm) as THREE.Quaternion)]));

  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(src);
  action.play();
  const fps = 30;
  const frames = Math.max(2, Math.ceil(src.duration * fps) + 1);
  const times = new Float32Array(frames);
  const world = new Map(names.map((nm) => [nm, new Float32Array(frames * 4)]));
  const pelvisW = new Float32Array(frames * 3);
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (let k = 0; k < frames; k++) {
    const t = Math.min(src.duration, k / fps);
    times[k] = t;
    action.time = t;
    mixer.update(0);
    rig.updateMatrixWorld(true);
    for (const nm of names) node(nm).getWorldQuaternion(q).toArray(world.get(nm) as Float32Array, k * 4);
    node('pelvis').getWorldPosition(p).toArray(pelvisW, k * 3);
  }
  mixer.stopAllAction();

  const mirroredWorld = (nm: string, k: number, out: THREE.Quaternion): THREE.Quaternion => {
    if (!rest.has(nm)) return node(nm).getWorldQuaternion(out); // static parent (Armature)
    out.fromArray(world.get(partner(nm)) as Float32Array, k * 4);
    return mirror(out).multiply(corr.get(nm) as THREE.Quaternion);
  };
  const tracks: THREE.KeyframeTrack[] = [];
  const wq = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  for (const nm of names) {
    const values = new Float32Array(frames * 4);
    const parent = (node(nm).parent as THREE.Object3D).name;
    for (let k = 0; k < frames; k++) {
      mirroredWorld(nm, k, wq);
      mirroredWorld(parent, k, pq);
      pq.invert().multiply(wq).toArray(values, k * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${nm}.quaternion`, times, values));
  }
  // Pelvis translation: reflect its model-space position, expressed in the (mirrored) root frame.
  const pv = new Float32Array(frames * 3);
  const rootPos = node('root').getWorldPosition(new THREE.Vector3());
  for (let k = 0; k < frames; k++) {
    p.fromArray(pelvisW, k * 3);
    p.x = -p.x;
    p.sub(rootPos).applyQuaternion(mirroredWorld('root', k, pq).invert());
    p.toArray(pv, k * 3);
  }
  tracks.push(new THREE.VectorKeyframeTrack('pelvis.position', times, pv));
  return new THREE.AnimationClip(`${src.name}_mirror`, src.duration, tracks);
}

/**
 * Gait of an in-place loop: ground speed (how fast a planted foot slides back under the body)
 * and the normalised time at which the left foot is furthest forward.
 */
function measureGait(scene: THREE.Object3D, clip: THREE.AnimationClip): { speed: number; phase: number } {
  const rig = cloneSkinned(scene);
  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(clip);
  action.play();
  const balls = ['ball_l', 'ball_r'].map((n) => rig.getObjectByName(n) as THREE.Object3D);
  const N = 72;
  const dt = clip.duration / N;
  const ys: number[][] = [[], []];
  const zs: number[][] = [[], []];
  const p = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    action.time = i * dt;
    mixer.update(0);
    rig.updateMatrixWorld(true);
    balls.forEach((bb, f) => {
      bb.getWorldPosition(p);
      ys[f].push(p.y);
      zs[f].push(p.z);
    });
  }
  const speeds: number[] = [];
  for (let f = 0; f < 2; f++) {
    const minY = Math.min(...ys[f]);
    for (let i = 1; i <= N; i++) {
      if (ys[f][i] < minY + 0.03 && ys[f][i - 1] < minY + 0.03) speeds.push((zs[f][i - 1] - zs[f][i]) / dt);
    }
  }
  mixer.stopAllAction();
  let lead = 0;
  for (let i = 1; i < N; i++) if (zs[0][i] > zs[0][lead]) lead = i;
  speeds.sort((a, c) => a - c);
  return { speed: speeds.length ? Math.max(0.3, speeds[Math.floor(speeds.length / 2)]) : 1, phase: lead / N };
}
