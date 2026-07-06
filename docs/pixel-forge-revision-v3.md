# Pixel Forge — Revision Pipeline V3

Status: **design only, no code.** This document is detailed enough to
implement without further architectural decisions — schemas, prompt
templates, sequencing rules, and lifecycle rules are all specified
concretely. Read alongside `pixel-forge-v3-design.md` (this document
supersedes that doc's rough Phase 2/3 sketches with a concrete, final
schema — Revision V3 cannot be built on a vague evaluator, so this spec
finishes the job Phase 2 started).

---

## 1. Architectural review — where does the reasoning actually go today?

### 1.1 The pipeline, traced call by call

`runDrawingJob`: draft → refine loop → one `submit_evaluation` call → result
saved via `saveTraitAsset`, `status: 'candidate'`.

`runRevisionJob` (`agent-loop.ts:542–588`): seeds the canvas from
`asset.pixels`, sends **one message** —
*"Revise this existing `{layerType}` layer. Current state shown below.
Instructions: `{revisionPrompt}`."* — then runs the identical refine loop
and evaluate call used for a brand-new drawing.

That second fact is the whole problem in one sentence: **the revision job
never reads `asset.evaluation`.** Confirmed by reading `tools-pixel-forge.ts`'s
`/traits/:id/revise` handler and `runRevisionJob` in full — neither
references `.evaluation`, `.missingFeatures`, or `.notes` anywhere.
Whatever the evaluator figured out about the previous attempt is sitting
right there in `data/pixel-forge/traits/<id>.json` and is never opened.

### 1.2 Where evaluation knowledge is lost

Walking the handoff step by step:

1. **`missingFeatures` / `notes` → discarded at the API boundary.** The only
   way this text reaches a revision today is if a human reads the trait
   page and manually retypes or pastes it into the revision prompt box.
   `pixel-forge-testing-log.md` even documents this as the *expected*
   manual workflow ("use the Copy for revision button... confirm a
   revision using that exact text") — the design already assumes this
   should be automatic and it simply never got wired.
2. **The boolean verdicts → discarded entirely, with no manual path even in
   principle.** There's no UI affordance and no server code that does
   anything with `cleanSilhouette`/`readableAtNativeSize`/`matchesLayerType`
   after they're computed once. A human sees them, but no downstream call
   ever reads them again.
3. **Spatial information never existed to begin with.** `missingFeatures`
   is a flat string array — "ears read as generic triangles" carries no
   location beyond what's in the sentence, so even a perfect handoff would
   still make the revision model re-locate the problem in the image from
   scratch every time.
4. **"What's already good" was never captured.** The evaluator only ever
   records failures. Nothing today records "the hat silhouette and palette
   are correct, don't touch them" — so even a hypothetical perfect
   forwarding of `missingFeatures` gives the revision model zero explicit
   protection against fixing one thing while breaking another, because
   *no signal about what to protect exists at any point in the pipeline.*
   This is the single largest structural gap: it's not just lost in
   transit, it was never produced.
5. **The old evaluation is overwritten, not archived.** `updateTraitAsset`
   replaces `record.evaluation` with the new one on every revision
   (`store.ts:206–244`). After one revision, there is no stored trace of
   what the *previous* evaluation said — so even a future fix that wires
   `missingFeatures` through naively still can't answer "did revision N
   actually fix what revision N-1's evaluation flagged," because the
   evidence needed to check that has already been deleted.

### 1.3 Which prompts ignore previous reasoning

- The revision seed message quoted above ignores literally all of it —
  every field of `Evaluation` and the entire concept of "this is a repair,
  not a fresh drawing."
- `buildSystemPrompt()` is **identical** for a brand-new draft and a
  revision of an already-approved-quality trait. Its "Refining" paragraph
  ("look at the render... if the silhouette does not immediately read as
  the intended subject, use `flood_fill`/`clear` and rebuild the wrong
  region") was written for a fresh drawing's *own* turn-by-turn
  self-correction, where being broadly skeptical of your own last few
  turns is exactly correct. Applied to a *revision* of an external,
  already-scored asset, the same instruction actively encourages
  regression: nothing in it says "and leave the rest alone."
- The tool a revision turn has access to includes `clear`
  (`canvas.clear(colorIndex)` in `canvas.ts:94–96`), which wipes the
  **entire grid**, no bounding box, no region argument. A revision job
  handed this tool and a system prompt that explicitly suggests
  `clear`-and-rebuild as the fix for a bad silhouette is one plausible
  model turn away from destroying an asset that had only one small,
  well-localized problem.

### 1.4 Which fields should survive into revision, and which are redundant

**Should survive (today: zero do, except by manual human copy-paste):**
`missingFeatures`, `notes`, and (once it exists) `blindDescription` — these
are exactly the raw diagnostic material a repair plan is built from.

**Currently redundant / should not be forwarded as-is:**
- `noStrayPixels` / `transparentBgPreserved` — almost always trivially
  true, mechanical rather than artistic; when false they're a real but
  low-complexity fix. They don't deserve their own top-level structure
  going forward (see §7) — folding them into the same structured-issue
  list as everything else, tagged with a `technical_hygiene` category,
  removes a parallel, mostly-empty field without losing any signal.
- `matchesLayerType` — this field is doing two unrelated jobs at once (see
  the audit in `pixel-forge-v3-design.md` §1.5): "is this the right kind of
  layer" (which essentially never changes across a trait's lifetime, since
  `layerType` is fixed at creation) versus "does this match the *specific*
  subject in the prompt" (which is the actual, recurring, high-value
  question). The first half doesn't need to be re-asked on every
  revision; the second half is better served by `recognizableAsSubject`
  (§7).

