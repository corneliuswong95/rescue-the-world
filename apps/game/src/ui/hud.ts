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
  update(dt: number): void;
}

export function createHud(): Hud {
  // A single root so the whole HUD can be hidden outside of play.
  const hudRoot = el('div', 'position:fixed;inset:0;pointer-events:none;z-index:8;display:none');
  document.body.appendChild(hudRoot);

  // Crosshair
  const crosshair = el('div', `position:fixed;left:50%;top:50%;width:16px;height:16px;
    transform:translate(-50%,-50%);pointer-events:none;z-index:9`);
  crosshair.innerHTML = `
    <div style="position:absolute;left:50%;top:50%;width:2px;height:2px;background:#fff;
      border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 2px #000"></div>
    ${line('50%', '0', '2px', '5px')}${line('50%', '11px', '2px', '5px')}
    ${line('0', '50%', '5px', '2px')}${line('11px', '50%', '5px', '2px')}`;
  hudRoot.appendChild(crosshair);

  // Hitmarker (X of 4 lines), hidden until a hit
  const hitmark = el('div', `position:fixed;left:50%;top:50%;width:28px;height:28px;
    transform:translate(-50%,-50%) rotate(45deg);pointer-events:none;z-index:9;opacity:0`);
  hitmark.innerHTML = mark('#fff');
  hudRoot.appendChild(hitmark);
  let hitTimer = 0;

  // Health (bottom-left)
  const healthWrap = el('div', `position:fixed;left:22px;bottom:22px;z-index:9;pointer-events:none;
    font:600 13px/1 ui-monospace,monospace;color:#eaf2ff`);
  const healthBarBg = el('div', `width:220px;height:14px;background:rgba(0,0,0,.5);border-radius:3px;
    overflow:hidden;margin-top:5px;box-shadow:0 0 0 1px rgba(255,255,255,.12)`);
  const healthBar = el('div', `height:100%;width:100%;background:linear-gradient(90deg,#37d67a,#7ef0a8);
    transition:width .12s ease-out`);
  healthBarBg.appendChild(healthBar);
  const healthLabel = el('div', '');
  healthLabel.textContent = 'HEALTH';
  healthWrap.append(healthLabel, healthBarBg);
  hudRoot.appendChild(healthWrap);

  // Ammo (bottom-right)
  const ammo = el('div', `position:fixed;right:24px;bottom:20px;z-index:9;pointer-events:none;
    font:700 15px/1.2 ui-monospace,monospace;color:#eaf2ff;text-align:right;
    text-shadow:0 1px 2px #000`);
  hudRoot.appendChild(ammo);

  // Objective (top-center)
  const objective = el('div', `position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9;
    pointer-events:none;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;color:#ffd9d0;
    letter-spacing:.4px;text-shadow:0 1px 2px #000`);
  hudRoot.appendChild(objective);

  // Center message
  const message = el('div', `position:fixed;left:50%;top:44%;transform:translate(-50%,-50%);z-index:12;
    pointer-events:none;font:700 34px/1.2 ui-sans-serif,system-ui,sans-serif;color:#fff;
    text-align:center;text-shadow:0 2px 10px rgba(0,0,0,.8);opacity:0;transition:opacity .25s`);
  hudRoot.appendChild(message);

  // Low-HP vignette
  const vignette = el('div', `position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;
    box-shadow:inset 0 0 200px 60px rgba(180,20,20,.85);transition:opacity .2s`);
  hudRoot.appendChild(vignette);

  // Damage direction indicator
  const dmgDir = el('div', `position:fixed;left:50%;top:50%;width:260px;height:260px;z-index:9;
    transform:translate(-50%,-50%);pointer-events:none;opacity:0`);
  dmgDir.innerHTML = `<div style="position:absolute;left:50%;top:0;width:70px;height:26px;
    transform:translateX(-50%);background:radial-gradient(ellipse at bottom,rgba(255,40,40,.9),
    rgba(255,40,40,0));border-radius:50%"></div>`;
  hudRoot.appendChild(dmgDir);
  let dmgTimer = 0;
  let aimStep = -1; // last written crosshair opacity step (avoid per-frame style writes)

  return {
    setVisible(visible) {
      hudRoot.style.display = visible ? 'block' : 'none';
    },
    setHealth(hp, max) {
      const f = Math.max(0, Math.min(1, hp / max));
      healthBar.style.width = `${f * 100}%`;
      healthBar.style.background =
        f > 0.5
          ? 'linear-gradient(90deg,#37d67a,#7ef0a8)'
          : f > 0.25
            ? 'linear-gradient(90deg,#e0a53a,#f0d07e)'
            : 'linear-gradient(90deg,#d64444,#f08a8a)';
      vignette.style.opacity = f < 0.35 ? `${(0.35 - f) / 0.35}` : '0';
    },
    setAmmo(mag, reserve, reloading) {
      ammo.innerHTML = reloading
        ? `<span style="color:#ffcf6a">RELOADING…</span>`
        : `<span style="font-size:22px">${mag}</span> <span style="opacity:.6">/ ${reserve}</span>`;
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
      dmgTimer = 0.9;
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
        dmgDir.style.opacity = `${Math.max(0, dmgTimer / 0.9)}`;
      }
    },
  };
}

function el(tag: string, css: string): HTMLDivElement {
  const d = document.createElement(tag) as HTMLDivElement;
  d.style.cssText = css;
  return d;
}
function line(left: string, top: string, w: string, h: string): string {
  return `<div style="position:absolute;left:${left};top:${top};width:${w};height:${h};
    background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 2px #000"></div>`;
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
