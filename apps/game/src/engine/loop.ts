/**
 * Fixed-timestep loop with an accumulator (CLAUDE.md rule 5: deterministic 60 Hz simulation
 * decoupled from the variable render rate). `update` runs at a fixed dt; `render` gets an
 * interpolation alpha in [0,1) so visuals can smoothly interpolate between sim steps.
 */
export interface LoopCallbacks {
  /** Fixed-step simulation. `dt` is constant, in seconds. */
  update: (dt: number) => void;
  /** Variable-rate render. `alpha` interpolates state between the last two sim steps. */
  render: (alpha: number, frameMs: number) => void;
}

export interface Loop {
  frame: () => void;
}

export function createFixedLoop(stepHz: number, cb: LoopCallbacks): Loop {
  const stepMs = 1000 / stepHz;
  const stepS = stepMs / 1000;
  const maxSubSteps = 5; // guard against the "spiral of death" after a long stall
  let last = performance.now();
  let acc = 0;

  return {
    frame(): void {
      const now = performance.now();
      let frameMs = now - last;
      last = now;
      if (frameMs > 250) frameMs = 250; // clamp tab-switch / breakpoint pauses
      acc += frameMs;

      let steps = 0;
      while (acc >= stepMs && steps < maxSubSteps) {
        cb.update(stepS);
        acc -= stepMs;
        steps += 1;
      }
      if (steps === maxSubSteps) acc = 0; // dropped frames: resync rather than fast-forward

      cb.render(acc / stepMs, frameMs);
    },
  };
}