---

## 2. The core redesign

**Evaluation produces a `RepairPlan`. Revision consumes that `RepairPlan`
directly.** The `RepairPlan` is the contract — it is the only thing that
crosses the boundary between "grading what exists" and "fixing what's
wrong," and it is designed so that crossing that boundary loses nothing.

Two things make this work, spelled out now because the rest of the
document builds on both:

- **The evaluator doesn't just grade — it emits the repair plan's raw
  content directly**, in one existing forced tool call (§7). There is no
  second "planning" agent or second model call. Diagnosis and repair
  planning are the same cognitive act if the evaluator is asked the right
  questions; splitting them into two calls would be exactly the kind of
  feature creep the brief warns against, for no quality gain.
- **Sequencing (tiers, priority order) is computed by deterministic code
  from a fixed category → tier lookup table, not authored by the model.**
  The evaluator's only job is to tag each issue with a `category` and
  `severity` — a small, bounded classification task models are reliably
  good at. A cheap, free, always-consistent code step turns those tags
  into the tier ordering. This is deliberate: asking the model to
  re-derive "what order should these be fixed in" every single call is
  wasted tokens and produces inconsistent orderings between two runs with
  the same issue set. See §5.

---

## 3. The `RepairPlan` object

### 3.1 Design principle: taxonomy, not thirteen arrays

The brief lists categories like Palette, Outline, Silhouette, Face, Eye,
Lighting, Cluster, Hue-shifting, Material, Recognizability, Trait-specific,
Composition, Background. The tempting literal reading is thirteen parallel
arrays (`paletteCorrections: [...]`, `outlineCorrections: [...]`, ...).
**Don't build that.** Most revisions have one to four real issues; thirteen
mostly-empty arrays is duplicated structure for no reason, and a single
issue frequently spans categories (a bad ear shape is arguably both
`silhouette` and `recognizability` — forcing it into exactly one of
thirteen buckets creates a classification argument that a `category` tag
on one canonical item sidesteps entirely).

So: **one flat `issues: RepairItem[]` array. `category` is an enum field on
each item.** This is the "think like an engineer" move — a bug tracker
doesn't have thirteen tables, it has one table with a `component` column.
Every category the brief asked for is represented; none of them cost a
schema.

### 3.2 `RepairCategory` (the enum, with the purpose of each value)

| Category | Purpose |
|---|---|
| `silhouette` | Overall shape/outline/proportion — the structural read of the subject. |
| `recognizability` | Subject-*identity* features specifically — kept distinct from `silhouette` because a silhouette can be clean and legible yet still fail to read as the *specific* requested subject (the stored "nyan cat" record: clean cat silhouette, fails recognizability against Nyan Cat specifically). |
| `face` | Facial composition/proportion/expression — mouth, nose/muzzle, brow, jaw. Distinct from `eye`. |
| `eye` | Eye-zone specifically — shape, placement, contrast, occlusion handling. |
| `palette` | Which colors / how many are used; ramp economy. |
| `hue_shift` | Whether shadow/highlight steps rotate hue rather than just darkening/lightening. |
| `outline` | Presence/absence/weight/color consistency of outline treatment. |
| `material` | Rendering-technique differentiation between distinct materials on one subject. |
| `lighting` | Light-source consistency, shadow hardness/placement, self-illumination handling. |
| `cluster` | Cluster geometry (regular/organic/radial/noise) matching the intended material or texture. |
| `composition` | Overall layout/balance/framing/margins — whole-canvas concerns not owned by one feature. |
| `background` | Negative-space/background treatment and its complexity relative to the subject. |
| `trait_specific` | Layer-type requirements — accessory needs an attachment point, icon must be self-contained, layer-role mismatch. |
| `technical_hygiene` | Stray pixels, transparency errors, off-palette values, out-of-bounds edits — mechanical, not artistic. |
| `other` | Escape hatch. Repeated use is a signal the taxonomy is missing a category — watch it, don't let it become a dumping ground. |

