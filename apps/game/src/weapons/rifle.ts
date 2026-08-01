/**
 * Original stylized carbine model, authored in code (no ripped assets — CS/CoD are *look*
 * references only, per CLAUDE.md rule 3). Built from primitives: receiver, handguard, barrel,
 * red-dot sight, angled magazine, pistol grip, stock. Local convention: barrel points -Z, grip
 * near the origin. Used for the player viewmodel (detailed) and the enemy-held weapon (same mesh,
 * smaller). Returns the group plus the muzzle tip in local space.
 */
import * as THREE from 'three/webgpu';
import { mergeStaticByMaterial } from '../engine/merge';

export interface Rifle {
  group: THREE.Group;
  muzzle: THREE.Vector3;
}

// Shared materials so both viewmodels and every enemy rifle batch cheaply.
const METAL = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.42, metalness: 0.75 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x161719, roughness: 0.35, metalness: 0.85 });
const POLYMER = new THREE.MeshStandardMaterial({ color: 0x1d1f23, roughness: 0.7, metalness: 0.08 });
const GLOW = new THREE.MeshBasicMaterial({ color: 0xff5a4d }); // red-dot reticle

function part(
  group: THREE.Group,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  rx = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  m.castShadow = true;
  group.add(m);
  return m;
}

export function createRifle(): Rifle {
  const g = new THREE.Group();

  // Receiver body.
  part(g, new THREE.BoxGeometry(0.05, 0.085, 0.34), METAL, 0, 0, -0.1);
  // Upper rail.
  part(g, new THREE.BoxGeometry(0.028, 0.02, 0.32), DARK, 0, 0.052, -0.11);
  // Handguard around the barrel.
  part(g, new THREE.BoxGeometry(0.05, 0.055, 0.22), POLYMER, 0, 0.006, -0.33);
  // Barrel.
  const barrel = part(g, new THREE.CylinderGeometry(0.014, 0.014, 0.3, 10), DARK, 0, 0.012, -0.44);
  barrel.rotation.x = Math.PI / 2;
  // Muzzle device.
  const muzzleDev = part(g, new THREE.CylinderGeometry(0.02, 0.02, 0.05, 10), DARK, 0, 0.012, -0.58);
  muzzleDev.rotation.x = Math.PI / 2;
  // Red-dot sight housing + reticle.
  part(g, new THREE.BoxGeometry(0.032, 0.05, 0.06), DARK, 0, 0.086, -0.06);
  const dot = part(g, new THREE.CircleGeometry(0.004, 8), GLOW, 0, 0.09, -0.03);
  dot.renderOrder = 6;
  // Angled magazine.
  part(g, new THREE.BoxGeometry(0.032, 0.15, 0.07), POLYMER, 0, -0.11, -0.03, -0.18);
  // Pistol grip.
  part(g, new THREE.BoxGeometry(0.034, 0.11, 0.05), POLYMER, 0, -0.085, 0.04, 0.42);
  // Stock.
  part(g, new THREE.BoxGeometry(0.045, 0.065, 0.17), POLYMER, 0, 0.006, 0.2);
  part(g, new THREE.BoxGeometry(0.02, 0.09, 0.03), POLYMER, 0, -0.02, 0.12);

  mergeStaticByMaterial(g); // ~12 parts → 4 draws (one per material)
  return { group: g, muzzle: new THREE.Vector3(0, 0.012, -0.6) };
}
