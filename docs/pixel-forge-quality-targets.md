# Pixel Forge — Quality Targets

Status: **design only, no code.** This document defines what "good" means
for Pixel Forge, in numbers, so that `pixel-forge-validation-batch.md`'s
output can be judged against something instead of just described. It is
meant to outlive the current implementation: the dimensions and framework
here should still be the right ones after Revision V4, Phase 1, and a
Reference System have all shipped and been replaced by whatever comes
after them. The *numbers* attached to each dimension are explicitly not
that durable — see the closing self-critique for exactly which ones to
expect to revise.

---

## 1. Why quality targets are necessary

`pixel-forge-validation-batch.md` produces distributions: convergence
rate, regression rate, cost per prompt, severity breakdowns. A number
alone answers nothing. "Convergence rate 65%" is not good or bad until
something says what it should be — and without that reference point,
every reading of a validation report degenerates into someone eyeballing
whether a number "feels okay," which is exactly the unreliable,
non-reproducible judgment this whole stabilization phase exists to move
away from. This project has already lived through the cost of that: a
human approved a trait whose self-evaluation explicitly said it failed —
not because the number lied, but because there was no stated target for
"how good is good enough" to check it against.

Targets solve four specific problems raw metrics can't:

- **They convert measurement into decision-making.** Without a target, a
  batch produces a description; with one, it produces a verdict (ship
  it / fix it / investigate it) — the actual reason to run a batch at
  all.
- **They let dimensions be judged against their own difficulty**, not a
  single uniform bar. Recognizing a specific named subject is inherently
  harder than not leaving stray pixels; a single "quality" threshold
  applied to both would be meaningless for at least one of them.
- **They provide a stop condition.** Without stated targets, validation
  batches can run forever, accumulating numbers, without ever forcing a
  go/no-go call on a feature.
- **They prevent moving the goalposts after the fact.** A target written
  down *before* a batch runs can't be quietly redefined once the result
  is in — the single most common way a measurement program loses its own
  credibility.

---

## 2. Quality dimensions

Fifteen dimensions, grouped into four clusters. Each states what it
measures, why it matters, and how it should be measured *today*, inside
the current architecture — the measurement approach is expected to
evolve; the dimension itself should not.

### Core artistic quality

**Recognizability** — does the output read as the *specific* requested
subject, not merely something generic in its class. Matters because this
is the best-documented real failure mode this project has (a stored,
real trait was approved despite its own self-grade saying it wasn't
recognizable as the specific requested character). Measured today via
`recognizableAsSubject` plus periodic human spot-checks against the same
output, to calibrate whether the self-grade can be trusted at all (see
"Evaluator trust" below).

**Prompt fidelity** — distinct from recognizability: does the output
match the *literal* requested attributes (color, requested accessory,
layer type) regardless of whether a specific named identity is even in
play (a plain "red heart" has no "identity" to recognize, but still has
a color to get right). Matters because a generation can be recognizable
as its general category while still ignoring what was actually asked
for. Measured via evaluator-flagged `trait_specific`/general issues today;
mechanically cross-checkable in some cases (is the requested color
actually present in the palette).

**Silhouette quality** — is the shape construction clean and unambiguous
at native resolution. Matters because it's foundational — palette and
hierarchy are decoration on top of a shape, and no amount of good color
choice saves a broken outline. Measured via the `silhouette` issue
category today.

**Rendering cleanliness / technical hygiene** — no stray pixels,
transparency preserved, no off-palette values, nothing out of bounds.
Matters as the floor: necessary but not sufficient, and the one dimension
that is nearly deterministic to check (it's a factual question, not a
judgment call), so it deserves the tightest, least-forgiving targets of
any dimension in this document (see §3).

