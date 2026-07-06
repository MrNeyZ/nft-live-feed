# Pixel Forge — Recognizability Testing Log

Manual testing log for the Tier-1 recognizability changes (generic
system-prompt paragraph + `missingFeatures` on evaluation). Plain
markdown, not a schema — fill in a row per test run, no tooling required.

Process: generate → read `missingFeatures` + the render → give your own
manual verdict (pass/fail/borderline) independent of what the model's
evaluation claimed → if it fails and generalizes beyond this one prompt,
note the lesson in the "notes" column. Only promote something out of this
log into a real prompt/schema change if the same failure recurs across
multiple prompts in a stage, not from a single example (avoid overfitting
to one run).

## Stage 1 — Simple geometric icons

Subjects: heart, star, skull, crown, mushroom.

Goal: baseline construction competence on shapes with mostly geometric
defining features (point count, symmetry, discrete parts) — isolates pure
construction failures from semantic-feature failures before Stage 2.

| Date | Prompt | Canvas | Preset | Model `missingFeatures` | Manual verdict | Notes / generalizable lesson |
|---|---|---|---|---|---|---|
| | | | | | | |

## Stage 2 — Simple living things

Subjects: cat, dog, frog, fish, bird.

Goal: this is the actual failure class that motivated this phase (the
"nyan cat" run). Validates whether the generic recognizability paragraph
alone is enough, without a category-specific library.

| Date | Prompt | Canvas | Preset | Model `missingFeatures` | Manual verdict | Notes / generalizable lesson |
|---|---|---|---|---|---|---|
| | | | | | | |

## Reading the results

- **Manual verdict disagrees with the model's own evaluation booleans**
  (e.g. `cleanSilhouette: true` but you'd call it a fail) → the strongest
  signal that the harsh-grading instructions still aren't strict enough;
  worth another prompt-wording pass before anything structural.
- **`missingFeatures` is empty but you still don't recognize the subject**
  → the model isn't applying the recognizability paragraph at all; check
  whether it's being read/followed, not whether it needs more detail.
- **`missingFeatures` correctly names the gap** → the mechanism is working;
  use the "Copy for revision" button in the UI and confirm a revision using
  that exact text actually fixes it.
- Recurring, *specific* failure patterns across ≥3 prompts in a stage are
  the bar for considering anything from Tier 2 of the design review
  (`docs/pixel-forge-recognizability-design.md`) — not a single bad run.

Stages 3 (wearables) and 4 (compositions) are described in
`docs/pixel-forge-recognizability-design.md` — add their own tables here
once Stage 1–2 evidence says it's worth continuing down that path.

- 2026-07-05 — run `2026-07-05_003` — icons-heads-busts v1, fast, 2 prompts — convergence 50%, regression 100% — see `data/pixel-forge/validation-runs/2026-07-05_003/summary.md`

- 2026-07-05 — run `2026-07-05_004` — icons-heads-busts v1, fast, 2 prompts — convergence 50%, regression 50% — see `data/pixel-forge/validation-runs/2026-07-05_004/summary.md`

- 2026-07-05 — run `2026-07-05_006` — icons-heads-busts v1, fast, 2 prompts — convergence 100%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_006/summary.md`

- 2026-07-05 — run `2026-07-05_007` — icons-heads-busts-animal-bust-subset v1, fast, 2 prompts — convergence 0%, regression 50% — see `data/pixel-forge/validation-runs/2026-07-05_007/summary.md`

- 2026-07-05 — run `2026-07-05_010` — icons-heads-busts v1, fast, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_010/summary.md`

- 2026-07-05 — run `2026-07-05_011` — icons-heads-busts v1, fast, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_011/summary.md`

- 2026-07-05 — run `2026-07-05_012` — icons-heads-busts v1, fast, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_012/summary.md`

- 2026-07-05 — run `2026-07-05_013` — revision-smoke-2prompt v1, fast, 1 prompts — convergence 100%, regression 0% — **ABORTED** — see `data/pixel-forge/validation-runs/2026-07-05_013/summary.md`

- 2026-07-05 — run `2026-07-05_014` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 100%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_014/summary.md`

- 2026-07-05 — run `2026-07-05_015` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 100%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_015/summary.md`

- 2026-07-05 — run `2026-07-05_017` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_017/summary.md`

- 2026-07-05 — run `2026-07-05_018` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_018/summary.md`

- 2026-07-05 — run `2026-07-05_019` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_019/summary.md`

- 2026-07-05 — run `2026-07-05_020` — sonnet-benchmark-5prompt v1, normal, 5 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-05_020/summary.md`

- 2026-07-05 — run `2026-07-05_021` — sonnet-benchmark-4prompt-revisions v1, normal, 4 prompts — convergence 25%, regression 50% — see `data/pixel-forge/validation-runs/2026-07-05_021/summary.md`

- 2026-07-05 — run `2026-07-05_022` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 100% — see `data/pixel-forge/validation-runs/2026-07-05_022/summary.md`

- 2026-07-06 — run `2026-07-06_001` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-06_001/summary.md`

- 2026-07-06 — run `2026-07-06_002` — sonnet-revision-smoke-bust-wizard v1, normal, 1 prompts — convergence 0%, regression 0% — see `data/pixel-forge/validation-runs/2026-07-06_002/summary.md`
