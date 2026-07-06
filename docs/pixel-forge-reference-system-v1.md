# Pixel Forge — Reference System V1: Calibrated Construction References

Status: **design only, no code.** Evaluates a potentially large quality
lever *before* implementing Revision V4, per explicit instruction. Ends
with a priority recommendation, argued critically rather than assumed.

## Relationship to existing designs (read this first)

This is not a new idea in isolation — it overlaps heavily with two things
already in `docs/`/`reference-library/`, and a reader should know how they
relate before going further:

- **`pixel-forge-style-lab-plan.md`** already designed a `StyleProfile`
  object with almost this exact shape (analysis-time vision, generation-
  time text-only injection, human draft→approved gate, `sourceNote`
  provenance requirement) — but it assumed a reference is directly
  analyzable and said nothing about *calibration*. This document is the
  concrete, single-image, calibration-first version of that plan. **If
  built, this system should supersede/absorb Style Lab, not sit beside
  it** — one mechanism for "attach a style influence to a generation job,"
  not two. Every safeguard Style Lab specified (provenance required, never
  auto-approved, original images never reach a generation call) is kept
  here unchanged.
- **`pixel-forge-v3-design.md` Phase 1 (Generation Prompt V3)** proposed
  adding *generic* construction principles (outline philosophy, hue-shift,
  material separation, visual hierarchy, shape language, cluster
  discipline) to the shared system prompt — confirmed in this project's
  own audit to still be **unimplemented** (`buildSystemPrompt`'s
  instructional content is unchanged from before that audit). Reference
  packs are a *per-reference specialization* of the same categories Phase
  1 already covers generically. They are not a substitute for Phase 1 —
  see §7 for why the sequencing between these two matters a great deal.
- **`pixel-forge-revision-v4.md`** (surgical repair philosophy) is
  directly relevant to §5 below and to the final recommendation in §7.

---

## 1. Core idea, restated precisely

The user is not uploading an image. **The user is calibrating an
instrument.** The output of calibration is not "a picture Pixel Forge has
access to" — it's a small set of measured and observed *rules* about how
that picture was constructed. The original pixels are calibration input,
not generation input; they should be usable to derive a profile once and
should not need to be seen again after that.

**Inherit:** proportions, silhouette discipline, outline philosophy,
palette relationships (ramp length, hue-shift behavior, saturation
distribution), cluster density/texture style, lighting philosophy, visual
hierarchy, rendering discipline.

**Never inherit:** subject, identity, character, accessories, symbols,
logos, exact colors, exact composition.

The line between these two lists is exactly the line between *how
something was built* and *what was built* — and it's a real, defensible
line: two completely different characters can share an outline weight, a
palette-ramp length, and a head/body ratio without sharing anything a
person would call "the same design." That's the entire premise this
system is betting on, and it's the same bet Style Lab already made.

---

## 2. Calibration workflow

### Step 1 — Upload

Manual upload only, exactly as Style Lab specified: no scraping, no
auto-ingest. A non-empty provenance/rights statement is required before
anything downstream can happen — not optional metadata, a blocking field.
The uploaded file goes into a staging area the generation/revision
pipeline never reads from directly (see §5 of Style Lab — unchanged here).

### Step 2 — Interactive calibration

**What the user does:** zoom, pan, overlay and align a candidate pixel
grid, drag the grid's origin, and adjust the logical resolution (grid
cell count) until the overlay genuinely lines up with the image's real
authored pixel blocks. This is explicitly **not image editing** — no
pixel is altered in this step, only the *interpretation* of which source
pixels constitute one logical pixel.

**Should logical resolution be manual, auto-detected, semi-assisted, or
confirmed?**

