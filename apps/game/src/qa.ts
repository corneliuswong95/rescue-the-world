/**
 * QA hooks consumed by the Playwright screenshot harness (qa/shoot.ts).
 *
 * A "state" arranges the scene/camera into a representative pose the critic should review
 * (e.g. 'default', later 'ads', 'firefight', 'muzzle-flash', 'hud'). Register the states you
 * want captured, then the harness snapshots each one.
 */
export type StateFn = () => void;

export interface QaConfig {
  states: Record<string, StateFn>;
}

declare global {
  interface Window {
    __QA_READY?: boolean;
    __qa?: {
      states: string[];
      setState: (name: string) => boolean;
    };
  }
}

export function installQaHooks(config: QaConfig): void {
  window.__qa = {
    states: Object.keys(config.states),
    setState(name: string): boolean {
      const fn = config.states[name];
      if (!fn) return false;
      fn();
      return true;
    },
  };

  // Signal readiness after two frames, so at least one full render has happened.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.__QA_READY = true;
    }),
  );
}
