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
| M3 | — | Procedural spatial SFX exist (gunfire, impacts, reload, hitmarker, enemy fire/death). Missing: footsteps, ambience bed, music, and mix polish/ducking. | Add footsteps + CC0 ambience/music clips (Freesound/Sonniss) and a proper bus/ducking pass. | Deferred |
