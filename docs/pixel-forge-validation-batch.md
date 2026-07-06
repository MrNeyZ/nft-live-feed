# Pixel Forge — Validation Batch V1

Status: **design only, no code.** This is the concrete execution of
`pixel-forge-architecture-review.md`'s #1-ranked item: nothing in
Evaluation v2, `RepairPlan`, or (once shipped) Revision V4 has ever been
measured against a real model call. This document designs the instrument
that produces that evidence — not a new pipeline feature, a measurement
harness bolted onto the existing one.

---

## 1. What exactly is a validation batch?

A **validation batch** is one bounded, reproducible run of a fixed prompt
set through the real, already-shipped Pixel Forge pipeline
(`runDrawingJob` / `runRevisionJob` / `buildRepairPlan`, called directly,
no mocking), executed deliberately (never automatically, never
scheduled), under hard cost and scope caps, producing a durable
structured record of objective metrics plus a human-readable summary.

It is a **measurement instrument, not a generation feature.** Its output
is validation-run data, not trait-library assets — batch runs must never
write into `data/pixel-forge/traits/` (see §6). It exists to answer one
question honestly: does the pipeline actually behave the way the design
documents claim, and by how much — not to produce traits anyone keeps.

A batch is identified by a `runId` and a resolved `config` (which prompt
set + version, which model preset, revision policy, hard caps, and — for
comparability — the code state that produced it, see §8). Given the same
prompt set and config, two runs are comparable in aggregate (convergence
rate, regression rate, cost distribution) even though individual model
outputs will differ — LLM non-determinism means you compare
distributions, never single prompts, across runs (see §8's caution).

---

## 2. What should one run include?

**Both a cheap smoke test and a real measurement pass — staged, not
either/or:**

- **Phase A — generation-only smoke test.** Every prompt, fresh
  generation, zero revisions. Cheapest possible run; validates the
  harness itself (does every job complete, parse, and log correctly) and
  gives a first read on raw first-draft quality before spending anything
  on revision rounds. Run this first, always, on a small subset (2–3
  prompts) before committing to a full batch — see §4 and §7.
- **Phase B — generation + up to 2 conditional revisions.** The real
  target. "Conditional" matters: a prompt only proceeds to a revision
  round if the previous round's `RepairPlan` has open issues at all; a
  clean first draft (`overallSeverity: 'none'`) stops at round 0 and
  spends nothing further. This is deliberate, not a shortcut — it directly
  exercises whether the pipeline (and, later, Revision V4) correctly
  recognizes "nothing left to fix" rather than always consuming its full
  round budget, which is itself one of the metrics this batch exists to
  produce (§3, §10).

Each revision round in Phase B calls `runRevisionJob` with the
**previous round's stored `RepairPlan` and empty additional human
instructions** — no typed text. This is a deliberate, important choice:
it's the only way to test, in isolation, whether "revision driven by the
plan alone" (the entire point of Revision V3's design) actually works
without a human quietly compensating for it by typing extra guidance.

Recommended default for the first real batch: **Phase B, capped at 2
revision rounds per prompt**, not more — a prompt that still has open
issues after 2 rounds is recorded as "did not converge within budget"
(a real, meaningful outcome — see §3), not silently given a third
attempt.

---

## 3. Metrics

Three levels, each answering a different question.

### Per-job record (one row per actual API job — one fresh draft or one revision round)

```
runId, promptId, roundNumber (0 = fresh, 1..2 = revision),
jobType: 'fresh' | 'revision',
layerType, canvasSize, modelPreset, actualModel, maxTurnsConfigured,
turnsUsed,                       // count of 'refine'-phase iterations actually consumed
stopped: boolean,                // did the batch harness's own cost/turn cap abort mid-job
failed: boolean, errorCode?,     // API/job failure (classifyAnthropicError's existing codes)
graded: boolean,                 // from TraitDrawResult.graded
tokenUsage: { inputTokens, outputTokens },
estimatedCostUsd,                // pre-job estimate (existing estimateJobCostUsd)
actualCostUsd,                   // computed post-job from real tokenUsage — see §7 on why both matter
recognizableAsSubject: boolean,
overallSeverity: 'none'|'minor'|'major'|'critical',
issueCounts: { critical, major, minor },
openIssueCount, deferredIssueCount,
resolvedCount,                   // issues open last round, absent (matched-resolved) this round —
                                  // computed by the harness diffing round K vs K-1's issue lists;
                                  // no change to buildRepairPlan needed, this is an external diff
                                  // over data it already returns
regressedCount,                  // issues this round flagged with regressed: true
```

### Per-prompt aggregate (across all rounds for one prompt)

```
runId, promptId, category (icon | animal_head | bust),
roundsUsed (0-2), converged: boolean,   // open critical/major issues == 0 by the last round run
finalOverallSeverity, finalRecognizable: boolean,
totalTokens, totalCostUsd (sum across rounds),
anyRegression: boolean, anyStoppedOrFailed: boolean,
```

### Batch-level aggregate (the report, §9)

- Total prompts, total jobs, total tokens, total actual cost vs. total
  pre-estimated cost (the ratio here is itself a critical finding — the
  architecture review already flagged the existing estimator as
  structurally undercounting; this batch is the first real measurement of
  by how much)
- Convergence rate, mean/median rounds-to-converge
- Regression rate (fraction of revision rounds introducing ≥1 regression)
- Severity distribution at round 0 vs. final round
- Recognizability rate at final round
- Stopped-job rate, failed-job rate
- Cost per prompt (mean/median/max)
- All of the above, broken out by category (icon / animal_head / bust) —
  difficulty is very unlikely to be uniform across these three, and
  collapsing them into one number would hide that

**Human approval** is intentionally **not** collected as part of the
automated run — there is no human in the loop during a batch. It's a
separate, lightweight, post-hoc step: after the batch completes, a human
looks at the final PNG for each prompt (already saved under `previews/`,
§6) and records a quick pass/fail/borderline verdict — this is exactly
`pixel-forge-testing-log.md`'s existing manual-verdict process, reused
rather than reinvented, just now fed by objective per-job data instead of
starting from nothing.

---

## 4. How many prompts for the first batch?

**20.** Reasoning, not just the number:

- Below ~15, percentage metrics (convergence rate, regression rate)
  are too noisy to trust — each prompt is a large share of the result.
- 20 is small enough to keep the full batch's cost bounded and estimable
  in advance (see the estimate below), while large enough to see a real
  distribution across three difficulty categories.

**Cost reality check, done explicitly rather than assumed:** using the
existing `estimateJobCostUsd` shape (32px canvas, 8 turns) at Sonnet
pricing, one job (fresh or revision) lands around $0.06–0.09. Twenty
prompts at up to 3 jobs each (worst case, no early stopping) is roughly
60 jobs — **on the order of $4–5 at Sonnet pricing, which is nearly this
entire tool's stated $5 starting budget, in one validation run.** That
is too tight a margin for a first, unproven run of a harness that has
never executed. Two concrete adjustments follow directly from that
arithmetic, not from caution for its own sake:

1. **Run the first batch on the `fast` (Haiku) preset**, not `normal`.
   This batch is validating pipeline *mechanics* (does tiering work, does
   revision consume the plan, do metrics collect correctly, does cost
   stay bounded) — those are model-agnostic questions. Model-*quality*
   comparison (Haiku vs. Sonnet vs. Opus) is a legitimate later batch,
   not this one. Haiku pricing is roughly half of Sonnet's, bringing the
   worst-case full batch to roughly $2–2.50.
2. **Always run a 2–3 prompt dry run on `fast`, Phase A only, before the
   full batch** — proving the harness itself has no bugs (crashes,
   mis-parsed records, a cap that doesn't trip) before committing real
   spend to the full 20-prompt run. This is cheap (well under $0.50) and
   directly protects the larger spend that follows it.

**Smoke-test-tier convention** (formalized in
`docs/pixel-forge-token-cost-audit.md` §5 — this is a standing operator
convention, not new code; every flag it names already exists on the CLI):
a **smoke test** is `--model fast` + a small `--max-prompts` (2–3) + a
`--max-turns` well under the preset default, always `--dry-run` first.
`--model normal`/`premium`, the full 20-prompt set, or the preset-default
`--max-turns` constitute a **quality-benchmark run** — a deliberate,
explicitly-approved spend, never the default for a routine pipeline check.

---

## 5. Prompt set — first 20-prompt suite

Three categories, chosen to match this project's own already-established
testing taxonomy (`pixel-forge-recognizability-design.md`'s Stage 1
geometric icons / Stage 2 simple living things, extended here with a
bust category since the brief asks specifically for icons/heads/busts).
Every prompt is deliberately generic — no named existing character or
IP, per that same document's own explicit hygiene note (its "nyan cat"
test prompt named a real meme character, which it flagged afterward as a
mistake worth not repeating).

| id | category | layerType | canvas | prompt |
|---|---|---|---|---|
| icon-heart | icon | icon | 32 | a red heart, centered, thick dark outline, simple pixel art |
| icon-star | icon | icon | 32 | a five-pointed yellow star, centered, thick dark outline, simple pixel art |
| icon-skull | icon | icon | 32 | a white skull icon, centered, dark eye sockets, simple pixel art |
| icon-shield | icon | icon | 32 | a small round shield icon, metallic gray, red cross emblem, centered |
| icon-potion | icon | icon | 32 | a small potion bottle icon, round base, red liquid, cork stopper, centered |
| icon-crown | icon | icon | 32 | a gold crown icon, three points, centered, simple pixel art |
| icon-lightning | icon | icon | 32 | a yellow lightning bolt icon, centered, thick dark outline |
| head-cat | animal_head | icon | 32 | a gray cat head, centered, pointed ears with an inner notch, small triangular nose, whiskers, simple pixel art |
| head-dog | animal_head | icon | 32 | a brown dog head, centered, floppy ears, black nose, simple pixel art |
| head-fox | animal_head | icon | 32 | an orange fox head, centered, pointed ears, white cheek markings, black nose, simple pixel art |
| head-owl | animal_head | icon | 32 | a brown owl head, centered, large round eyes, small hooked beak, simple pixel art |
| head-frog | animal_head | icon | 32 | a green frog head, centered, bulging round eyes on top of the head, wide mouth, simple pixel art |
| head-bear | animal_head | icon | 32 | a brown bear head, centered, small round ears, black nose, simple pixel art |
| bust-wizard | bust | body | 32 | a bearded wizard bust, pointed blue hat, gray beard, centered, simple pixel art |
| bust-knight | bust | body | 32 | a knight bust, gray metal helmet with a narrow eye slit, centered, simple pixel art |
| bust-pirate | bust | body | 32 | a pirate bust, red bandana, black eyepatch, centered, simple pixel art |
| bust-viking | bust | body | 32 | a viking bust, horned helmet, orange beard, centered, simple pixel art |
| bust-robot | bust | body | 32 | a robot head-and-shoulders bust, boxy metal head, single round eye lens, centered, simple pixel art |
| bust-ninja | bust | body | 32 | a ninja bust, black hood covering the lower face, narrow eyes visible, centered, simple pixel art |
| bust-explorer | bust | body | 32 | an explorer bust wearing a wide-brimmed tan hat, centered, simple pixel art |

Stored as its own versioned file, e.g.
`data/pixel-forge/validation-runs/prompt-sets/icons-heads-busts-v1.json`
— never inlined into a run's config, so multiple runs can reference the
identical set by name + version (required for §8's comparisons to mean
anything).

---

## 6. Storage layout

```
data/pixel-forge/validation-runs/
  prompt-sets/
    icons-heads-busts-v1.json        # the table in §5, versioned, reused across runs
  <runId>/                            # e.g. 2026-07-05T18-30-00_batch01
    config.json                       # resolved batch config — prompt set+version, model
                                       # preset, revision policy, hard caps, git SHA + a
                                       # human-entered pipelineVersion label (§8)
    jobs.jsonl                         # one line per job — the §3 per-job record, append-only
    prompts.jsonl                      # one line per prompt, written/updated as each completes
    report.md                         # generated summary — §9
    previews/
      <promptId>-round0.png
      <promptId>-round1.png
      ...
```

**JSONL, not one-file-per-record and not a database, deliberately:**
append-only means a killed/crashed run leaves a fully valid, parseable
partial result (every line written so far is a complete record) — no
"transaction" to roll back, no corruption from a partial write the way a
single large mutable JSON file could suffer. Trivially greppable/`jq`-able
without any tooling. Matches the existing project convention (flat files,
atomic writes) without a database migration.

**Markdown for the report**, matching `pixel-forge-testing-log.md`'s
existing convention exactly rather than inventing a second reporting
style. The batch script should also **append a short linked entry** to
that same file (date, run id, prompt-set version, one-line headline
result) so it stays the single chronological index of "what's been
tested," with the heavy per-job data living in `data/...`.

**Validation runs never touch `data/pixel-forge/traits/`.** The harness
calls `runDrawingJob`/`runRevisionJob`/`buildRepairPlan` directly — the
same exported functions the HTTP routes call — but never
`saveTraitAsset`/`updateTraitAsset`, and needs no HTTP layer, no
`requireAuth`, no server process at all. Between rounds, the script holds
the running pixel/palette/RepairPlan state in its own memory (exactly
what `tools-pixel-forge.ts`'s route handlers already do between an HTTP
request and the next) and only touches disk to append the JSONL records
and preview PNGs. Reasons this matters, stated plainly: keeps the real,
human-curated trait gallery free of test junk; and does not add to the
architecture review's already-flagged "full directory scan on every list
call" scalability problem by dumping dozens of throwaway records into the
directory that problem is about.

---

## 7. Avoiding runaway cost — hard caps

Layered, checked at the finest grain that's actually cheap to check:

- **`maxJobsPerRun`** — hard ceiling on total jobs in one batch (default
  70 — 20 prompts × up to 3 jobs, plus small margin). The harness refuses
  to start job #(maxJobsPerRun + 1) unconditionally.
- **`maxRevisionsPerPrompt`** — default 2 (§2). Never exceeded regardless
  of how many issues remain open; a prompt that hits the cap is recorded
  as not-converged, not given another round.
- **`maxTurnsPerJob`** — default 6–8 for validation runs specifically
  (smaller than the existing `HARD_MAX_TURNS=15` ceiling, which still
  applies underneath as the absolute backstop). Keeping this low for
  validation runs bounds per-job cost tightly and is fine for this
  purpose — the batch is measuring convergence/regression behavior, not
  chasing maximum polish.
- **`maxEstimatedCostPerRun`** (default **$3.00** for the first Haiku
  batch) — checked *before every job starts*: if running-total estimated
  cost plus this job's pre-estimate would exceed the cap, the batch
  aborts immediately without starting that job. Checked per-job, not
  per-prompt, so the abort happens as early as possible.
- **`stopOnCostThreshold`** (a second, post-hoc check) — because the
  architecture review already found the existing cost estimator
  structurally undercounts (image-token growth is quadratic in turn
  count, the estimator assumes linear), the harness must *also* track
  real cumulative cost from actual returned `tokenUsage` after every
  completed job, and abort the remainder of the batch if that real total
  crosses the same cap — independent of what the pre-job estimates said.
  This two-tier check exists specifically because the two numbers are
  already known to disagree; whichever trips first wins.
- **`--estimate-only` dry mode** — prints the full projected cost for the
  configured batch (every planned job at max rounds, summed) with zero
  API calls, so a human explicitly confirms before spending anything.
  This is the batch-level version of the existing per-job
  `estimateJobCostUsd` console log, just aggregated and gated behind a
  human look before real spend starts.
- **No automatic retries beyond a small bounded count.** A job that fails
  outright is recorded failed and the batch moves to the next prompt —
  never retried in a loop (a systemic failure, e.g. a bad API key, must
  never turn into unbounded spend). The one exception: `anthropic_rate_limited`
  / `anthropic_overloaded` (already-classified error codes) get up to 2
  bounded, backed-off retries before being recorded as failed — real
  transient conditions shouldn't tank an entire batch, but the retry
  count itself is capped, not open-ended.
- **Graceful interrupt** — the harness should tolerate being killed
  (Ctrl-C) at any point and leave a valid partial `jobs.jsonl`/`prompts.jsonl`
  behind, a direct consequence of the append-only JSONL choice in §6, not
  extra work.

---

## 8. Comparing before/after changes

- **Prompt-set identity is the precondition for any comparison.**
  Two runs are only meaningfully comparable if they reference the exact
  same `prompt-sets/<name>-v<N>.json`. A comparison across different
  prompt-set versions should be flagged, loudly, not silently computed.
- **Every run's `config.json` records both an objective and a readable
  marker of what code produced it**: the current git commit SHA
  (cheap, automatic, unambiguous) *and* a short human-entered
  `pipelineVersion` label (e.g. `"revision-v3-baseline"`,
  `"revision-v3+v4"`, `"v3+phase1-principles"`) — the SHA is precise but
  meaningless to skim; the label is exactly the opposite; keep both.
- **A comparison report** takes two run directories (same prompt-set
  version) and produces a small markdown table: each batch-level metric
  from §3, side by side, with a delta column. No new tooling beyond what
  §6 already produces — this is a second, much smaller pass over the same
  `prompts.jsonl` shape from two runs.
- **Trust distributions, not individual prompts, across runs** —
  restating `pixel-forge-recognizability-design.md`'s own discipline
  ("promote a rule only after recurring evidence, not a single run")
  applied here to interpretation: "regression rate dropped from 35% to
  10%" is a real signal; "prompt `head-fox` needed one more issue this
  time" is noise on a 20-prompt sample and should not drive a decision on
  its own.

The first genuinely useful comparison this design enables: **run Phase B
once now, on current (V3-only, pre-V4) code, labelled
`"revision-v3-baseline"` — that becomes the baseline every future
Revision V4 (and Phase 1, and anything else revision-shaped) claim gets
checked against, instead of resting on the design documents' own
say-so.**

---

## 9. Reports

- **Per-run `report.md`** (generated, not hand-written): batch config
  summary (prompt set + version, model preset, caps, estimated vs. actual
  cost), the full batch-level aggregate table from §3, a per-prompt table
  (id, category, rounds used, converged?, final severity, cost,
  regression?), and a short "notable failures" section listing any
  failed/stopped jobs and any regression, for fast human scanning.
- **A linked one-line entry appended to `pixel-forge-testing-log.md`** —
  date, run id, prompt-set version, one-line headline result (e.g.
  "convergence 65%, regression rate 30%, Haiku, 20 prompts") — keeping
  that file the single chronological index it already is.
- **A comparison report** (§8) whenever two same-prompt-set runs exist.
- **Explicitly not building for v1:** any HTML/dashboard/live-updating
  report — markdown only, per the no-new-UI constraint. Because the
  underlying data is structured JSONL from the start, nothing here blocks
  building a dashboard later directly off these files, with zero
  re-instrumentation — a deliberate, low-cost hedge, not a promise to
  build one.

---

## 10. What counts as success or failure?

Two different questions, deliberately kept separate:

**Did the harness do its job?** (mechanical success) — completed without
crashing, never exceeded any hard cap, every job produced a
schema-conformant record, the report generated correctly. If actual cost
blew past the pre-run estimate by a wide margin, that is not a harness
failure — it's the single most important finding the first batch could
produce, direct confirmation (or refutation) of the architecture review's
quadratic-cost-growth claim.

**What do the first batch's *results* mean for Pixel Forge itself?**
— not a fixed pass/fail bar, evidence that informs the next decision:

- **Convergence rate** (prompts reaching zero open critical/major issues
  within 2 rounds): below ~50% points to something structurally wrong,
  worth stopping and investigating before any further prompt/revision
  feature work; 50–80% says the pipeline is workable but exactly matches
  why Phase 1 principles and Revision V4 were already prioritized; above
  ~80% would suggest the pipeline is already in good enough shape to
  reconsider paused feature work sooner than planned.
- **Regression rate** (fraction of revision rounds introducing ≥1
  regression): this is the number Revision V4 exists to fix. A genuinely
  possible, and worth-stating-honestly, outcome: if this number is
  already low without V4, that's a real, surprising finding worth
  re-examining V4's priority against — the batch's job is to test that
  assumption, not assume it's already confirmed. If it's high (>25–30%),
  that confirms the premise and argues for shipping V4 promptly, with
  numbers instead of anecdotes behind the decision.
- **Recognizability rate** (`recognizableAsSubject` at final round): low
  here points back toward better generic/subject-specific guidance
  (Phase 1, and the still-deferred Stage 2+ work in
  `pixel-forge-recognizability-design.md`), not toward more
  revision-mechanism engineering — a different bottleneck than the one
  V4 targets, and this batch is what would tell the two apart.

---

## Final recommendation

**Yes — implement Validation Batch before any further prompt or revision
work, exactly as the architecture review ranked it.** It's cheap (one
script, no new infrastructure, no schema changes to anything shipped),
and it's the only thing that turns every open question left by
Evaluation V3, Revision V4, and the architecture review itself — does
revision converge, does it regress, is the cost model even accurate —
from a design-document claim into a number. Nothing proposed here creates
new UI, a database, a new provider, or touches Reference Packs/Style
Packs. Run the dry run, then the real 20-prompt batch, before deciding
what (if anything) gets built next.
