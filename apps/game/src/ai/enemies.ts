/**
 * Owns the live enemy set: spawning (snapped to the navmesh, then onto the real floor), fixed-step
 * AI, interpolated render, gunfire broadcast for hearing. Corpses persist until `clear()`.
 *
 * Bots are pooled per look: `clear()` parks them (hidden, physics disabled) and `spawn()` reuses
 * a parked bot of the same kit/tint before building a new one, so a round start does no mesh,
 * collider or controller construction — and nothing new for the renderer to upload or compile.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import { AttackTokens, Enemy, CAPSULE_HALF_HEIGHT, CONTROLLER_OFFSET, type EnemyDeps } from './enemy';
import type { Archetype } from './archetypes';
import { BloodPools } from './bloodPools';

/** How many bots may fire aimed shots at the player at once (the rest suppress). */
const AIMED_SHOOTERS = 2;
/** Player speed above which footsteps are a sprint (player walk 5.2, sprint 8.6 m/s). */
const SPRINT_SPEED = 6.5;
/** How far sprint footsteps carry. */
const STEP_HEAR = 7.5;

const sameLook = (a: Archetype['soldier'], b: Archetype['soldier']): boolean =>
  a.kit === b.kit && a.uniform === b.uniform && a.vest === b.vest && a.helmet === b.helmet && a.scale === b.scale;

export class EnemyManager {
  private readonly enemies: Enemy[] = [];
  private readonly parked: Enemy[] = [];
  private readonly tokens = new AttackTokens(AIMED_SHOOTERS);
  private readonly blood: BloodPools;
  private readonly _v = new THREE.Vector3();
  private readonly floorRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(private readonly deps: EnemyDeps) {
    this.blood = new BloodPools(deps.scene);
  }

  spawn(at: THREE.Vector3, arch: Archetype): Enemy {
    const p = this.deps.nav.closestPoint(at) ?? at.clone();
    // Navmesh heights are quantised to the 0.2 m cell height (they can sit ~0.3 m above a dock
    // top), so drop a ray onto the actual static collider and stand the capsule on it. Queries
    // see colliders only once the pipeline is updated (a freshly built level isn't yet).
    this.deps.world.updateSceneQueries();
    const o = this.floorRay.origin;
    o.x = p.x;
    o.y = p.y + 0.8;
    o.z = p.z;
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = this.deps.world.castRay(this.floorRay, 3, true, flags);
    if (hit) p.y = o.y - hit.timeOfImpact;
    p.y += CAPSULE_HALF_HEIGHT + CONTROLLER_OFFSET;

    const i = this.parked.findIndex((e) => sameLook(e.soldierLook, arch.soldier));
    const e = i >= 0 ? this.parked.splice(i, 1)[0] : new Enemy(this.deps, arch, this.tokens, this.blood);
    e.activate(p, arch);
    this.enemies.push(e);
    return e;
  }

  integrate(dt: number): void {
    for (const e of this.enemies) e.integrate(dt);
  }

  render(alpha: number, dt: number): void {
    for (const e of this.enemies) e.render(alpha, dt);
    this.blood.update(dt);
  }

  /** Player gunfire heard from `pos` — alert nearby bots even without line of sight. */
  broadcastGunfire(pos: THREE.Vector3): void {
    for (const e of this.enemies) e.hear(pos);
  }

  /** A player footstep at `pos` while moving at `speed` m/s: sprinting is heard within 7.5 m. */
  hearFootstep(pos: THREE.Vector3, speed: number): void {
    if (speed < SPRINT_SPEED) return;
    for (const e of this.enemies) e.hear(pos, STEP_HEAR);
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (!e.isDead) n += 1;
    return n;
  }

  /** End the round: every bot (corpses included) is parked for reuse by the next `spawn()`s. */
  clear(): void {
    for (const e of this.enemies) {
      e.deactivate();
      this.parked.push(e);
    }
    this.enemies.length = 0;
    this.tokens.reset();
    this.blood.clear();
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
