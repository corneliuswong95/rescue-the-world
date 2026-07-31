/**
 * Rapier physics world. Uses the `-compat` build (see DECISIONS.md 2026-07-31): same engine,
 * WASM inlined so it bundles under Vite with no extra plugins. `await initPhysics()` once at
 * boot, then step at a fixed rate from the sim loop.
 */
import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

let ready = false;

/** Initialise the Rapier WASM module. Idempotent. */
export async function initPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

export interface PhysicsWorld {
  world: RAPIER.World;
  step: () => void;
}

export function createPhysicsWorld(stepHz: number, gravityY = -20): PhysicsWorld {
  if (!ready) throw new Error('initPhysics() must be awaited before createPhysicsWorld()');
  const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
  world.timestep = 1 / stepHz;
  return {
    world,
    step: () => world.step(),
  };
}