### 3.3 `RepairItem`

Answering the brief's question directly — yes, every issue should carry
severity, reason, repair strategy, and expected result. Plus a stable id
(for tiering/ordering references and cross-revision matching) and a
plain-language location (see §9 for why this is prose, not coordinates,
in this version):

```
RepairItem {
  id: string                 // stable short id, e.g. "R1" — scoped to one RepairPlan
  category: RepairCategory
  severity: 'critical' | 'major' | 'minor'
  location: string           // plain-language region: "left ear", "background upper-right quadrant", "whole silhouette"
  problem: string            // what's wrong, as an observation
  reason: string             // why it matters — cite the specific defining feature/principle where useful
  repairStrategy: string     // concrete action: what to actually do, not a restatement of the problem
  expectedResult: string     // falsifiable statement, checked by the next evaluation
  dependsOn: string[]        // ids of other repairs that must land first, if any (usually empty — tiering handles most ordering, see §5)
}
```

`severity` meanings, fixed definitions (so the model isn't inventing its
own scale each time): **critical** = subject is unrecognizable or the
asset is fundamentally broken; **major** = clearly wrong, subject still
reads; **minor** = polish, wouldn't block approval on its own.

### 3.4 `PreserveItem`, `doNotModify`, `intentionalChoices`

```
PreserveItem {
  id: string
  description: string   // what's good and must survive — "the overall bust proportions and hat silhouette"
  reason: string         // optional, but valuable: why it's good, so an adjacent fix doesn't drift into it
}
```

`doNotModify: string[]` — plain-language, hard-constraint region/element
names. Stronger than `preserve`: `preserve` says "this is good, don't
regress it as a side effect"; `doNotModify` says "do not touch this
pixel region under any circumstance, even if a nearby fix would be easier
if you did." Reserve it for the highest-regression-risk elements: the
established palette indices already in use, the overall canvas bounding
silhouette, background transparency, anything a *previous* revision
already had to fix once (a second regression on the same element is
worse than a first one).

`intentionalChoices: string[]` — things that look like they might be
errors to a fresh, naive look, but are confirmed deliberate style choices
(an asymmetric accessory, an unusually saturated background per
`pixel-forge-universal-principles.md`'s documented exceptions). This is
what the brief's "Ignore:" bucket in the revision prompt maps to. Without
this list, a revision model re-evaluating with fresh eyes can "fix" a
deliberate choice it mistakes for a mistake — a real and specific
regression risk this design should close, not just the more obvious
"broke something while fixing something else" kind.

### 3.5 The rest of the object

```
RepairPlan {
  schemaVersion: number
  traitId: string
  sourceRevision: number       // which trait revision this plan was computed against
  subject: string              // the original prompt — carried forward so revision never has to re-derive intent
  currentDescription: string   // = evaluator's blindDescription (§7) — "what a stranger sees right now"

  issues: RepairItem[]         // empty array if nothing open — sparse by construction, never padded
  preserve: PreserveItem[]
  doNotModify: string[]
  intentionalChoices: string[]
  deferred: RepairItem[]       // known but not actively worked this round — see §6.4

  sequence: RepairTier[]       // computed by code, not authored by the model — see §5
  successCriteria: string[]    // = issues[].expectedResult, plus "everything under preserve/doNotModify is unchanged"
}

RepairTier {
  tier: number                 // 1..N ascending = processing order
  label: string                // "Structural", "Features", "Rendering", "Composition/Background", "Polish"
  issueIds: string[]           // members of this tier, order-agnostic within it
}
```

Nothing above is duplicated: `issues` is the single source of truth for
"what's wrong and how to fix it"; `sequence` only ever references
`issues[].id`, it never repeats the problem/strategy text; `successCriteria`
is a flat projection of `issues[].expectedResult` for convenience at the
next evaluation, not independently authored.

---

## 4. Anti-regression design

The brief names the exact failure mode to prevent: fix the eyes, destroy
the silhouette; fix the palette, ruin the composition; fix recognizability,
lose the style. Three layers, from softest to hardest:

1. **Default-deny region editing (the primary mechanism).** The revision
   prompt states explicitly: *if a region is not named by an open repair
   item, it is off-limits.* This inverts today's framing (broad license to
   "rebuild the wrong region" with no boundary on what counts as wrong) into
   an allowlist — only named regions may change. This is the single
   biggest lever here and it's pure prompt design, zero schema cost.
