/**
 * M1 greybox playground: a walled room with cover, pillars, a ramp and a raised platform.
 * Every visual box gets a matching Rapier fixed cuboid collider so the player collides and
 * bullets have something to hit. "Feel first, not looks" — flat greybox materials on purpose.
 *
 * Geometry and materials are shared across boxes to keep draw calls and allocations low.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

const SHARED_BOX = new THREE.BoxGeometry(1, 1, 1);

const MAT = {
  floor: new THREE.MeshStandardMaterial({ color: 0x5a626c, roughness: 0.95, metalness: 0.0 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x76808c, roughness: 0.9, metalness: 0.0 }),
  crate: new THREE.MeshStandardMaterial({ color: 0xa8987c, roughness: 0.8, metalness: 0.05 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xc85a3c, roughness: 0.7, metalness: 0.05 }),
  pillar: new THREE.MeshStandardMaterial({ color: 0x8891a0, roughness: 0.85, metalness: 0.0 }),
} as const;

type Vec3 = [number, number, number];

interface BoxSpec {
  size: Vec3;
  pos: Vec3;
  /** Rotation about the X axis, radians (for ramps). */
  rotX?: number;
  material: THREE.MeshStandardMaterial;
  receiveShadow?: boolean;
}

function addBox(scene: THREE.Scene, world: RAPIER_NS.World, spec: BoxSpec): void {
  const [sx, sy, sz] = spec.size;
  const [px, py, pz] = spec.pos;

  const mesh = new THREE.Mesh(SHARED_BOX, spec.material);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(px, py, pz);
  mesh.castShadow = true;
  mesh.receiveShadow = spec.receiveShadow ?? true;

  const q = new THREE.Quaternion();
  if (spec.rotX) {
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), spec.rotX);
    mesh.quaternion.copy(q);
  }
  scene.add(mesh);

  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(px, py, pz)
    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  const body = world.createRigidBody(bodyDesc);
  const colDesc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
  world.createCollider(colDesc, body);
}

export function buildGreybox(scene: THREE.Scene, world: RAPIER_NS.World): void {
  // Floor (top surface at y = 0).
  addBox(scene, world, { size: [40, 0.4, 40], pos: [0, -0.2, 0], material: MAT.floor });

  // Perimeter walls (6 m tall, 0.5 m thick).
  const H = 6;
  addBox(scene, world, { size: [40, H, 0.5], pos: [0, H / 2, -20], material: MAT.wall });
  addBox(scene, world, { size: [40, H, 0.5], pos: [0, H / 2, 20], material: MAT.wall });
  addBox(scene, world, { size: [0.5, H, 40], pos: [20, H / 2, 0], material: MAT.wall });
  addBox(scene, world, { size: [0.5, H, 40], pos: [-20, H / 2, 0], material: MAT.wall });

  // Cover crates scattered for shooting/peeking.
  const crates: Vec3[] = [
    [-6, 0.6, -3],
    [-4.7, 0.6, -3],
    [-5.3, 1.8, -3],
    [7, 0.6, 4],
    [8.5, 0.6, 5],
    [2, 0.6, -8],
  ];
  for (const p of crates) {
    addBox(scene, world, { size: [1.2, 1.2, 1.2], pos: p, material: MAT.crate });
  }

  // A couple of accent crates as readability landmarks.
  addBox(scene, world, { size: [1.2, 1.2, 1.2], pos: [-2, 0.6, 6], material: MAT.accent });
  addBox(scene, world, { size: [1.2, 1.2, 1.2], pos: [10, 0.6, -6], material: MAT.accent });

  // A long low wall for crouch-cover.
  addBox(scene, world, { size: [8, 1.2, 0.6], pos: [4, 0.6, 10], material: MAT.wall });

  // Pillars.
  addBox(scene, world, { size: [1, H, 1], pos: [-10, H / 2, 8], material: MAT.pillar });
  addBox(scene, world, { size: [1, H, 1], pos: [12, H / 2, -12], material: MAT.pillar });

  // Ramp up to a raised platform.
  addBox(scene, world, { size: [5, 0.4, 4], pos: [-13, 0.9, -8], rotX: -0.32, material: MAT.crate });
  addBox(scene, world, { size: [7, 0.4, 7], pos: [-16, 1.75, -12], material: MAT.wall });
}
