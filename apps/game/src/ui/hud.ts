/**
 * M2 combat HUD (DOM overlay above the canvas): crosshair, hitmarker (headshot/kill variants),
 * health bar + low-HP vignette, ammo counter with reload state, damage-direction indicator,
 * objective/enemy counter, and center messages ("You died", "Hostiles eliminated"). Game state
 * lives in the sim; the HUD only renders what it's told (PLAN §4: keep state out of the DOM).
 */
export interface Hud {
  setVisible(visible: boolean): void;
  setHealth(hp: number, max: number): void;
  setAmmo(mag: number, reserve: number, reloading: boolean): void;
  hitmarker(headshot: boolean, killed: boolean): void;
  damageFrom(relAngleRad: number): void;
  setObjective(text: string): void;
  setMessage(text: string | null): void;
  /** 0 hip … 1 aimed: the crosshair fades out as the optic takes over. */
  setAim(factor: number): void;
  /** Crosshair gap (px from centre to each tick) = the weapon's current spread cone on screen. */
  setSpread(gapPx: number): void;
  update(dt: number): void;
}

// Condensed "military display" stack available without shipping a font file.
const FONT = `"Bahnschrift","DIN Alternate","DIN Condensed","Arial Narrow",system-ui,sans-serif`;

export function createHud(): Hud {
  // A single root so the whole HUD can be hidden outside of play.
  const hudRoot = el('div', 'position:fixed;inset:0;pointer-events:none;z-index:8;display:none');
  document.body.appendChild(hudRoot);

  // Crosshair
  // Four ticks around a centre dot; their distance from centre (--gap) tracks weapon spread.
  const crosshair = el('div', `position:fixed;left:50%;top:50%;width:0;height:0;
    pointer-events:none;z-index:9;--gap:8px`);
  const tick = (dx: number, dy: number, w: number, h: number): string =>
    `<div style="position:absolute;width:${w}px;height:${h}px;background:#fff;box-shadow:0 0 2px #000;
      transform:translate(-50%,-50%) translate(calc(var(--gap) * ${dx}), calc(var(--gap) * ${dy}))"></div>`;
  crosshair.innerHTML = `
    <div style="position:absolute;width:2px;height:2px;background:#fff;border-radius:50%;
      transform:translate(-50%,-50%);box-shadow:0 0 2px #000"></div>
    ${tick(0, -1, 2, 6)}${tick(0, 1, 2, 6)}${tick(-1, 0, 6, 2)}${tick(1, 0, 6, 2)}`;
  hudRoot.appendChild(crosshair);

  // Hitmarker (X of 4 lines), hidden until a hit
  const hitmark = el('div', `position:fixed;left:50%;top:50%;width:28px;height:28px;
    transform:translate(-50%,-50%) rotate(45deg);pointer-events:none;z-index:9;opacity:0`);
  hitmark.innerHTML = mark('#fff');
  hudRoot.appendChild(hitmark);
  let hitTimer = 0;

  // Health (bottom-left)
  // Health (bottom-left): thin neutral bar + numeric readout; goes red when low.
  const healthWrap = el('div', `position:fixed;left:28px;bottom:26px;z-index:9;pointer-events:none;
    font:600 12px/1 ${FONT};letter-spacing:2px;color:rgba(235,240,245,.85);text-shadow:0 1px 2px #000`);
  const healthLabel = el('div', 'display:flex;justify-content:space-between;width:200px');
  const healthNum = el('span', 'font-size:20px;letter-spacing:1px;color:#f2f4f6');
  healthLabel.innerHTML = '<span style="align-self:flex-end">HEALTH</span>';
  healthLabel.appendChild(healthNum);
  const healthBarBg = el('div', `width:200px;height:4px;background:rgba(0,0,0,.45);margin-top:6px;
    box-shadow:0 0 0 1px rgba(255,255,255,.10)`);
  const healthBar = el('div', 'height:100%;width:100%;background:#e8ecef;transition:width .12s ease-out');
  healthBarBg.appendChild(healthBar);
  healthWrap.append(healthLabel, healthBarBg);
  hudRoot.appendChild(healthWrap);

  // Weapon + ammo (bottom-right)
  const ammo = el('div', `position:fixed;right:30px;bottom:24px;z-index:9;pointer-events:none;
    font:600 13px/1.1 ${FONT};letter-spacing:2px;color:rgba(235,240,245,.85);text-align:right;
    text-shadow:0 1px 2px #000`);
  hudRoot.appendChild(ammo);

  // Objective (top-left, under where a minimap would sit)
  const objective = el('div', `position:fixed;left:28px;top:24px;z-index:9;pointer-events:none;
    font:600 13px/1 ${FONT};color:#f0e2c8;letter-spacing:2.5px;text-shadow:0 1px 2px #000`);
  hudRoot.appendChild(objective);

  // Center message
  const message = el('div', `position:fixed;left:50%;top:44%;transform:translate(-50%,-50%);z-index:12;
    pointer-events:none;font:700 34px/1.2 ${FONT};letter-spacing:4px;color:#fff;
    text-align:center;text-shadow:0 2px 10px rgba(0,0,0,.8);opacity:0;transition:opacity .25s`);
  hudRoot.appendChild(message);

  // Low-HP vignette: dark-red edges only (centre stays clear), shown below 40% HP.
  const vignette = el('div', `position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;
    background:radial-gradient(ellipse at center,rgba(0,0,0,0) 52%,rgba(90,0,0,.55) 82%,rgba(60,0,0,.85) 100%);
    transition:opacity .25s`);
  hudRoot.appendChild(vignette);

  // Damage direction: a wide red arc near the screen edge, rotated toward the shooter.
  const dmgDir = el('div', `position:fixed;left:50%;top:50%;width:84vmin;height:84vmin;z-index:9;
    transform:translate(-50%,-50%);pointer-events:none;opacity:0`);
  dmgDir.innerHTML = `<div style="position:absolute;inset:0;border-radius:50%;
    border:10px solid transparent;border-top-color:rgba(220,30,20,.85);
    filter:blur(3px) drop-shadow(0 0 8px rgba(255,40,30,.8))"></div>`;
  hudRoot.appendChild(dmgDir);
  let dmgTimer = 0;
  let aimStep = -1; // last written crosshair opacity step (avoid per-frame style writes)
  let gapPx = -1;
  let lastHp = -1;

  return {
    setVisible(visible) {
      hudRoot.style.display = visible ? 'block' : 'none';
    },
    setHealth(hp, max) {
      const f = Math.max(0, Math.min(1, hp / max));
      const shown = Math.ceil(hp);
      if (shown === lastHp) return; // regen ticks every frame — only touch the DOM on change
      lastHp = shown;
      healthNum.textContent = `${shown}`;
      healthBar.style.width = `${f * 100}%`;
      healthBar.style.background = f > 0.35 ? '#e8ecef' : '#e2453a';
      vignette.style.opacity = f < 0.4 ? `${Math.min(1, (0.4 - f) / 0.3)}` : '0';
    },
    setAmmo(mag, reserve, reloading) {
      const count = reloading
        ? `<span style="color:#ffcf6a;font-size:16px">RELOADING</span>`
        : `<span style="font-size:34px;letter-spacing:1px;color:${mag <= 8 ? '#ff6a4d' : '#f2f4f6'}">${mag}</span>` +
          `<span style="font-size:16px;opacity:.6"> / ${reserve}</span>`;
      ammo.innerHTML = `<div style="opacity:.7;margin-bottom:4px">5.56 CARBINE · AUTO</div>${count}`;
    },
    hitmarker(headshot, killed) {
      hitmark.innerHTML = mark(killed ? '#ff5a4d' : headshot ? '#ffd24d' : '#ffffff');
      hitmark.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${headshot || killed ? 1.35 : 1})`;
      hitmark.style.opacity = '1';
      hitTimer = killed ? 0.3 : 0.15;
    },
    damageFrom(relAngleRad) {
      dmgDir.style.transform = `translate(-50%,-50%) rotate(${relAngleRad}rad)`;
      dmgDir.style.opacity = '1';
      dmgTimer = 0.55;
    },
    setObjective(text) {
      objective.textContent = text;
    },
    setMessage(text) {
      if (text) {
        message.textContent = text;
        message.style.opacity = '1';
      } else {
        message.style.opacity = '0';
      }
    },
    setSpread(px) {
      const g = Math.round(Math.max(5, Math.min(140, px)));
      if (g === gapPx) return;
      gapPx = g;
      crosshair.style.setProperty('--gap', `${g}px`);
    },
    setAim(factor) {
      const step = Math.round(Math.max(0, 1 - factor * 1.6) * 10);
      if (step === aimStep) return;
      aimStep = step;
      crosshair.style.opacity = `${step / 10}`;
    },
    update(dt) {
      if (hitTimer > 0) {
        hitTimer -= dt;
        if (hitTimer <= 0) hitmark.style.opacity = '0';
      }
      if (dmgTimer > 0) {
        dmgTimer -= dt;
        dmgDir.style.opacity = `${Math.max(0, dmgTimer / 0.55)}`;
      }
    },
  };
}

function el(tag: string, css: string): HTMLDivElement {
  const d = document.createElement(tag) as HTMLDivElement;
  d.style.cssText = css;
  return d;
}
function mark(color: string): string {
  const seg = (s: string): string =>
    `<div style="position:absolute;${s};background:${color};box-shadow:0 0 3px #000"></div>`;
  return (
    seg('left:50%;top:0;width:2px;height:9px;transform:translateX(-50%)') +
    seg('left:50%;bottom:0;width:2px;height:9px;transform:translateX(-50%)') +
    seg('top:50%;left:0;height:2px;width:9px;transform:translateY(-50%)') +
    seg('top:50%;right:0;height:2px;width:9px;transform:translateY(-50%)')
  );
}
