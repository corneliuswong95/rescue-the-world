/**
 * Owns the live enemy set: spawning (snapped to the navmesh, then onto the real floor), fixed-step
 * AI, interpolated render, gunfire broadcast for hearing. Corpses persist until `clear()`.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import { AttackTokens, Enemy, CAPSULE_HALF_HEIGHT, CONTROLLER_OFFSET, type EnemyDeps } from './enemy';
import type { Archetype } from './archetypes';

/** How many bots may fire aimed shots at the player at once (the rest suppress). */
const AIMED_SHOOTERS = 2;

export class EnemyManager {
  private readonly enemies: Enemy[] = [];
  private readonly tokens = new AttackTokens(AIMED_SHOOTERS);
  private readonly _v = new THREE.Vector3();

  constructor(private readonly deps: EnemyDeps) {}

  spawn(at: THREE.Vector3, arch: Archetype): Enemy {
    const p = this.deps.nav.closestPoint(at) ?? at.clone();
    // Navmesh heights are quantised to the 0.2 m cell height (they can sit ~0.3 m above a dock
    // top), so drop a ray onto the actual static collider and stand the capsule on it.
    const ray = new RAPIER.Ray({ x: p.x, y: p.y + 0.8, z: p.z }, { x: 0, y: -1, z: 0 });
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = this.deps.world.castRay(ray, 3, true, flags);
    if (hit) p.y = ray.origin.y - hit.timeOfImpact;
    p.y += CAPSULE_HALF_HEIGHT + CONTROLLER_OFFSET;
    const e = new Enemy(this.deps, p, arch, this.tokens);
    this.enemies.push(e);
    return e;
  }

  integrate(dt: number): void {
    for (const e of this.enemies) e.integrate(dt);
  }

  render(alpha: number, dt: number): void {
    for (const e of this.enemies) e.render(alpha, dt);
  }

  /** Player gunfire heard from `pos` — alert nearby bots even without line of sight. */
  broadcastGunfire(pos: THREE.Vector3): void {
    for (const e of this.enemies) e.hear(pos);
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (!e.isDead) n += 1;
    return n;
  }

  /** Remove every enemy, corpses included (level reset / restart). */
  clear(): void {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.tokens.reset();
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
