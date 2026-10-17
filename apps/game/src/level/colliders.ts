/**
 * Static collision for the level: a Rapier fixed cuboid per blocker, plus an invisible proxy
 * box mesh with the same transform for navmesh generation (recast reads matrixWorld). Visuals
 * are separate (merged / instanced), so complex props still collide as simple, stable boxes.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

const UNIT = new THREE.BoxGeometry(1, 1, 1);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class LevelColliders {
  /** Navmesh input geometry (never added to the scene). */
  readonly navMeshes: THREE.Mesh[] = [];

  constructor(private readonly world: RAPIER_NS.World) {}

  /**
   * @param size   full extents (m)
   * @param center world-space centre
   * @param yaw    rotation about +Y
   * @param pitch  rotation about the (yawed) X axis — ramps
   * @param walkable include in the navmesh input (false for thin dressing bots should ignore)
   */
  box(
    size: [number, number, number],
    center: [number, number, number],
    yaw = 0,
    pitch = 0,
    walkable = true,
  ): void {
    _q.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(center[0], center[1], center[2])
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2), body);

    if (!walkable) return;
    const proxy = new THREE.Mesh(UNIT);
    proxy.scale.set(size[0], size[1], size[2]);
    proxy.position.set(center[0], center[1], center[2]);
    proxy.quaternion.copy(_q);
    proxy.updateMatrixWorld(true);
    this.navMeshes.push(proxy);
  }
}
