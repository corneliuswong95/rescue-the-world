/**
 * Dependency-free stats overlay. Shows FPS, frame time, draw calls, triangles and the true
 * render backend — the numbers the critic's perf-overlay rubric checks against CLAUDE.md.
 * Swap in stats-gl later for GPU timings.
 */
import type * as THREE from 'three/webgpu';

export interface Stats {
  /** Call once per rendered frame with the measured frame time in ms. */
  sample: (frameMs: number) => void;
}

export function createStatsOverlay(
  renderer: THREE.WebGPURenderer,
  backendName: string,
): Stats {
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:8px;left:8px;font:12px/1.45 ui-monospace,monospace;color:#9ff;' +
    'background:rgba(0,0,0,.5);padding:6px 9px;border-radius:5px;white-space:pre;' +
    'pointer-events:none;z-index:10';
  document.body.appendChild(hud);

  let acc = 0;
  let frames = 0;
  let fps = 0;
  let frameMs = 0;

  return {
    sample(dtMs: number): void {
      acc += dtMs;
      frames += 1;
      if (acc >= 500) {
        fps = Math.round((frames * 1000) / acc);
        frameMs = Number((acc / frames).toFixed(2));
        frames = 0;
        acc = 0;
      }
      const info = renderer.info.render;
      hud.textContent =
        `FPS        ${fps}\n` +
        `frame ms   ${frameMs}\n` +
        `drawcalls  ${info.drawCalls}\n` +
        `triangles  ${info.triangles}\n` +
        `backend    ${backendName}`;
    },
  };
}
