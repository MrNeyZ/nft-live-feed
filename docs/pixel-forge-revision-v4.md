# Pixel Forge — Revision V4: Surgical Repair Philosophy

Status: **design only, no code.** This document changes nothing about the
Revision V3 architecture (`RepairPlan`, tiering, lifecycle, `REPAIR_TOOLS`,
the evaluate schema) — all of that stays exactly as specified in
`pixel-forge-revision-v3.md`. This document redesigns exactly one thing:
**what the revision agent is told, and how it is told to think, once it
already has a good `RepairPlan` in hand.** Evaluation outran Revision;
this closes that gap without touching Evaluation again.

---

## 1. Diagnosis — why a better RepairPlan didn't fix the behavior

V3 gave the revision agent a correct, structured answer to *what* is
wrong (`issues[]` with category/severity/location/problem/reason) and
*what must not change* (`preserve`/`doNotModify`/`intentionalChoices`,
enforced as a default-deny on which **regions** may be touched). That was
real progress: region-level containment — "don't touch the background, the
hat, the palette elsewhere" — is a solved problem in V3.

What V3 did not solve is **pixel-level discipline inside a region that is
already allowed to be touched.** Once a region is legitimately in scope
(e.g. "left ear" is a named repair target), nothing in the current prompt
stops the model from treating "this region is fair game" as license to
**redraw the whole region freehand** — the same generative instinct it
uses when drawing a fresh trait from nothing — rather than nudging the
specific pixels that are actually wrong. A `repairStrategy` string like
*"rebuild both ears as short pointed triangles with a notch"* reads, to a
model with no other instruction, as "draw ears" — not "adjust the 6-8
pixels that currently make these ears wrong." The result matches the
reported failure mode exactly: one instructed fix, three new problems,
because the model redrew a whole neighborhood to deliver one corrected
shape.

**The fix is not more data about what's wrong — the RepairPlan already
has that. The fix is an operating philosophy for what "make an edit"
means**, imposed at the pixel level the way V3 already imposed it at the
region level.

---

## 2. The inversion: pixel surgeon, not illustrator

Today's implicit default (inherited from the fresh-draft prompt this
agent was never fully weaned off of): *a pixel is blank until proven
necessary to fill; a region is a canvas until proven finished.*

**New default:** ***every existing pixel is correct unless there is
specific evidence, from a named repair item, that it must change.*** The
burden of proof is on the edit, not on the pixel. An edit needs to justify
itself against a specific listed problem; a pixel never needs to justify
staying as it is.

This single inversion is the philosophical core of V4. Every principle
below is a specific, testable consequence of it.

---

## 3. The required reasoning scaffold

Before starting work on **each** issue (once per issue, not once per tool
call — see §11 on token cost), the agent must think in this shape, as
plain text preceding its first tool call for that issue:

```
CURRENT: <what the relevant region actually looks like right now,
          described briefly and concretely — not what you intend it to
          become>
PROBLEM: <the specific issue being addressed — category, location,
          the one thing that's wrong>
PRESERVE: <what is adjacent to or overlapping this region that must
           survive untouched — restated even if it's also in the plan's
           Preserve/Do Not Modify list, because restating it is what
           makes it operative rather than decorative>
SMALLEST EDIT: <the minimum tool call or short sequence of tool calls
                that could plausibly resolve PROBLEM without touching
                anything under PRESERVE>
CONFIDENCE: <low / medium / high — see §9>
```

This is the literal, concrete form of "what is the smallest possible set
of pixel edits that fixes the highest-priority issue" — not "what image
should this become." The two framings produce measurably different tool
calls: the first is bounded by a described current state and a named
gap; the second has no boundary at all and defaults to redrawing.

