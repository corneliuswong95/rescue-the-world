/**
 * Navmesh + pathfinding via recast-navigation (see DECISIONS.md 2026-07-31: generated at
 * runtime from the code-authored greybox; offline bake arrives with authored levels in M4).
 * `await initNavigation()` once, then `buildNavigation(meshes)` to get a path query.
 */
import * as THREE from 'three/webgpu';
import { init as initRecast, NavMeshQuery, type NavMesh } from 'recast-navigation';
import { threeToSoloNavMesh } from '@recast-navigation/three';
import type { Mesh } from 'three';

let ready = false;

export async function initNavigation(): Promise<void> {
  if (ready) return;
  await initRecast();
  ready = true;
}

export class Navigation {
  private readonly query: NavMeshQuery;
  readonly navMesh: NavMesh;

  constructor(meshes: THREE.Mesh[]) {
    if (!ready) throw new Error('initNavigation() must be awaited first');
    // three/webgpu Mesh is structurally identical to the three Mesh the helper expects.
    const { success, navMesh } = threeToSoloNavMesh(meshes as unknown as Mesh[], {
      cs: 0.2, // cell size (m)
      ch: 0.2, // cell height (m)
      walkableRadius: 2, // ≈ agent radius 0.4 m / cs → bots keep off walls
      walkableHeight: 9, // ≈ 1.8 m / ch
      walkableClimb: 2, // ≈ 0.4 m step
      walkableSlopeAngle: 50,
    });
    if (!success || !navMesh) throw new Error('navmesh generation failed');
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
  }

  /** Straight-line-of-polys path between two world points, or null if none. */
  findPath(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3[]): boolean {
    const r = this.query.computePath(from, to);
    if (!r.success || r.path.length === 0) return false;
    out.length = 0;
    for (const p of r.path) out.push(new THREE.Vector3(p.x, p.y, p.z));
    return true;
  }

  /** Nearest point on the navmesh to `p` (e.g. to validate a spawn), or null. */
  closestPoint(p: THREE.Vector3): THREE.Vector3 | null {
    const r = this.query.findClosestPoint(p);
    if (!r.success) return null;
    return new THREE.Vector3(r.point.x, r.point.y, r.point.z);
  }

  /** A random reachable point within `radius` of `center`, or null. */
  randomPoint(center: THREE.Vector3, radius: number): THREE.Vector3 | null {
    const r = this.query.findRandomPointAroundCircle(center, radius);
    if (!r.success) return null;
    return new THREE.Vector3(r.randomPoint.x, r.randomPoint.y, r.randomPoint.z);
  }
}