**Palette discipline** — ramp structure, hue-shift correctness, color
economy, outline consistency. Matters because it's the dimension most
directly targeted by work that hasn't shipped yet (the generic
construction principles) and is currently the least-addressed dimension
in the live prompt. Measured partly mechanically (ramp length, hue-shift
presence are simple color-space arithmetic, not judgment calls) and
partly via evaluator-flagged `palette`/`hue_shift`/`outline` issues.

**Style consistency** — do independently-generated traits share a
coherent visual language suitable for one collection. Matters enormously
at collection scale, and today has **no real measurement mechanism at
all** — there is no cross-trait comparison in the current architecture.
Included here because it matters, not because it's currently
measurable; see §5 for why it's ranked low priority to *act on* right
now despite being conceptually important.

### Repair / process quality

**Repair effectiveness** — when a revision targets a specific issue, does
it get resolved without collateral damage. This is the entire premise
`RepairPlan` and Revision V4 were built around. Measured via the already-
designed resolved/regressed classification, per round.

**Revision efficiency** — how many rounds/turns/tokens to reach zero open
critical/major issues. Matters as a direct cost and workflow-speed
concern independent of whether convergence eventually happens. Measured
via rounds-to-converge and turns-per-round, both already specified in
the validation batch design.

**Revision stability** — across *multiple* rounds on the same trait, does
quality move monotonically better, or oscillate (fix one thing, break
another, "fix" that back, break the first again). Distinct from
single-round repair effectiveness — a pipeline can look fine round-to-
round and still never actually settle. Measured via regression-rate trend
across rounds 1→2 on the same trait, not just presence/absence in one
round.

**Loop rate (non-convergence rate)** — the fraction of prompts that hit
the revision-round cap without ever reaching zero open critical/major
issues. Distinct from a stopped/failed job (an operational failure) —
this is the repair loop trying and running out of budget, a design-level
signal about whether the round cap and escalation logic are well-tuned.

### Operational

**Cost efficiency** — dollar/token cost *per converged trait*, not per
job (a trait needing three rounds costs three times a trait needing one,
and the metric should reflect that). Matters as a hard, real constraint
today and remains relevant at any future scale, since cost scales with
collection size.

**Latency** — wall-clock time from job start to a converged (or capped)
result. Matters for workflow usability independent of dollar cost — a
technically cheap trait that takes fifteen minutes of wall-clock time is
still a bad experience for iterating on a collection. **Not currently
measured at all** — no timestamp is captured anywhere in the existing
design. This should be added to the validation batch's per-job record as
a near-zero-cost addition; every latency target in §3 is provisional
until it is.

**Stopped/failed-job rate** — how often a job is aborted (cap) or fails
outright (API error). An operational reliability signal, not an artistic
one — distinct from loop rate, which is a *design* failure to converge
within budget, not an *infrastructure* failure.

### Trust (governs whether the other twelve numbers mean anything)

**Human approval rate** — the fraction of candidates a human actually
approves. The only non-self-graded checkpoint in the entire system, and
therefore the ultimate arbiter every other metric is implicitly answering
to. If self-graded metrics look good while approval rate stays low, that
is not a contradiction to resolve in approval rate's favor — it's
evidence the self-graded metrics are miscalibrated.

**Evaluator trust / self-grade calibration** — how well the self-graded
evaluation (severity, recognizability, issue detection) matches
independent human judgment on the same output. This is the meta-
dimension: every other automated number in this document is only as
trustworthy as the evaluator producing it. Measured via periodic sampling
— a human re-grades a sample of outputs blind to the model's own verdict,
and agreement is compared. Expensive to do exhaustively; valuable as a
recurring spot-check, not a per-job requirement.

---

## 3. Maturity levels

Four stages: **Prototype** (today — a personal tool, numbers exist to
establish a baseline, not to impress), **MVP** (reliable enough that a
human can hand-build a small real collection, dozens of traits, without
excessive manual fixing), **Beta** (reliable enough for a medium
collection across multiple layer types with reasonable cross-trait
consistency), **Production** (reliable and cost-predictable enough to
support many collections — the "100 collections" scale named in the
architecture review — with minimal per-trait babysitting).

