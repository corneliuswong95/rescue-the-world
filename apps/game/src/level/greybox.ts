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
import type { LevelMaterials } from './materials';

const SHARED_BOX = new THREE.BoxGeometry(1, 1, 1);

type Vec3 = [number, number, number];

interface BoxSpec {
  size: Vec3;
  pos: Vec3;
  /** Rotation about the X axis, radians (for ramps). */
  rotX?: number;
  material: THREE.MeshStandardMaterial;
  receiveShadow?: boolean;
}

function addBox(
  scene: THREE.Scene,
  world: RAPIER_NS.World,
  collide: THREE.Mesh[],
  spec: BoxSpec,
): void {
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
  mesh.updateMatrixWorld(true); // navmesh generation reads matrixWorld
  scene.add(mesh);
  collide.push(mesh);

  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(px, py, pz)
    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  const body = world.createRigidBody(bodyDesc);
  const colDesc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
  world.createCollider(colDesc, body);
}

/** Builds the room; returns the collidable meshes (used as navmesh input geometry). */
export function buildGreybox(
  scene: THREE.Scene,
  world: RAPIER_NS.World,
  MAT: LevelMaterials,
): THREE.Mesh[] {
  const collide: THREE.Mesh[] = [];
  const add = (spec: BoxSpec): void => addBox(scene, world, collide, spec);

  // Floor (top surface at y = 0).
  add({ size: [40, 0.4, 40], pos: [0, -0.2, 0], material: MAT.floor });

  // Perimeter walls (6 m tall, 0.5 m thick).
  const H = 6;
  add({ size: [40, H, 0.5], pos: [0, H / 2, -20], material: MAT.wall });
  add({ size: [40, H, 0.5], pos: [0, H / 2, 20], material: MAT.wall });
  add({ size: [0.5, H, 40], pos: [20, H / 2, 0], material: MAT.wall });
  add({ size: [0.5, H, 40], pos: [-20, H / 2, 0], material: MAT.wall });

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
    add({ size: [1.2, 1.2, 1.2], pos: p, material: MAT.crate });
  }

  // A couple of accent crates as readability landmarks.
  add({ size: [1.2, 1.2, 1.2], pos: [-2, 0.6, 6], material: MAT.accent });
  add({ size: [1.2, 1.2, 1.2], pos: [10, 0.6, -6], material: MAT.accent });

  // A long low wall for crouch-cover.
  add({ size: [8, 1.2, 0.6], pos: [4, 0.6, 10], material: MAT.wall });

  // Pillars.
  add({ size: [1, H, 1], pos: [-10, H / 2, 8], material: MAT.pillar });
  add({ size: [1, H, 1], pos: [12, H / 2, -12], material: MAT.pillar });

  // Ramp up to a raised platform (west).
  add({ size: [5, 0.4, 4], pos: [-13, 0.9, -8], rotX: -0.32, material: MAT.crate });
  add({ size: [7, 0.4, 7], pos: [-16, 1.75, -12], material: MAT.wall });

  // Central cover — an L of chest-high walls to break up the open middle.
  add({ size: [0.6, 1.5, 6], pos: [1, 0.75, -4], material: MAT.wall });
  add({ size: [5, 1.5, 0.6], pos: [3.5, 0.75, -7], material: MAT.wall });
  add({ size: [1.2, 1.2, 1.2], pos: [-1, 0.6, -6], material: MAT.crate });
  add({ size: [1.2, 1.2, 1.2], pos: [0.2, 1.8, -6.5], material: MAT.crate });

  // East ramp + raised platform (a second vantage).
  add({ size: [4, 0.4, 4], pos: [13, 0.7, 5], rotX: -0.3, material: MAT.crate });
  add({ size: [6, 0.4, 6], pos: [16, 1.4, 5], material: MAT.wall });

  // A couple more scattered crates for flanking cover.
  add({ size: [1.4, 1.4, 1.4], pos: [6, 0.7, -14], material: MAT.crate });
  add({ size: [1.4, 1.4, 1.4], pos: [-9, 0.7, 2], material: MAT.accent });

  return collide;
}
