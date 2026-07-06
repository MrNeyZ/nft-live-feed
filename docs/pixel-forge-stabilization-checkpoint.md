# Pixel Forge — Stabilization Checkpoint

Status: **checkpoint only — no code, no API calls, no deploy, no PM2
restart, no validation run triggered by this document.** Snapshots where
the pipeline stands after a run of small, evidence-driven fixes, each
traced back to a specific paid run that exposed the problem it fixes.

---

## 1. What was fixed

- **Token/cost estimator** (`agent-loop.ts` — `estimateJobCostUsd` /
  `estimateJobTokenUsage` / `estimateJobCallBreakdown`) — recalibrated
  against real per-call usage after the original estimate significantly
  undercounted actual spend.
- **Draft-array redaction** — a fresh draft's raw pixel array (the
  dominant cost driver for draft jobs) is stripped from message history
  immediately after being consumed into the `Canvas`, replaced with a
  short placeholder, instead of being resent in full on every subsequent
  refine turn.
- **Per-call logging** (`[pixel-agent] job usage` / `revision usage`
  console output, plus the per-call usage table in every run's
  `summary.md`) — added so estimator accuracy and turn-over-turn cost
  growth could actually be measured instead of assumed.
- **Runtime validation of the draft submission** (`agent-loop.ts:1087`) —
  a submitted `pixels` array with the wrong length is clamped/padded
  rather than the job being discarded; a pixel value outside the palette
  range still throws. Schema `minItems`/`maxItems` is a hint, not an
  API-enforced guarantee.
- **Synthetic-recognizability invariant** (`repair-plan.ts` —
  `SYNTHETIC_RECOGNIZABILITY_ISSUE_ID`) — if an evaluation returns
  `recognizableAsSubject: false` with an empty `issues` array (the
  evaluator failing to itemize its own negative verdict), a repair plan
  now synthesizes one critical issue instead of silently producing an
  empty, un-actionable repair plan.
- **No-edit revision warning** (`pixel-forge-validation.ts` —
  `detectNoEditRevisionWarning`) — flags any revision round that started
  with open issues but made zero refine-phase tool calls, so
  "convergence" that only happened because the evaluator's own grade
  drifted (nothing was actually edited) is never silently trusted the
  same as a round backed by real edits.
- **Thinking disabled for refine calls** (`agent-loop.ts:901` —
  `thinking: { type: 'disabled' }`) — Sonnet 5 defaults to adaptive
  thinking when the `thinking` param is omitted (unlike Opus 4.7/4.8);
  with `tool_choice: auto`, a turn could spend its entire `max_tokens`
  budget on a thinking block and never reach a `tool_use` block. Raising
  `max_tokens` didn't help — thinking shares the same budget rather than
  having its own. Disabling it removes the stall instead of deferring it.
- **DONE WHEN verification gate** (`buildRevisionSystemPrompt`) — before
  stopping, the model must compare the current render against each open
  issue's own "done when" text and either make one more safe edit or
  explicitly leave the issue unresolved, rather than declaring a round
  complete because it explained the intended fix.
- **Tool-result bbox feedback** (`tools.ts` — `diffSummary`/`withDiff`) —
  every mutating tool call now returns the actual changed-pixel bounding
  box (`"changed N px; affected bbox x=..,y=.."`) instead of a bare
  `"ok"`, so the model can confirm where an edit actually landed instead
  of re-deriving it from the next re-render.
- **Hair/beard shape vocabulary** (`buildSystemPrompt` +
  `buildRevisionSystemPrompt`) — a short static rule: hair/fur/eyebrows/
  beards must not be flat-edged rectangles or solid blocks (reads as
  cloth/collar/scarf); build a jagged/tapered/stepped boundary instead,
  e.g. stacked `fill_rect` calls of decreasing width or a few broken
  boundary pixels.
- **Bust prompt-set `layerType` correction**
  (`icons-heads-busts-v1.json`) — all 7 `bust`-category prompts changed
  from `layerType: "body"` to `layerType: "icon"`. `category` (reporting
  only) is unchanged; `layerType` is what actually reaches the model, and
  `"body"` was pushing it toward a torso-only interpretation that
  actively conflicts with head/face-dominant bust prompts.

---

## 2. Which paid runs informed each fix