2. **Explicit reinforcement for the highest-risk elements
   (`preserve` / `doNotModify`).** Belt-and-suspenders on top of (1) for
   the specific things most likely to get clobbered as an incidental side
   effect of an unrelated fix (palette indices, overall bounding
   silhouette, background transparency) — named explicitly so the model
   doesn't have to infer them from "not mentioned in `issues`."
3. **Remove the one tool that makes (1) and (2) unenforceable: `clear`.**
   Prompt-level restraint can be ignored by the model; a tool that isn't
   offered can't be misused. Revision jobs should receive a `REPAIR_TOOLS`
   set — identical to today's `REFINE_TOOLS` minus `clear` — so a
   worst-case "let me just start over" impulse is structurally impossible,
   not just discouraged. `set_pixel` / `fill_rect` / `draw_line` /
   `flood_fill` remain fully sufficient for every repair category above;
   none of them require a full-canvas wipe, and `flood_fill` already
   bounds itself to a contiguous same-color region, which is exactly the
   "fix this region, not the whole canvas" behavior repair work needs.

A fourth layer closes the loop across *iterations*, not within one: the
next evaluation explicitly checks `preserve`/`doNotModify` survival and
feeds any violation back in as a **regression**, which (§6.3) is escalated
to `critical` severity in the next `RepairPlan` regardless of how minor the
drift looks — a regression is strictly worse than a persisting known
issue, because the known issue's cost was already priced in and a
regression is new, unbudgeted damage.

---

## 5. Ordering — should repairs be sequential?

**Yes.** Here's the engineering reason, not just an assertion: several
categories change the coordinate system or visual anchors that other
categories reason relative to. Fixing a downstream thing before an
upstream thing invalidates the downstream fix and burns a turn re-doing
it — this is the actual convergence cost of getting order wrong, and it's
measurable in wasted refine-loop turns, not just aesthetics.

Fixed category → tier mapping (computed by code, never re-derived by the
model per call — see §2):

| Tier | Label | Categories | Why it's here and not another tier |
|---|---|---|---|
| 1 | Structural | `silhouette`, `recognizability` | These two are grouped together deliberately: in the stored evidence (the rabbit-eared "cat"), the recognizability failure *was* a silhouette failure — "ears read as generic triangles" is a shape problem, not a color problem. Anything downstream (face/eye placement, material rendering) is reasoned about relative to the silhouette's boundaries; changing the silhouette after placing eyes means re-placing the eyes. |
| 2 | Features | `face`, `eye` | Depend on the *final* silhouette (tier 1) but are largely independent of color/material treatment (tier 3) — safe to fix once tier 1 is stable, safe to fix before tier 3. |
| 3 | Rendering | `palette`, `hue_shift`, `material`, `outline`, `cluster` | Surface treatments applied to a now-stable shape. Changing these doesn't invalidate structural or feature decisions, so they belong after both. |
| 4 | Composition/Background | `composition`, `background` | Per `pixel-forge-universal-principles.md` principle 13, background complexity should be budgeted *against the character's final complexity* — it has to come after material/feature decisions are settled, or the budget is computed against a moving target. |
| 5 | Polish | `technical_hygiene`, `other` | Cheap, non-invalidating, always safe last. |

Note `lighting` deliberately sits in tier 3 alongside `material` rather
than getting its own tier: you can't correctly light a material you
haven't finalized, so it must not precede `material`, but it doesn't
depend on tier 1/2 the way `material` itself barely does either — same
tier is the right granularity, a tier per category would be over-fitting
the table to the brief's example list rather than to actual dependencies.

**Within a tier**, items may be worked in any order or together — they
don't invalidate each other by construction. **Across tiers**, this
version uses **soft ordering only**: the revision prompt presents tiers in
order and instructs sequential processing, but no code-level gate blocks
tier 2 work until tier 1 is verifiably done. A hard, code-enforced gate
(e.g. a forced mid-loop checkpoint call asserting "tier 1 complete")
would need new control logic and its own judgment calls about what counts
as "done" — real complexity for a benefit that's unproven without
evidence. The enforcement mechanism for this version is the **next
evaluation's regression check** (§4, §6.3): if working tiers out of order
in one pass causes tier 2 work to get invalidated by tier 1 work in the
same pass, that shows up as new/regressed issues next round and gets
priority then. This mirrors the project's own existing discipline
(`pixel-forge-testing-log.md`: promote a rule only after recurring
evidence, not a single run) — ship the cheap version, harden only if the
soft version is repeatedly violated.

