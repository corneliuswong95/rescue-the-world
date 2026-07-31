# PLAN.md — OPERATOR build plan

The detailed plan for the browser FPS. Rules and budgets live in `CLAUDE.md`; this file is
the *what* and *in what order*. Sections: §4 tech stack · §5 subsystem fan-out · §6
milestones · §7 critic protocol · §8 asset pipeline · plus the first command to Claude Code.

---

## §4. Tech stack (verified current — 2026)

| Concern | Choice | Notes |
|---|---|---|
| Renderer | **Three.js via `three/webgpu`** (`WebGPURenderer`) | Production-ready since r171 (Sep 2025); WebGPU is Baseline across major browsers in 2026 with **automatic WebGL2 fallback**. `await renderer.init()` before first render. |
| Shaders | **TSL** (Three Shader Language) | Write once → compiles to WGSL and GLSL; avoids maintaining separate shader codebases across the WebGPU/WebGL split. |
| Language / build | **TypeScript (strict) + Vite** | Fast HMR; `build.target: 'esnext'` for top-level await. |
| Physics | **Rapier** (`@dimforge/rapier3d-simd`) | Fastest browser physics (Rust→WASM+SIMD). Async `await RAPIER.init()`. Built-in **kinematic character controller** — use it for player and bots. |
| Nav / pathfinding | **recast-navigation-js** + `@recast-navigation/three` | WASM port of Recast/Detour (industry-standard navmesh). **Pre-bake the navmesh offline per level**, import at runtime; Detour crowd/agents for bot movement. (Simpler alt: `three-pathfinding` or `navcat`.) |
| AI behavior | Custom FSM / behavior tree (+ optional `yuka.js` steering) | Perception (FOV cones + LOS raycasts + hearing) → decide → act. |
| Post-processing | Three node-based post (TSL) on the WebGPU path | Bloom, GTAO/SSAO, ACES or AgX tonemapping, TAA or SMAA, subtle motion blur, vignette, sharpen. (On the WebGL renderer, use pmndrs `postprocessing`.) |
| Shadows | Cascaded shadow maps for large exteriors; **baked lightmaps** for static geometry | Realtime GI isn't feasible — fake it with baked lighting + IBL + AO. |
| Assets | glTF/`.glb`, **Draco** geometry, **meshopt**, **KTX2/Basis** textures | Compression is mandatory to hit the memory budget. |
| Audio | Web Audio API + Three `PositionalAudio`/`AudioListener` | Bus mixer (SFX/music/ambience), ducking, spatialized gunfire + footsteps. |
| HUD / UI | React + TS DOM overlay above the `<canvas>` | Keep game state out of React; React just renders the HUD. |
| Profiling | `stats-gl`, `renderer.info`, Spector.js, DevTools Performance | Measure before optimizing; watch draw calls and frame allocations. |
| ECS (optional, recommended) | **miniplex** (TS-friendly) or **bitecs** (max perf) | Clean entities/systems separation. |

> Only `three` is a dependency of the M0 seed. Install the rest (Rapier, recast-navigation,
> etc.) as you reach the milestones that need them, and log any version pins in `DECISIONS.md`.

---

## §5. Subsystem fan-out — the "sub-agents," done right

Each subsystem is an **independently ownable unit** with explicit acceptance criteria.
Parallelize the ones with no shared dependency; serialize the dependency chain (see the
"Depends on" column). This is the correct translation of "fan out sub-agents."

| # | Subsystem | Depends on | Scope | Acceptance criteria |
|---|---|---|---|---|
| 1 | **Core & Render Pipeline** | — | Vite+TS boot, `three/webgpu` renderer + fallback, camera rig, fixed-timestep loop, stats overlay, resize/pixel-ratio | Boots to a lit scene at 60 FPS; overlay shows draw calls + frame time; fallback verified |
| 2 | **Physics & Character Controller** | 1 | Rapier world, fixed step, kinematic capsule controller, collision layers, raycasts | Capsule walks/collides on a blockout; no tunneling; deterministic step |
| 3 | **Player: movement, camera, input** | 2 | Pointer Lock mouse-look, WASD, sprint, crouch, jump, momentum, head-bob/lean | Responsive and weighty; no camera jitter; sensible acceleration |
| 4 | **Weapons** | 3 | Viewmodel (separate FOV layer, no world clip), firing (hitscan + optional projectile), recoil, spread, ADS, reload, ammo, weapon switch, hitboxes (head/body/limb multipliers) | Crunchy to shoot; ADS smooth; recoil learnable; hitboxes register correctly |
| 5 | **Enemy AI** | 2, 6 | Baked navmesh pathing, perception (FOV + LOS + hearing), combat FSM (patrol → alert → cover → engage → reposition → flank), fair aim (reaction time + error), health/death/ragdoll | Bots navigate real geometry, take cover, feel fair not cheap, die convincingly |
| 6 | **Level & Environment** | 1 | Greybox blockout → art pass; modular kit; PBR materials; HDRI/IBL; baked lightmaps; skybox; instanced props | Cohesive, readable space; within draw-call budget; baked lighting looks intentional |
| 7 | **VFX** | 1 | Muzzle flash, tracers, pooled impact decals, blood/sparks, explosions, smoke, particle systems (GPU/compute where possible) | Impactful, pooled (no GC spikes), consistent with art direction |
| 8 | **Audio** | 1 | Web Audio bus mixer, spatialized gunfire/footsteps/reload/impacts, ambience, music, ducking, hitmarker | Positional and punchy; balanced mix; no clipping |
| 9 | **HUD / UI & menus** | 1 | Crosshair, ammo, health, compass/minimap, hitmarkers, kill feed, damage direction, main menu, pause, settings (sensitivity, quality tiers) | Clear, legible, non-intrusive; quality tiers actually change perf |
| 10 | **Match / game loop** | 3, 4, 5 | Spawns, objective(s), score, win/lose, wave/scenario logic, difficulty scaling | Playable start→finish with a clear objective |

