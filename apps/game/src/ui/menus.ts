/**
 * Menu system (DOM): main menu, pause, settings, and win/lose screens. Pure presentation —
 * it raises callbacks the game controller wires to lifecycle transitions, and reports settings
 * changes. Shown when the pointer is unlocked; hidden during play.
 */
import type { Settings, Quality, Difficulty } from '../game/settings';

export interface Menus {
  showMenu(): void;
  showPause(): void;
  showWin(seconds: number): void;
  showLose(): void;
  hideAll(): void;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onQuitToMenu: () => void;
  onSettingsChange: (s: Settings) => void;
}

const ACCENT = '#e8a33d';
const PANEL = 'background:rgba(12,14,18,.92);border:1px solid rgba(232,163,61,.35);border-radius:10px';

export function createMenus(initial: Settings): Menus {
  const settings: Settings = { ...initial };

  const root = div(
    `position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;
     font-family:ui-sans-serif,system-ui,sans-serif;color:#e8ecf2;
     background:radial-gradient(ellipse at center,rgba(8,10,14,.72),rgba(4,5,7,.92))`,
  );
  root.style.pointerEvents = 'auto';
  document.body.appendChild(root);

  const api: Menus = {
    onStart: () => {},
    onResume: () => {},
    onRestart: () => {},
    onQuitToMenu: () => {},
    onSettingsChange: () => {},
    showMenu: () => show('menu'),
    showPause: () => show('pause'),
    showWin: (s) => {
      winTime.textContent = `Sector cleared in ${s.toFixed(1)}s`;
      show('win');
    },
    showLose: () => show('lose'),
    hideAll: () => {
      root.style.display = 'none';
    },
  };

  // --- Screens ---
  const screens: Record<string, HTMLElement> = {};
  let settingsReturn: 'menu' | 'pause' = 'menu';

  function show(name: string): void {
    root.style.display = 'flex';
    for (const k of Object.keys(screens)) screens[k].style.display = k === name ? 'block' : 'none';
  }

  // Main menu
  const menu = panel();
  menu.appendChild(title('OPERATOR'));
  menu.appendChild(tagline('BROWSER TACTICAL FPS'));
  menu.appendChild(button('DEPLOY', () => api.onStart(), true));
  menu.appendChild(button('SETTINGS', () => openSettings('menu')));
  menu.appendChild(
    hint('WASD move · Shift sprint · Ctrl crouch · Space jump · L-click fire · R-click ADS · R reload'),
  );
  screens.menu = menu;
  root.appendChild(menu);

  // Pause
  const pause = panel();
  pause.appendChild(title('PAUSED', 26));
  pause.appendChild(button('RESUME', () => api.onResume(), true));
  pause.appendChild(button('SETTINGS', () => openSettings('pause')));
  pause.appendChild(button('RESTART MISSION', () => api.onRestart()));
  pause.appendChild(button('QUIT TO MENU', () => api.onQuitToMenu()));
  screens.pause = pause;
  root.appendChild(pause);

  // Win
  const win = panel();
  win.appendChild(title('MISSION COMPLETE', 26, '#7ef0a8'));
  const winTime = tagline('');
  win.appendChild(winTime);
  win.appendChild(button('REDEPLOY', () => api.onRestart(), true));
  win.appendChild(button('MAIN MENU', () => api.onQuitToMenu()));
  screens.win = win;
  root.appendChild(win);

  // Lose
  const lose = panel();
  lose.appendChild(title('K.I.A.', 30, '#f08a8a'));
  lose.appendChild(tagline('You were eliminated.'));
  lose.appendChild(button('RETRY', () => api.onRestart(), true));
  lose.appendChild(button('MAIN MENU', () => api.onQuitToMenu()));
  screens.lose = lose;
  root.appendChild(lose);

  // Settings
  const settingsPanel = panel();
  settingsPanel.appendChild(title('SETTINGS', 24));
  settingsPanel.appendChild(
    slider('Look sensitivity', 0.2, 3, 0.05, settings.sensitivity, (v) => {
      settings.sensitivity = v;
      commit();
    }),
  );
  settingsPanel.appendChild(
    slider('Master volume', 0, 1, 0.05, settings.volume, (v) => {
      settings.volume = v;
      commit();
    }),
  );
  settingsPanel.appendChild(
    select<Quality>('Quality', ['low', 'medium', 'high'], settings.quality, (v) => {
      settings.quality = v;
      commit();
    }),
  );
  settingsPanel.appendChild(
    select<Difficulty>('Difficulty', ['recruit', 'regular', 'veteran'], settings.difficulty, (v) => {
      settings.difficulty = v;
      commit();
    }),
  );
  settingsPanel.appendChild(button('BACK', () => show(settingsReturn)));
  screens.settings = settingsPanel;
  root.appendChild(settingsPanel);

  function openSettings(from: 'menu' | 'pause'): void {
    settingsReturn = from;
    show('settings');
  }
  function commit(): void {
    api.onSettingsChange({ ...settings });
  }

  return api;

  // --- builders ---
  function panel(): HTMLElement {
    const p = div(
      `${PANEL};display:none;padding:34px 40px;min-width:340px;text-align:center;
       box-shadow:0 20px 60px rgba(0,0,0,.5)`,
    );
    return p;
  }
  function title(text: string, size = 44, color = '#fff'): HTMLElement {
    const t = div(
      `font-weight:800;font-size:${size}px;letter-spacing:${size > 30 ? 8 : 4}px;color:${color};
       margin-bottom:8px`,
    );
    t.textContent = text;
    return t;
  }
  function tagline(text: string): HTMLElement {
    const t = div(`color:${ACCENT};letter-spacing:3px;font-size:12px;margin-bottom:22px`);
    t.textContent = text;
    return t;
  }
  function hint(text: string): HTMLElement {
    const t = div('color:#8a93a0;font-size:11px;margin-top:18px;max-width:360px;line-height:1.5');
    t.textContent = text;
    return t;
  }
  function button(label: string, onClick: () => void, primary = false): HTMLElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      `display:block;width:100%;margin:8px 0;padding:12px 18px;font:600 14px/1 inherit;
       letter-spacing:2px;cursor:pointer;border-radius:6px;transition:all .12s;` +
      (primary
        ? `background:${ACCENT};color:#1a1206;border:1px solid ${ACCENT}`
        : 'background:rgba(255,255,255,.05);color:#e8ecf2;border:1px solid rgba(255,255,255,.14)');
    b.onmouseenter = () => (b.style.filter = 'brightness(1.15)');
    b.onmouseleave = () => (b.style.filter = 'none');
    b.onclick = onClick;
    return b;
  }
  function slider(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap = div('margin:14px 0;text-align:left');
    const l = div('font-size:12px;color:#b6bfca;letter-spacing:1px;margin-bottom:6px');
    const val = document.createElement('span');
    val.style.cssText = `color:${ACCENT};float:right`;
    val.textContent = value.toFixed(2);
    l.textContent = label;
    l.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.cssText = `width:100%;accent-color:${ACCENT}`;
    input.oninput = () => {
      const v = parseFloat(input.value);
      val.textContent = v.toFixed(2);
      onInput(v);
    };
    wrap.append(l, input);
    return wrap;
  }
  function select<T extends string>(
    label: string,
    options: T[],
    value: T,
    onChange: (v: T) => void,
  ): HTMLElement {
    const wrap = div('margin:14px 0;text-align:left');
    const l = div('font-size:12px;color:#b6bfca;letter-spacing:1px;margin-bottom:6px');
    l.textContent = label;
    const sel = document.createElement('select');
    sel.style.cssText =
      'width:100%;padding:9px 10px;border-radius:6px;background:rgba(255,255,255,.05);' +
      'color:#e8ecf2;border:1px solid rgba(255,255,255,.14);font:inherit;text-transform:capitalize';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      if (o === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => onChange(sel.value as T);
    wrap.append(l, sel);
    return wrap;
  }
}

function div(css: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  return d;
}