This also directly continues `pixel-forge-v3-design.md` Phase 4's
mid-refine "silhouette lock" checkpoint idea — that checkpoint is exactly
a tier-1-completion check, informally. This document doesn't add new
machinery on top of it; it gives that existing idea a name (`sequence`) and
a concrete boundary (tier 1 = silhouette + recognizability).

---

## 6. Iterative lifecycle — how a `RepairPlan` evolves across revisions

### 6.1 What triggers a new `RepairPlan`

Every evaluation call (end of a fresh draft, or end of a revision) produces
a new evaluator output (§7). A deterministic, non-model code step —
call it `buildRepairPlan(evaluatorOutput, previousPlan | null)` — turns
that into the stored `RepairPlan`. On a fresh draft, `previousPlan` is
null and the function is trivial (wrap the evaluator's issues/preserve/etc.
directly, tier them, done). The interesting logic is the revision case.

### 6.2 Matching new issues against the previous plan

The evaluator has no stable identity for a visual problem across two
separate calls — it just sees an image and reports what's wrong, fresh,
every time. So `buildRepairPlan` matches each newly-reported issue against
`previousPlan.issues` by **(category, location-text similarity)** — a
pragmatic heuristic, not a perfect one. Be explicit about this in the
implementation: it's a similarity match, not an id lookup, and when it's
ambiguous the safer default is **treat it as a continuation of the
highest-severity open issue in the same category**, not as a brand-new
issue — the cost of wrongly resetting a stuck problem's attempt counter
(losing escalation pressure, §6.4) is worse than the cost of occasionally
conflating two distinct same-category issues.

### 6.3 Classifying each previous issue

For every issue in `previousPlan.issues`, after matching against the new
evaluator output:

- **Resolved** — no matching new issue, and the region it named doesn't
  appear in the new issue list at all. **Drop it entirely.** Don't carry
  it forward, don't re-mention it — there is no value in re-stating a
  fixed problem, and doing so both wastes tokens and risks the model
  re-opening something that's already correct.
- **Unresolved** — a matching new issue still exists. Carry it forward,
  increment `attempts`. See §6.4 for what happens as `attempts` grows.
- **Regressed** — the region is now flagged by a new issue that overlaps a
  `preserve` or `doNotModify` entry, or a `technicalHygiene`-style
  mechanical check that was previously fine now fails. Force
  `severity: 'critical'` regardless of the issue's "natural" severity, and
  place it at the front of tier 1 processing order regardless of its
  category — a regression is a strictly worse event than a persisting
  known issue and must be treated as such structurally, not left to
  compete for attention on severity text alone.
- **New** — a problem not previously flagged, discovered only now (either
  a genuinely new mistake, or something the previous, shallower evaluation
  simply missed). Added at its own assessed severity, normal tiering
  applies.

`preserve`/`doNotModify`/`intentionalChoices` entries are carried forward
unchanged by default (confirmed-good doesn't need re-confirming every
round) **unless** the new evaluation explicitly reports one of them as
now-violated (which is exactly the regression path above), or the human's
free-text revision instructions explicitly ask to change something on the
`intentionalChoices` list — a human can promote an "ignore" item into a
real repair; that override always wins over a self-graded plan (see §8).

### 6.4 Escalation on repeated failure

If an issue's `attempts` reaches 2 with no resolution, two things happen,
not one: severity is bumped one notch (major → critical; minor → major),
**and** the next `RepairPlan`'s `repairStrategy` text for that item is
required to differ from what was tried before — re-issuing an identical
instruction that already failed once is not a plan, it's a retry with
no new information. In practice this means the evaluator, when it
re-diagnoses a still-open issue, should be prompted (as part of its own
instructions, §7) to propose a **different class of fix** for
repeat-offenders — e.g. "adjust the edge" failing twice should escalate to
"flood-fill and rebuild the region from scratch," not a third phrasing of
the same nudge.

### 6.5 The `deferred` bucket — bounding how much one round attempts

Per-round turn budgets are finite ($5-budget tool, `HARD_MAX_TURNS = 15`).
If, after classification, more than roughly six issues are open across all
tiers, the lowest-severity items beyond that count move to `deferred`
instead of `issues` — **still fully specified, still carried forward
verbatim next round, just not part of this round's active work.** This
directly serves "eliminate repeated reasoning": a deferred item is not
rediscovered next time, it's already fully diagnosed and sitting ready,
just queued behind higher-priority work. Deferred items never silently
disappear — they only leave `deferred` by being promoted into `issues` on
a later round (once room opens up) or by being classified `resolved` if a
later evaluation happens to find them already fine (rare, but possible if
an adjacent fix incidentally addressed them).

### 6.6 Summary answering the brief's direct questions