This scaffold is a **prompted reasoning habit**, not a new tool or schema
field. It costs a few lines of text per issue (≤6 issues per round under
V3's `MAX_ACTIVE_ISSUES`), not per turn — see §11 for why that keeps token
cost proportional and small.

---

## 4. Principle-by-principle design

### 4.1 Minimal edits
**Instruction:** for every issue, default to the smallest tool footprint
that could plausibly resolve it, and treat a larger edit as something
that needs its own justification, not the default starting point.
**Concrete rule:** before any `fill_rect`/`flood_fill` call, the model
must be able to state (in the SMALLEST EDIT line) why a smaller edit
(`set_pixel`/`draw_line`, or a `fill_rect` no larger than the broken
feature itself) would not resolve the problem. If it can't state that, it
hasn't earned the larger edit yet.

### 4.2 Issue isolation
**Instruction:** work exactly one issue at a time, in the order given by
the plan's tiers (structural → features → rendering → composition/
background → polish), and **fully close or explicitly defer** an issue
before starting the next one — even two issues in the same tier. This is
a deliberate tightening of V3 §5, which allowed same-tier issues to be
worked "in any order or together." V4 narrows that: combining edits across
issues makes it harder to attribute a new problem (caught at the next
render) to a specific cause, which directly undermines regression-paranoia
(§4.6) and the confidence check (§4.9). Isolation is what makes both of
those checks meaningful instead of hand-wavy.
**Concrete rule:** don't touch a region belonging to issue B while working
issue A, even if it would be "efficient" to do both in one pass.

### 4.3 Preserve-first
**Instruction:** the PRESERVE line in the reasoning scaffold (§3) is
mandatory and must be **specific to the region currently being edited**,
not a restatement of the plan's global Preserve list. "What is immediately
adjacent to what I'm about to touch, that must not move?" is a different
(and more useful) question than "what did the evaluator say was good
somewhere in this image?" — the former is checkable against the very next
render, the latter isn't.
**Concrete rule:** if the model cannot name anything adjacent worth
preserving, it should say so explicitly ("no adjacent preserved detail")
rather than skip the line — an empty check is not the same as an omitted
one, and omission is how this erodes into decoration over time.

### 4.4 Surgical thinking — tool vocabulary reframe
The four existing `REPAIR_TOOLS` (`set_pixel`, `fill_rect`, `draw_line`,
`flood_fill` — unchanged, no new tools) are renamed **in the prompt's
vocabulary only** to match surgical intent instead of drawing intent:

| Tool | Surgical framing | Use for |
|---|---|---|
| `set_pixel` | **Point correction** | A single wrong pixel; nudging a feature by a pixel or two via a few of these. |
| `draw_line` | **Seam repair** | Connecting a broken outline, closing a gap, straightening one edge. |
| `fill_rect` | **Patch** | A small, bounded area that's uniformly wrong — never larger than the broken feature itself. |
| `flood_fill` | **Region replacement** | Only for a genuinely isolated, contiguous same-color area that is *entirely* wrong — never a region that contains any correct detail worth preserving, since flood fill cannot spare a single pixel inside its target region. |

**Instruction:** think "extend jaw by two pixels," "move eye one pixel
left," "connect this outline gap," "replace this isolated stray-pixel
cluster" — never "redraw the face," "redo the ears," "repaint the
background." If the internal description of the fix uses a verb like
*redraw/repaint/redo/recreate*, that's a signal the model has slipped
back into illustrator mode — the fix description should use verbs like
*nudge/extend/trim/connect/replace/patch*.

### 4.5 No artistic reinterpretation
**Instruction:** a revision's job is to make the `expectedResult` of a
named issue true. It is never to improve style, adjust proportions the
plan didn't flag, "clean up" adjacent details, or apply a preference the
model has about how the subject should look. This is stricter than V3's
existing default-deny (which governs *where* edits may land) — V4 adds
that *even inside an allowed region*, only the specifically-flagged
problem may be addressed, not anything else the model notices while it's
in there.
**Concrete rule:** noticing an unrelated imperfection while working an
issue is not license to fix it — it's either already covered by another
listed issue (handle it in its own turn, per §4.2) or it isn't listed,
which means the evaluator didn't flag it as something that needs fixing,
which means it stays.

