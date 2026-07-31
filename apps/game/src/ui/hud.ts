/**
 * Minimal M1 HUD: a crosshair and a "click to play" prompt shown while the pointer is unlocked.
 * The full HUD (ammo/health/compass/kill feed) is subsystem #9, later.
 */
export interface Hud {
  setLocked: (locked: boolean) => void;
}

export function createHud(): Hud {
  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;width:16px;height:16px;transform:translate(-50%,-50%);' +
    'pointer-events:none;z-index:9';
  crosshair.innerHTML = `
    <div style="position:absolute;left:50%;top:50%;width:2px;height:2px;background:#fff;
      border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 2px #000"></div>
    ${crossLine('50%', '0', '2px', '5px')}
    ${crossLine('50%', '11px', '2px', '5px')}
    ${crossLine('0', '50%', '5px', '2px')}
    ${crossLine('11px', '50%', '5px', '2px')}
  `;
  document.body.appendChild(crosshair);

  const prompt = document.createElement('div');
  prompt.textContent = 'Click to play — WASD move · Shift sprint · Ctrl crouch · Space jump · Click to fire';
  prompt.style.cssText =
    'position:fixed;left:50%;top:66%;transform:translateX(-50%);z-index:11;' +
    'font:14px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cfe;text-align:center;' +
    'background:rgba(0,0,0,.55);padding:10px 16px;border-radius:8px;pointer-events:none;' +
    'letter-spacing:.2px';
  document.body.appendChild(prompt);

  return {
    setLocked(locked: boolean): void {
      prompt.style.display = locked ? 'none' : 'block';
      crosshair.style.opacity = locked ? '1' : '0.35';
    },
  };
}

function crossLine(left: string, top: string, w: string, h: string): string {
  return `<div style="position:absolute;left:${left};top:${top};width:${w};height:${h};
    background:#fff;transform:translate(-50%,-50%);box-shadow:0 0 2px #000"></div>`;
}
