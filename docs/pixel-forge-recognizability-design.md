# Pixel Forge — Recognizability Design (next phase, design only)

Status: **design only, no code**. Infrastructure (Phase 1 + 1.5) is proven —
this phase is purely about drawing *intelligence*: making generated
subjects actually read as what they were asked to be, using only
prompting, iterative generation, evaluation design, and a small
human-curated rule library. No training, embeddings, external vision
models, datasets, or fine-tuning.

## Diagnosis of the "nyan cat" failure

The evaluator passed every check (`cleanSilhouette`, `readableAtNativeSize`,
`noStrayPixels`, `transparentBgPreserved`) — correctly, the *pixel-art
hygiene* was fine. But nothing in the rubric ever asked "does this
specifically read as a cat." `matchesLayerType` checks the layer's
*role* (icon vs. accessory), not the *subject*. So a technically clean
blob-with-ears sailed through every gate that existed, because no gate
was ever aimed at subject recognizability.

Root cause, in the user's own framing: **Claude understands pixel-art
construction but has no forced checkpoint for "what specific features
make this object identifiable," and the evaluator can rubber-stamp a
vague resemblance because it's never asked to commit to a description
before grading itself.**

## Answers to the design questions

**Should the evaluator explicitly score recognizability?** Yes — but not
as a direct yes/no (too easy to rubber-stamp, as proven). Add a
**blind-description** step: before grading, the model must write a
free-text description of what the image looks like *as if seeing it cold*,
with no reference to the original prompt. Only after committing to that
description does it compare it against the intended subject. This is the
single highest-leverage change here — it converts "does this look right?"
(easy to answer yes reflexively) into "what does this actually look
like?" (forces an honest, falsifiable statement first).

**Should the system prompt contain visual checklists per object class?**
Yes, but at the *category* level, never the specific-object level — e.g.
a generic "animal head" checklist (species-appropriate ear shape, eye
shape, a nose/muzzle marker, one distinguishing detail), not a memorized
"here's how to draw a cat." Category-level keeps it generic and reusable;
object-level would be overfitting and would drift toward copying whatever
reference the category was written from.

