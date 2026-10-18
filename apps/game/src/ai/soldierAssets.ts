/**
 * Skinned soldier assets: the CC0 Quaternius body (65-joint UE-style rig) and its CC0 animation
 * library (see CREDITS.md), prepared once at boot.
 *
 * Body prep (once):
 *  - the meshopt/quantized positions are re-baked to real metres in the bind pose and the
 *    skeleton's inverses recomputed, so `positionGeometry` is a stable, unit-correct pattern
 *    space for the procedural camo (it never swims with the animation);
 *  - each vertex gets a zone from its dominant joint: hands → gloves, head/neck → knit
 *    balaclava with a skin band at the eyes, feet → tucked inside the code-built boots,
 *    everything else → camo uniform inflated ~1.5 cm along the normal (loose fabric, not a
 *    wetsuit).
 * Per look (kit + tint) a template is built: body + all kit parts merged into ONE skinned
 * geometry (each gear vertex rigidly weighted to its bone) — one draw call per soldier.
 *
 * Clips (once): translation channels are stripped except the pelvis (scaled to this body's
 * leg length) so the clips keep the body's proportions; then split into lower-body (locomotion)
 * and upper-body (aim / posture) sets, plus an additive upper-body flinch.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { BOOT, GLOVE, KNIT, SKIN, S_BOOT, S_GLOVE, S_KNIT, S_SKIN, buildKit, camoSurface, type Look } from './soldierKit';
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
  hitChest: THREE.AnimationClip;
  hitHead: THREE.AnimationClip;
  /** Natural ground speed of each locomotion loop (m/s): foot-contact speed, clamped to a
   *  plausible human range (these in-place loops aren't strictly foot-locked). */
  speed: Record<LocoName, number>;
}

interface BodyBase {
  scene: THREE.Object3D; // prepared body (bind pose), used as the clone source per look
  mesh: THREE.SkinnedMesh;
  boneIndex: Map<string, number>;
  zone: Uint8Array;
  position: Float32Array; // inflated / tucked, real metres
  normal: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
}

const Z_UNIFORM = 0;
const Z_GLOVE = 1;
const Z_KNIT = 2;
const Z_SKIN = 3;
const Z_FOOT = 4;
const INFLATE: Record<number, number> = { [Z_UNIFORM]: 0.015, [Z_GLOVE]: 0.004, [Z_KNIT]: 0.006, [Z_SKIN]: 0.004, [Z_FOOT]: 0 };

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
  const nrm = g.getAttribute('normal');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const n = pos.count;
  const boneIndex = new Map<string, number>();
  sk.bones.forEach((b, i) => boneIndex.set(b.name, i));

  // Bake bind-pose skinned positions/normals in real metres.
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const zone = new Uint8Array(n);
  const blend = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
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
    nm.setFromMatrix4(blend);
    nv.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    // Zone from the dominant joint.
    const name = sk.bones[best].name;
    let z = Z_UNIFORM;
    if (/^(hand_|index_|middle_|ring_|pinky_|thumb_)/.test(name)) z = Z_GLOVE;
    else if (name === 'Head' || name === 'neck_01') {
      z = v.y > 1.675 && v.y < 1.755 && v.z > 0.03 && Math.abs(v.x) < 0.085 ? Z_SKIN : Z_KNIT;
    } else if (/^(foot_|ball_)/.test(name) || (name.startsWith('calf_') && v.y < 0.2)) z = Z_FOOT;
    zone[i] = z;
    if (z === Z_FOOT) {
      // Tuck the bare foot / ankle inside the boot shell.
      const cx = Math.sign(v.x) * 0.118;
      v.x = cx + (v.x - cx) * 0.62;
      v.y = 0.055 + (v.y - 0.055) * 0.7;
      v.z = -0.02 + (v.z + 0.02) * 0.86;
    } else {
      v.addScaledVector(nv, INFLATE[z]);
    }
    v.toArray(position, i * 3);
    nv.toArray(normal, i * 3);
  }
  const idx = g.getIndex();
  if (!idx) throw new Error('soldier body: expected indexed geometry');
  const index = new Uint32Array(idx.count);
  for (let i = 0; i < idx.count; i++) index[i] = idx.getX(i);

  // The bind pose is now the real-unit geometry: recompute inverses for it.
  sk.calculateInverses();
  mesh.bind(sk, mesh.matrixWorld);
  return { scene, mesh, boneIndex, zone, position, normal, skinIndex, skinWeight, index };
}

/** Body + kit, merged into one skinned geometry, on a clone of the prepared body. */
function buildTemplate(b: BodyBase, look: Look): THREE.Object3D {
  const parts = buildKit(look);
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
  const c = new THREE.Color();
  const dust = new THREE.Color(0x8c7d64);
  const zoneLook: [number, typeof camo][] = [
    [look.uniform, camo],
    [GLOVE, S_GLOVE],
    [KNIT[look.kit], S_KNIT],
    [SKIN[look.kit], S_SKIN],
    [BOOT, S_BOOT],
  ];
  for (let i = 0; i < nBody; i++) {
    const [hex, s] = zoneLook[b.zone[i]];
    c.setHex(hex);
    const y = b.position[i * 3 + 1];
    if (b.zone[i] === Z_UNIFORM && y < 0.6) c.lerp(dust, ((0.6 - y) / 0.6) * 0.4);
    c.toArray(albedo, i * 3);
    surf[i * 4] = s.rough;
    surf[i * 4 + 1] = s.metal;
    surf[i * 4 + 2] = s.camo;
    surf[i * 4 + 3] = s.pattern;
  }

  // Gear vertices: rigid to their bone.
  let vo = nBody;
  let io = b.index.length;
  for (const p of parts) {
    const bone = b.boneIndex.get(p.bone);
    if (bone === undefined) throw new Error(`soldier kit: unknown bone ${p.bone}`);
    const g = p.geo;
    const cnt = g.getAttribute('position').count;
    position.set(g.getAttribute('position').array as Float32Array, vo * 3);
    normal.set(g.getAttribute('normal').array as Float32Array, vo * 3);
    albedo.set(g.getAttribute('albedo').array as Float32Array, vo * 3);
    surf.set(g.getAttribute('surf').array as Float32Array, vo * 4);
    for (let i = 0; i < cnt; i++) {
      skinIndex[(vo + i) * 4] = bone;
      skinWeight[(vo + i) * 4] = 1;
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
    hitChest: additiveUpper('Hit_Chest'),
    hitHead: additiveUpper('Hit_Head'),
    speed: { idle: 0, walk: 0, jog: 0, sprint: 0 },
  };
  const range: Record<'walk' | 'jog' | 'sprint', [number, number]> = { walk: [0.9, 1.8], jog: [2.6, 4.0], sprint: [5.0, 7.0] };
  for (const k of ['walk', 'jog', 'sprint'] as const) {
    out.speed[k] = THREE.MathUtils.clamp(measureSpeed(b.scene, lower[k]), range[k][0], range[k][1]);
  }
  return out;
}

/** Ground speed of an in-place loop: how fast a planted foot slides back under the body. */
function measureSpeed(scene: THREE.Object3D, clip: THREE.AnimationClip): number {
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
  if (!speeds.length) return 1;
  speeds.sort((a, c) => a - c);
  return Math.max(0.3, speeds[Math.floor(speeds.length / 2)]);
}
