/**
 * PBR surface materials for the code-built parts of the level (ground, sidewalks, cast
 * concrete). Texture sets are PolyHaven CC0 (see CREDITS.md), 2K WebP: albedo (sRGB),
 * OpenGL normal, and packed ARM (R = AO, G = roughness, B = metal).
 *
 * Geometry carries world-scaled UVs (see `level/geometry.ts`), so texel density is uniform on
 * every face. TSL layers on top of the scans what a single tiling texture can't do:
 *   - low-frequency macro variation (kills visible tiling over a 40 m courtyard),
 *   - damp patches on the asphalt (darker + smoother — reads wet without fake mirror puddles),
 *   - ground-contact grime on vertical concrete (dirt splash line where it meets the floor).
 */
import * as THREE from 'three/webgpu';
import {
  float,
  luminance,
  mix,
  mx_fractal_noise_float,
  normalMap,
  positionWorld,
  smoothstep,
  texture,
  vec2,
  vec3,
} from 'three/tsl';

export interface LevelMaterials {
  asphalt: THREE.MeshStandardNodeMaterial;
  sidewalk: THREE.MeshStandardNodeMaterial;
  concrete: THREE.MeshStandardNodeMaterial;
  /** Weathered structural steel (dock lips, cable hangers): dark, rust-mottled. */
  steel: THREE.MeshStandardNodeMaterial;
  /** Worn yellow safety paint over steel/concrete. */
  safetyPaint: THREE.MeshStandardNodeMaterial;
  /** Black rubber (dock bumpers, cables). */
  rubber: THREE.MeshStandardNodeMaterial;
}

interface TexSet {
  color: THREE.Texture;
  normal: THREE.Texture;
  arm: THREE.Texture;
}

const loader = new THREE.TextureLoader();

async function loadSet(name: string): Promise<TexSet> {
  const [color, normal, arm] = await Promise.all(
    ['color', 'normal', 'arm'].map((m) => loader.loadAsync(`/assets/textures/${name}/${m}.webp`)),
  );
  color.colorSpace = THREE.SRGBColorSpace;
  for (const t of [color, normal, arm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { color, normal, arm };
}

/** Macro brightness variation in ~[1-amp, 1+amp], from world XZ at the given frequency. */
const macro = (freq: number, amp: number) =>
  mx_fractal_noise_float(positionWorld.xz.mul(freq), 3, 2.0, 0.5).mul(amp).add(1);

function surface(set: TexSet, tint: THREE.Color): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const arm = texture(set.arm);
  m.colorNode = texture(set.color).rgb.mul(vec3(tint.r, tint.g, tint.b)).mul(macro(0.09, 0.14));
  m.normalNode = normalMap(texture(set.normal));
  m.roughnessNode = arm.g;
  m.metalnessNode = float(0);
  m.aoNode = arm.r;
  return m;
}

export async function loadLevelMaterials(): Promise<LevelMaterials> {
  const [asphaltTex, sidewalkTex, concreteTex] = await Promise.all([
    loadSet('asphalt_02'),
    loadSet('dirty_concrete'),
    loadSet('concrete_wall_008'),
  ]);

  // Asphalt: damp patches — darker albedo, lower roughness, flattened normal.
  const asphalt = surface(asphaltTex, new THREE.Color(1, 1, 1));
  const damp = smoothstep(0.18, 0.42, mx_fractal_noise_float(positionWorld.xz.mul(0.075), 4, 2.0, 0.55));
  const aArm = texture(asphaltTex.arm);
  asphalt.colorNode = texture(asphaltTex.color).rgb.mul(macro(0.06, 0.16)).mul(mix(float(1), float(0.62), damp));
  asphalt.roughnessNode = mix(aArm.g, float(0.34), damp);
  asphalt.normalNode = normalMap(texture(asphaltTex.normal), vec2(mix(float(1), float(0.35), damp)));

  const sidewalk = surface(sidewalkTex, new THREE.Color(0.92, 0.9, 0.86));

  // Cast concrete: the formwork scan is warm beige — pull it to a weathered grey (part-
  // desaturate + darken) and add a dirt splash line near the ground on vertical faces.
  const concrete = surface(concreteTex, new THREE.Color(1, 1, 1));
  const grime = smoothstep(0.0, 0.85, positionWorld.y).mul(0.42).add(0.58);
  const raw = texture(concreteTex.color).rgb;
  concrete.colorNode = mix(vec3(luminance(raw)), raw, 0.35)
    .mul(0.78)
    .mul(macro(0.21, 0.14))
    .mul(grime);

  // Procedural metals/paint: low-frequency mottling + fine breakup, no texture memory.
  const fine = mx_fractal_noise_float(positionWorld.mul(9), 3, 2.0, 0.5);
  const steel = new THREE.MeshStandardNodeMaterial();
  const rust = smoothstep(0.15, 0.6, mx_fractal_noise_float(positionWorld.mul(1.7), 3, 2.0, 0.55));
  steel.colorNode = mix(vec3(0.11, 0.11, 0.115), vec3(0.24, 0.12, 0.06), rust).mul(fine.mul(0.12).add(1));
  steel.roughnessNode = mix(float(0.48), float(0.85), rust).add(fine.mul(0.08));
  steel.metalnessNode = mix(float(0.85), float(0.2), rust);

  const safetyPaint = new THREE.MeshStandardNodeMaterial();
  const wear = smoothstep(0.35, 0.65, mx_fractal_noise_float(positionWorld.mul(3.2), 4, 2.0, 0.55));
  safetyPaint.colorNode = mix(vec3(0.62, 0.42, 0.04), vec3(0.16, 0.15, 0.14), wear).mul(fine.mul(0.1).add(1));
  safetyPaint.roughnessNode = mix(float(0.62), float(0.8), wear);
  safetyPaint.metalnessNode = float(0);

  const rubber = new THREE.MeshStandardNodeMaterial({ color: 0x141414, roughness: 0.82, metalness: 0 });

  return { asphalt, sidewalk, concrete, steel, safetyPaint, rubber };
}
