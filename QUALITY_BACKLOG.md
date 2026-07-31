# QUALITY BACKLOG

Visual/perf issues the `critic` flagged that were deferred after the 3-cycle cap for a
milestone. Revisit before v1 sign-off.

| Milestone | Screenshot | Issue | Suggested fix | Status |
|---|---|---|---|---|
| M1 | qa/shots/M1/default.png | Viewmodel renders in the world scene at the 70° world FOV — clips world geometry near walls and distorts at frame edges. | Move the viewmodel to a dedicated overlay scene + narrow-FOV (~55°) camera with a depth clear between passes (PLAN §4 "separate FOV layer"). Owned by the Weapons subsystem. | Deferred |
| M1 | — | Rapier `-compat` inlines its WASM → ~2.8 MB JS bundle (970 KB gzip). Fine for M1 but eats into the <5 s time-to-playable budget as content grows. | Code-split Rapier via dynamic import, or migrate to `-simd` with `vite-plugin-wasm` (separate cacheable `.wasm`). | Deferred |
| M1 | — | Headless QA runs on the WebGL2 backend (forced via `?webgl=1`) because headless Chromium's WebGPU device is unstable. Critic never sees the true WebGPU path. | For milestone gates that must judge the WebGPU pipeline, run the harness headed under a real GPU/xvfb. | Deferred |