- **Should `RepairPlan` evolve after every iteration?** Yes, deterministically, via §6.3's classification, not by asking the model to freely re-author the whole plan each time.
- **Should solved items disappear?** Yes — dropped on `resolved`, not carried forward, not re-mentioned.
- **Should unresolved items remain?** Yes — carried forward with an incrementing `attempts` counter.
- **Should priorities change?** Yes, in exactly two directions: escalate on repeated failure (§6.4) and force-escalate to critical on any regression (§6.3) — priority never silently *decreases* except by full resolution.

---

## 7. Evaluator critique and redesign

### 7.1 Critique, stated plainly

Today's evaluator (`SUBMIT_EVALUATION_TOOL` / `Evaluation` in `tools.ts`)
returns five flat booleans, a string array, and a notes string. Concretely
wrong with this, evidenced by the two real stored records read for this
audit:

- `matchesLayerType: false` on the "nyan cat" record conflates "wrong
  layer role" with "right role, wrong specific subject" — a human has to
  read prose to figure out which failure actually happened, and nothing
  forces that distinction to be legible without reading `notes`.
- `missingFeatures` on the rabbit-eared "cat" record is good raw material —
  six specific, well-written observations — but it's unstructured: no
  severity (are all six equally bad?), no location beyond what's in the
  sentence, no stated fix, no stated done-condition. A human (or a
  revision model) has to re-derive all four of those from prose, every
  time, from scratch.
- The second stored record's evaluation JSON is **missing the
  `missingFeatures` key entirely** — evidence of undetected schema drift,
  because nothing stamps which schema shape a record was written with.

### 7.2 Yes — every issue should carry severity, reason, repair strategy,
### and expected result

This is exactly `RepairItem` from §3.3. The evaluator's real job, properly
understood, already *is* repair planning — a good diagnosis of "the ears
read as rabbit ears, not cat ears" is worthless to a revision model unless
it also says *why* that reads wrong (reason) and *what specifically to do
about it* (repairStrategy) and *how to know it's fixed* (expectedResult).
Asking for a flat description and expecting a downstream process to
reverse-engineer a fix plan from prose is asking a second reasoning pass
to redo work the first pass already implicitly did but never wrote down.

### 7.3 The redesigned evaluator output

This supersedes the loose sketch in `pixel-forge-v3-design.md` §Phase 2
with a final, concrete shape. One forced tool call, same pattern as today
(`submit_evaluation`, same tool-choice-pinned mechanism):

```
EvaluationResult {
  schemaVersion: number
  blindDescription: string          // written cold, before any other field — the Tier-2 mechanism from recognizability-design.md, finally implemented
  recognizableAsSubject: boolean     // the one deliberately-kept standalone boolean — see rationale below

  issues: RepairItem[]               // empty if none — see §3.3. Includes what used to be cleanSilhouette/
                                      // readableAtNativeSize/noStrayPixels/transparentBgPreserved/matchesLayerType
                                      // failures, each as a normal issue tagged with the matching category
                                      // (silhouette, technical_hygiene, trait_specific respectively) instead of
                                      // five parallel always-present booleans.
  preserve: PreserveItem[]
  doNotModify: string[]
  intentionalChoices: string[]

  overallSeverity: 'none' | 'minor' | 'major' | 'critical'  // COMPUTED by code from issues — max severity present, or 'none' if issues is empty. Never authored by the model: free, and guaranteed consistent with the issues list by construction.
  notes: string                      // small free-text catch-all for anything genuinely not covered above
}
```

**Why `recognizableAsSubject` is the one exception to "no parallel
booleans":** every other former boolean field is folded into `issues`
because those checks only need to exist as an issue *when something's
wrong* — a `silhouette` issue not being present already means the
silhouette is fine, no separate flag needed. Recognizability is different:
it is the single check most prone to silent rubber-stamping (that's the
entire diagnosis in `pixel-forge-recognizability-design.md`, and the
stored "nyan cat" record is live proof it still happens). Making it a
mandatory, always-computed field — derived explicitly from comparing
`blindDescription` against the subject, not asserted independently — is a
forcing function that an omittable, only-present-when-flagged issue
wouldn't be. One deliberate exception, with a stated reason, beats a rule
applied uniformly past the point it stops making sense.

**Why `overallSeverity` is computed, not authored:** it's a pure function
of `issues` (max severity, or `none`). Asking the model to also state this
independently risks it disagreeing with its own `issues` list — a
consistency bug for zero benefit. Compute it in code from data the model
already produced.

### 7.4 Worked example, using the real stored "rabbit-eared cat" record

Today's actual stored output for that trait:

