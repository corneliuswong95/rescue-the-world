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

## 2026-07-31 — Runtime navmesh generation for M2 (vs. offline bake)

Context: PLAN §8 says pre-bake the navmesh offline per level. But the M2 greybox is generated
in code, not authored in a DCC tool, so there is no `.glb` to bake against — and the geometry
is fully static and tiny.
Decision: Generate a solo navmesh at load with `@recast-navigation/three`'s `threeToSoloNavMesh`
from the greybox collider meshes (`recast-navigation` 0.43.1). `NavMeshQuery.computePath` drives
bot pathing.
Consequences: One-time cost at boot (negligible for this room). When real authored levels land
in M4 we move to the offline bake + import path per PLAN §8; runtime generation stays as the
fallback for dynamic geometry only.

## 2026-10-17 — Realism pass: HDRI-driven lighting, TRAA post stack, kit-built level

Context: User asked for a much more realistic look ("same level as Call of Duty"). Literal CoD
parity stays an anti-goal (CLAUDE.md); this pass chases the measurable AAA-*feeling* bar instead.
Decision:
- **Lighting:** one sun, extracted from the HDRI (direction + colour), then clamped out of the
  IBL copy so shadows aren't re-lit by unshadowable environment light. Sky yawed to art-direct the
  sun azimuth. Exponential height haze with sun-tinted forward scattering (`scene.fogNode`).
- **Post (PLAN §4 node pipeline, unchanged stack):** MRT (colour/normal/velocity) → GTAO
  (half-res, temporal) → HDR bloom → **TRAA** (replaces FXAA) → explicit tone map → display-space
  grade (S-curve, split-tone, saturation, sharpen, vignette, grain). `outputColorTransform=false`.
- **Level:** greybox replaced by "Foundry Yard", assembled from Poly Haven's CC0 modular factory
  facade kit + photoscanned props, GPU-instanced; code-built ground/docks use world-scaled UVs
  merged per material. Gameplay layout kept close to the M4 greybox.
- **Asset encoding:** glTF → `gltf-transform optimize` (meshopt + **WebP** textures, simplification
  on heavy scans) via `tools/assets/build.py`. KTX2 is still the target per PLAN §8 but needs
  KTX-Software (`toktx`) on the build machine; at the current asset set GPU memory is well under
  budget (1K prop textures, 2K ground). Backlogged.
- **tsconfig `typeRoots`** pinned to the app's own `node_modules/@types`: tsc otherwise walks
  ancestor folders and hung on an iCloud-evicted `@types` file outside the repo.
Consequences: Asset download ≈ 25 MB (models 11 MB, textures 9 MB, HDRI 5 MB) — inside the < 5 s
broadband target but worth watching. Swapping the HDRI automatically re-aims the sun.

## 2026-10-17 — Realism pass follow-ups: perf + review cycles

Context: Designer + gamer review agents scored the first realism build 2.3 / 2.2 and drove two
fix cycles (PLAN §7 cap of 3). Several fixes are architectural:
Decision:
- **Post tiers:** high = MRT (colour, 8-bit normals, velocity) + GTAO + bloom + TRAA + sharpen;
  medium = plain pass + bloom + FXAA. Post passes use `samples: 0` (AA comes from TRAA/FXAA; an
  inherited 4× MSAA on the HDR MRT targets was the single biggest GPU cost and broke TRAA's depth
  copy on WebGPU). Transparent VFX write alpha 0 into the G-buffer attachments, which use
  material blending, so they never corrupt GTAO/TRAA inputs.
- **Baked light probe:** the yard's local probe (bounce + reflections) is baked offline
  (`tools/assets/bake-probe.mjs`) as the PMREM cube-UV atlas (half-float, 1.6 MB) and loaded as a
  pre-filtered environment; a live bake is the fallback. Re-bake when the level, lighting or
  three.js version changes.
- **Constant light set:** no light may live under an object whose visibility toggles (the
  viewmodel's muzzle light did → every material rebuilt on DEPLOY). Lights hang off the camera.
- **Prewarm:** only the active tier's passes are compiled at boot; a tier switch compiles once.
- **CSS-pixel resolution on every tier** (TRAA/FXAA + sharpen), so retina panels don't pay 2–4×
  fill for little gain.
- **Bots are pooled** (built once, parked/reactivated per round).
Consequences: M1 (below target class), WebGPU, 1080p: high ≈ 60 fps, medium ≈ 75 fps; prod
boot→menu ≈ 4.5 s on localhost (asset payload ≈ 26 MB still needs KTX2/streaming for the < 5 s
broadband target — backlogged).

## 2026-10-18 — Skinned CC0 soldiers (Quaternius) instead of code-built rigs

Context: Both review agents capped character art at ~2.5/5: rigid code-built segments can't read
as real people. The user chose the free route over Mixamo (which needs an Adobe account — its
licence is per account).
Decision: Quaternius **Universal Base Characters [Standard]** (Superhero Male body) + **Universal
Animation Library [Standard]** clips, both shipped with CC0 licence files (Quaternius has since
introduced a "QAL" licence for some newer releases — these packs' own files say CC0; re-check
the bundled licence whenever adding more Quaternius content). Same 65-joint UE-style rig, so
clips bind by bone name. Built by `tools/assets/build-characters.mjs` (mesh+skin only, no
textures; 15 clips with finger/scale channels stripped → 375 KB total). The code-built kit
(helmet, armour, pouches, rifle) becomes bone attachments; the body is shaded as a uniform.
The free tier has no rifle clips: the rifle hold is two-bone arm IK over the two-handed
`Pistol_Aim_*` poses, blended by aim pitch.
Consequences: Skinned meshes + per-soldier AnimationMixer (pooled, parked bots don't tick). Paid
tiers (Pro rifle clips, Regular-proportion bodies) would improve fidelity further but are not
needed to ship.