| Run id(s) | One-line lesson |
|---|---|
| `2026-07-05_003`, `_004`, `_006`, `_007` | Original token/cost audit — text (system prompt, tool schemas, the draft's own raw pixel array), not images, is the dominant per-call cost driver. |
| `2026-07-05_011` | Recalibrated estimator confirmed against real per-call usage once per-call logging existed to check it against. |
| `2026-07-05_003` | Icon-heart trait: a revision resolved its target issue but silently deleted a clean outline nothing asked it to touch (major→critical) — the regression Revision V4's surgical rules, including the DONE WHEN gate, were written to stop. |
| `2026-07-05_015`, `_017`, `_018` | Refine turns stalling at `stopReason: "max_tokens"` with zero tool calls, entire budget spent on an adaptive `thinking` block — root-caused to Sonnet 5's thinking-on-by-default behavior; also the first observed instances of the no-edit-revision pattern the validator now flags automatically. |
| `2026-07-05_022` | Coordinate-grounding audit: the model had no way to confirm where an edit actually landed and re-derived it from the next render, turning one misplaced beard into two full guess/undo cycles — motivated the bbox tool-result feedback. |
| `2026-07-06_001` | Beard placement was correct (bbox feedback working — no guess/undo cycles) but the beard itself rendered as a flat-topped, uniform-color rectangle that read as a collar/scarf, not hair — motivated the shape-vocabulary rule. |
| `2026-07-06_002` | Smoke test meant to re-check the beard rule instead surfaced a different bug: `layerType: "body"` on a bust prompt caused the model to skip the head/face/hat/beard entirely and draw an abstract torso/collar shape — also the first live occurrence of the synthetic-recognizability invariant (`recognizableAsSubject=false`, `issues=[]`). Cross-checked against `2026-07-05_020`, `_021`, `_007`, which show the same `body`/bust tension causing inconsistent (not deterministic) head-omission across earlier runs too. |

---

## 3. Current known remaining risks

- **Revision quality is still not benchmarked broadly** — evidence so far
  is a handful of single-prompt smoke tests, not a multi-prompt,
  multi-category sample.
- **Shape vocabulary is still minimal** — only hair/fur/beard is covered;
  eyes, ears, and shoulders/robe silhouettes have no equivalent
  construction rule yet.
- **The evaluator can be strict or stochastic run to run** — the same
  prompt/config has produced both full recognizable busts and totally
  abstract, unrecognizable shapes across different rollouts.
- **`flood_fill` can still overspill** through an unclosed outline and
  wipe an entire canvas/background in one call — observed more than
  once, not specifically hardened by any fix above.
- **The bust prompt-set `layerType` correction is unmeasured** — it fixes
  a demonstrated conflict, but no paid run has yet confirmed it actually
  produces consistent full-bust output across multiple bust prompts.
- **Cost:** Sonnet (`normal` preset) with one revision round runs
  roughly **$0.15–$0.25 per prompt** in the runs so far.

---

## 4. Recommended next paid benchmark (when budget is available)

```
npm run pixel-forge:validate -- \
  --model normal \
  --max-prompts 4 \
  --max-revisions 1 \
  --max-turns 4 \
  --cost-limit 0.90 \
  --prompt-file data/pixel-forge/validation-runs/prompt-sets/icons-heads-busts-v1.json
```

- 4 prompts, Sonnet `normal`, `maxRevisions 1`, `maxTurns 4`,
  `costLimit` 0.90–1.00.
- Use the now-corrected `icons-heads-busts-v1.json` (all 7 `bust`
  entries are `layerType: "icon"`).
- `--max-prompts 4` takes the first 4 prompts in file order, which today
  means 4 `icon`-category entries, not a single corrected `bust` prompt —
  **worth curating a 4-prompt subset that actually includes at least 2
  `bust` entries** (e.g. `bust-wizard`, `bust-knight`, plus 2 controls)
  so this run can speak to both the `layerType` fix and the shape-
  vocabulary rule at once, the same way the prior single-prompt temp
  files were built.
- **Stop after analysis** — no further fixes without a hard crash, no
  deploy, no PM2 restart.

---

## 5. Do NOT run anything now

This document is a checkpoint only. No command above has been executed as
part of producing it.
