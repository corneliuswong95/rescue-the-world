/**
 * Loads the CC0 PBR texture sets (ambientCG — see CREDITS.md) into per-role MeshStandard
 * materials for the greybox. Textures tile via per-material repeat (approximate — the room
 * shares one unit-box geometry, so exact per-face world-scaled UVs are a QUALITY_BACKLOG item).
 * Colour maps are sRGB; normal/roughness stay linear.
 */
import * as THREE from 'three/webgpu';

export interface LevelMaterials {
  floor: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  pillar: THREE.MeshStandardMaterial;
}

const loader = new THREE.TextureLoader();

async function loadSet(
  role: string,
  repeat: [number, number],
): Promise<{ map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }> {
  const [map, normalMap, roughnessMap] = await Promise.all([
    loader.loadAsync(`/assets/textures/${role}/color.jpg`),
    loader.loadAsync(`/assets/textures/${role}/normal.jpg`),
    loader.loadAsync(`/assets/textures/${role}/rough.jpg`),
  ]);
  map.colorSpace = THREE.SRGBColorSpace; // albedo
  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 8;
  }
  return { map, normalMap, roughnessMap };
}

export async function loadLevelMaterials(): Promise<LevelMaterials> {
  const [floorTex, wallTex, crateTex] = await Promise.all([
    loadSet('floor', [10, 10]),
    loadSet('wall', [8, 2.5]),
    loadSet('crate', [1, 1]),
  ]);

  // Tint the light concrete down to a cooler, less-blown industrial grey (colour multiplies map).
  const floor = new THREE.MeshStandardMaterial({ ...floorTex, color: 0x8a8f96, roughness: 1, metalness: 0 });
  const wall = new THREE.MeshStandardMaterial({ ...wallTex, color: 0x9aa0a8, roughness: 1, metalness: 0 });
  const crate = new THREE.MeshStandardMaterial({ ...crateTex, color: 0xd8c8ad, roughness: 1, metalness: 0 });

  // Accent + pillar keep distinct solid colours but borrow surface relief for detail.
  const accent = new THREE.MeshStandardMaterial({
    color: 0xc85a3c,
    normalMap: wallTex.normalMap,
    roughnessMap: wallTex.roughnessMap,
    roughness: 0.9,
    metalness: 0.1,
  });
  const pillar = new THREE.MeshStandardMaterial({
    color: 0x9aa2ad,
    normalMap: wallTex.normalMap,
    roughnessMap: wallTex.roughnessMap,
    roughness: 1,
    metalness: 0,
  });

  return { floor, wall, crate, accent, pillar };
}