**Parallelization example:** once M2 exists, #7 (VFX), #8 (Audio), and #9 (HUD) can proceed
concurrently as separate subagents; keep #2 → #3 → #4 → #5 in sequence.

---

## §6. Milestones — vertical slices (each ships runnable)

**M0 — Skeleton.** Vite + TS + `three/webgpu` boots to an empty lit scene with a camera and a
stats overlay; fallback verified. *(This repo ships an M0 seed — verify it runs, then extend.)*
*Gate: 60 FPS empty scene.*

**M1 — Greybox playground (FEEL FIRST).** Rapier capsule controller; WASD + jump + crouch +
sprint with good momentum; one collidable blockout room; a placeholder weapon that fires a
raycast and spawns a pooled impact decal. **About movement/shooting feel, not looks.**
*Gate: it feels good to move and shoot in a grey box.*

**M2 — Combat core.** One enemy type with baked-navmesh pathing, perception, the ability to
shoot back and die; player health/damage; hitmarkers; ammo + reload. *Gate: a real (if ugly)
firefight works.*

**M3 — Art & audio pass (starts to feel AAA).** Real PBR materials, HDRI/IBL, the full post
stack, weapon + enemy models with Mixamo animations, spatial audio, VFX. First critic pass
runs here. *Gate: rubric mean ≥ 4/5 on must-haves; budgets green.*

**M4 — Content & polish.** One full playable level with an objective; 2–3 enemy types;
difficulty; menus + HUD; a dedicated performance pass to hit all budgets; final critic passes.
*Gate: Definition of Done (`CLAUDE.md`).*

**Later** — additional levels, weapons, enemy types, low-end quality tiers.

---

## §7. The Critic Protocol — visual QA that terminates

The correct translation of "a harsh critic sub-agent that checks it visually." Harsh,
objective, and it **stops**.

**Mechanism (how the agent actually "sees" the game):**
1. The **Playwright harness** (`qa/shoot.ts`) loads the built app headless, drives it through
   the QA states the app advertises on `window.__qa`, and captures a PNG per state into
   `qa/shots/<milestone>/`.
2. The **`critic` subagent** (`.claude/agents/critic.md`) views those PNGs and scores them
   against the rubric below — a demanding art/tech director listing concrete, fixable defects.

**Rubric — score each 1–5, list specific defects:**
- Lighting & exposure · Material realism · Silhouette & readability · Animation quality ·
  VFX quality · UI clarity · **Perf overlay** (FPS / draw calls / frame time vs. `CLAUDE.md`
  budgets).
- **Jank checklist (must be clean):** z-fighting, texture/LOD popping, viewmodel
  world-clipping, aliasing, shadow acne / peter-panning, tearing.

**Hard iteration cap:** **max 3 critic → fix cycles per subsystem per milestone.** Anything
unresolved after 3 cycles goes to `QUALITY_BACKLOG.md` (with screenshot + defect note) and the
build **moves on**. This single rule prevents unbounded time/credit burn.

**Reference use:** you may study CoD/other AAA footage to *calibrate the rubric* (what good
muzzle flash or exposure looks like). Do **not** embed their frames in the repo, and do **not**
attempt to pixel-match a title. Judge against the rubric.

**Milestone gate:** passes when rubric mean ≥ 4/5 on must-haves **and** perf budgets green
**and** jank checklist clean — or residuals explicitly backlogged with justification.

---

## §8. Asset pipeline & sources

**Sources (CC0 / licensed only — verify each license):**
- **PolyHaven**, **ambientCG** — HDRIs, PBR textures, some models (CC0).
- **Quaternius**, **Kenney**, **KayKit** — cohesive prop/kit packs.
- **Mixamo** — rigged humanoids + a large animation library (free, Adobe account).
- **Sketchfab** — filter to Creative Commons; check each model's license.
- **Freesound**, **Sonniss GDC packs** — audio (check per-clip license).

**Pipeline:**
- Model → glTF (`.glb`) → **`gltf-transform`** CLI (Draco + meshopt + KTX2) → load.
- Bake **lightmaps** for static geometry in Blender; keep only a few realtime lights.
- **Pre-bake the navmesh** per level offline; import at runtime (runtime generation is a
  fallback for dynamic geometry only).
- Log every asset in `CREDITS.md` — source + license, one line each. Matters legally and for a
  clean handoff.

---

## First command to give Claude Code

> "Read `CLAUDE.md` and `PLAN.md`. First **verify the M0 seed**: run `pnpm install`, then
> `pnpm --filter @operator/game dev`, and confirm a lit scene renders at ~60 FPS with the
> stats overlay showing draw calls and frame time (bump `three` to the latest r18x and log it
> in `DECISIONS.md` if needed). Once M0 is green, proceed to **M1 only**: add the Rapier
> kinematic capsule controller, Pointer-Lock mouse-look, WASD + jump + crouch + sprint with
> good momentum, one collidable greybox room, and a placeholder raycast weapon with a pooled
> impact decal. Stop at the M1 gate (movement + shooting *feel*) and report. Do not start M2."
