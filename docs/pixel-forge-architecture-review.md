# Pixel Forge — Architecture Review

Status: **review only, no code, no redesign of everything.** This
document evaluates the system as a whole — the shipped code (Revision
V3's schema, `repair-plan.ts`, the storage layer, the frontend) and the
six design documents stacked on top of it (`pixel-forge-v3-design.md`,
`pixel-forge-revision-v3.md`, `pixel-forge-revision-v4.md`,
`pixel-forge-reference-system-v1.md`, `pixel-forge-recognizability-design.md`,
`pixel-forge-universal-principles.md`, `pixel-forge-v2-roadmap.md`).

**Ground truth before anything else, because it changes the shape of this
review:** only a fraction of this design stack is actually running.
Shipped: Evaluation v2 (`blindDescription`, `recognizableAsSubject`,
structured `issues[]`), `repair-plan.ts`, the revision prompt/tool wiring,
the frontend crash fix. **Not shipped:** `pixel-forge-v3-design.md`
Phase 1 (the generic outline/hue-shift/hierarchy/shape-language
principles — `buildSystemPrompt`'s fresh-draft instructional content is
unchanged from before any of this work), Phase 5/6, all of Revision V4,
all of the Reference System. And **no Anthropic API call has been run
against any of this new machinery** — every claim in every one of these
documents about convergence, regression reduction, or quality improvement
is still theoretical. That fact is load-bearing for this whole review and
shows up as risk #1 below.

---

## Cross-document contradictions

The brief asked explicitly for every contradiction found, not just a
summary judgment — five real ones, at different severities:

1. **`pixel-forge-v3-design.md`'s own recommended order was not
   followed.** It said ship "1 and 2 in parallel → 3 → 4 → 5 → 6."
   Implementation instead went straight to a large chunk of Phases 2–4
   (Revision V3) while Phase 1 — the cheapest, most foundational item —
   still hasn't shipped. Not fatal, but it means the document's own
   sequencing logic was abandoned without anyone deciding that on
   purpose, which is a process smell worth naming.

2. **`recognizability-design.md`'s methodology was bypassed by its own
   implementation.** That document is explicit and repeated: promote a
   mechanism only after staged, logged, recurring evidence (Stage 1
   geometric icons → Stage 2 animals → Stage 3 wearables → Stage 4
   compositions), never from a single run. `pixel-forge-testing-log.md`'s
   tables are still empty — zero rounds were ever logged. Yet
   `blindDescription`/`recognizableAsSubject` were shipped directly into
   Evaluation v2 anyway, with none of the staged testing that document
   said was the entire point of the exercise. The mechanism is probably
   fine — but the document that specified how to validate it was ignored
   by the team that wrote it.

3. **`pixel-forge-revision-v3.md` vs. `pixel-forge-revision-v4.md` on
   same-tier ordering.** V3 says same-tier issues "may be worked in any
   order or together — they don't invalidate each other by construction."
   V4 explicitly overrides this to strict one-at-a-time, even within a
   tier. This is a *known, deliberate* amendment (V4 says so), not a
   silent one — but it means V3's document, read on its own, is now
   inaccurate about actual intended behavior. Nothing currently marks V3
   as partially superseded; a future reader of V3 alone would get this
   wrong.

4. **`pixel-forge-reference-system-v1.md` states a policy it doesn't
   enforce.** "Structure inherited, values never copied" is stated
   firmly, twice. But `mechanicalAnalysis` necessarily contains the
   reference's literal palette hex values (you cannot compute a hue-shift
   or ramp length without them), and nothing in the design stops a human
   editing `derivedPromptFragments` before approval from pasting one of
   those literal values into the fragment text that *does* reach a
   generation call. The firewall is real for the image itself; it is
   currently just a policy statement, not a structural guarantee, at the
   one point (human-edited prompt fragments) where it could leak.