| Approach | Pros | Cons |
|---|---|---|
| Manual only | Always correct once entered; no heuristic to get wrong | Asks a non-expert user to know something they usually don't (most people can't eyeball "this is a 34px-wide sprite upscaled 8x") — high abandonment risk |
| Fully automatic | Zero user effort; fast | **Silently wrong is the failure mode**, and it's a real one here, not hypothetical — see below |
| Semi-assisted (auto-propose, user adjusts) | Cheap starting point for the easy case, full correction power for the hard case | Requires building the overlay/adjustment UI regardless (see confirmation, below) |
| User-confirmed | The only step that's actually load-bearing regardless of which method proposes a value | Not an alternative to the other three — it's the mandatory last step of whichever one is used |

**This project already has direct, first-hand evidence that naive
automatic detection is unreliable across style diversity.** An earlier
exploration in this same project ran two successive grid-detection
heuristics over the 14-image reference-pack-002 set: the first
(`detect_grid.py`) degenerated to guessing a uniform "4px cell" almost
regardless of the actual image; the second, refined version
(`detect_grid2.py`) correctly reported *no* detectable periodicity
(confidence `f=1.00` at cell size 1 — i.e. "found nothing") for several
images that later, human visual inspection confirmed were genuinely
soft/anti-aliased styles (`milady.png`) rather than hard-edge pixel art —
a case where automatic detection *should* fail, and did, but silently
trusting either heuristic's output without a human look would have
produced a confidently wrong calibration for at least one of the two
versions on the very same test set this project already ran.

**Recommendation: semi-assisted, with mandatory confirmation.** Propose a
candidate grid using a cheap heuristic (see below), overlay it visibly,
and require the user to accept or drag it into place before calibration
can complete — never silently trust the proposal, and never force a
non-expert to start from a blank grid either. This mirrors the exact
"never auto-promote" discipline Style Lab and the trait-approval gate
both already use elsewhere in this project.

**What the proposal heuristic should conceptually do** (no implementation
detail): scan rows and columns of the source image for the distances
between color-boundary transitions, and propose the most common
("modal") such distance as the candidate cell size, with a simple
confidence signal (how consistent that modal distance is across the whole
image, not just one row). A high-confidence result pre-fills the grid
close to correct for the common case (clean, nearest-neighbor-upscaled
pixel art); a low-confidence result should visibly present as
low-confidence in the UI (e.g. a wide or absent initial grid) rather than
confidently overlaying a wrong guess — exactly the graceful-failure
behavior the historical experiment above actually exhibited once it was
refined.

**Optional sub-step — mark background:** let the user click (flood-select,
reusing the same contiguous-region idea `Canvas.floodFill` already
implements) the region(s) that are background rather than subject. Not
required for every reference, but it materially improves §2.4's silhouette/
negative-space measurements when present, and costs nothing to skip when
the reference has no clean single background (e.g. a full-bleed action
scene).

### Step 3 — Logical extraction

Once grid size, origin, and (optionally) background regions are
confirmed, the system stops working from the original PNG entirely and
produces a **logical image**: a small palette-index grid, exactly the
same data shape (`{ size, palette, pixels }`) Pixel Forge already produces
for every generated trait. That reuse is deliberate, not incidental — the
existing preview/render path (`Canvas.toPng`) can display the extracted
logical image with zero new rendering code.

**How each logical pixel's color should be resolved, conceptually:** not
by averaging the source pixels inside its cell. Averaging is actively
wrong for this purpose — a cell straddling a hard color edge with a few
anti-aliased transition pixels around it would average into a muddy
in-between color that was never actually "the" color a human reading that
sprite would name. Instead, take the **most frequent (mode) color** among
the cell's source pixels, optionally after a small tolerance-based
grouping of near-identical colors (compression artifacts, slight
anti-aliasing) into one bucket. The mode recovers what a human eye already
does automatically when reading pixel art at a glance: it discards the
edge-noise and reports the flat fill color the cell is "really" showing.

The result is a small, deduplicated palette (typically single digits to
low dozens of colors) plus a flat index array — ready for both rendering
(via the existing Canvas path) and for every measurement in Step 4.

### Step 4 — Reference analysis

Two layers, because they have genuinely different cost and reliability
characteristics — conflating them would either waste API calls on things
arithmetic can already answer, or claim arithmetic can answer things that
actually require a judgment call.