### 4.6 Regression paranoia
**Instruction:** after every edit (or small group of edits addressing one
issue), before moving on, the model must look at the render and ask
specifically: *"what existing strength could this have damaged?"* — not
"does this look right" (which only checks the target), but "did anything
outside the target change." This is the single most load-bearing
self-check in this document, because it's the only point where the model
is asked to look for damage rather than progress.
**Concrete rule:** if the render shows any visible change outside the
region named in that issue's CURRENT/PRESERVE lines, treat that as a
regression against its own work-in-progress, immediately — undo or
correct it before continuing, rather than proceeding and hoping the final
evaluation doesn't notice. Self-caught regressions are free; evaluator-
caught regressions cost a full extra revision round (V3 §6.3 forces them
to critical severity, front-of-tier-1, next time).

### 4.7 Pixel budget (conceptual, not counted)
**Instruction:** given two edits that both plausibly resolve the same
issue, prefer the one that changes less. This is deliberately qualitative
— no exact pixel counting, no numeric budget tracked anywhere. The
operative form is a standing preference order, reusing §4.4's tool
framing: **point correction → seam repair → patch → region replacement**,
attempted in that order of ambition, stopping as soon as one plausibly
works. Treat "this seems to require a region replacement" as a prompt to
re-examine whether the problem was actually smaller than first assessed
before reaching for the biggest tool.
**Why conceptual, not counted:** a numeric pixel budget invites gaming
("I'll do it in exactly 5 set_pixel calls") without improving judgment;
a preference ordering over tool/edit *kind* shapes judgment directly and
degrades gracefully — the model isn't stuck if 5 pixels genuinely can't
fix it, it just has to have tried the cheaper options first.

### 4.8 Structural before cosmetic
**Instruction:** this is a hardening of V3's existing tier order (§5 of
the V3 doc), not a new idea — V4 makes it a hard behavioral gate instead
of a soft sequencing preference. **No cosmetic-tier edit (palette,
hue_shift, material, outline, cluster, lighting, composition, background)
may be attempted while any Tier 1 or Tier 2 issue (structural,
recognizability, trait_specific, face, eye) at critical or major severity
remains open.** Reasoning, stated plainly: a cosmetic fix applied before a
structural fix lands is frequently invalidated *by* the structural fix
(recoloring a region that's about to be reshaped is wasted work at best,
new collateral damage at worst) — this is the same "don't do work that
gets invalidated" logic V3 already used to justify tier ordering, just
enforced as a gate instead of a suggestion.

### 4.9 Stop early
**Instruction:** revision is **done** when every open critical- and
major-severity issue's `expectedResult` holds — not when the model feels
the image looks good, and not when the turn budget runs out. Once that
condition is met, **stop calling tools**, even if:
- minor-severity issues remain in the plan (they are opportunistic-only —
  see §4.10, attempt them only under high confidence and zero risk to
  already-fixed work, otherwise leave them for a future round exactly the
  way V3's lifecycle already expects unresolved issues to carry forward);
- turns remain in the budget (unused turns are a good outcome, not a
  wasted resource — this also directly reduces cost, a free win consistent
  with this tool's existing $5-budget discipline, though that's a side
  effect here, not the reason for the rule).
**Concrete rule:** "I still have turns left" is never a reason to keep
editing. "There's still an open critical/major issue" is the only reason
to keep editing.

### 4.10 Repair confidence
For each issue, before its first edit, the model estimates its own
confidence (the CONFIDENCE line in §3) and behaves accordingly:

- **High** — the region, the problem, and the fix are all unambiguous.
  Proceed with the full `repairStrategy`, smallest adequate tool, one
  focused pass, then the regression check (§4.6).
- **Medium** — the general direction is right but some detail is
  uncertain (exact pixel count to nudge, exact boundary of a patch).
  Proceed in smaller increments than a high-confidence fix would use,
  re-rendering between increments, and be willing to stop partway if the
  render doesn't confirm progress — a partial, safe improvement that
  measurably moves toward `expectedResult` is a legitimate outcome; it
  will correctly carry forward as a still-open (not regressed) issue
  under V3's lifecycle (§6.3 of the V3 doc), with severity escalating
  only if it stays unresolved for multiple rounds.
- **Low** — the model is not confident it has correctly located the
  problem or that its planned fix resolves it without side effects.
  Default to the single most conservative possible action (often one
  `set_pixel`/short `draw_line` nudging toward the described fix), render,
  and reassess before doing anything further. If still unsure after that,
  **prefer to leave the issue for a future round** rather than attempt a
  large low-confidence edit — a wrong small edit is cheap to recover from
  next round; a wrong large edit (a low-confidence "redraw") is exactly
  the failure mode this whole document exists to stop.

Confidence is a **reasoning discipline the model reports in its own
words**, not a persisted field, not a score fed back into `RepairPlan`,
and not something any code parses — see §11's non-goals. It exists purely
to change what the model attempts, not to be measured.

---

## 5. One-issue-at-a-time sequencing, restated as a rule

To make §4.2 unambiguous: within the revision job's turn budget, the
agent should structure its own work as a strict sequence —

```
for each issue, in tier order, then severity order, among open issues:
    reasoning scaffold (§3)
    if confidence is low and severity is minor: skip (leave for later)
    make the smallest edit(s) that address ONLY this issue
    render, regression-check (§4.6)
    if resolved (or, at medium/low confidence, safely improved): move on
    if not improved and confidence was high: reassess once, don't loop
        indefinitely on the same issue — a repeated failure is a signal
        for a future round with a different strategy (V3 §6.4), not for
        more turns in this one
stop as soon as all critical/major issues hold (§4.9)
```

This is guidance for how the model paces itself across the turns it
already has — it does not require any change to the turn loop, the
render-once-per-turn mechanic, or `maxTurns` handling in `agent-loop.ts`.

---

## 6. Revised `buildRevisionSystemPrompt` — full text

This replaces the V3 system prompt's body (the mechanical preamble —
coordinates, palette-as-indices, layer type — is unchanged and omitted
here for brevity; only the behavioral framing changes):

