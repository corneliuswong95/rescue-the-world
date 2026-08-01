# QUALITY BACKLOG

Visual/perf issues the `critic` flagged that were deferred after the 3-cycle cap for a
milestone. Revisit before v1 sign-off.

| Milestone | Screenshot | Issue | Suggested fix | Status |
|---|---|---|---|---|
| M1 | qa/shots/M1/default.png | Viewmodel renders in the world scene at the 70° world FOV — clips world geometry near walls and distorts at frame edges. | Move the viewmodel to a dedicated overlay scene + narrow-FOV (~55°) camera with a depth clear between passes (PLAN §4 "separate FOV layer"). Owned by the Weapons subsystem. | Deferred |
| M1 | — | Rapier `-compat` inlines its WASM → ~2.8 MB JS bundle (970 KB gzip). Fine for M1 but eats into the <5 s time-to-playable budget as content grows. | Code-split Rapier via dynamic import, or migrate to `-simd` with `vite-plugin-wasm` (separate cacheable `.wasm`). | Deferred |
| M1 | — | Headless QA runs on the WebGL2 backend (forced via `?webgl=1`) because headless Chromium's WebGPU device is unstable. Critic never sees the true WebGPU path. | For milestone gates that must judge the WebGPU pipeline, run the harness headed under a real GPU/xvfb. | Deferred |
| M2 | qa/shots/M2/combat.png | Enemy death is a scripted topple + sink, not a ragdoll. | Rapier dynamic-body ragdoll on death (impulse from the killing shot). Owned by Enemy AI in M3 polish. | Deferred |
| M2 | — | Enemy FSM holds position when it has LOS and advances when it doesn't — no explicit cover selection or flanking (PLAN §5 lists "cover → reposition → flank"). | Add cover-point scoring + strafe/reposition once real levels exist (M4). | Deferred |
| M2 | qa/shots/M2/combat.png | Blood is a soft additive particle blob; reads as placeholder. | Replace in the M3 VFX pass with a textured spray + a persistent decal. | Deferred |
| M2 | — | Enemy aim fairness (reaction/spread/cadence) is set by feel, not tuned against playtest data. | Tune during the M4 difficulty pass with real play sessions. | Deferred |
| M3 | qa/shots/M3/overview.png | Post stack has IBL + GTAO + bloom but no TAA/SMAA temporal AA (edges alias, esp. in motion). | Add a TAA (or SMAA) node to the RenderPipeline graph. Asset-free. | Deferred |
| M3 | qa/shots/M3/overview.png | Look still reads as greybox: flat MeshStandard colours, no PBR texture detail, capsule/box character + weapon proxies. This is the core "AAA look" gap. | Real CC0 PBR textures (ambientCG) + HDRI IBL (PolyHaven) + character/weapon glTF models + Mixamo animations. Needs asset sourcing + licensing (CREDITS.md); Mixamo needs an Adobe account. | Blocked on assets |
| M3 | — | Procedural spatial SFX + footsteps + ambience bed now exist. Missing: music and mix polish/ducking. | Add CC0 music (Freesound/Sonniss) + a ducking pass. | Deferred |
| M4 | qa/shots/M4/combat.png | Enemy arms are static (merged into the torso for the draw-call budget), so a soldier aiming off-axis holds its rifle stiffly straight out. | Un-merge the arms into shoulder/elbow pivots and drive an aim pose toward the target; or blend a small IK. Costs draw calls — pair with instanced/skinned batching. | Deferred |
| M4 | qa/shots/M4/overview.png | Character locomotion is procedural (box rig), not skeletal/mocap. Reads stylised but poses are simple. | Optional: swap to a skinned rig + authored clips if a CC0 soldier is sourced (see M3 row). | Deferred |
| M4 | — | Combat VFX (muzzle flash, tracers, blood) are transient and don't appear in the 400 ms-settle QA stills, so the critic can't score them. | Add a QA-only "freeze VFX" hook, or capture mid-effect, so the critic sees muzzle/tracer/impact. | Deferred |
| M4 | qa/shots/M4/overview.png | AA is FXAA (post) — softens edges but blurs slightly; no temporal stability. | Evaluate TAA or MSAA sample count on the scene pass for the WebGPU path. | Deferred |
| M4 | qa/shots/M4/overview.png | Walls read plainer than the floor (plaster texture is subtle at this tiling). | Retune wall tiling / add trim + edge detail; per-face world-scaled UVs (see M3 UV row). | Deferred |
| M3 | qa/shots/M3/overview.png | Enemy character is three's CC0 "RobotExpressive" placeholder (a robot, not a soldier) — user wanted a Quaternius soldier, but no scriptable Quaternius download was available here. | Drop in a Quaternius CC0 soldier `.glb` (same Idle/Running/Death clip roles → near drop-in via `ai/character.ts`). Needs a reliable download or user-provided file. | Blocked on asset |
| M3 | — | Player weapon is still the procedural box viewmodel — no CC0 gun model was auto-fetchable. | Integrate a CC0 rifle glTF on a separate-FOV viewmodel layer (also fixes the M1 world-clip row). | Blocked on asset |
| M3 | — | glTF/texture assets ship uncompressed (small M3 set, measured well under the 1.5 GB GPU-memory budget). Rule 8 wants KTX2/Draco/meshopt before scale. | Add a `gltf-transform` step (Draco + meshopt + KTX2) once the asset set grows in M4. | Deferred |
| M3 | qa/shots/M3/overview.png | 4 skinned characters ≈ 209 draw calls. Fine now, but scales linearly with enemy count. | Batch/instance skinned meshes or cap concurrent live enemies for larger fights (M4). | Deferred |
