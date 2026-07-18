# Pixel Forge — Generation Quality Bottleneck Audit

Status: **audit only. No code, no API calls, no deploy.** Scope is
strictly generation quality (drawing/refine/evaluate/repair) for
SMB-style traits — UI is deliberately out of scope. Grounded directly in
current source (`agent-loop.ts`, `tools.ts`, `canvas.ts`, `repair-plan.ts`,
`reference-analysis.ts`) plus the project's own prior findings in
`pixel-forge-v3-design.md`, `-revision-v3.md`, `-revision-v4.md`,
`-recognizability-design.md`, `-stabilization-checkpoint.md`, and
`-token-cost-audit.md`. Where this audit's conclusion matches or extends
an already-documented finding, that's cited rather than re-derived; where
it disagrees with a prior doc's own priority call, that's stated
explicitly with reasoning.

---

## 0. What's already solved — don't re-spend on these

Worth stating up front so the ranking below isn't misread as "everything
is broken":

- **Exact color/hex fidelity** — structurally impossible to violate.
  Colors are palette-index-only in every tool schema (`tools.ts`); the
  model cannot emit an arbitrary hex value even if it wanted to.
- **Guess/undo cycles from position uncertainty** — fixed. Every tool
  result now reports an actual before/after diff bbox
  (`tools.ts:349-372`), directly closing the gap that caused the
  documented misplaced-beard incident (run `2026-07-05_022`,
  `pixel-forge-stabilization-checkpoint.md`).
- **Revision wiping the whole canvas** — fixed. `REPAIR_TOOLS` drops
  `clear` (`tools.ts:121`); a revision job structurally cannot nuke the
  entire grid in one call anymore (though see §1.6 — `flood_fill` is a
  narrower, still-open version of the same risk).
- **Thinking-budget stalls** — fixed. `thinking: { type: 'disabled' }` on
  every refine/evaluate/reference-analysis call removes the
  `stopReason: max_tokens` / zero-tool-call failure mode.
- **Empty, un-actionable repair plans from an evaluator that fails to
  itemize its own negative verdict** — fixed. The synthetic-
  recognizability invariant (`repair-plan.ts:227-256`) forces exactly one
  critical issue when `recognizableAsSubject:false` with `issues:[]`.
- **Hair/beard reading as cloth/collar** — mitigated via explicit shape
  vocabulary in both system prompts (`agent-loop.ts:570-576, 661-669`).

---

## 1. Ranked bottlenecks

| # | Bottleneck | Impact | Cost | Est. improvement | Dependencies |
|---|---|---|---|---|---|
| 1 | Self-evaluation bias — same-conversation grading | **High** | Low–Med | High | none |
| 2 | No repeatable quality-measurement harness | **High** | Med | Enables measuring #1–10 | none |
| 3 | Geometry/anchor constraints unenforced ("biggest true gap") | **High** | High | High (esp. compositor) | LayerType ext., DNA storage |
| 4 | Per-layer isolation in the new layer-first workflow | **High** | Med–High | High (compositor-specific) | Direct Reference plumbing |
| 5 | Draft phase is blind (no-vision) full-grid generation | Medium–High | Medium | Medium–High | none |
| 6 | `flood_fill` unbounded overspill | Medium | **Low** | Medium (bounded) | none |
| 7 | Direct Reference image not yet reaching drawing model | Medium–High* | Low | Medium–High* | already built (redaction) |
| 8 | No mirror/ellipse/pattern tool primitives | Medium | Medium | Medium | none |
| 9 | RepairPlan cross-round location matching is text-fuzzy | Medium | Med–High | Medium | overlaps #3 |
| 10 | LayerType limitations (no head/headwear, icon overload) | Medium | Medium | Low–Medium directly, unlocks #3/#4 | none |

*Impact/improvement for #7 is conditional — only matters on jobs that
actually attach a reference image; irrelevant to the (currently larger)
population of no-reference jobs.

---

### 1. Self-evaluation bias — same-conversation grading

