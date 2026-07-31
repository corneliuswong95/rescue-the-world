/**
 * Maps a Rapier collider handle → something damageable, so a weapon raycast can turn a
 * physics hit into gameplay damage without the weapon knowing about enemy types.
 */
import type * as THREE from 'three/webgpu';

export interface Hittable {
  /** Apply a hit. Returns true if this hit killed the target. */
  onHit(damage: number, point: THREE.Vector3, headshot: boolean): boolean;
  /** World-space Y above which a hit counts as a headshot (top of the torso). */
  headY(): number;
}

export class HitRegistry {
  private readonly map = new Map<number, Hittable>();

  register(colliderHandle: number, h: Hittable): void {
    this.map.set(colliderHandle, h);
  }
  unregister(colliderHandle: number): void {
    this.map.delete(colliderHandle);
  }
  get(colliderHandle: number): Hittable | undefined {
    return this.map.get(colliderHandle);
  }
}