**Should we introduce an internal "shape language" library?** Yes — this
*is* the "lightweight rule extraction" mechanism the user asked for: a
small, human-curated, versioned text file mapping broad categories to
required features and observed failure patterns. Entries are written by a
human after watching a real failure, describing the *generic lesson*
("round ears + dot eyes alone reads as generic creature, not cat — needs a
visible ear-notch/tuft and a small triangular nose"), never a specific
pixel template and never a reference to an existing character/collection.

**Should revisions reason about missing semantic features?** Yes — a
recognizability-driven revision should be structured as: (1) blind-describe
the current state, (2) diff against the category checklist to name
specifically what's missing, (3) only then edit. This mirrors exactly what
already works well in the refine loop's silhouette instructions, just
extended to semantic features instead of pure geometry.

**Should objects have required visual anchors?** Yes, as a *semantic*
checklist (required features), not new pixel-coordinate anchors — the
existing `anchor` field already covers spatial alignment; this is a
different, additive concept: "an animal head needs species-appropriate
ears + eyes + a muzzle marker + 1 distinguishing detail," checked by
name, not by coordinate.

**Should evaluation become stricter before accepting drafts?** Yes, via
the blind-description gate — but "stricter" here means *harder to fake*,
not more binary gates. The existing candidate → approved → rejected human
gate already stops anything from shipping unreviewed; this phase makes the
self-graded signal leading into that human review more honest.

## Mechanism additions (design, not implementation)

1. **`subjectCategory`** — new optional job param, sibling to the existing
   `layerType`/`anchor`. Free-text string for now (not a locked enum) so
   the testing stages below can discover the right category vocabulary
   before it hardens. When present, the matching entry from the shape
   library is folded into the system prompt as an additional section —
   purely additive, so traits generated without it behave exactly as
   today (no regression risk to what already works, e.g. the heart/star
   cases).

2. **Shape-language library** (`docs/pixel-forge-shape-language.md` or a
   structured file once stable) — entries shaped like:
   ```
   category: animal_head
   requiredFeatures:
     - species-appropriate ear shape and placement
     - eye shape consistent with the species
     - a nose/muzzle marker distinct from the fill color
     - at least one additional distinguishing detail (whiskers, marking, fur tuft)
   commonFailurePatterns:
     - "round ears + dot eyes + no nose reads as generic creature/bear/mouse, not the named animal"
   ```
   Purely descriptive text, curated by a human after each real test —
   never pixel data, never a reference image, never tied to a specific
   named character or existing collection.

3. **`submit_evaluation` gains** (design, not schema yet):
   - `blindDescription: string` (required) — free-text, written cold.
   - `recognizableAsSubject: boolean` — derived by comparing
     `blindDescription` against the intended subject, not asserted directly.
   - `missingFeatures: string[]` — when not recognizable, which checklist
     items are absent; directly feeds a revision prompt.

4. **Revision prompts**, when aimed at recognizability, should require the
   three-step reasoning above (describe → diff against checklist → edit)
   rather than "look at it and try again."

## Guardrails against copying / overfitting (explicit, since this matters a lot here)

- Library entries are abstract category rules only — geometry/topology
  descriptions, never references to specific existing IP, memes, or
  collections, and never embedded example images.
- No "golden example" pixel grids stored to imitate — only text rules
  describing what *went wrong* generically, never what to copy.
- Test prompts across the roadmap below should default to generic
  descriptive language ("a gray cat," "a five-pointed star") rather than
  named existing characters. Small hygiene note: the test prompt that
  surfaced this issue said "nyan cat," which itself names a specific,
  widely-recognized existing meme character — worth generalizing test
  prompts to avoid steering the system's own habits toward reproducing a
  particular known design, even though the *output* clearly didn't
  resemble it here.
- The category mechanism is strictly additive/opt-in — nothing about
  existing generation without `subjectCategory` changes.

## Testing roadmap

Each stage: what we're learning, what weaknesses we're hunting, what
should come out of it as a prompt change and an evaluator change. Process
for all stages: generate → human judges pass/fail on recognizability →
if fail, write **one** short generic rule into the shape library → retest
periodically to confirm the rule generalizes rather than overfits to the
one example that prompted it. Keep a lightweight running log (prompt,
canvas size, preset, verdict, rule added if any) — a plain changelog, not
a database, matching the "no ML" spirit. Prune/merge overlapping rules
every 10–15 cycles so the library stays small and general rather than a
pile of one-off patches.

### Stage 1 — Simple geometric icons (heart, star, skull, crown, mushroom)

- **Learning:** baseline construction competence on shapes whose defining
  features are almost purely geometric/topological (a star has N points,
  a skull has eye sockets + a jaw line) — a clean control group to isolate
  *construction* failures from *semantic-feature* failures before Stage 2
  introduces the harder problem.
- **Weaknesses hunted:** pixel-count/silhouette discipline, symmetry,
  whether the draft phase alone (no vision yet) already gets most of the
  way there, whether the model can count/place discrete features (star
  points, crown spikes) correctly.
- **Prompt improvements expected:** sharpen the generic (category-free)
  silhouette instructions already in the system prompt — e.g. "count the
  discrete points/lobes the shape name implies before drawing" for
  count-sensitive shapes (a star, a crown).
- **Evaluator improvements expected:** introduce and validate the
  blind-description mechanic here first, since correctness is easy to
  verify objectively (does the model's cold description say "5-pointed
  star" or something else) before applying it to harder, fuzzier subjects.

### Stage 2 — Simple living things (cat, dog, frog, fish, bird)

- **Learning:** this is the actual failure mode in hand. Does a
  category-level checklist ("animal head") meaningfully improve
  recognizability without hardcoding a per-animal template?
- **Weaknesses hunted:** the "generic blob with appendages" failure;
  confusable species (cat vs. bear vs. mouse — all "round head + round
  ears + dot eyes" without a differentiator); whether small distinguishing
  details (whiskers, muzzle shape) survive at 16–32px or get silently
  dropped under the existing pixel-budget instructions.
- **Prompt improvements expected:** author the first real
  `animal_head` shape-library entry from observed failures; test whether
  requiring the draft phase to name (in its own reasoning, before
  submitting) which specific features distinguish the target species from
  a generic round-eared creature improves first-pass results.
- **Evaluator improvements expected:** blind-description becomes load
  -bearing here — ask "what animal does this look like, if any, with no
  hint" and diff against the target; iterate the checklist itself based on
  repeated, specific mismatches rather than one-off fixes.

### Stage 3 — Wearables (glasses, helmet, crown, headphones, scarf)

- **Learning:** does the existing "accessory must look worn/attached"
  instruction (already added after the earlier heart-as-accessory finding)
  generalize across genuinely different wearable types, or does each need
  its own sub-checklist?
- **Weaknesses hunted:** a technically-attached object that still doesn't
  read as *that kind* of wearable (e.g. glasses drawn without a clear lens
  vs. frame distinction); whether one generic "needs a strap/attachment
  point" rule is too coarse.
- **Prompt improvements expected:** split "accessory" guidance into
  sub-categories (eyewear, headwear, neckwear, ear-worn), each with 2–3
  required features, still written generically (shape/topology, never a
  specific design) to avoid overfitting to one look.
- **Evaluator improvements expected:** extend blind-description to ask
  "what kind of wearable is this, and where would it attach on a
  character?" — checks object-type recognizability and the "wearable"
  semantic requirement in the same step.

### Stage 4 — Complex compositions

- **Learning:** does the accumulated library compose correctly when a
  single trait must satisfy two or more category checklists at once (e.g.
  an animal head plus eyewear, or a multi-part object like a
  crown-with-gems), and do new failure modes appear at higher detail
  budgets / larger canvas sizes (32–48px)?
- **Weaknesses hunted:** rule conflicts (a self-contained "icon" instinct
  vs. a "wearable needs context" instinct pulling against each other);
  detail-budget overload burying the silhouette; whether blind-description
  scales past single-subject description.
- **Prompt improvements expected:** guidance on composition order when
  multiple checklists apply (establish the base subject's required
  features first, then layer the secondary category's features as a
  modification — not simultaneously), plus a complexity-budget reminder
  scaled to canvas size.
- **Evaluator improvements expected:** a compound blind-description prompt
  ("describe every distinct element and what it's doing") and a
  `allRequiredElementsPresent`-style check against the compound checklist,
  item by item, rather than one holistic pass/fail.

## What's explicitly deferred

- Locking `subjectCategory` into a fixed enum — stays free-text until the
  four stages show what vocabulary actually recurs.
- Any UI for browsing/editing the shape library — it starts as a plain
  markdown file a human edits directly.
- Automated library maintenance (dedup/merge) — stays a manual, periodic
  human pass per the process above.
