import { defineConfig } from 'vite';

// three/webgpu ships as ESM and needs no special plugin for a basic setup.
// `esnext` target keeps top-level `await` (used for renderer.init()) in the output.
export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'esnext' },
});
