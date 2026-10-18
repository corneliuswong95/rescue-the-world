/**
 * Enemy archetypes (M4). Each bundles a visual (soldier tint/scale) with combat parameters so
 * the same Enemy class reads fair-but-distinct behaviour. Difficulty scales these at spawn time.
 */
import type { SoldierConfig } from './soldier';

export interface Archetype {
  name: string;
  soldier: SoldierConfig;
  maxHp: number;
  patrolSpeed: number;
  engageSpeed: number;
  fireInterval: number;
  damage: number;
  fireRange: number;
  /** Seconds from spotting the player to the first shot (randomised ±15% per sighting). */
  reaction: number;
  spread: number; // metres of aim error per metre of distance
  /** Lateral speed while engaging (m/s) — keeps them from standing still as gallery targets. */
  strafeSpeed: number;
}

export const RIFLEMAN: Archetype = {
  name: 'Rifleman',
  soldier: { uniform: 0x4d5340, vest: 0x24261f, helmet: 0x3a3f2e, scale: 1.0, kit: 'rifleman' },
  maxHp: 100,
  patrolSpeed: 2.2,
  engageSpeed: 4.6,
  fireInterval: 0.5,
  damage: 9,
  fireRange: 34,
  reaction: 0.75,
  spread: 0.03,
  strafeSpeed: 1.9,
};

export const RUSHER: Archetype = {
  name: 'Rusher',
  // Coyote uniform, ranger-green chest rig: light kit, reads slimmer than the plate carriers.
  soldier: { uniform: 0x7a6a50, vest: 0x40463a, helmet: 0x6d604b, scale: 0.96, kit: 'rusher' },
  maxHp: 70,
  patrolSpeed: 2.8,
  engageSpeed: 6.4, // closes distance fast
  fireInterval: 0.4,
  damage: 7,
  fireRange: 22, // wants to be close
  reaction: 0.6,
  spread: 0.05, // less accurate
  strafeSpeed: 2.5,
};

export const HEAVY: Archetype = {
  name: 'Heavy',
  // Lifted from near-black so the Heavy still reads in shade (uniform albedo ≈ 0.08 linear).
  soldier: { uniform: 0x4b5153, vest: 0x2a2e30, helmet: 0x2a2e30, scale: 1.14, kit: 'heavy' },
  maxHp: 210,
  patrolSpeed: 1.8,
  engageSpeed: 3.0, // slow
  fireInterval: 0.7,
  damage: 15,
  fireRange: 30,
  reaction: 0.9,
  spread: 0.022, // accurate
  strafeSpeed: 1.5,
};

/** Scale an archetype's threat by a difficulty multiplier (1 = normal). */
export function scaleArchetype(a: Archetype, difficulty: number): Archetype {
  return {
    ...a,
    maxHp: Math.round(a.maxHp * (0.8 + 0.2 * difficulty)),
    damage: a.damage * (0.7 + 0.3 * difficulty),
    reaction: a.reaction / (0.7 + 0.3 * difficulty),
    fireInterval: a.fireInterval / (0.85 + 0.15 * difficulty),
    spread: a.spread * (1.3 - 0.3 * difficulty),
  };
}