> `missingFeatures: ["Ears are too tall, thin, and rounded at the tip —
> they read as rabbit/bunny ears, not the short pointed triangular ears of
> a cat", "No inner-ear notch/detail...", ...]`

Under this design, the first item becomes:

```
{
  id: "R1",
  category: "silhouette",
  severity: "critical",
  location: "both ears",
  problem: "Ears are tall, thin, and rounded at the tip.",
  reason: "This reads as rabbit/bunny ears, not the short pointed
           triangular ears that identify a cat specifically — rounded
           long ears plus dot eyes reads as generic creature, per the
           animal-head recognizability checklist.",
  repairStrategy: "Rebuild both ears as short, sharp-pointed triangles
                    with a small inner-ear notch on the leading edge.
                    Keep the same base attachment point and overall head
                    width — only the ear shape itself changes.",
  expectedResult: "Ear silhouette alone (mentally cropping out the rest
                    of the head) reads unambiguously as a cat ear, not a
                    rabbit ear, rounded triangle, or generic point.",
  dependsOn: []
}
```

Tiered as `tier: 1` (category `silhouette`). Every downstream field a
revision model needs — what, why, how, and how to know it's done — is now
explicit instead of implied by a single descriptive sentence.

---

## 8. The redesigned revision prompt

### 8.1 Structure

Matches the shape the brief sketched, populated concretely from a
`RepairPlan`. This replaces the single free-text seed message in
`runRevisionJob` and pairs with its own system-prompt framing (§8.2) —
not the shared fresh-draft `buildSystemPrompt()`.

```
You are repairing an existing pixel-art trait — a senior artist fixing a
colleague's work, not redrawing from memory. Most of this image is
already correct; your job is to fix ONLY what's listed below, without
disturbing anything else.

DEFAULT RULE: if a region is not named by an open repair item below, it
is off-limits. Do not restyle, "improve," or reinterpret anything outside
the named repair regions, even if you would have drawn it differently.

PRESERVE (confirmed good — do not regress):
- {preserve[i].description} ({preserve[i].reason})
...

DO NOT MODIFY (hard constraint, no exceptions):
- {doNotModify[i]}
...

IGNORE (deliberate choices — do not "fix" these):
- {intentionalChoices[i]}
...

REPAIR PLAN — work through tiers in order; do not begin a later tier
until every repair in the current tier is done and its "done when"
condition holds.

Tier 1 — Structural:
  [R1] (critical) {location}
    Problem: {problem}
    Why it matters: {reason}
    Fix: {repairStrategy}
    Done when: {expectedResult}
  ...
Tier 2 — Features: ...
Tier 3 — Rendering: ...
Tier 4 — Composition/Background: ...
Tier 5 — Polish: ...

(Tiers with zero repair items are omitted entirely — no "Tier 4: none.")

ADDITIONAL HUMAN INSTRUCTIONS (these outrank everything above; if they
conflict with a Preserve/Ignore item, follow the human instruction and
say so in your closing note):
{human's free-text revisionPrompt, if any}

SUCCESS CRITERIA — this is exactly what the next evaluation checks:
{successCriteria}
```

### 8.2 System-prompt framing (`buildRevisionSystemPrompt`, new — distinct
### from `buildSystemPrompt`)

Reuses the genuinely-shared mechanical preamble from today's prompt
(coordinate system, palette-as-indices, transparency rule, layer-type
reminder) but **replaces** the "Refining"/"Recognizability" paragraphs
(written for fresh-draft self-correction) with repair-specific framing:
senior-artist-fixing-another-artist's-work; default-deny editing (§4);
tier-gated processing (§5); the tool set is `REPAIR_TOOLS` (§4, excludes
`clear`).

### 8.3 Human-instruction precedence

Human free text is the highest authority in the system — higher than a
self-graded `RepairPlan`. If it conflicts with `preserve` or
`intentionalChoices`, the human wins, and the model is required to say so
explicitly in its final note (so the override is visible in the stored
record, not silent). It cannot override `doNotModify` implicitly by simply
not mentioning it — if a human genuinely wants a `doNotModify` region
changed, that item needs to be explicitly dropped from the plan (a
human editing the plan itself, not a revision instruction fighting it from
inside the same job).

---

## 9. What this deliberately does not do (scope discipline)

- **No pixel-coordinate bounding boxes on `RepairItem.location`.**
  Considered and deferred, not ignored: a coordinate box would let tool
  calls be *mechanically* restricted to named regions (stronger than
  prompt discipline), but it asks the evaluator to reason precisely about
  canvas-native coordinates from an upscaled render, adds a real error
  mode (misaligned boxes blocking a legitimate fix or missing the real
  area), and isn't asked for by either research pack. Revisit only if
  regressions persist after §4's three layers ship and are given a fair
  test — evidence-gated, same discipline as everything deferred in
  `pixel-forge-v3-design.md` Phase 6.