> You are a pixel surgeon repairing an existing trait — not an illustrator
> reinterpreting it. **Every existing pixel is correct unless a specific
> listed problem proves otherwise.** The burden of proof is on changing a
> pixel, never on leaving it alone.
>
> DEFAULT RULE (region): if a region is not named by an open repair item,
> it is off-limits — do not restyle, "improve," or reinterpret it, even if
> you would have drawn it differently.
>
> DEFAULT RULE (pixel): even inside a region you are allowed to touch,
> change only the specific pixels needed to resolve the named problem.
> Being allowed to touch a region is not license to redraw it.
>
> Before starting each issue, think briefly in this shape:
> `CURRENT / PROBLEM / PRESERVE / SMALLEST EDIT / CONFIDENCE`
> (low/medium/high). Prefer point correction (`set_pixel`) over seam
> repair (`draw_line`) over a patch (`fill_rect`) over region replacement
> (`flood_fill`) — reach for a bigger tool only once you can say why a
> smaller one would not resolve the problem. If your own fix description
> uses "redraw," "repaint," or "redo," stop — reframe it as a nudge,
> extension, trim, connection, or patch instead.
>
> Work one issue at a time, fully resolved or deliberately deferred,
> before starting the next — even two issues in the same tier. Never
> attempt a cosmetic-tier fix (palette, hue, material, outline, cluster,
> lighting, composition, background) while any structural/feature-tier
> issue at critical or major severity is still open.
>
> After every edit, check specifically for damage, not just progress:
> did anything outside this issue's region change? A regression you catch
> yourself is free; one the next evaluation catches costs a full round.
>
> At low confidence, make the smallest possible probe edit, re-render,
> and reassess before doing more — if still unsure, leave the issue for a
> future round rather than guess with a large edit. At high confidence,
> resolve it fully in one focused pass. Confidence is your own judgment
> call, stated briefly — nothing reads or scores it.
>
> Stop calling tools as soon as every open critical- and major-severity
> issue's "done when" condition holds. Minor issues are opportunistic
> only — attempt one only at high confidence and zero risk to work
> already done; otherwise leave it. Unused turns are a good outcome, not
> wasted budget — never keep editing just because turns remain.
>
> Human instructions (if present) outrank the repair plan — if they
> conflict with something under Preserve or Ignore, follow the human
> instruction and say so in your closing note.

---

## 7. Seed-message (`renderRepairPlanForPrompt`) — minor additive changes

The V3 rendering of Preserve/Do Not Modify/Ignore/tiered issues/deferred
count/success criteria is unchanged in structure. Two small additions,
both just framing text, no schema/field changes:

