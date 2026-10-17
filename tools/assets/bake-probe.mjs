// Bake the yard's local light probe into a shippable asset.
//
//   node tools/assets/bake-probe.mjs [devServerUrl]     (default http://127.0.0.1:5173)
//
// Opens the game with `?bakeprobe` (WebGPU), which bakes the probe live and exposes the PMREM
// atlas bytes, then writes apps/game/public/assets/hdri/foundry_yard_probe.bin. Re-run after
// changing the level layout, lighting/HDRI, or upgrading three.js.
import { chromium } from '../../qa/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'apps/game/public/assets/hdri/foundry_yard_probe.bin');

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`${base}/?bakeprobe`, { waitUntil: 'load' });
await page.waitForFunction('window.__probeBytes !== undefined', null, { timeout: 180_000 });
const b64 = await page.evaluate(() => {
  const bytes = window.__probeBytes;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
await writeFile(out, Buffer.from(b64, 'base64'));
console.log(`wrote ${out} (${(Buffer.byteLength(b64, 'base64') / 1e6).toFixed(2)} MB)`);
await browser.close();
