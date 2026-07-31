# DECISIONS

Architecture and stack decisions. Append an entry whenever you deviate from `PLAN.md` §4 or
make a notable architectural choice.

Format:

```
## YYYY-MM-DD — <decision>
Context:      why this came up
Decision:     what was chosen
Consequences: what it implies / what it rules out
```

---

## 2026-07-31 — Initial stack

Context: Greenfield browser FPS, single-player vs AI bots, built agentically.
Decision: Three.js `three/webgpu` (WebGPURenderer + automatic WebGL2 fallback); TypeScript +
Vite; Rapier physics (`@dimforge/rapier3d-simd`); recast-navigation-js for AI navmesh. Full
list in `PLAN.md` §4.
Consequences: WebGPU-first with automatic fallback; shaders authored in TSL. Only `three` is
installed at M0; other libraries are added per milestone.

## 2026-07-31 — Rapier `-compat` build instead of `-simd` (M1)

Context: PLAN §4 pins `@dimforge/rapier3d-simd`. The SIMD build ships a separate `.wasm`
that needs `vite-plugin-wasm` + top-level-await wiring to bundle cleanly, and adds
cross-origin-isolation friction. At M1 the physics load is one kinematic capsule + static
level colliders — SIMD throughput is irrelevant here.
Decision: Use `@dimforge/rapier3d-compat@0.14.0`. Same Rapier engine/API; the compat build
inlines the WASM (base64) and exposes `await RAPIER.init()`, so it bundles under Vite with
zero extra plugins and no COOP/COEP headers.
Consequences: Slightly larger JS payload and no SIMD. Revisit and migrate to `-simd`
(with `vite-plugin-wasm`) if/when we simulate many dynamic rigid bodies (ragdolls, debris)
and profiling shows the physics step is a bottleneck. Tracked in QUALITY_BACKLOG if it bites.
