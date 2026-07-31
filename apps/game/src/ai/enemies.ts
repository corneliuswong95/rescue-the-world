/**
 * Owns the live enemy set: spawning (snapped to the navmesh), fixed-step AI, interpolated
 * render, gunfire broadcast for hearing, and reaping cleaned-up bots.
 */
import * as THREE from 'three/webgpu';
import { Enemy, type EnemyDeps } from './enemy';

export class EnemyManager {
  private readonly enemies: Enemy[] = [];
  private readonly _v = new THREE.Vector3();

  constructor(private readonly deps: EnemyDeps) {}

  spawn(at: THREE.Vector3): Enemy | null {
    const p = this.deps.nav.closestPoint(at) ?? at.clone();
    // Lift to capsule-centre height (feet on the navmesh surface).
    p.y += 0.9;
    const e = new Enemy(this.deps, p);
    this.enemies.push(e);
    return e;
  }

  spawnMany(points: THREE.Vector3[]): void {
    for (const p of points) this.spawn(p);
  }

  integrate(dt: number): void {
    for (const e of this.enemies) e.integrate(dt);
  }

  render(alpha: number, dt: number): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i].render(alpha, dt)) this.enemies.splice(i, 1);
    }
  }

  /** Player fired at `pos` — alert nearby bots even without line of sight. */
  broadcastGunfire(pos: THREE.Vector3): void {
    for (const e of this.enemies) e.hear(pos);
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (!e.isDead) n += 1;
    return n;
  }

  /** Nearest living enemy centre to `from`, or null. Used to frame QA shots. */
  nearestAlive(from: THREE.Vector3, out: THREE.Vector3): boolean {
    let best = Infinity;
    let found = false;
    for (const e of this.enemies) {
      if (e.isDead) continue;
      e.position(this._v);
      const d = this._v.distanceToSquared(from);
      if (d < best) {
        best = d;
        out.copy(this._v);
        found = true;
      }
    }
    return found;
  }
}
