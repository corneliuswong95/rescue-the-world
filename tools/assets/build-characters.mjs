// Build the soldier character assets from Quaternius' CC0 packs (see CREDITS.md).
//
//   node tools/assets/build-characters.mjs <gltf-transform tools dir> <UBC Standard dir> <UAL1_Standard.glb>
//
//   <UBC Standard dir>  = ".../Universal Base Characters[Standard]" (free tier, CC0)
//   <UAL1_Standard.glb> = ".../Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb" (CC0)
//
// Outputs (apps/game/public/assets/characters/):
//   soldier_body.glb  — Superhero_Male body only (skinned, 65-joint UE-style rig), no textures:
//                       the game dresses it with procedural uniform/gear materials.
//   soldier_anims.glb — the UAL1 clips the AI uses, on a bare skeleton (no mesh), meshopt-compressed.
// Both packs share the same rig, so clips bind to the body by bone name.
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [toolsDir, ubcDir, ual1] = process.argv.slice(2);
// Resolve the gltf-transform toolchain from its own install (not a game dependency).
const require = createRequire(path.join(path.resolve(toolsDir), 'package.json'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS, EXTMeshoptCompression } = require('@gltf-transform/extensions');
const { prune, resample, dedup, weld, reorder, quantize } = require('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = require('meshoptimizer');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'apps/game/public/assets/characters');
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const KEEP_CLIPS = new Set([
  'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop',
  'Death01', 'Hit_Chest', 'Hit_Head',
  'Pistol_Idle_Loop', 'Pistol_Aim_Up', 'Pistol_Aim_Neutral', 'Pistol_Aim_Down', 'Pistol_Shoot', 'Pistol_Reload',
]);

/** Dispose accessors nothing references any more (prune can miss data from disposed clips). */
function dropOrphanAccessors(doc) {
  for (const acc of doc.getRoot().listAccessors()) {
    if (acc.listParents().every((p) => p === doc.getRoot())) acc.dispose();
  }
}

async function write(doc, file) {
  dropOrphanAccessors(doc);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(path.join(outDir, file), doc);
  console.log('wrote', file);
}

// --- Body: male base mesh only, textures dropped (the game shades it procedurally). ---
{
  // Read the glTF JSON ourselves and drop all image/texture refs first: the pack references some
  // images under names that don't exist on disk, and the game doesn't use them anyway.
  const dir = path.join(ubcDir, 'Base Characters', 'Godot - UE');
  const json = JSON.parse(await readFile(path.join(dir, 'Superhero_Male_FullBody.gltf'), 'utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  const resources = {};
  for (const b of json.buffers) resources[b.uri] = new Uint8Array(await readFile(path.join(dir, b.uri)));
  const doc = await io.readJSON({ json, resources });
  for (const mesh of doc.getRoot().listMeshes()) {
    const mats = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() ?? '');
    if (!mats.some((n) => n.startsWith('MI_Superhero'))) {
      for (const node of doc.getRoot().listNodes()) if (node.getMesh() === mesh) node.setMesh(null);
      mesh.dispose(); // eyes + brows: hidden under goggles/balaclava
    }
  }
  for (const tex of doc.getRoot().listTextures()) tex.dispose();
  for (const mat of doc.getRoot().listMaterials()) mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
  await doc.transform(prune(), dedup(), weld(), reorder({ encoder: MeshoptEncoder }), quantize());
  await write(doc, 'soldier_body.glb');
}

// --- Clips: keep the AI's set, drop the mannequin mesh, keep the skeleton the clips target. ---
{
  const doc = await io.read(ual1);
  for (const anim of doc.getRoot().listAnimations()) {
    if (KEEP_CLIPS.has(anim.getName())) continue;
    for (const sampler of anim.listSamplers()) sampler.dispose(); // else their keyframes still get written
    anim.dispose();
  }
  // Fingers/leaf bones are posed procedurally around the rifle in-game: drop their channels
  // (≈60% of the keyframe data), plus constant scale tracks.
  const FINGER = /(index|middle|ring|pinky|thumb)_\d|leaf/;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const name = ch.getTargetNode()?.getName() ?? '';
      if (FINGER.test(name) || ch.getTargetPath() === 'scale') {
        ch.getSampler()?.dispose();
        ch.dispose();
      }
    }
  }
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) node.setMesh(null);
    if (node.getSkin()) node.setSkin(null);
  }
  for (const m of doc.getRoot().listMeshes()) m.dispose();
  for (const s of doc.getRoot().listSkins()) s.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }), dedup());
  const names = doc.getRoot().listAnimations().map((a) => a.getName());
  console.log('clips:', names.join(', '));
  await write(doc, 'soldier_anims.glb');
}
