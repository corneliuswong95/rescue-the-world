/**
 * OPERATOR — QA screenshot harness.
 *
 * Loads the running app in Chromium, drives it through the QA states the app advertises on
 * `window.__qa`, and captures one PNG per state into qa/shots/<label>/. The `critic` subagent
 * then reviews those PNGs.
 *
 * Usage:
 *   BASE_URL=http://localhost:4173 LABEL=M3 pnpm run shoot
 *   (defaults: BASE_URL=http://localhost:5173, LABEL=adhoc)
 *
 * The app contract (see apps/game/src/qa.ts):
 *   window.__QA_READY  -> true once at least one frame has rendered
 *   window.__qa.states -> string[] of capturable state names
 *   window.__qa.setState(name) -> arranges the scene/camera for that state, returns boolean
 *
 * Headless WebGPU note: WebGPU in headless Chromium is unreliable. We pass the WebGPU flags,
 * but if the GPU path is unavailable the app's automatic WebGL2 fallback renders instead —
 * a valid, supported render path for QA. For true-WebGPU captures in CI, run headed under
 * xvfb (`xvfb-run -a pnpm run shoot`).
 */
import { chromium, type ConsoleMessage } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const LABEL = process.env.LABEL ?? 'adhoc';
const OUT_DIR = path.resolve('shots', LABEL);
const READY_TIMEOUT = 30_000;
const SETTLE_MS = 400; // let the scene render a few frames after switching state

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--ignore-gpu-blocklist',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  page.on('console', (m: ConsoleMessage) => console.log(`[page:${m.type()}]`, m.text()));
  page.on('pageerror', (e: Error) => console.error('[page:error]', e.message));

  console.log(`Loading ${BASE_URL} …`);
  await page.goto(BASE_URL, { waitUntil: 'load' });

  // Wait until the app signals it has rendered at least one frame.
  await page.waitForFunction('window.__QA_READY === true', null, { timeout: READY_TIMEOUT });

  // Discover the states the app exposes (defaults to a single 'default' state).
  const states: string[] = await page.evaluate(
    () => (window as unknown as { __qa?: { states: string[] } }).__qa?.states ?? ['default'],
  );
  console.log(`Capturing ${states.length} state(s): ${states.join(', ')}`);

  for (const state of states) {
    const applied: boolean = await page.evaluate(
      (s) =>
        (window as unknown as { __qa?: { setState?: (n: string) => boolean } }).__qa?.setState?.(
          s,
        ) ?? true,
      state,
    );
    if (!applied) console.warn(`  ! state "${state}" was not applied by the app`);

    await page.waitForTimeout(SETTLE_MS);
    const file = path.join(OUT_DIR, `${state}.png`);
    await page.screenshot({ path: file });
    console.log(`  ✓ ${file}`);
  }

  await browser.close();
  console.log(`Done. ${states.length} shot(s) in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
