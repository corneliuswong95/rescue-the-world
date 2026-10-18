/**
 * Damageable things a weapon ray can hit. Bodies are tested precisely (per-bone volumes) rather
 * than through their physics colliders: the registry knows which collider handles belong to a
 * body, so the weapon's physics ray can pass through them and only stop on world geometry, then
 * ask the registry for the nearest real body hit in front of that.
 */
import type * as THREE from 'three/webgpu';

/** Result of a precise ray test against a body. */
export interface TraceHit {
  /** Distance along the (unit) ray. */
  t: number;
  /** True if the head volume was hit. */
  head: boolean;
}

export interface Hittable {
  /** Precise test of a unit ray against the body; true (and `out` filled) if hit before `maxT`. */
  trace(origin: THREE.Vector3, dir: THREE.Vector3, maxT: number, out: TraceHit): boolean;
  /** Apply a hit. Returns true if this hit killed the target. */
  onHit(damage: number, point: THREE.Vector3, headshot: boolean): boolean;
}

export class HitRegistry {
  private readonly byHandle = new Map<number, Hittable>();
  private readonly bodies: Hittable[] = [];
  private readonly _tmp: TraceHit = { t: 0, head: false };

  /** `colliderHandle` is the body's physics collider (weapon rays pass through it). */
  register(colliderHandle: number, h: Hittable): void {
    this.byHandle.set(colliderHandle, h);
    if (this.bodies.indexOf(h) < 0) this.bodies.push(h);
  }

  unregister(colliderHandle: number): void {
    const h = this.byHandle.get(colliderHandle);
    if (!h) return;
    this.byHandle.delete(colliderHandle);
    const i = this.bodies.indexOf(h);
    if (i >= 0) {
      this.bodies[i] = this.bodies[this.bodies.length - 1];
      this.bodies.length -= 1;
    }
  }

  /** True if the collider belongs to a registered body. */
  isBody(colliderHandle: number): boolean {
    return this.byHandle.has(colliderHandle);
  }

  /** Nearest precise body hit along the unit ray before `maxT`, or null. Allocation-free. */
  trace(origin: THREE.Vector3, dir: THREE.Vector3, maxT: number, out: TraceHit): Hittable | null {
    let best: Hittable | null = null;
    let bestT = maxT;
    for (let i = 0; i < this.bodies.length; i++) {
      if (this.bodies[i].trace(origin, dir, bestT, this._tmp)) {
        best = this.bodies[i];
        bestT = this._tmp.t;
        out.t = this._tmp.t;
        out.head = this._tmp.head;
      }
    }
    return best;
  }
}
