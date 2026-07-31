# OPERATOR — browser FPS (agentic-build starter)

A monorepo starter for building a single-player, modern-military FPS in the browser with
Three.js, driven agentically by Claude Code. **This repo is the spec + scaffold; Claude Code
builds the game from it.**

## Layout

| Path | What |
|---|---|
| `CLAUDE.md` | Always-loaded working agreement (the rules). |
| `PLAN.md` | The build plan: tech stack, subsystem fan-out, milestones, critic protocol, asset pipeline. |
| `DECISIONS.md` | Stack/architecture change log. |
| `CREDITS.md` | Asset license ledger. |
| `QUALITY_BACKLOG.md` | Deferred quality issues from the critic. |
| `.claude/agents/critic.md` | The harsh visual-QA subagent. |
| `.claude/commands/critic.md` | The `/critic <milestone>` gate command. |
| `apps/game/` | Vite + TypeScript + Three.js app. Ships as an **M0 seed** (boots a lit scene + stats overlay). |
| `packages/` | Shared packages to factor out later (engine, ai, weapons, …). |
| `qa/` | The Playwright screenshot harness the critic reviews. |

## Prerequisites

- Node 20+ and **pnpm** (`corepack enable`).

## Smoke test (do this before handing it to Claude Code)

```bash
pnpm install
pnpm --filter @operator/game dev      # open http://localhost:5173
```

You should see a lit greybox scene (ground + a row of coloured boxes, casting shadows) with a
stats overlay in the top-left. If it renders at a healthy frame rate, you're good.

Then start Claude Code — the suggested first prompt is at the bottom of `PLAN.md`.

## Visual-QA gate (manual)

```bash
pnpm --filter @operator/qa exec playwright install chromium   # once per machine
pnpm --filter @operator/game build
pnpm --filter @operator/game preview &                        # serves :4173
BASE_URL=http://localhost:4173 LABEL=M0 pnpm --filter @operator/qa run shoot
```

Screenshots land in `qa/shots/M0/`. In Claude Code, **`/critic M0`** automates all of this
and runs the `critic` subagent against the shots.

## Honest caveats

- **Versions:** the `package.json` files pin recent-but-fixed versions; this starter was
  authored offline and **not installed or run** in the environment that produced it. Run
  `pnpm install` first, and let Claude Code bump/verify — `three` especially (target the
  latest r18x). Log any change in `DECISIONS.md`.
- **Seed markers:** `apps/game/src/main.ts` has a few `NOTE:` comments where an API is
  best-effort (shadow enable, backend-name detection). Confirm/fix these during M0 — they're
  trivial.
- **Headless WebGPU** is flaky; the QA harness falls back to WebGL2 automatically (a valid
  render path). For true-WebGPU captures, run the harness headed under xvfb in CI.
- **Assets:** none bundled. Source only CC0/licensed assets (`PLAN.md` §8) and never ingest
  ripped commercial-game assets. Track every asset in `CREDITS.md`.