**Layer A — mechanical (pure arithmetic over the logical grid, zero API
cost, fully deterministic, re-computable at any time):**
- Logical resolution (confirmed width/height)
- Palette: the full hex list and its size
- Palette ramps: group palette colors by hue/lightness proximity (simple
  color-space clustering by numeric distance — not a trained model) into
  candidate material ramps, and report each ramp's step count
- Hue-shift presence per ramp: does hue actually rotate between the
  ramp's darkest and lightest step, or does only lightness change —
  directly the same measurement this project already made by hand for
  the LPC palette system (`palettes-analysis.md`), now made routine
- Outline color(s): the color that predominates at silhouette/region
  boundaries
- Outline thickness: measured in logical pixels
- Outline consistency: does the same boundary color/weight convention
  hold at internal seams (between attached parts) as at the external
  silhouette, or only externally
- Silhouette bounding box and margin relative to the full canvas
- Mirror symmetry (a plain left/right pixel comparison — a legitimate
  internal calibration number even though earlier analysis work in this
  project deliberately avoided reporting numbers like this *as the
  substance of a human-facing write-up*; used here purely as
  machine-consumed calibration data, not as a conclusion in itself)
- Cluster density: average contiguous same-color region size relative to
  canvas area — the arithmetic proxy for "flat, few large regions" vs.
  "busy, many small regions"
- Dithering/checkerboard texture detection: a repeating small-scale color
  alternation inconsistent with a smooth ramp, distinguished from a
  genuine flat-fill or gradient-banded region

**Layer B — semantic (one single one-off vision analysis call, forced
tool-call output, same Claude model already integrated elsewhere in this
pipeline — not a new or external model, and not one call per generation,
one call per reference pack):**
- Lighting philosophy: single consistent key light, flat/ambient, or
  self-illuminating accents present
- Visual hierarchy: what wins first-glance attention and why (contrast,
  saturation, position — not raw size)
- Shape language: is there a dominant soft-base-plus-sharp-accent pattern,
  fully soft, or fully angular construction
- Accessory scale/hierarchy, **if applicable** — how large is a
  hat/headwear/held-item relative to the head/body it's attached to
- Head/body ratio and eye construction, **if applicable** — bust-portrait
  vs. full-figure convention, eye scale/contrast strategy, whether an
  occlusion-substitution pattern is present (e.g. sunglasses standing in
  for eyes)
- Construction hierarchy notes: does headwear/hair frame the face as an
  outer layer with a shadow gap, or sit flush
- Negative space policy: background complexity relative to subject
  complexity