5. **No stated precedence between generic principles and calibrated
   reference guidance.** `pixel-forge-v3-design.md` Phase 1 (generic:
   "use N flat steps, hue-shift the shadow") and
   `pixel-forge-reference-system-v1.md` (specific: "this pack's reference
   used 4 steps, no hue-shift on this particular ramp") will disagree with
   each other the moment both exist and are both attached to the same
   job. Neither document says which one wins. This isn't a mistake either
   document made individually — it's a gap that only exists *because* they
   were written independently, months of design-time apart, without a
   unifying pass. It needs an answer before both are live simultaneously
   (recommendation: the more specific — attached reference pack — should
   win over the generic global default, the same way a job-level `anchor`
   already overrides nothing generic today; state this explicitly when
   Phase 1 ships).

---

## 1. Pipeline ordering

The diagram (`Prompt → Generation → Evaluation → RepairPlan → Revision →
Evaluation → Revision → ...`) is a reasonable simplification for a
README, but it hides three real things a senior reviewer should insist on
seeing before calling this "the architecture":

**RepairPlan is not a stage, it's a fold over history, and the diagram
draws it like a stage.** Generation, Evaluation, and Revision are all
model calls that transform their immediate input. RepairPlan is a *pure
code function of two things*: this round's evaluation, **and the entire
previous RepairPlan** (for attempt-counting, regression detection,
resolved/carried-forward classification). Drawing it as a simple forward
arrow implies it's stateless like its neighbors. It isn't — it's the one
place genuine cross-cycle memory lives in the whole system, and the
diagram should show that as a feedback edge into a stored state, not a
left-to-right box. Anyone building tooling around "the pipeline" from the
diagram alone would misjudge where state actually lives.

**There is no formal "this is unsalvageable, stop revising, regenerate"
decision point.** The loop as drawn only ever goes forward into more
revision rounds. If a first draft is wrong at the structural level (wrong
silhouette family, wrong subject entirely), no amount of Revision
V4-style minimal surgical editing can fix it without becoming, in
practice, a full redraw — which V4 correctly forbids. Today, and even
after V4 ships, the *only* way to get a fresh draft is a human manually
starting a new generation job — the architecture itself has no signal
(not even an implicit one) distinguishing "keep repairing this" from
"discard and start over." Combined with the next point, this is a real
gap, not a hypothetical one.

**There is no cap on total revision rounds.** `maxTurns` bounds one job.
Nothing bounds how many times a human (or, later, some automated flow)
can click "Revise" on the same trait. `revision: number` just increments
forever. Paired with the missing abandon-and-regenerate signal above, a
stubbornly-wrong trait can accumulate indefinite revision rounds, each
burning real cost, with the architecture offering no opinion that it
might be time to stop and start over.

**Verdict:** the diagram is directionally fine but incomplete in a way
that matters. Fix: (a) document RepairPlan explicitly as a stateful fold,
not a stage; (b) add an attempt-count-based circuit breaker (e.g. after
3–4 total revision rounds on one trait, the UI should surface "consider
regenerating instead of revising again" rather than silently offering
another Revise button with no comment).

---

## 2. State propagation

**Concrete, already-shipped duplication:** `TraitAsset.evaluation.preserve`
/`.doNotModify`/`.intentionalChoices`/`.blindDescription` and
`TraitAsset.repairPlan.preserve`/`.doNotModify`/`.intentionalChoices`/
`.currentDescription` store **the same data twice**, by my own design —
`buildRepairPlan` copies these fields from the fresh evaluation verbatim
rather than referencing them once. Low storage cost, real "two sources of
truth for one fact" smell.

**That duplication has already produced a genuine divergence bug.** When
a job is stopped before evaluation, `result.evaluation` is the
`STOPPED_EVALUATION` placeholder (empty `issues`, blank
`blindDescription`) and `result.graded` is `false`. The route handler
correctly keeps the OLD `repairPlan` in that case (`asset.repairPlan ??
null`) — but it still writes `evaluation: result.evaluation` into
storage regardless of `graded`. **After a stopped-early revision, a
trait's stored `.evaluation` shows "nothing wrong, empty everything" while
its `.repairPlan` correctly shows the real outstanding issues.** Two
fields that are supposed to describe the same reality now disagree, and
nothing catches it. This is a live bug in currently-shipped code, not a
theoretical risk.

**What disappears, on purpose:** RepairPlan history beyond the immediately
previous plan (a deliberate V3 choice — reasonable for now, but it means
nobody can audit *how* a trait got to its current state, or notice it's
been oscillating between two bad states across many rounds).

**What disappears, probably not on purpose:** the entire per-turn
reasoning trace (`DrawingIteration.note`, one line of free text per turn)
lives only in an in-memory `Map` in the Express process
(`tools-pixel-forge.ts`'s `jobs`), capped at 50 tracked jobs and wiped on
every server restart. This is, concretely, **the single most granular
record of "why did the model make this specific edit" in the entire
system, and it is also the least durable piece of data in the entire
system.** For a philosophy (V4) whose entire value proposition is "make
smaller, better-reasoned edits," having zero durable record of the
per-edit reasoning that produced a given trait is a real gap for anyone
trying to later measure whether V4 is actually working.

**Unnecessary reconstruction:** the full mechanical preamble (coordinate
system, palette legend) is rebuilt and resent in full on every single API
call within a job — draft, every refine turn, and the evaluate call all
resend it, unavoidable given the Messages API is stateless per call. This
isn't "waste" in the sense of being avoidable without an architectural
change — see §3, where it becomes the actionable finding.

---

## 3. Token efficiency

**The single largest inefficiency in the whole system: image-token cost
grows quadratically with turn count, not linearly.** `refineAndEvaluate`
keeps every prior turn's rendered image in the `messages` array and never
prunes it. Turn *N*'s API call resends turns *1..N-1*'s images in full,
because that's the only way the stateless Messages API sees conversation
history. A job with 8 refine turns doesn't pay for 8 renders — it pays
for `1 + 2 + ... + 8 = 36` renders' worth of image tokens by the time it
finishes. **The existing cost estimator (`estimateJobCostUsd`) assumes
linear cost (`imageTokensPerRender * maxTurns`) — it's a real,
already-present formula, and it under-counts actual spend for any job
that uses more than 1–2 turns.** This gets strictly worse as more
standing context gets added on top (a bigger RepairPlan render, a future
Reference Pack's derived text) — every one of those additions is
multiplied by the same quadratic growth. This is an architectural
problem, not a prompt-wording problem, and it should be fixed before
adding anything that grows the standing context further.

**Second, related, and currently unexploited: no prompt caching.** None
of the `client.messages.create()` calls use Anthropic's `cache_control`
breakpoints anywhere. The system prompt (identical across every turn of
one job, and largely stable across many jobs of the same `layerType`) is
paid for in full, every single call. This is a real, concrete,
architectural — not cosmetic — lever: caching the stable prefix
(mechanical preamble + layer-type instructions) would cut a meaningful
fraction of input-token cost on every job with more than one turn, for
free, with no behavior change. It does not fix the quadratic image
problem (each image genuinely differs turn to turn) but it directly
addresses the "resend the same system prompt every call" waste, which
compounds with every future feature that adds more standing prompt
content (generic principles, reference-pack guidance).

**Third, smaller:** the shared system prompt carries phase-irrelevant
instructions into every phase — the draft-only "count discrete features
before emitting the array" line is resent (and paid for) on every refine
turn and the evaluate call too, where it does nothing.

**Fourth, smaller:** a RepairPlan issue that survives 3 unresolved rounds
gets its full problem/reason/repairStrategy/expectedResult text re-sent
in full, 3 separate times, once per round — the same root cause as the
system-prompt case (each revision job is a fresh stateless conversation),
and the same fix (caching the stable parts of that render) helps here
too.

**Priority for a fix, if this is picked up:** prompt caching first (cheap,
purely additive, no behavior change, addresses the second- and
fourth-largest items at once) — then a real architectural decision about
image-history growth (a sliding window that keeps only the most recent
1–2 renders in context, collapsing older turns to text, is the
lowest-risk option; it changes the model's runtime "memory" of its own
work, so it needs actual testing, not just a confidence estimate).

---

## 4. Single responsibility

**Evaluation has quietly become "diagnose + plan."** `preserve` /
`doNotModify` are not observations, they're policy decisions about what a
future revision may touch — that's repair-planning, not evaluation. This
was a deliberate, defensible cost trade-off when it was designed (a
second "planning" call would be redundant reasoning over the same image
for no measured gain) — but it means "Evaluation" is no longer a
single-responsibility stage in the classic sense, and nothing currently
says so out loud. Worth naming precisely so nobody down the line is
confused about why a "grading" call produces planning-shaped fields.

**Generation and Revision both bundle 2–3 responsibilities under one job
type** (draft+refine+evaluate; repair+re-evaluate) — consistent with each
other, which is good, but it means a single stored `TokenUsage` total
conflates drawing-cost and self-assessment-cost with **no breakdown by
phase anywhere in storage.** You cannot tell, from a `TraitAsset` alone,
how much of its cost was drawing vs. grading itself — a real, concrete
loss of information caused by responsibility-bundling at the storage
layer, not just at the execution layer.

**RepairPlan is the cleanest single-responsibility component in the
system** — pure, deterministic, one job, no model call. Worth calling out
explicitly as the thing to imitate (see §13).

**`ReferencePack`, as designed, is at real risk of becoming a god object**
before a single line of it is built: calibration state, two independent
analysis layers, derived prompt content, preview rendering, and
approval-workflow state are all bundled into one mutable record with one
lifecycle. These have genuinely different change frequencies (calibration
is set once; analysis might reasonably be re-run without recalibrating;
derived fragments are human-edited and change most often of all) —
bundling them now, before anything is built, is the cheapest possible
moment to reconsider it.

---

## 5. Feedback loops

**The per-turn refine loop (edit → render → look → decide) is a real,
quality-improving loop** — keep it, it's the mechanism that makes
iterative pixel art generation work at all (see §13).

**The across-round revision loop's "improves quality" property is not
guaranteed — it depends entirely on evaluator self-consistency, which is
explicitly not guaranteed.** The resolved/unresolved classification uses
a fuzzy (category + location-text-overlap) match against the prior
plan's open issues, by design, because the evaluator has no stable
identity for a visual problem across two separate calls. A genuinely
unresolved issue can be silently reclassified as "resolved" simply
because the fresh evaluation phrases the same problem differently. This
loop can appear to converge (issue count trending to zero) while actually
just losing track of things — a subtle, real risk this project's own
design docs already flagged as a known limitation but is worth restating
here as a live feedback-loop hazard, not a footnote.

**A loop that currently burns tokens without benefit: re-litigating a
human's already-made override decision.** The real, stored "nyan cat"
trait was approved despite a failed self-check. If that trait is ever
revised for an unrelated reason, the next evaluation will re-flag the
exact same "not recognizable as the specific character" gap the human
already explicitly accepted — because a human's approval-despite-failure
decision does not get written back anywhere as a recorded exception
(`intentionalChoices` only captures what the *model* decides is
intentional, never what a *human* already decided to accept). This is a
real, currently-missing feedback path from human judgment back into
future evaluation.

**Loops that should terminate earlier:** exactly what V4 is for — today
(V3 only, no V4), a revision round works through every active issue
regardless of severity, with no notion of "critical/major issues are
resolved, stop." This is a live gap right now, not a future one, and it's
the strongest concrete argument for shipping V4 promptly.

---

## 6. Scalability (1000 traits, 100 collections, many reference packs, future style packs)

**No, the architecture does not feel clean at this scale, in two
specific, verifiable places.**

**Storage/listing has no scalability plan at all.** `listTraitAssets()`
reads every JSON file and every PNG file from disk, unconditionally, on
every single call — no pagination, no summary-only projection, full
`evaluation`+`repairPlan`+base64-encoded PNG returned for every trait,
every time (including on the ~1.5s poll interval the frontend already
uses while a job is running). At 1000 traits this is 2000 file reads and
several megabytes of JSON per call. This will be noticeable well before
1000 traits — likely in the low hundreds — and it's a consequence of a
reasonable initial choice (flat-file-per-trait, fine for a $5-budget
personal tool at a handful of traits) that was never revisited against
the scale the brief is now explicitly asking about.

**There is no collection concept in the data model, at all.** `zIndex`
and `layerType` exist per trait; there is no entity representing "these
40 traits form collection X," no membership, no compatibility
relationship between traits in the same collection. At "100 collections,"
this is arguably the single biggest missing piece in the entire system —
bigger than anything about reference packs — because the whole
architecture today assumes one undifferentiated global pool of traits. `
Tags` are the only (informal, free-text) grouping mechanism that exists.

**"Many reference packs" and "future style packs" scale fine individually
but reveal the same problem from a different angle** — see §9: without a
shared abstraction, "many packs" means "many packs across N independently
built systems," each needing its own browse/filter/search affordance, at
N times the cost.

---

## 7. Failure recovery

| Failure | Recovery today | Compounds or contains? |
|---|---|---|
| Evaluation false positive (flags something fine) | Human approval gate is the backstop, but it's *late* (cost already spent) and depends entirely on human attentiveness — which the real "nyan cat" approval shows cannot be assumed | Contains, imperfectly |
| Evaluation false negative (misses a real problem) | None — nothing re-audits an already-evaluated trait unless a human manually revises again. Accepted, explicit trade-off given the standing "no extra agents/models" constraint, not an oversight — but worth stating plainly as a real, permanent gap under that constraint | Compounds silently |
| Revision makes the image worse | Regression detection on the *next* evaluation catches it and forces critical severity — a real, working, already-designed loop, once V4 ships. **But there is no pixel-level rollback** — `updateTraitAsset` overwrites `pixels` in place; the previous (possibly-better) state is gone the moment a bad revision lands. The only recovery is forward-fixing, which costs strictly more than reverting would | Compounds — no undo exists anywhere in the system |
| RepairPlan misses a problem | Identical to the evaluation false-negative case — RepairPlan is purely derived, so this is the same risk under a different name | Compounds silently |
| ReferencePack is low quality (bad calibration/misleading analysis) | Blast radius is structurally contained (text-only firewall — bad guidance, never bad pixels, leaks through) and gated by the same human draft→approved review — but nothing forces a human to actually read the derived analysis text carefully before approving; a quick glance at the preview image is enough to click approve | Contains, imperfectly |

**The most serious, correctable-today item in this table is the absence
of pixel-level rollback.** It is cheap to fix (retain the previous
pixel/palette array alongside the previous RepairPlan — one more stored
field) and it is the difference between "a bad revision costs one wasted
round" and "a bad revision costs the trait."

---

## 8. Coupling

**The persistence boundary has zero runtime validation, and this is not
hypothetical — it already caused a real incident.** `readRecord` does
`JSON.parse(raw) as TraitAsset` — a raw type assertion, no schema check.
The crash fixed earlier this project (a stored record silently missing
`missingFeatures`) reached the *frontend* before anything caught it,
because nothing at the *storage read* boundary validates shape. The
symptom was fixed (defensive frontend rendering); the root cause (no
validation where malformed data first enters the system) is unchanged and
will produce the same class of incident the next time any persisted
schema evolves.

**Frontend and backend maintain two independent, hand-written copies of
the same types**, with nothing mechanically enforcing they match — not a
shared module, not a generated type, not even a lint rule. This is
simultaneously *too loosely coupled* (no shared source of truth) and
*inherently, functionally coupled anyway* (they must agree or the UI
breaks) — the worst combination of the two. This is the direct cause of
the earlier production crash and is guaranteed to recur at the next
schema change unless addressed structurally, not just patched again after
the fact.

**Good decoupling worth preserving:** Evaluation's *output shape* and the
revision prompt's *text rendering* are cleanly separated (a schema change
doesn't force a prompt-wording change and vice versa). V4's entire
philosophy is pure prompt text against zero schema/tool changes — the
reason it was so cheap to design is that it's correctly decoupled from
everything else. Keep both patterns; they're the right shape of
independence, in contrast to the two coupling problems above, which are
the wrong shape.

---

## 9. Future extensibility

**No — today's architecture would not absorb Reference Packs, Style
Packs, Palette Packs, Character Bases, and Layer Libraries naturally. It
would absorb the first one built reasonably well and then repeat
substantially the same design-and-build effort four more times**, because
all five are the same underlying concept wearing different names: *an
approved, versioned, reusable influence artifact, folded into a
generation/revision job as text, never as raw pixels.* Building each as
its own bespoke system (which is exactly the trajectory `pixel-forge-
style-lab-plan.md`'s `StyleProfile` and `pixel-forge-reference-system-v1.md`'s
`ReferencePack` are already on, independently) means duplicated storage,
duplicated approval-workflow code, duplicated prompt-injection logic,
five times over, and a user who has to remember which of five systems a
given pack lives in.

**"Character Bases" is very likely the same idea as the anchor-point/
`CollectionSpec` concept already deferred in `pixel-forge-v3-design.md`
Phase 6** — another point in favor of recognizing these as one family of
problem rather than five unrelated feature requests.

**"Layer Libraries" may not need a new mechanism at all.** The trait
store already *is* a layer library; what's missing is organization
(collections, tags, search — see §6), not a new storage/approval system.

**Recommendation:** before building any of these, design one shared
shape — provisionally `InfluencePack { id, name, description, status,
sourceNote, schemaVersion, preview, exclusions, derivedPromptFragments,
kind: 'reference' | 'style' | 'palette' | 'character_base', payload:
<kind-specific> }` — one storage module, one approval workflow, one
prompt-injection mechanism, reused across every kind. This is design work,
not code, and it is far cheaper to do now, before anything is built, than
after two or three of these ship independently and someone has to
reconcile them.

---

## 10. Complexity — elegant but unearned

Being genuinely willing to cut things I designed myself, not just things
inherited from elsewhere:

- **`RepairItem.dependsOn`** — designed, documented as "usually empty,
  tiering handles most ordering," and confirmed in its own spec as having
  zero code that reads it. This is complexity added for a case explicitly
  predicted to rarely occur, with no current consumer. Cut it until
  there's a concrete case tiering can't handle.
- **The 5-tier category scheme** — every tier boundary has a defensible
  argument, which is exactly what makes it *look* right without any
  evidence it *is* right. A coarser 3-bucket scheme (Structural / Surface
  / Polish) would very plausibly capture most of the ordering benefit
  with a meaningfully smaller taxonomy to explain, maintain, and get
  category-placement judgment calls wrong on (the `trait_specific`
  placement already needed an ad hoc call during implementation — a sign
  the taxonomy is finer than the available reasoning cleanly supports).
- **The `deferred` bucket / `MAX_ACTIVE_ISSUES` cap** — a real, defensible
  idea (turn budgets are genuinely finite) but built and tuned (the
  specific number 6) with zero real usage data. It may well be doing
  nothing today if most real revision rounds have 1–3 issues. Worth
  measuring before trusting the number, not before existing at all.

**What earns its complexity, explicitly, for balance:** the two-layer
(mechanical/semantic) reference analysis split has a real, stated,
defensible cost/reliability reason (one is free arithmetic, one
genuinely needs a vision judgment) — keep it. `schemaVersion` stamping is
cheap and already justified by a real bug — keep it, and extend it to
every future persisted object without debate. The repeated
draft/candidate/approved-style status-gate pattern across artifact types
is consistent, learnable once, and a maintainability asset, not
complexity for its own sake — keep repeating it.

---

## 11. Ten biggest architectural risks, ranked

1. **Nothing has been validated against a real model yet.** Every claim
   in every one of these six documents about convergence, regression
   reduction, or quality improvement is still theoretical — zero
   Anthropic API calls have exercised any of Evaluation v2, RepairPlan,
   or (once shipped) V4. This is ranked first because it undermines
   confidence in every other finding and every threshold (`MAX_ACTIVE_ISSUES
   = 6`, `ESCALATE_AFTER_ATTEMPTS = 2`, `LOCATION_MATCH_THRESHOLD = 0.34`)
   in the system.
2. **No pixel-level rollback.** A bad revision permanently destroys the
   prior good state; recovery is always forward, never backward, and
   forward is strictly more expensive.
3. **Quadratic image-token growth inside a job's turn loop** — a live,
   structural inefficiency that gets worse with every future feature that
   adds standing context.
4. **No collection/grouping concept** — the architecture cannot represent
   "100 collections" today, which the brief explicitly names as a target
   scale.
5. **No runtime schema validation at the storage boundary** — already
   caused one real incident, guaranteed to recur at the next schema
   change for the identical reason.
6. **Frontend/backend type duplication with no shared source of truth** —
   the proximate cause of #5's incident, doubled.
7. **Multiple independently-designed "attachable pack" mechanisms heading
   toward 5x duplicated effort** (Style Lab, Reference System, and three
   more named in the brief).
8. **No circuit breaker on total revision attempts** — unbounded repair
   spend possible on a draft that may simply be unsalvageable.
9. **A concrete, already-existing state-divergence bug** — a stopped-early
   job leaves `.evaluation` and `.repairPlan` describing different
   realities.
10. **No storage/listing scalability plan** — full-scan, full-payload,
    no pagination; will be user-visibly slow well before 1000 traits.

---

## 12. What to remove (simplify ~20%, keep ~95% of the quality ceiling)

- Cut `RepairItem.dependsOn` — zero current consumers.
- Collapse the 5-tier category scheme to 3 (Structural / Surface /
  Polish) until real data argues for finer granularity.
- Cut the `deferred`-bucket machinery as a distinct subsystem; let
  turn-budget-plus-stop-early (V4) bound how much gets attempted, rather
  than a separate pre-filter with its own promotion lifecycle.
- Do not build Reference System v1 as originally scoped. Ship Layer A
  (mechanical/deterministic measurements) with **manual-only** resolution
  entry first; defer the semi-assisted auto-detect calibration UI — it is
  the single most expensive, least-validated piece of that entire design,
  and Layer A alone already captures most of the concrete, structural
  guidance value (palette ramps, hue-shift, outline consistency).
- Do not build Style Lab's `StyleProfile` and Reference System's
  `ReferencePack` as two separate systems — that's not a feature cut, it's
  cutting duplicated future work before it happens (see §9).

## 13. What to absolutely keep

- **The human approval gate, never auto-promoted.** The single most
  important safety property in the system; every other finding in this
  review assumes it stays exactly as strict as it is today.
- **`RepairPlan` as a pure, deterministic, code-only transform.** The
  cleanest, most testable, most maintainable component in the whole
  architecture — resist any future temptation to make tiering or
  classification "smarter" via another model call.
- **The text-only firewall for any influence artifact** (never show
  original or extracted reference pixels to a generation call) — the
  structural, not-just-policy, anti-copying guarantee.
- **Additive/opt-in design for every new job parameter** (`layerType`
  branches, a future `referencePackId`) — the pattern that's kept every
  new mechanism from regressing anything that already works; keep
  applying it to everything new.
- **The render-once-per-turn, vision-interleaved refine loop.** This is
  the actual mechanism that makes iterative pixel art generation possible
  at all, and it's the reason a Planner/Executor split was correctly
  rejected earlier in this project — never trade it for a "plan blind,
  execute without looking" approach.
- **`schemaVersion` stamping** — cheap, already proven necessary by a
  real bug, expand it to every future persisted object without debate.

---

## 14. New roadmap — reordered from first principles, not from prior priority

Ranked by expected quality improvement, implementation complexity,
long-term architectural value, maintenance cost, token cost, and expected
ROI. This **replaces** the ordering implied by the existing documents,
where reasoning above changed the conclusion.

| # | Item | Quality | Complexity | Arch. value | Maintenance | Token cost | ROI |
|---|---|---|---|---|---|---|---|
| 1 | **Run a real validation batch** — actually generate/revise real traits against the live API, no new code | N/A (enables measuring everything else) | Trivial | Very high | None | Real but small, bounded | **Highest — do this before building anything else** |
| 2 | Ship Phase 1 generic construction principles (still unimplemented) | High | Low | Med-high | Low | Low | Very high |
| 3 | Ship Revision V4 | High (fixes observed regressions) | Low | High (prerequisite for trusting future eval work) | Low | Low/neutral | Very high |
| 4 | Fix the stopped-job evaluation/repairPlan divergence bug | Low-med (correctness) | Trivial | Medium | Reduces confusion | None | High |
| 5 | Add prompt caching for the stable system-prompt prefix | Neutral | Medium | High | Low | High savings | High |
| 6 | Add storage-boundary schema validation | N/A (robustness) | Low-med | High (prevents a recurring bug class) | Reduces future incidents | None | High |
| 7 | Add pixel-history/rollback before overwrite | Med-high (recovery) | Low-med | High | Small | None | High |
| 8 | Design (not build) the unified `InfluencePack` shape before building any pack system | Indirect | Low (design only) | Very high | Saves future maintenance heavily | None | Very high given how cheap it is now vs. later |
| 9 | Fix quadratic image-history growth (sliding window over rendered turns) | Neutral | Medium-high (touches the core loop, needs real testing) | High | Medium | High savings | High, rising with every future feature |
| 10 | Minimal collection/grouping entity | N/A directly | Medium | High (unblocks "100 collections") | Medium | None | Medium-high |
| 11 | Trait-listing pagination | N/A | Low-medium | Medium | Low | None | Medium (not urgent at today's actual trait count) |
| 12 | Reference System v1, trimmed (Layer A + manual resolution only) | Potentially high for consistency | Medium | Medium-high | Medium | Low, one-time per pack | Medium — gated on 1, 2, 3, 8 |
| 13 | Full Reference System v1 (calibration UI, auto-detect, Layer B) | High ceiling | High | High | Medium-high | Low-medium | Medium — gated on real evidence from #12 |
| 14 | Style/Palette/CharacterBase/LayerLibrary packs | Unknown until #8's pattern is validated | Medium-high each | Depends entirely on #8 | Depends on #8 | Low each | Unranked until #8 and #12/13 land |

**What changed from prior priority, explicitly:** the previous
recommendation (in `pixel-forge-reference-system-v1.md`) was "Phase 1 →
Revision V4 → Reference System." This review does not overturn that
ordering — it *sharpens* it: five additional items (real validation,
three concrete bug/robustness fixes, and the pack-unification design
pass) now sit at or above Revision V4 in priority, all of them cheap,
all of them either already-evidenced problems or force-multipliers on
everything that comes after. Reference System v1 moves *further* down
the list than previously stated, and even then only in a deliberately
trimmed form — not because the idea is weak, but because building it on
top of an unvalidated, token-inefficient, rollback-free, un-unified
foundation would be compounding exactly the risks this review found,
not avoiding them.
