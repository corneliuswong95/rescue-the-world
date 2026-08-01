---
description: Visual-QA critic gate for a milestone — build, capture screenshots, review against the rubric, apply ≤3 fix cycles, backlog residuals.
argument-hint: <milestone e.g. M4>
---

Run the OPERATOR critic gate for milestone **$1** (PLAN.md §7). This gate terminates: **max 3
critic → fix cycles**, then backlog residuals and move on.

1. Build the game: `pnpm --filter @operator/game build`.
2. Ensure a preview server is serving `apps/game/dist` on :4173 (`pnpm --filter @operator/game
   preview`), then capture screenshots:
   `cd qa && BASE_URL="http://127.0.0.1:4173/?webgl=1" LABEL=$1 pnpm run shoot`
   (The `?webgl=1` forces the stable WebGL2 backend for headless capture.)
3. Launch the **critic** subagent to review `qa/shots/$1/` against the rubric and return scored,
   concrete defects.
4. Apply fixes for the top defects, rebuild, re-capture, re-review — **at most 3 cycles**.
5. Anything unresolved after 3 cycles → `QUALITY_BACKLOG.md` with a screenshot + defect note.
6. Report the final rubric mean, budget status, and PASS/FAIL, then commit.