| Metric | Prototype | MVP | Beta | Production | Reasoning |
|---|---|---|---|---|---|
| Recognition rate | ≥40% | ≥55% | ≥70% | ≥85% | Two real historical data points both had recognizability problems; 100% is not a real target — some subjects are inherently ambiguous at 32px even for a skilled human artist. Gains from Prototype→MVP come mostly from Evaluation v2 maturing; the larger jump to Beta/Production depends on still-deferred subject-checklist work (`pixel-forge-recognizability-design.md` Stage 2+). |
| Technical hygiene pass rate | ≥85% | ≥93% | ≥97% | ≥99% | Nearly mechanical (transparency, stray pixels, palette bounds) — not a hard creative judgment call, so this should already be tight even at Prototype. A low number here indicates a tooling bug, not a model-quality gap, and should be treated with more urgency than any other dimension at the same numeric shortfall. |
| Average revisions to converge | ~1.5–2.0 | ~1.0–1.3 | ~0.7–1.0 | ~0.4–0.7 | Prototype is expected to often hit the round cap without full convergence (this is exactly the behavior that motivated Revision V4). MVP's drop is attributed to V4's regression reduction; Beta's further drop to Phase 1 principles reducing first-draft issues. |
| Regression rate | unknown, plausibly 30–50%+ | ≤15% | ≤8% | ≤5% | The Prototype number is a range, not a point estimate, on purpose — this is the single most important number the *first* validation batch actually measures, not something to assume in advance. 0% is not a realistic target ever, for any repair process operating on a lossy, low-resolution medium. |
| Revision success rate (net improvement per round) | ~40–50% | ≥70% | ≥80% | ≥90% | Mirrors the regression-rate reasoning from the opposite direction; not 100%, since some issues are genuinely hard to fix without any risk. |
| Loop / non-convergence rate | 30–50%+ | ≤20% | ≤10% | ≤5% | Directly the complement of revision efficiency maturing; also a signal on whether the round cap and escalation thresholds are well-tuned, not just whether the model is good. |
| Avg. cost per converged trait (Sonnet-equivalent) | $0.15–0.30 | $0.10–0.15 | $0.06–0.10 | $0.05–0.08 | Anchored to the existing linear cost estimator, which the architecture review already found undercounts real spend (quadratic image-token growth) — treat these as likely *optimistic* until that inefficiency is fixed, not conservative. Halve for Haiku, roughly ×2.5 for Opus. |
| Avg. latency per converged trait | not tracked / unknown | ≤5 min | ≤3 min | ≤2 min | No wall-clock time is captured anywhere today — every number in this row is a rough order-of-magnitude estimate from call counts, not a measurement, and should be treated as the most provisional row in this table until timestamps are added to the batch harness. |
| Human approval rate | track only (n too small to target) | ≥60% | ≥75% | ≥85% (not higher) | Deliberately capped below 100% at every stage — a rate approaching 100% is a warning sign (rubber-stamping, or a lowered bar), not a goal, exactly as already observed once in this project's real data. |
| Stopped/failed-job rate | ≤5% / ≤3% | same | same | same | Operational reliability, not creative quality — should already be low at every stage and does not have a "maturity trajectory" the way artistic dimensions do; if it's elevated, something is infrastructurally broken, not "not yet mature." |