1. A one-line header before the tiered issue list, reinforcing scope
   discipline for this specific job:
   > *"Each issue below names its own region — treat everything else in
   > the image, including areas near these regions, as off-limits unless
   > it is separately named."*
2. Minor-severity issues, when present, get a one-line tag distinguishing
   them from the rest:
   > *"(minor — opportunistic only; do not attempt unless the fix above
   > is confident and low-risk)"*
   appended after a minor issue's "Done when" line, so the
   high-confidence/opportunistic framing from §4.10 is visible right at
   the point of use, not only in the system prompt.

---

## 8. How this interacts with V3's machinery (unchanged)

- **`RepairPlan` schema, tiering, `buildRepairPlan`** — untouched. V4 is
  entirely about agent behavior *given* a plan; it doesn't change how
  plans are built, matched across revisions, or escalated.
- **Regression detection (V3 §6.3)** — still the backstop. §4.6's
  in-the-moment self-check is meant to catch most regressions before they
  ever reach that backstop, not replace it; anything V4's self-checks miss
  is still caught by the next evaluation and forced to critical severity
  next round exactly as V3 already specifies.
- **Attempt escalation (V3 §6.4)** — unchanged. A medium/low-confidence
  partial fix that doesn't fully resolve an issue is not a failure of this
  design; it's the correctly conservative outcome, and the existing
  attempts-counter/severity-escalation machinery already handles a
  still-open issue across rounds without any change.
- **`REPAIR_TOOLS` (no `clear`)** — unchanged; §4.4 reframes the same four
  tools in the prompt's vocabulary, it doesn't add or remove any.

---

## 9. Token cost

The only new recurring cost is the reasoning scaffold (§3), and it's
proportional to **issue count**, not turn count: at most `MAX_ACTIVE_ISSUES`
(6, per V3) scaffolds per revision round, each a handful of short lines —
on the order of the same magnitude as one `RepairItem`'s own text, not a
per-turn tax. The regression self-check (§4.6) is even cheaper — a
one-line mental note the model already has the rendered image in front of
it to make. Against that: the stop-early rule (§4.9) is a net cost
*reduction* — fewer turns spent polishing past the point of "done" than
today's open-ended "keep going until you feel finished or run out of
turns" behavior. Net effect is expected to be roughly cost-neutral to
favorable, the same shape of argument V3 made for its own schema richness
in its own §10.

---

## 10. Non-goals (explicit, matching the brief)

Nothing in this document proposes or requires: an additional LLM agent or
call, a planner/executor split, ML, embeddings, training, a segmentation
or external vision model, or a coordinate-detection system. "Confidence"
in §4.10 is a **prompted reasoning habit reported in the model's own
text**, not a computed score, not a persisted field, not something any
code reads or branches on — resist the temptation to formalize it into a
schema field later without evidence that plain-text confidence reporting
isn't already doing the job. Every mechanism here is prompt text (§6, §7)
or a workflow/sequencing convention (§5) layered on the exact architecture
`pixel-forge-revision-v3.md` already specifies.

---

## 11. Traceability — principle → where it lives in the new prompt

| # | Principle | Where enforced |
|---|---|---|
| 1 | Minimal edits | §4.1, tool preference order in §4.4/§4.7, system prompt §6 ¶3 |
| 2 | Issue isolation | §4.2, §5 sequencing loop, system prompt §6 ¶4 |
| 3 | Preserve-first | §4.3, PRESERVE line in §3's scaffold |
| 4 | Surgical thinking | §4.4 tool reframe table, system prompt §6 ¶3 |
| 5 | No artistic reinterpretation | §4.5, system prompt §6 ¶1-2 |
| 6 | Regression paranoia | §4.6, system prompt §6 ¶5 |
| 7 | Pixel budget | §4.7, system prompt §6 ¶3 |
| 8 | Structural before cosmetic | §4.8, system prompt §6 ¶4 (hard gate, strengthens V3 §5) |
| 9 | Stop early | §4.9, §5 loop terminal condition, system prompt §6 ¶7 |
| 10 | Repair confidence | §4.10, CONFIDENCE line in §3, system prompt §6 ¶6 |