- **No hard, code-enforced tier gating.** See §5 — soft ordering plus
  next-round regression detection is the v1 enforcement mechanism.
  Upgrade only with evidence the soft version is routinely violated.
- **No second "repair planning" model call.** The evaluator's forced tool
  call already produces everything `RepairPlan` needs; a code function
  assembles the rest for free. Adding a distinct planning agent on top
  would be a second, redundant reasoning pass over the same image for no
  stated gain — the exact feature creep the brief warns against.
- **No unbounded history log.** `TraitAsset` needs exactly one new field —
  `repairPlan: RepairPlan | null`, the *current* plan — because each new
  plan already carries forward everything still-relevant from its
  predecessor (§6). A separate, growing audit log of every past plan is a
  plausible future nice-to-have (Phase-6-style) but isn't required for
  this design to work and isn't built now.
- **No new database, ML, embeddings, or external vision model.** Nothing
  in this document needs any of them; every mechanism here is a schema
  field, a prompt template, or a small deterministic code function.

---

## 10. Token-cost accounting (the brief's "don't pay for this unless it's
### worth it" instruction, answered with numbers)

**What gets more expensive:** the evaluation call's *output* grows from a
handful of short `missingFeatures` strings (~15–25 tokens each) to full
`RepairItem`s (~60–120 tokens each, five fields). With a typical 1–4 open
issues, that's on the order of a few hundred extra output tokens per
evaluation call.

**Why that's negligible in context:** `estimateJobCostUsd`'s own formula
(`agent-loop.ts:112–126`) shows the refine loop's image tokens already
dominate cost — `imageTokensPerRender ≈ (canvasSize·8)²/750`, multiplied by
`maxTurns`, plus `refineOutputTokens = maxTurns · 400`. For an 8-turn job
that's roughly 700 image-tokens-per-turn and 3,200 refine-output-tokens
already being spent — a few hundred extra structured-evaluation tokens is
low-single-digit-percent overhead on a job that already costs this much,
not a multiplier.

**What gets cheaper, and why this is the actual point:** today, a revision
that receives no diagnostic handoff has to *rediscover* the problem
through its own vision before it can even start fixing it — that
rediscovery consumes real refine-loop turns that produce no forward
progress, and if the revision doesn't fully re-diagnose correctly, it may
need a second or third revision round to converge, each paying the full
per-job image-token cost again. Handing over an already-diagnosed,
already-prioritized, already-sequenced plan means more of the *same or
fewer* turns go directly to drawing fixes instead of re-diagnosing.
**Net effect: token-cost neutral to favorable overall**, because the
marginal cost of a richer evaluation schema is paid once per job, while
the savings compound across however many fewer revision rounds it takes
to converge — which is precisely "maximize convergence speed," the
brief's stated objective, expressed in the pipeline's own cost terms.

---

## 11. Implementation map (for the engineer building this — no
### decisions left, just wiring)

- `src/pixel-agent/tools.ts` — extend `SUBMIT_EVALUATION_TOOL`'s
  `input_schema` to §7.3's `EvaluationResult` shape; replace the
  `Evaluation` interface accordingly; bump `schemaVersion`.
- `src/pixel-agent/agent-loop.ts` — add `buildRevisionSystemPrompt()`
  (§8.2), add `REPAIR_TOOLS` (= `REFINE_TOOLS` minus `clear`) for use in
  `runRevisionJob`'s loop instead of the shared `REFINE_TOOLS`; add the
  pure function `buildRepairPlan(evaluatorOutput, previousPlan | null):
  RepairPlan` implementing §5's tiering table and §6's
  resolved/unresolved/regressed/new/deferred classification; construct the
  §8.1 seed message from a `RepairPlan` instead of the current one-line
  string in `runRevisionJob`.
- `src/pixel-agent/store.ts` — add `repairPlan: RepairPlan | null` to
  `TraitAsset`; persist it on every `saveTraitAsset`/`updateTraitAsset`
  call (computed from the just-completed job's evaluator output plus the
  trait's previous `repairPlan`, per §6.1).
- `src/server/tools-pixel-forge.ts` — the `/traits/:id/revise` handler
  reads `asset.repairPlan` and passes it into `runRevisionJob` alongside
  today's free-text `revisionPrompt`; no new endpoints needed.
- Old stored records (pre-`schemaVersion`) have no `repairPlan` — treat
  `null` as "no prior plan, behave like a fresh evaluation" rather than
  attempting to backfill/migrate.
