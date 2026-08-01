/**
 * Persistent player settings (localStorage). Sensitivity, quality tier (which actually changes
 * perf — see main.ts applyQuality), master volume, and difficulty.
 */
export type Quality = 'low' | 'medium' | 'high';
export type Difficulty = 'recruit' | 'regular' | 'veteran';

export interface Settings {
  sensitivity: number; // multiplier around the base look speed
  quality: Quality;
  volume: number; // 0..1
  difficulty: Difficulty;
}

const KEY = 'operator.settings.v1';

const DEFAULTS: Settings = {
  sensitivity: 1,
  quality: 'high',
  volume: 0.8,
  difficulty: 'regular',
};

export const DIFFICULTY_VALUE: Record<Difficulty, number> = {
  recruit: 0,
  regular: 1,
  veteran: 2,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