**The single most concretely-proven bottleneck.** `refineAndEvaluate`'s
evaluate call (`agent-loop.ts:1093-1123`) reuses the *exact same*
`messages` array and `system` prompt the drawing turns just ran in — it
is not an independent audit, it is the same agent, with full memory of
its own intent, grading its own output. `pixel-forge-v3-design.md` §1.4/
§1.8 already names this "genuine anchoring bias the current architecture
can't remove" at **Critical** priority, tied to a real, already-shipped
consequence: stored trait `b428ab3d…` (Nyan Cat) graded
`matchesLayerType:false` with notes admitting it wasn't recognizable —
and a human still approved it, because nothing forced the gap to be
harder to wave past. The fix is already fully designed there (§1.8): one
additional, cheap, **same-model, fresh-context** call — no conversation
history, just the final render + subject — explicitly **not** a
multi-agent critic swarm (rejected there as feature creep, and this audit
agrees that's the right line). Per `pixel-forge-stabilization-
checkpoint.md`'s "already shipped" list, this fix is the one Critical
item from v3-design that has **not** shipped yet, despite everything
else on that list being addressed — strong signal it's next in the
project's own queue, not just this audit's opinion.

**Dependencies:** none. **Cost:** low — reuses `SUBMIT_EVALUATION_TOOL`
and the existing model client, only needs a trimmed message array and a
second `client.messages.create()` call.

### 2. No repeatable quality-measurement harness

`pixel-forge-testing-log.md`'s Stage 1/2 tables (geometric icons, living
things) were never filled in. The only real signal it contains is wild
run-to-run swings — `_003`: 50%/100% regression, `_022`: 0%/100%,
`_006`: 100%/0% — and `stabilization-checkpoint.md` states outright: "the
evaluator can be strict or stochastic run to run — the same prompt/config
has produced both full recognizable busts and totally abstract,
unrecognizable shapes across different rollouts." Without a fixed
prompt set run repeatedly and compared, **every other fix in this list is
a hypothesis, not a measured improvement** — including whatever ships
from #1. This is infrastructure, not a prompt/tool change, so it doesn't
itself produce a "prettier trait," but it's what makes every dollar spent
on #1/#3/#4/#5 below actually verifiable rather than vibes-based.

### 3. Geometry/anchor constraints unenforced

Named directly in the project's own docs as **"the biggest true gap in
this whole document"** (`pixel-forge-v3-design.md` §1.9): the `anchor`
field is free-text, per-job, with no shared coordinate system enforced
across a trait library. This shows up twice, concretely:
- A single job's `anchor` param is prose ("head center at x=16, y=15")
  folded into the system prompt (`agent-loop.ts:589-591`) with zero
  verification that the actual drawn silhouette lands there.
- Collection DNA's geometry anchors (`smbAnimalCollectionDNA.geometry.
  anchors`, `__fixtures__/collection-dna-smb-animal.ts:20-34`) are
  percentage bboxes composed into prose guidance
  (`composeCollectionPromptSection`) with the same zero-verification gap
  — and, per `pixel-forge-layer-stack-compositor-mvp.md` §2, some of
  those anchor names (`head`, `ears`, `headwear`) don't even correspond
  to a real `LayerType` a job can be tagged with, so the "(this trait)"
  marker meant to highlight the active anchor can structurally never fire
  for a `head` generation today.

This is squarely the risk the newest feature (Layer Stack Compositor)
lives or dies on: assembling independently-generated layers only works
if their geometry actually agrees, and nothing currently checks that.

### 4. Per-layer isolation in the new layer-first workflow

The most important finding **specific to this exact moment** in the
project. `pixel-forge-stabilization-checkpoint.md` records that a real,
cross-run pattern (`_020`, `_021`, `_007`, `_002`) was fixed by generating
SMB-style busts as **one monolithic `icon`-layer trait**, not decomposed
parts — decomposition was previously causing the model to skip head/
face/hat/beard entirely. The Layer-first workflow just shipped (this
session's prior three turns) pushes in the *opposite* direction:
generating `body`/`eyes`/`mouth`/`accessory` as separate calls, each with
**zero visual awareness of the sibling layers it will be composited
with** — only abstract percentage-bbox text (§3 above). A body and a
pair of eyes can each individually pass their own self-evaluation and
still not cohere as a set once stacked. This is the layer-first
initiative's central, currently-unmitigated risk, not a hypothetical one
— it's the same failure mode that already forced a reversal once, now
reintroduced by design.

**The good news:** the fix reuses infrastructure that already exists.
The Direct Reference Mode redaction plumbing (`agent-loop.ts`'s
`buildReferenceImageBlock`/`redactReferenceImageBlocks`, built but
unwired — `pixel-forge-direct-reference-mode-audit.md`) is exactly the
mechanism needed to show a sibling layer's already-approved render to the
draft call for a new layer, then redact it from history — the same
one-time-image-then-redact shape, just with a different image source
(a sibling layer's PNG instead of a user upload).

### 5. Draft phase is blind, no-vision, full-grid generation

`runDrawingJob`'s draft phase (`agent-loop.ts:1166-1175`) forces the
entire initial grid — up to 48×48 = 2304 integers — as one flat array in
a single call, with **no rendered image, no vision check, before it's
accepted**. `pixel-forge-v3-design.md` §1.2 calls this "Medium" priority
and untested rather than a proven failure; this audit rates it somewhat
higher, for a structural reason the prior doc doesn't emphasize: every
refine/repair mechanism downstream (tiering, escalation, DONE WHEN gates)
operates on top of whatever silhouette the draft produced, and a bad
foundational silhouette burns refine turns on structural correction
instead of polish — turns that are budget-capped (`PRESET_DEFAULT_MAX_
TURNS`: 4/8/12, `HARD_MAX_TURNS = 15`). Symmetry is also asked for as a
single unreinforced sentence ("mirror the left and right halves,"
`agent-loop.ts:539`) with no tool support (§1.8) and no re-assertion
during refine.

### 6. `flood_fill` unbounded overspill

Cheapest real fix on this list. `Canvas.floodFill` (`canvas.ts:79-92`)
has no bound on spread — `stabilization-checkpoint.md` states plainly:
"`flood_fill` can still overspill through an unclosed outline and wipe an
entire canvas/background — observed more than once, not specifically
hardened by any fix above." It remains in `REPAIR_TOOLS`
(`tools.ts:121`), so a revision job retains this exact risk even after
`clear` was removed for the same reason. A cap (max affected-pixel count,
or refusing a fill whose spread exceeds some fraction of the canvas) is a
small, isolated, deterministic code change with no prompting involved.

### 7. Direct Reference image not yet reaching the drawing model

Already fully audited (`pixel-forge-direct-reference-mode-audit.md`) and
the redaction mechanism is built (§4 above). Recommendation there stands:
Option B (draft-call-only, redact immediately after) is the cheapest
useful mode, cost ~$0.003–0.006/job even at max reference size. Only
relevant when a reference is actually attached — a real, but currently
narrower-than-#1–#5, lever.

### 8. No mirror/ellipse/pattern-stamp tool primitives

`REFINE_TOOLS`/`REPAIR_TOOLS` (`tools.ts:49-121`) are exactly `set_pixel`,
`fill_rect`, `draw_line`, `flood_fill`, `clear` — no symmetry, no curve/
ellipse, no region-copy. The system prompt's own hair/beard workaround
("stack 2-3 fill_rect regions of decreasing width" — a prompt-level patch
for a tool-level gap) is itself evidence this ceiling is real: organic
shapes and enforced symmetry are being simulated through many small
rectangle calls instead of a primitive built for the job. A `mirror_
region` tool in particular would also make the draft prompt's "mirror
the left and right halves" instruction (§5) something the model can
*execute* deterministically rather than approximate by hand.

### 9. RepairPlan cross-round location matching is text-fuzzy

`matchPrevious` (`repair-plan.ts:148-156`) matches a fresh issue against
the previous round's open issues by token-overlap ratio over free-text
`location` strings, threshold 0.34 — explicitly a "pragmatic heuristic,
not an id lookup" per its own comment, and `pixel-forge-revision-v3.md`
already considered and deferred pixel-coordinate bboxes here ("revisit
only if regressions persist"). A wrong match either resets an issue's
`attempts` counter (weakening the escalate-after-2-attempts rule) or
conflates two distinct same-category problems. Fixing this properly
shares its dependency with #3 — both want the same real, grounded
coordinate system instead of prose.

### 10. LayerType limitations

Already fully audited in `pixel-forge-layer-stack-compositor-mvp.md` §2:
no real `head`/`headwear` value, `icon` semantically means "standalone
symbol" (not "head"), `DEFAULT_Z_INDEX` ties `accessory`/`icon` at 40.
Its impact is mostly on **collection-level coherence and compositor
correctness**, not a single trait's own visual quality — ranked lower
than #3/#4 because it's a subset of the same underlying investment
(extending the real geometry/anchor system almost certainly requires
extending `LayerType` alongside it, not as a separate project).

---

## 2. What NOT to over-rank

- **Prompt structure**, standing alone, is *not* a top-10 item anymore.
  Both system prompts have already been through multiple real iteration
  rounds (hair/beard vocabulary, DONE WHEN gates, tiered repair language,
  CURRENT/PROBLEM/PRESERVE/SMALLEST EDIT/CONFIDENCE scaffold, blind-
  description-first). Further wordsmithing without a new tool/harness/
  architecture change is likely low-yield from here.
- **Palette enforcement** is not a bottleneck at all — see §0.
- **Evaluator schema issues** (e.g. `matchesLayerType` conflating role-vs-
  subject match, no schema version stamp — both named in v3-design §1.5)
  are real but small; folding them into whatever ships for #1 is cheaper
  than treating them as separate work.

---

## 3. Before spending another $20

At the stabilization checkpoint's own measured ~$0.15–0.25/prompt
(Sonnet `normal`, one revision round), $20 buys roughly 80–130 more
generation jobs — still smoke-test scale, not a real benchmark batch.
Everything recommended here is a **code change verifiable offline**,
matching this project's own standing discipline of proving a mechanism
before spending on it:

1. **Ship #1** — the fresh-context independent evaluation call. Design
   already exists (v3-design §1.8); this is the highest-confidence,
   lowest-cost, already-proven-necessary fix on the list.
2. **Ship #6** — bound `flood_fill`'s spread. A few lines in `canvas.ts`,
   fully unit-testable with a synthetic grid, zero paid calls needed to
   verify.
3. **Stand up the skeleton of #2** — even a small, fixed 5-10 prompt set
   with a repeatable comparison script (no paid calls yet — just the
   harness) so the *first* $20 actually spent on generation produces
   comparable, not one-off, data.

Only after those: one small, explicitly-approved paid smoke test
comparing pre/post #1 on 2-3 prompts — cost-capped, not a batch, per this
project's own standing convention.

## 4. Before spending another $100

$100 (~400-650 more jobs at the same rate) is enough to run a real first
pass of the harness from §3.3 across the two live tensions this audit
surfaced:

1. **Layer-first vs. monolithic-bust**, head-to-head: the same subject,
   once as a single `icon`-layer bust (the already-proven-working path),
   once decomposed into `body`/`eyes`/`mouth`/`accessory` via the new
   layer-first workflow, assembled in the Layer Stack Preview. This
   directly tests #4's hypothesis with real data instead of leaving it as
   a documented risk.
2. **Direct Reference Option B**, real smoke test — per the existing
   audit's own recommended next step, now that #4's testing has
   established a harness to compare against.
3. **A first real geometry-constraint experiment** (§3/§9) — even a
   cheap version (e.g. render the sibling layer's silhouette bbox as a
   guide overlay in the draft call's image, reusing #4's plumbing) before
   committing to the full DNA-architecture-level fix, which is
   meaningfully larger engineering scope than this budget tier justifies.

## 5. Probably impossible regardless of prompting

- **Pixel-perfect deterministic geometry/symmetry via prompting alone.**
  An LLM predicting integer coordinates one token at a time will never
  have a zero error rate on "mirror this exact silhouette" or "this bbox
  precisely." The fix is moving that precision into code (a real
  `mirror_region` tool, a real bbox-conformance check), not better
  wording — §8/§3 are "tool problems," not "prompt problems," precisely
  because of this ceiling.
- **Fully eliminating self-evaluation bias with a same-model fresh-context
  call.** #1's fix reduces the bias (removes shared conversation memory)
  but a fresh call from the *same model* still shares that model's
  aesthetic tendencies and blind spots. A genuinely independent evaluator
  (a different model, or a human) would close more of the gap — the
  project has already explicitly and reasonably ruled that out as scope
  creep (v3-design §1.8), so some residual bias here is a permanent,
  accepted tradeoff, not a bug to keep chasing.
- **Guaranteed cross-trait visual consistency from text-described DNA
  alone**, with no shared image grounding. Every generation call is
  independently stochastic; a text rule ("head occupies ~80% of subject
  height") is a constraint on intent, not a guarantee on pixels. #4's
  image-grounded sibling approach narrows this gap but a purely
  text-driven system has a real, non-zero consistency ceiling no prompt
  wording removes.
- **Recognizability for subjects outside the base model's visual
  "knowledge."** The blind-description mechanism (recognizability-
  design.md) can catch *that* a render fails to read as the subject, but
  cannot manufacture visual knowledge the underlying model doesn't have
  for an obscure/highly-specific subject — that's a training-data
  ceiling, not something any prompt or tool in this pipeline can close.

---

## 6. Recommended next single engineering task

**Implement the fresh-context independent evaluation call (bottleneck
#1).** Reasoning, weighed against every other candidate on this list:

- **Already fully designed**, not a new idea needing exploration —
  `pixel-forge-v3-design.md` §1.8 specifies exactly the shape (same
  model, trimmed/no history, same `SUBMIT_EVALUATION_TOOL` schema). Zero
  design risk.
- **Cheapest real fix with the broadest leverage.** Unlike #3/#4/#5/#8
  (which each improve *some* generations), this fix improves the
  *reliability of the gate itself* — every single job, reference or not,
  layer-first or monolithic, passes through this one evaluate step before
  a human ever sees an approve/reject decision. A more trustworthy gate
  compounds across every other bottleneck on this list rather than
  competing with them for priority.
- **Directly tied to a confirmed, not hypothetical, real failure** — the
  Nyan Cat trait that reached `approved` status despite its own
  self-grade admitting it wasn't recognizable. This isn't a theoretical
  improvement; it's closing a gap that has already produced a bad, real,
  shipped result.
- **The project's own trajectory already points here** — it's the one
  Critical-priority item from v3-design's list that every other item
  around it has since shipped past.

Runner-up, and worth doing in the same engineering session since it's
nearly free: bottleneck **#6** (`flood_fill` bound) — a few lines, fully
offline-testable, closes a separate, still-open, occasionally
catastrophic failure mode with no interaction with #1's work.