- An overall style-archetype tag (free text — e.g. "hard-edge bust
  portrait," "soft anime bust," "high-detail mecha") used later to gate
  which archetype-specific principles apply (mirrors
  `pixel-forge-universal-principles.md`'s own archetype-gated rules, e.g.
  "headwear is the dominant silhouette mass — except for integrated-armor
  archetypes")
- **Explicit exclusions**, generated by the same call: a short list of
  exactly what must never be carried forward from this specific reference
  — its subject, its specific accessories/symbols, its exact palette
  values, its exact composition. This is not boilerplate; it's the
  concrete, stored, per-pack instantiation of the never-copy list in §1,
  and it feeds directly into generation as active negative guidance (§4).

Where a category genuinely doesn't apply (an icon-style reference has no
"head/body ratio"; an abstract background reference has no "eye
construction"), the analysis should say so explicitly rather than force
an answer — fabricated structure is worse than an honest gap.

### Step 5 — Reference Pack (the stored object)

```
ReferencePack {
  id, name, description                 // human-authored intent
  status: 'draft' | 'approved' | 'archived'   // never auto-approved
  sourceNote: string                     // REQUIRED — provenance/rights

  originalImageRef: string               // staging-area pointer only —
                                          // never read by generation/
                                          // revision; kept for audit and
                                          // re-calibration only

  calibration: {
    logicalWidth, logicalHeight,
    originX, originY,                    // confirmed grid mapping
    backgroundRegions: [...] | null,      // optional, from Step 2
    confirmedBy: 'human', confirmedAt,
  }

  logicalImage: { size, palette, pixels } // Canvas-compatible — same
                                          // shape as a TraitAsset's own
                                          // pixel data; used only to
                                          // render a preview and to
                                          // (re)compute Layer A, never
                                          // sent to a generation call

  mechanicalAnalysis: { ... }             // Layer A, §4 — free to
                                          // recompute if calibration
                                          // changes
  semanticAnalysis: { ... }               // Layer B, §4 — the one-off
                                          // vision call's output;
                                          // human-editable before approval,
                                          // exactly like Style Lab's
                                          // analysis draft
  exclusions: string[]                    // the "never copy" list, always
                                          // shown alongside inherited
                                          // guidance, never dropped

  derivedPromptFragments: PromptTemplate[] // short reusable text pieces
                                          // built from the two analyses,
                                          // reviewable/editable by a human
                                          // before approval — same
                                          // mechanism as Style Lab's
                                          // promptTemplates

  preview: pngBase64                      // rendered from logicalImage,
                                          // via the existing Canvas.toPng
                                          // path — no new rendering code

  schemaVersion: number
  applicableArchetype: string | null      // from semanticAnalysis — used
                                          // for a soft mismatch warning
                                          // at generation time, §4
  createdAt, updatedAt, approvedAt
}
```

Preserving Style Lab's core safeguard exactly: **the original image and
the logical image are both stored, and neither is ever attached to a
generation or revision job.** Only `mechanicalAnalysis` +
`semanticAnalysis` + `exclusions`, folded into text, ever cross into a
job's prompt. A model cannot copy pixels it is never shown — this is a
structural guarantee, not a policy statement resting on good behavior.

---

## 3. Generation with a reference pack

```
today:     prompt                              → drawing
proposed:  reference pack (approved, optional)
           + prompt                            → drawing
```

An optional `referencePackId` job field, sibling to today's
`layerType`/`anchor` — **strictly additive**: a job without it behaves
exactly as today, zero regression risk to anything that already works
(same non-regression guarantee Style Lab specified for its own
mechanism).

**What concretely gets folded into the system prompt, and how:**

- **Palette ramp discipline, as structure, never as literal values** —
  "use N flat steps per material, dark to light, with hue rotating toward
  [warm/cool] at the highlight end," derived from `mechanicalAnalysis`,
  applied to whatever palette *this* job actually supplies. The
  reference's own hex values are never quoted into the prompt — only the
  ramp *shape* (length, hue-rotation direction, saturation-by-role
  pattern) is inherited. This is the sharpest edge in the whole design and
  worth stating twice: **structure is inherited, values are not.**
- **Outline discipline** — weight, and whether internal seams match the
  external silhouette's treatment — described qualitatively ("near-black,
  consistent weight, matched between base shape and attachments"), not as
  a copied hex.
- **Cluster/texture guidance** — "prefer large flat contiguous regions"
  or "controlled dither texture is expected at [X]," from
  `mechanicalAnalysis`.
- **Proportion guidance** — head/body ratio, silhouette margin, symmetry
  expectation — expressed proportionally (percentages/ratios) so it
  scales correctly to whatever canvas size the job actually uses, never
  as literal source-pixel coordinates.
- **Lighting philosophy, visual hierarchy, shape-language accent,
  accessory-scale, eye-construction, construction-hierarchy** guidance —
  folded in as additional prompt paragraphs exactly like the existing
  `layerType === 'icon' | 'accessory'` conditional sections already do,
  gated by `applicableArchetype`/relevance the same way Layer B marks
  "not applicable" categories as absent rather than forced.
- **An explicit negative-guidance paragraph**, built from `exclusions`:
  *"The following are NOT part of the inherited style and must not be
  reproduced: [subject], [named accessories/symbols], [exact palette
  values], [exact composition]."* This is an active instruction to
  forget, not a passive title on the feature — the single most important
  paragraph this system adds, given the entire premise rests on not
  copying.
- **A soft mismatch warning**, not a hard block, when `applicableArchetype`
  doesn't obviously fit the job's `layerType` (e.g. a bust-portrait-
  calibrated pack attached to a `background` job) — surfaced to the human
  who chose to attach it, consistent with this project's human-in-the-
  loop default everywhere else; never auto-refused.

---

## 4. Revision with a reference pack

This is the part most likely to go wrong if designed carelessly, because
"make this conform better to the reference" sounds exactly like the kind
of broad restyling `pixel-forge-revision-v4.md` was written specifically
to stop. Resolve the tension explicitly rather than leaving it implied:

**Reference conformance is primarily a generation-time concern.** It
should be baked into the first draft via §3, not retrofitted onto an
existing trait through revision. **Attaching a reference pack to a trait
that was never drafted against it, and asking revision to bring it into
conformance, is out of scope for "revision" as this project defines it —
that is regeneration, not repair**, and should be presented to the user
as such (a fresh draft against the pack), not routed through the revision
endpoint.

**What revision legitimately does with a reference pack:** if a trait
*was* generated with a pack attached, the evaluator has a more specific
standard to check future rounds against — and reference-conformance
failures are not a new issue category. They map directly onto categories
`RepairPlan` already has: a ramp with too few steps or no hue-shift is a
`palette`/`hue_shift` issue; an inconsistent outline is an `outline`
issue; a busier-than-calibrated cluster texture is a `cluster` issue. No
schema change, no new category — the reference pack just makes the
evaluator's existing categories more specific than the generic global
principles would be on their own.

**Which principles are effectively fixed vs. intentionally violable:**
logical-resolution/pixel-density consistency and outline weight/color
consistency should almost never be intentionally violated within one
collection — these are exactly the "fixed anchor"-style invariants that
make a set of independently-generated traits look like one coherent
collection (the same lesson LPC's fixed body/head-mount coordinates
teach, applied here without needing that heavier architecture). Palette
hue choice, accessory scale, and cluster density are much more reasonably
violable for a deliberate variant (a "legendary" trait meant to break the
mold). Either way, **the mechanism for recording an intentional deviation
is the one that already exists** — `intentionalChoices` on the evaluation/
RepairPlan — not a new field. A human approving a trait despite a flagged
reference-conformance failure (exactly the precedent already set by the
real, currently-stored "nyan cat" trait, approved despite failing its own
`matchesLayerType` check) is the same override mechanism, unchanged.

**How repairs must behave:** exactly like every other repair under
Revision V4 — minimal, region-scoped, one issue at a time, no wholesale
re-render "to match the reference better." A reference-conformance
repair strategy should read like *"shift the shadow-band index used on
the left ear to a hue-rotated darker entry instead of the flat-darkened
one currently there"* (one region, one targeted palette-index swap) —
never *"recolor the whole trait to match the reference's ramp."* Adding a
reference pack does not create a second, looser standard where broad
restyling becomes acceptable; it only makes the existing, already-strict
standard more specific.

---

## 5. Comparison: current pipeline vs. reference-guided pipeline

| Dimension | Assessment |
|---|---|
| Quality improvement | High, but bounded and non-substitutable — this targets construction fundamentals (proportion, palette discipline, outline consistency) that are today completely unaddressed for fresh drafts (confirmed absent from `buildSystemPrompt` in the original V3 audit). It does **not** address subject-recognizability failures ("Nyan Cat" class) — that's Evaluation V3's/Revision V4's territory, a different axis entirely. |
| Consistency improvement | Very high, specifically for multi-trait collections — today every trait is drawn in total visual isolation with no shared construction invariant at all (flagged as a real architecture gap in `pixel-forge-v3-design.md` §1.9). A reference pack is a materially cheaper partial answer to that gap than the heavier "named anchor-point/CollectionSpec" idea already deferred to that document's Phase 6 — this arguably delivers a large fraction of that phase's value at a fraction of its cost. |
| Implementation complexity | Medium-high — a genuinely new subsystem: upload handling, an interactive calibration UI (grid overlay, zoom/pan, origin drag — real frontend canvas-manipulation work), the Layer A arithmetic, one new one-off analysis tool call, a new `ReferencePack` store, and additive prompt wiring in both generation and revision. Substantially larger than Revision V4, which is prompt text only against already-shipped V3 infrastructure. |
| Maintenance cost | Medium, ongoing — calibration heuristics and cluster/dither thresholds may need retuning across style diversity (this project has already observed real heuristics behave inconsistently across just 14 references, §2), reference packs are yet another versioned stored object and another place for schema drift, and packs need occasional human re-review. Revision V4's maintenance cost is close to zero — it lives entirely in prompt text next to prompts that already exist. |
| Token cost | The analysis call is one-time per pack, not per generation, and amortizes well across reuse. Per-generation cost rises modestly (additional folded-in prompt text, roughly comparable in size to what the still-unshipped Phase 1 generic principles would already add). Comparable in shape to Revision V4's own token accounting, plus the one extra one-time analysis call per pack. |

---

## 6. Recommendation

**No — do not implement this before Revision V4. Ship in this order:**

1. **`pixel-forge-v3-design.md` Phase 1** (generic construction
   principles in the shared system prompt) — still unimplemented,
   already fully designed, pure prompt text, addresses the *same*
   "construction fundamentals are unaddressed" gap this document is
   worried about, at a fraction of the cost, using generic rules already
   validated by this project's own research.
2. **Revision V4** — already designed, pure prompt text against
   already-shipped V3 infrastructure, and directly fixes an
   *already-observed, evidence-backed* active failure mode (documented
   real regressions in this project's own stored data).
3. **Reference System V1** — only after 1 and 2 are live and have
   produced real generation/revision data.

**Why, argued critically rather than asserted:**

This is not a claim that reference packs are a weaker idea than Revision
V4 — long-run, calibrated construction references may well be the larger
total quality win, precisely because of the consistency argument in §5.
The claim is narrower and more important: **shipping this before Revision
V4 actively compounds the exact problem Revision V4 exists to fix,
instead of reducing it.**

A calibrated reference pack makes the evaluator's judgments *more
specific* — more precise ramp-length checks, more precise outline-
consistency checks, more precise cluster-density checks. More specific
evaluation means **more repair items, more precisely diagnosed**, landed
on a revision agent that — pre-V4 — still treats "fix this" as license to
redraw a neighborhood. Sharper diagnosis fed into an unreliable repair
mechanism doesn't produce better traits; it produces more frequent,
more confidently-triggered regressions, because there are simply more
findable things to "fix" badly. The single sentence that matters here:
**you cannot safely add a more sensitive smoke detector to a house whose
sprinkler system sprays random rooms.** Fix the sprinklers first.

There's a second, quieter reason: Revision V4 was commissioned *because*
this project had already measured Evaluation outrunning Revision. Adding
reference-pack-driven evaluation on top of that widens a gap this project
has already diagnosed and already designed a fix for, before that fix
ships. And practically — once reference packs exist, the very first
real-world test of whether calibration is working at all would run
through a revision mechanism already known to be unreliable, contaminating
any attempt to judge the reference system on its own merits. Sequence
the fix for the known-broken part before adding a feature whose success
depends on that part working.

---

## 7. Non-goals / scope discipline

Nothing here requires ML, embeddings, training, an external or additional
vision model, a segmentation model, coordinate-solving, or a multi-agent
system. The "Layer B" one-off analysis call uses the same Claude model
already integrated for generation and evaluation, doing one more
forced-tool-call job — the same architectural pattern `submit_draft` and
`submit_evaluation` already establish, applied once per reference pack
rather than once per generation. Every arithmetic measurement in Layer A
is deterministic color/geometry math over an already-extracted palette-
index grid — sorting, distance thresholds, run-length counting — not a
trained or learned component of any kind.