**Style consistency and evaluator-trust calibration have no numeric row**
here on purpose — neither has a real measurement mechanism yet (style
consistency needs a future reference/anchor system; evaluator-trust
calibration needs a recurring human-blind-regrade sampling process that
hasn't been run once). Assigning numeric targets to an unmeasured
dimension would be inventing precision that doesn't exist — track
qualitatively until a real measurement exists, then backfill this table.

---

## 4. Failure thresholds

Distinct from the maturity targets above (which are aspirational and
comparative), these are hard trip-wires that apply **regardless of
maturity level** — crossing one means something is actively broken, not
"not yet mature," and the correct response is to stop and investigate,
not to keep collecting comparative data as if the run were valid.

- **Regression rate > 50%** — worse than a coin flip that revision helps
  at all; revision is net-harmful and should be treated as broken, not
  tuned.
- **Combined stopped + failed job rate > 20%** — an operational/infra
  problem, not a quality signal; nothing else in the batch should be
  trusted until this is fixed.
- **Actual cost exceeds pre-run estimate by more than 2x** — direct
  confirmation of the architecture review's quadratic-cost-growth
  concern; if this trips, the cost model itself needs fixing before any
  cap or budget decision built on the old estimate can be trusted again.
- **Recognition rate < 20%** — below this, the pipeline isn't doing its
  basic job, not merely under-tuned.
- **> 50% of prompts hit the revision round cap without converging** —
  the repair loop essentially never finishes; a design-level failure, not
  noise.
- **Human approval rate < 30%** (when measured) — the ground-truth signal
  itself is failing; nothing upstream of it should be trusted as "good"
  regardless of what it claims.

A batch that trips any of these should be read as **diagnostic, not
comparative** — its job is to explain the failure, not to serve as a
valid "before" or "after" point in a trend (§8).

---

## 5. Metrics hierarchy

**Critical** — a failure here undermines trust in the whole system, or
means the output is literally unusable: *technical hygiene* (unusable
asset if it fails), *recognizability* (the core deliverable), *human
approval rate* (the only real ground truth), *evaluator trust/calibration*
(governs whether any other self-graded number can be believed at all),
*regression rate* (the specific, already-documented, core motivating
problem behind Revision V4).

**High** — directly actionable, materially affects whether the pipeline
is usable day to day: *repair effectiveness*, *revision efficiency*,
*cost efficiency*, *loop rate*, *silhouette quality*.

**Medium** — real, but slower-moving or harder to act on immediately:
*palette discipline*, *prompt fidelity*, *revision stability*, *latency*,
*stopped/failed-job rate* (usually low-variance once infra is stable, so
less day-to-day signal once it's confirmed healthy).

**Low (to act on *right now*, not forever)** — *style consistency*: it
matters a great deal long-term, but there is currently no mechanism to
measure or improve it (that's gated on a future reference/collection
system), so today it's something to track qualitatively and revisit,
not something a validation batch can act on. Low priority today; expect
this to move up sharply once a collection/consistency mechanism exists.

---

## 6. Tradeoffs — not everything should be maximized

**Recognizability vs. cost.** The marginal cost of the last 10–20% of
recognizability on a genuinely ambiguous subject can dwarf the cost of
the first 70% — chasing full convergence on a stubborn prompt via
repeated revision is often more expensive than a human simply rejecting
it and trying a different prompt. Recognizability should be pursued with
a conscious stopping point, not unconditionally.

**Revision-loop iteration vs. first-draft investment.** Fewer needed
revisions can be bought either by spending more upfront (a more careful,
slower, possibly pricier first draft) or by iterating more in revision.
These are not symmetric: revision carries structural regression risk a
good first draft doesn't. Given that, the deliberate resolution here is
to **bias effort toward first-draft quality (Phase 1 principles) over
revision-loop iteration** wherever there's a choice — not because
revision is bad, but because it's the riskier of the two places to spend
effort.

**Style consistency vs. prompt flexibility.** Locking style tightly
improves cross-trait consistency but fights against a prompt that
deliberately wants to be different (a "legendary" rarity tier breaking
convention on purpose). Resolution: **consistent by default, divergent
only by deliberate, human-endorsed exception** — reusing the
`intentionalChoices` mechanism already in the architecture rather than
inventing a new one. Consistency should never be maximized to the point
that it forecloses a deliberate creative choice.

**Evaluation thoroughness vs. token usage.** A longer, more exhaustive
evaluation (more categories checked, a second independent grading pass)
improves trust but costs roughly double per pass. Past a point, an
evaluator that's slightly less exhaustive but cheap enough to run
constantly beats one so thorough it discourages running validation
often. Reserve genuinely expensive checks (a second, fresh-context
re-grade) for periodic calibration sampling, not every job.

**Explicit non-maximization list**, since the brief asks directly: human
approval rate should not be pushed toward 100% (a warning sign, not a
goal); cost and latency should be minimized only down to the point where
quality stops degrading, not further; recognizability and repair
effectiveness should be pursued with clear diminishing-returns awareness,
not treated as unconditionally-maximize targets.

---

## 7. Quality Score — concept, not formula

**Not a single weighted-sum number.** A weighted average hides *which*
dimension is dragging a score down — "mediocre everywhere" and
"catastrophic in one place, fine elsewhere" would be indistinguishable,
and those two situations demand completely different responses. Weights
would also need constant re-justification as priorities shift, which
directly fights the "should be stable for a long time" requirement, and
a single chased number is exactly the Goodhart's-law risk named in §9.

**Design: a gate, then a profile, then a band — in that order.**

1. **Gate.** Check every §4 failure threshold. If any critical gate
   fails, the score is **Failing**, full stop, regardless of how good
   anything else looks. You cannot buy your way out of a critical failure
   with unrelated strength elsewhere.
2. **Profile.** Above the gate, look at how many *High*- and *Medium*-tier
   dimensions (§5) are meeting their current maturity-level target. This
   is a small set of pass/fail flags per dimension, not a blended number.
3. **Band.** A qualitative label — **Failing / Developing / Solid /
   Strong / Excellent** — derived from the profile (e.g., "gate passes,
   all Critical dimensions on target, most High-tier dimensions on
   target" → *Strong*), always shown **together with** the profile that
   produced it, never alone.

Example rendering: *"Quality Score: Solid — Gate: PASS. Critical: 5/5 on
target. High: 4/5 on target (weak: cost efficiency). Medium: 3/5 on
target."* A reader gets the fast skim (Solid) and the actionable detail
(cost efficiency is where to look) in the same glance — the entire point
of avoiding a single float.

---

## 8. Validation interpretation

**First question, always: did any §4 gate fail?** If yes, stop — the run
is diagnostic, not comparative; go find the root cause before reading
anything else in the report as a trend point.

**If gates pass, read the profile, not the band.** The band is a
skim-level summary; investigation always starts from which specific
dimensions are below target, never from "Solid" or "Developing" alone.

**Compare against the last comparable run** (same prompt-set version,
per `pixel-forge-validation-batch.md` §8). A dimension that was fine last
run and is failing now is a much stronger signal than one that's been
chronically weak and already known about — newly-broken beats
already-flagged for triage priority.

**Trends across three or more runs matter more than any single run.** A
20-prompt sample is small enough that single-run noise is expected;
don't treat a one-run delta as a real change until it's shown up
consistently, and don't celebrate a one-run improvement either. (The
exact size of "normal noise" between two runs of *unchanged* code isn't
known yet — this is itself something the first several baseline runs
should establish, not something this document can state in advance.)

**What should trigger investigation regardless of trend:** any single run
crossing a §4 failure threshold, even once — these represent structural
or catastrophic failure modes, not gradual drift, and don't need a
repeated pattern to be worth stopping for.

**What should not trigger a reaction:** a Medium- or Low-tier dimension
missing its target once, with no multi-run trend behind it. Log it, note
it, move on.

---

## 9. Long-term philosophy

The targets in this document are instruments, not the goal. The actual
goal, unchanged over however many years this project runs: **a human
describes a trait in a sentence and reliably gets something professional-
looking, consistent with the rest of their collection, at a cost and
speed that makes iterating a pleasure rather than a chore** — repeatedly,
across many collections, without the tool needing constant hand-holding
or producing surprises.

**Explicitly avoid optimizing the numbers for their own sake.** Every
metric in this document can be gamed: prompts could be quietly chosen for
being easy rather than representative; an evaluator could be tuned
lenient rather than a generator being made better; a round cap could be
raised until "convergence rate" looks good while actual output quality
stays flat. The antidote is that **human judgment — approval rate,
evaluator-trust calibration — stays load-bearing forever**, never fully
handed off to automated metrics, because those are the two checks in this
whole document that can't be gamed by tuning the system that's being
measured.

**Don't chase Production-level numbers prematurely.** A Prototype-stage
system optimizing for Production-stage targets would over-invest in
expensive mechanisms (more evaluation passes, heavier reference systems,
more revision rounds) before the fundamentals — Phase 1, Revision V4 —
are even validated. That's the same mistake the architecture review
already found once (design velocity outrunning validation); this
document's maturity staging exists specifically to stop it from
happening twice.

**The dimensions and this framework should stay stable for years. The
numbers should not** — they are first estimates, meant to be revised as
real validation-batch data accumulates, not a permanent scoreboard.

---

## Constraints compliance

Nothing in this design requires ML, training, embeddings, a new AI
provider, or an external evaluator. Every measurement described uses
data the existing architecture already produces (Evaluation v2's fields,
`RepairPlan`'s lifecycle classification, job token/turn counts) or a
human directly looking at output — the same self-grading and
human-approval mechanisms already in production, applied on a schedule
rather than invented anew.

---

## Self-critique — where these targets are probably wrong

**Likely too optimistic:**
- **Regression rate MVP target (≤15%).** This assumes Revision V4 — a
  purely-designed, entirely untested prompt philosophy — will produce a
  dramatic improvement on the first attempt. Prompt-only behavior changes
  are notoriously less reliable than schema/architecture fixes; 25–30% on
  V4's first real measurement would not be a surprising result, and this
  target should not be treated as a pass/fail bar until V4 has actually
  run once.
- **Recognition rate Production target (85%).** There is currently zero
  evidence that any recognizability-improving mechanism (Phase 1, or the
  still-deferred subject-checklist work) produces a large gain — this
  number is an aspirational north star, not a confidently achievable
  target, and should be treated as such.
- **Every cost target in §3.** Anchored to the existing linear cost
  estimator, which the architecture review already found undercounts
  real spend due to quadratic image-token growth. If that inefficiency
  isn't fixed first, real costs will likely land *above* every number in
  that row — these targets are optimistic, not conservative, precisely
  because of a known, already-diagnosed measurement gap.

**Likely too conservative or under-specified:**
- Technical hygiene was initially under-specified in an earlier draft of
  this reasoning (bundled into a vague "critical floor" with no numbers)
  before being corrected in §3 — it's nearly mechanical and should
  already be near-100% even at Prototype; the numbers now in §3 reflect
  that correction, but are worth double-checking against real data
  precisely because this is the one dimension with the least excuse to
  be wrong.
- The human-approval-rate Production cap (85%, explicitly not higher) is
  a principled guess (leave room for legitimate rejection) but the
  specific number has no empirical grounding beyond two historical data
  points — it could reasonably be 80% or 90% instead; don't defend "85"
  specifically, defend "capped below 100, and the cap needs revisiting
  once real approval data exists."

**Should be treated as fully provisional until real data accumulates:**
- Every latency number in §3 — zero wall-clock measurement exists
  anywhere in this project today.
- The exact regression-rate and recognition-rate progressions across all
  four maturity levels — both depend on features (V4, Phase 1, deferred
  Stage 2+ recognizability work) that haven't shipped, let alone been
  measured.
- The §4 failure-threshold numbers themselves (50% regression, 20%
  stopped/failed, 2x cost overrun, etc.) — reasonable first guesses, and
  exactly the kind of number the first several validation batches should
  be used to calibrate, not numbers to treat as permanently correct
  because they're written down here.
