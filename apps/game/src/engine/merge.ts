/**
 * Merges a group's *direct* mesh children by shared material into one mesh per material
 * (baking each child's local transform), to cut draw calls. Child groups/objects are left
 * intact, so animated sub-rigs still work. Used on the soldier torso + rifle.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function mergeStaticByMaterial(group: THREE.Object3D): void {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const originals: THREE.Mesh[] = [];

  for (const child of group.children) {
    const m = child as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) continue;
    const geo = m.geometry.clone();
    m.updateMatrix();
    geo.applyMatrix4(m.matrix);
    const arr = byMat.get(m.material as THREE.Material) ?? [];
    arr.push(geo);
    byMat.set(m.material as THREE.Material, arr);
    originals.push(m);
  }

  for (const m of originals) {
    group.remove(m);
    m.geometry.dispose();
  }

  for (const [mat, geos] of byMat) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}
