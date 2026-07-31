# CLAUDE.md — OPERATOR (browser FPS)

Single-player, modern-military first-person shooter running in the browser on Three.js,
with AI bot opponents. Built agentically with Claude Code.

**This file is the always-loaded working agreement — the rules.** The detailed build plan
(tech stack, subsystem breakdown, milestones, critic protocol, asset pipeline) lives in
**`PLAN.md`**. Living docs: `QUALITY_BACKLOG.md` (deferred quality issues), `DECISIONS.md`
(stack/architecture changes), `CREDITS.md` (asset license ledger).

---

## Quality bar — read this before writing any code

Target: an **AAA-*feeling*** browser FPS, defined by **measurable criteria** — **not**
parity with a shipped Call of Duty title.

> Why not CoD parity: a modern CoD is hundreds of people over years on a proprietary native
> engine with gigabytes of bespoke, mocap'd assets. A browser has hard ceilings on GPU
> memory, draw calls, and shader budget. Chasing literal parity never converges. What a solo
> browser project *can* do is look and feel genuinely great — that's the goal.

| Dimension | Target |
|---|---|
| Frame rate | Locked 60 FPS at 1080p on a mid-range discrete GPU (RTX 3060 / Apple M2 class); no stutter spikes > 33 ms |
| Input feel | Sub-frame input sampling; responsive, weighty mouse-look via Pointer Lock |
| Time-to-playable | < 5 s on broadband for the first level |
| Visual cohesion | Consistent art direction, correct PBR + image-based lighting, a full post stack, zero obvious jank |
| Combat feel | Crunchy hit feedback, readable enemy silhouettes, satisfying recoil/ADS |

**Operational definition:** a first-time player never thinks *"this looks like a cheap
demo."* The `critic` subagent (`.claude/agents/critic.md`) enforces this **objectively**,
against the rubric in `PLAN.md` — not against CoD.

---

## Working agreement — hard rules

1. **Performance budgets are non-negotiable** (per frame, 1080p): draw calls **≤ 500**
   (stretch ≤ 200; use instancing / `BatchedMesh` / merging), triangles **≤ 2–3 M**, GPU
   memory **≤ 1.5 GB** (enforced by KTX2 compression), and **zero per-frame allocations in
   hot loops** (pool bullets, decals, particles, damage numbers; dispose everything you drop).
2. **The tech stack in `PLAN.md` §4 is locked.** Needed swaps get a rationale entry in
   `DECISIONS.md` *before* changing — no silent substitutions.
3. **Asset licensing is strict.** Only CC0 / properly licensed assets. **Never** ingest
   ripped assets, audio, maps, UI, logos, or trademarked names from Call of Duty or any
   commercial game (copyright/trademark). CoD is a look reference you observe — never a source
   of files. Log every asset in `CREDITS.md`.
4. **TypeScript strict.** Clean module boundaries, no dead code, no unjustified `any`.
5. **Deterministic simulation** where it matters: fixed-timestep physics (60 Hz), decoupled
   from the variable-rate render loop via an accumulator.
6. **The Critic Protocol governs quality checks, and it terminates.** Hard cap of **3
   critic→fix cycles per subsystem per milestone**, then backlog residuals. No "loop until
   perfect."
7. **The game is runnable at every checkpoint.** Commit vertical slices; never leave the
   build unable to boot.
8. **Desktop-first** (mouse + keyboard). Touch/mobile FPS is a later, separate problem.

---

## Definition of Done

**Per feature:** implemented, typed, runs at budget, no entries on the jank checklist
(`PLAN.md` §7), and passes the critic rubric for its subsystem (or residuals are backlogged
with justification).

**v1 overall:** one complete playable level with an objective; 2–3 enemy types with working
navmesh AI; a full weapon (ADS, recoil, reload, hit detection); HUD + menus; art + audio pass
complete; all performance budgets green; critic gate passed.

---

## Anti-goals — do NOT do these

- ❌ Try to match a shipped Call of Duty 1:1. Not achievable solo in-browser; it derails the
  loop. Goal is AAA-*feeling* per the measurable bar above.
- ❌ Rip or copy any commercial game's assets, audio, maps, UI, logos, or names. (Rule 3.)
- ❌ Run open-ended "loop until perfect." Respect the 3-cycle cap; backlog residuals.
- ❌ Chase photoreal human faces / mocap-grade facial animation — biggest effort sink, least
  browser payoff. Use stylized-realistic characters + Mixamo animation.
- ❌ Fan out large numbers of subagents on speculative work, or run the critic on every
  micro-edit — both burn credits. Critic runs at milestone checkpoints and on completed
  subsystems only.
- ❌ Block the main thread. Push heavy work (navmesh generation, physics) to Workers / WASM.
- ❌ Skip asset compression — uncompressed textures blow the memory budget and crash real
  hardware.

---

## Agentic workflow (summary — full detail in `PLAN.md`)

- **Parallelize independent subsystems** with subagents (Task tool); **serialize the
  dependency chain**: character controller → weapons → AI combat. (`PLAN.md` §5.)
- **Critic gate per milestone** via `/critic <milestone>`: build → capture screenshots
  (`qa/`) → the `critic` subagent scores them against the rubric → apply **≤ 3** fix passes →
  backlog residuals → commit → advance. (`PLAN.md` §7.)
- **Full milestone plan, acceptance criteria, and asset pipeline:** see **`PLAN.md`**.

---

## Where things live

```
CLAUDE.md              ← you are here (rules)
PLAN.md                ← build plan (stack, subsystems, milestones, critic, assets)
DECISIONS.md           ← stack/architecture change log
CREDITS.md             ← asset license ledger
QUALITY_BACKLOG.md     ← deferred quality issues
.claude/agents/critic.md      ← harsh visual-QA subagent
.claude/commands/critic.md    ← /critic <milestone> gate command
apps/game/             ← Vite + TS + Three.js app (ships as an M0 seed)
packages/              ← shared packages to factor out later (engine, ai, weapons, …)
qa/                    ← Playwright screenshot harness the critic reviews
```
