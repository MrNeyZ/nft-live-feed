# Pixel Forge V3 — Engineering Design Blueprint

Status: **design only, no code changes.** This document is the audit +
blueprint requested to turn the reference-library research into concrete
engineering work. It assumes the reader has NOT read the source research —
conclusions are restated with enough context to act on, not just cited.

## Sources reviewed

- `src/pixel-agent/agent-loop.ts`, `tools.ts`, `canvas.ts`, `store.ts`
- `src/server/tools-pixel-forge.ts`
- `docs/pixel-forge-recognizability-design.md` (design, unimplemented beyond Tier 1)
- `docs/pixel-forge-style-lab-plan.md` (design, fully unimplemented)
- `docs/pixel-forge-testing-log.md` (empty log, process only)
- `reference-library/lpc/lpc-style-guide.md` + `pixel-forge-lessons.md` (synthesis of 15 per-category reports over 144,699 LPC sprite files)
- `reference-library/lpc/{eyes,head,hair,hat,facial-accessories,body,palettes}-analysis.md` (spot-read for detail behind the synthesis)
- `reference-library/reference-pack-002/pixel-forge-universal-principles.md` + `pixel-forge-v2-roadmap.md` (15-principle synthesis of 14 bust/mecha/creature references)
- Two real stored trait records in `data/pixel-forge/traits/` — used as ground truth for the evaluation critique, not hypothetical

**`reference-library/reference-pack-001/` does not exist anywhere on this machine.** It is referenced in the brief but there is no such directory under `reference-library/`, only `lpc/` and `reference-pack-002/`. This document proceeds on the two packs that do exist. Recommend either creating reference-pack-001 or removing it from future briefs — flagging rather than guessing at its contents.

## What's already right (do not disturb without reason)

- Forced tool-call schemas (`submit_draft`, `submit_evaluation`) for every structured hand-off — no prose parsing, no JSON-in-text.
- Palette-index color model (0 = transparent, 1..N = hex) — bounds every edit to a fixed swatch, prevents color drift across turns.
- Human approval gate (`candidate` → `approved`/`rejected`) never bypassed by AI — self-evaluation is explicitly advisory, not authoritative, in both code comments and behavior.
- Cost discipline: render-once-per-turn (not per tool call), hard turn cap, `shouldStop` checked before every model call including evaluate, Opus gated behind an explicit env flag, per-preset turn defaults. This is a stated $5-budget tool and the code treats it that way.
- The Tier-1 recognizability paragraph (2–4 uniquely-defining-features instruction + `missingFeatures` on evaluation) is shipped and, per stored data, does produce specific, useful output when it fires.
- The style-lab design's core safeguard — reference images are seen only by a one-off, human-gated analysis step; a generation job only ever receives abstracted text/palette, never the source images — is the correct anti-derivative boundary and should be preserved exactly as designed when Phase 5 is built.

This review's job is to find what's missing, not to relitigate the above.

---

## 1. Gap Analysis

### 1.1 Generation system prompt — topic-by-topic

`buildSystemPrompt()` (agent-loop.ts:211–288) is one shared string reused for draft, refine, and evaluate. Checked against every topic the research corpus treats as load-bearing:

| Topic | Current behavior | Research conclusion | Why they conflict | Quality impact | Priority | Complexity |
|---|---|---|---|---|---|---|
| Silhouette-before-detail | One sentence in the draft section: "block out the overall recognizable outline first... then fill, then add small details last." Not re-asserted during refine turns. | LPC lesson #2 (critical): silhouette-first, layer-additive construction is the single most-repeated structural rule across 21 categories. reference-pack-002 principle 3: identity survives on 2–4 large masses. | Present but thin — stated once at draft time, never reinforced once the refine loop starts spending turns on detail. | Medium — early passes are fine; later turns can erode a good silhouette with unchecked detail edits, and nothing re-anchors it. | Medium | Small (prompt wording + one loop checkpoint) |
| Visual hierarchy (what should win first-glance attention) | Not mentioned anywhere in the prompt. | reference-pack-002 principles 1, 9, 13: contrast/saturation/position — not size — determine first-glance priority, and this is designed, not accidental (LPC's own 3-tier hierarchy: base silhouette → primary equipment slot → small high-contrast accessories). | Total absence — the model has no vocabulary to reason about *which* feature should draw the eye first, so it can't deliberately design for it. | High — this is exactly the kind of thing that separates "technically clean" from "reads as intended," which is the whole failure class in the stored nyan-cat record (see §2). | High | Small (prompt paragraph) |
| Cluster discipline (cluster shape ↔ material) | "Prefer a few large, deliberate regions over many scattered small edits" — a crude anti-noise instruction, not a material-signaling system. | reference-pack-002 principle 4 + LPC lesson #1/#9: cluster *geometry* (regular ribbed, soft blob, pseudo-random, concentric radial, repeated small-per-hair-type) is itself a representational channel distinguishing metal/glossy/organic/energy/fur. | Current instruction only prevents visual noise; it says nothing about *choosing* a cluster pattern to signal a material. | Medium-High for anything beyond flat single-material icons (accessories, bodies with mixed materials). | Medium | Medium (needs a short "cluster vocabulary" reference table in-prompt) |
| Hue shifting | Not mentioned. Palette is a flat, un-annotated list of 16 hex strings with no ramp/material grouping. | LPC's #1 critical lesson, backed by machine-read JSON data (not inference): every material ramp is 6 flat steps, shadow steps rotate hue (not just darken), confirmed numerically (`#99423c`→`#7F4C31` type shifts). reference-pack-002 principles 5 & 6 independently converge on the same rule from a different corpus. | Total absence, and it's structurally hard to fix as long as the palette is an arbitrary flat list — the model has no way to know "these three indices are a ramp" because nothing tells it. | High — this is called out in both research packs as the single highest-leverage lever on perceived color/material quality. | **Critical** | Medium (needs both a prompt instruction AND restructuring `DEFAULT_PALETTE` into named ramp groups — see 1.9) |
| Material separation (distinct rendering technique per material) | Not mentioned. | reference-pack-002 principle 8 + LPC lesson #9: 3+ distinct techniques for complex subjects, material-as-shading-parameter on a fixed silhouette. | Absent; the model has one undifferentiated "shade it" instinct regardless of how many materials a prompt implies. | Medium-High, scales with prompt complexity (a "robot knight" needs this; a plain heart icon doesn't). | Medium | Medium |
| Accessory hierarchy | Icon-vs-accessory distinction exists (icon = self-contained, accessory = needs a strap/attachment point) — a real, useful, already-shipped rule. Nothing about accessory *scale* relative to what it composites onto, and nothing about the integrated-armor/aura exceptions. | reference-pack-002 principles 2 & 12: headwear/accessories should be an outer frame strictly larger than the face inset, with a cast-shadow gap; "largest silhouette mass = identity anchor" is gated by archetype, not universal. | Partially covered (attachment semantics) but the *sizing/placement relative to a face* half of the rule is structurally uncheckable today — see 1.9, this is an architecture gap, not just a missing sentence. | Medium | Medium (prompt part is small; full fix depends on 1.9's anchor-image gap) | 
| Shape language (soft base + one sharp accent) | Not mentioned. | reference-pack-002 principle 1 — validated independently across every one of 14 unrelated-style references; the single most consistently-confirmed rule in that corpus. | Total absence. | Medium — affects "memorable silhouette" quality specifically, less about correctness than distinctiveness. | Medium | Small (prompt paragraph) |
| Negative space / background budget | `background` is its own `LayerType`, generated in total isolation from whatever character it will sit behind. Nothing in the prompt addresses background complexity at all. | reference-pack-002 principle 13: background detail budget should scale *inversely* with the character's own complexity — a designed relationship, not two independent choices. | Structurally impossible to satisfy today: a background job has zero information about the character-trait(s) it will be composited with. | Medium (currently: no correctness signal either way, since there's nothing to check against) | Medium | Medium — needs a `complexityHint` param, not a new subsystem (see Phase 1 / 4.6) |
| Eye construction | `eyes` is a `LayerType` with zero eye-specific guidance anywhere in the prompt. | LPC eyes-analysis.md: fixed-anchor substitution-set for emotion, extreme scale-appropriateness (2–4px at 64px canvas), never resized/moved. reference-pack-002 principle 9: eye-zone must contain *some* high-contrast occupant, literal rendering optional. | Total absence of category-specific guidance for a layer type that exists explicitly in the schema. | High for any collection actually shipping distinct eye traits — this is a directly load-bearing, already-modeled layer type getting zero of the applicable research. | High | Small (prompt paragraph, `layerType === 'eyes'` branch exactly like the existing icon/accessory branches) |
| Head/body proportions & anchor points | A single free-text `anchor` string per job — an ad hoc hint, not a system. No notion of a fixed neck/collar/waist coordinate shared across a trait set. | LPC lesson #4 (critical): fixed anchor points per attachable category is what lets independently-authored assets combine at scale; body-analysis.md confirms head-mount row never moves across 6 different body types. | The `anchor` field is the right *shape* of idea (a spatial hint) but it's per-job free text, not a systemic invariant checked across a whole trait library. | High for any real multi-trait collection (misalignment is the single most visible composite-time defect class); currently invisible because nothing has been composited yet. | High | Large — this is a real data-model extension, not a prompt fix (see Phase 6) |
| Outline philosophy | **Not mentioned anywhere in the system prompt.** | LPC lesson #3 (critical, measured at 89% of sampled assets) + reference-pack-002 principle 10: outline marks object boundaries not shade boundaries; density scales with mechanical vs. organic; color is usually near-black with two narrow, deliberate exceptions. | Total, surprising absence given how heavily both research packs weight this — the model currently has no instruction at all about when/whether to use its outline tool deliberately vs. incidentally. | High — outline behavior is highly visible and currently entirely improvised per-generation with no consistency rule. | **Critical** | Small (prompt paragraph — cheapest fix in this table relative to its measured impact) |
| Palette economy | Implicit: model is bounded to whatever palette it's given, but nothing instructs *how many* of the available colors a clean asset should use, or that decoration below a size threshold should waive the outline rule. | LPC palettes-analysis.md: mean 6.0 unique colors per single-material asset, matching ramp length almost exactly — evidence assets are drawn to use the *whole* ramp, not 2–3 of it. Lesson #12: outline waiver below a size threshold. | Not contradicted, just unaddressed — economy is accidental, not directed. | Low-Medium | Low | Small |
| Readability at native size | Explicit in both the draft/refine instructions and the evaluation checklist (`readableAtNativeSize`). One of the strongest-covered topics already. | Matches research emphasis directly. | No conflict. | — | — (already good) | — |

**Root-cause note:** four of the "Critical/High" rows above (hue shifting, material separation, accessory sizing, background budget) all trace back to the same two structural facts, not four separate prompt-wording problems: (a) the palette is a flat, unstructured hex list, and (b) every trait is generated in total visual isolation from anything it will be composited with. Fixing wording alone caps how much these can improve — see §1.9.

### 1.2 Draft prompt

| | |
|---|---|
| **Current behavior** | One forced `submit_draft` call, no vision, must emit exactly `size²` integers. Instructed to mirror symmetric subjects and build silhouette before detail. |
| **Research conclusion** | LPC/reference-pack-002 both treat silhouette-first as foundational; recognizability-design.md's own Stage-1 test plan calls for explicit point/lobe *counting* for count-sensitive shapes (a star has N points, a crown has N spikes) before drawing. |
| **Why they conflict** | The draft instructions cover silhouette order and symmetry but never ask the model to explicitly count/name discrete defining features before emitting pixels — the exact gap recognizability-design.md's own Stage 1 plan flags as untested. |
| **Quality impact** | Medium — affects count-sensitive subjects specifically (stars, crowns, multi-pointed anything); the draft is a single forced call with no vision, so a wrong count here can't self-correct until a refine turn actually looks at the render. |
| **Priority** | Medium |
| **Complexity** | Small — one added sentence: name/count the discrete defining features before emitting the array. |

### 1.3 Refine prompt

| | |
|---|---|
| **Current behavior** | Shared system prompt + free tool-use loop; one render per turn folded into the next user turn; ends on first turn with no tool calls or at `maxTurns`. |
| **Research conclusion** | No specific refine-loop mechanic contradicted by the research (loop mechanics aren't a research-corpus topic) — but recognizability-design.md explicitly proposes a three-step **describe → diff against checklist → edit** reasoning shape for any recognizability-driven revision, which the *current* refine loop never performs even once, including inside the very first drawing job. |
| **Why they conflict** | The refine loop's only self-correction instruction is "look at the render and judge it as a stranger would" — a single vague imperative, not the structured describe-first discipline recognizability-design.md itself already designed (just never implemented, and never even scoped to apply mid-refine, only at final evaluation). |
| **Quality impact** | High — this is the mechanism that would catch a drifting silhouette *before* the turn budget runs out, not just at the very end when it's too late to cheaply fix. |
| **Priority** | High |
| **Complexity** | Small-Medium — inject one structured checkpoint message partway through the loop (see Phase 4), no new tools or calls. |

### 1.4 Evaluation prompt

| | |
|---|---|
| **Current behavior** | One forced `submit_evaluation` call, sharing the **entire prior conversation** (system prompt + every draft/refine turn + every render) — the same context window that did the drawing does the grading. Inline instruction demands harsh grading, "as a stranger," comparison against the literal prompt text. |
| **Research conclusion** | recognizability-design.md's own diagnosis of the "nyan cat" failure: the model can rubber-stamp a vague resemblance because it's "never asked to commit to a description before grading itself." Proposed fix (never implemented): a forced **blind-description** step before any boolean verdict. |
| **Why they conflict** | Two separate problems, both still open: (1) no blind-description step exists in the shipped schema at all — confirmed by grep, zero occurrences of `blindDescription` anywhere in the codebase; (2) even if blind-description were added, the evaluation call still runs in the same conversation that drew the image, so "as a stranger seeing it for the first time" is asked of a model that has its own drawing intentions sitting a few turns back in context — genuine anchoring bias the current architecture can't remove. |
| **Quality impact** | **Critical**, and not hypothetical: the stored trait `b428ab3d…` ("nyan cat head icon") was graded `matchesLayerType: false` with a note explicitly stating it "only gestures at a generic cat face, not the specific recognizable Nyan Cat character" — and was still moved to `status: approved` by a human, because the self-eval, while honest in its notes, never forced a cold, prompt-blind description that would have made the gap harder to wave past. This is the exact failure class the design doc predicted, still live in production data. |
| **Priority** | **Critical** |
| **Complexity** | Medium — blind-description field is small; fresh-context call (new point 2) is a bigger but still bounded change (one extra lightweight API call with a trimmed message list, no new infrastructure). |

### 1.5 Evaluation schema

| | |
|---|---|
| **Current behavior** | `Evaluation`: 5 booleans (`cleanSilhouette`, `readableAtNativeSize`, `noStrayPixels`, `transparentBgPreserved`, `matchesLayerType`) + `missingFeatures: string[]` + `notes: string`. No schema version field. |
| **Research conclusion** | recognizability-design.md's own proposed schema (unimplemented) adds `blindDescription` and `recognizableAsSubject` derived *from* it. Neither reference pack asks for more booleans in general — the gap is specificity of what's checked, not count of fields. |
| **Why they conflict** | (1) `matchesLayerType`'s description conflates two different questions — "is this the right kind of layer" (icon vs. accessory) vs. "does this match the *specific* subject in the prompt." The nyan-cat record fails it for the second reason while every other field about the *icon* itself (clean silhouette, no stray pixels) is true — the schema has no field that isolates "generic-but-correct-category" from "wrong category entirely," so a human reading the record has to parse prose notes to know which failure happened. (2) `cleanSilhouette` and `readableAtNativeSize` overlap heavily in practice — both ultimately ask "is the shape unambiguous" — without a clearly differentiated failure mode for each, they're likely to move together on almost every record, reducing their combined signal versus one well-specified check. (3) No version field: the second stored record's evaluation JSON is missing `missingFeatures` entirely, meaning either an older schema shape was persisted un-migrated or the field silently didn't fire — undetectable today because nothing stamps which schema shape a record used. |
| **Quality impact** | High — a coarse/overlapping schema is exactly what let a specific-vs-generic failure ship to `approved`. |
| **Priority** | High |
| **Complexity** | Small (splitting the conflated field, adding a schema-version stamp) to Medium (adding the new ramp/outline/hierarchy checks from 1.1). |

### 1.6 Revision prompt

| | |
|---|---|
| **Current behavior** | `runRevisionJob` seeds the canvas from stored pixels and sends exactly one message: *"Revise this existing {layerType} layer. Current state shown below. Instructions: {revisionPrompt}"* — `revisionPrompt` is whatever free text the human typed into the revise box. The prior evaluation record (`missingFeatures`, `notes`) is **never read or attached** anywhere in `runRevisionJob` or the `/traits/:id/revise` route — confirmed by reading both files in full. |
| **Research conclusion** | recognizability-design.md: revisions should be **describe → diff against checklist → edit**, not "look at it and try again." testing-log.md's own manual process explicitly assumes a human will "use the Copy for revision button... confirm a revision using that exact text" — i.e. the design already assumes `missingFeatures` should flow into a revision, it just was never wired server-side. |
| **Why they conflict** | The stored evaluation is the single most specific, already-computed diagnosis of what's wrong with a trait, and it is silently discarded the moment a revision job starts — the human has to manually re-type or copy-paste it into the prompt box for it to have any effect, and nothing confirms afterward that the specific issue actually got fixed. |
| **Quality impact** | High — this is a cheap, already-collected signal being thrown away at exactly the moment it would be most useful. |
| **Priority** | High |
| **Complexity** | Small — the data already exists in the stored `TraitAsset`; this is a wiring change (see Phase 3), not new capability. |

### 1.7 Generation loop

| | |
|---|---|
| **Current behavior** | draft (or seed) → refine loop (≤ `maxTurns`) → one evaluate call. Render once per turn. Hard cap 15 turns regardless of preset. |
| **Research conclusion** | No research-corpus objection to this shape — it is a sound, cheap loop. The gap is entirely about *what happens inside it* (covered in 1.1/1.3), not the loop's control flow. |
| **Why they conflict** | They don't, structurally — flag this explicitly so Phase 4 doesn't get read as "rebuild the loop." |
| **Quality impact** | — |
| **Priority** | Low (preserve as-is) |
| **Complexity** | — |

### 1.8 Agent orchestration

| | |
|---|---|
| **Current behavior** | Single model, single conversation thread carries draft → refine → evaluate. No second model call, no independent critic, no multi-candidate generation. |
| **Research conclusion** | Neither research pack asks for a multi-agent architecture — this finding is sourced from the *engineering* critique this brief specifically asked for (fresh eyes vs. anchoring), not from the reference libraries. |
| **Why they conflict** | The existing code comment already states the intent ("judge it as a stranger seeing it for the first time would") — the single-conversation architecture makes that literally impossible to fully satisfy, since the evaluating turn shares full context with the drawing turns. |
| **Quality impact** | High, same underlying cause as 1.4. |
| **Priority** | High |
| **Complexity** | Medium — one additional lightweight, short-context API call per job. Explicitly **not** a multi-agent critic swarm — that would violate the brief's own "avoid feature creep" instruction and multiply cost on a stated $5-budget tool for a gain the corpus doesn't ask for. |

### 1.9 Engineering assumptions embedded in the pipeline

These are the structural facts that several 1.1 rows trace back to — listed once here instead of repeated per-row:

1. **`DEFAULT_PALETTE` is a flat, unstructured 16-hex list** with no material/ramp grouping and no metadata distinguishing "these 3 indices are a skin ramp" from "these are unrelated accent colors." This directly blocks the hue-shift and palette-economy rows in 1.1 from being fully addressable by prompt wording alone.
2. **Every trait is generated in total visual isolation.** A `body`, `eyes`, `accessory`, or `background` job never sees any other trait it will eventually be composited with — no reference silhouette, no size context, nothing. This blocks the accessory-sizing-relative-to-a-face and background-complexity-budget rows in 1.1 from being more than aspirational prompt text; there is currently nothing for the model to size or budget *against*.
3. **The `anchor` field is a free-text, per-job hint, not a system.** There is no shared, named coordinate system (head-mount row, collar row, waist row) enforced across a trait library the way LPC enforces one across 6 body types and hundreds of thousands of assets. This is the biggest true gap for anyone assembling multiple Pixel Forge traits into one coherent character later.
4. **Style Lab is 100% unimplemented.** `docs/pixel-forge-style-lab-plan.md` is a complete, sound design (confirmed by reading it in full) but grep confirms zero occurrences of `StyleProfile`, `styleProfileId`, or any related type anywhere in `src/`. This is the mechanism explicitly designed to carry reference-pack-002/LPC lessons into real jobs, and it doesn't exist yet — right now the *only* place this research can land is inside the shared, global system prompt (Phase 1), which cannot express "this collection uses a saturated-background/desaturated-character palette logic" as a per-collection choice.
5. **Recognizability Tier 1 shipped; Tiers 2+ did not**, and production data proves the gap is real today, not theoretical (§1.4/§2).

---

## 2. Evaluation Critique

Answering the brief's specific questions directly, grounded in the two real stored records read for this audit:

**What important artistic failures can currently pass?** Anything where the render is technically clean (good silhouette, no stray pixels, correct transparency) but generic relative to a *specific* named subject — proven by `b428ab3d…`, approved despite its own notes stating it doesn't show Nyan Cat's rainbow trail, pop-tart body, or tan/pink coloring. Also unchecked entirely: palette-ramp/hue-shift discipline, outline consistency, material-technique differentiation, shape-language distinctiveness, and (for accessories/backgrounds) any size/complexity relationship to what they'll composite with — none of these have any representation in the schema, so nothing can fail them, they simply aren't asked about.

**What important failures are never checked?** The five items just listed, plus: whether the model actually built the silhouette before the details (no process check, only an outcome check); whether decoration stays inside the base shape's silhouette (LPC lesson #13); whether a small decorative element correctly waived the outline rule instead of spending its entire pixel budget on a border (LPC lesson #12).

**Which checks are redundant?** `cleanSilhouette` and `readableAtNativeSize` are highly correlated in practice — both are, at bottom, "is the shape unambiguous," just asked at two different described distances. They aren't harmful, but they don't carry two independent bits of signal today. Recommend keeping both only if their descriptions are sharpened to fail independently (e.g. `cleanSilhouette` = shape topology is right; `readableAtNativeSize` = topology is right but detail density is too fine to survive the target resolution) — otherwise merge.

**Which checks should become mandatory?** Blind-description before any boolean verdict (proven necessary by the nyan-cat record) and a fresh-context evaluation call (removes anchoring bias the current architecture structurally cannot avoid). Both are Critical/High priority in §1.4/§1.8.

**Which checks should produce actionable revision instructions?** `missingFeatures` already reads as a revision-ready checklist when it fires — the gap isn't the field's design, it's that nothing downstream ever consumes it (§1.6). Fixing that wiring makes the *existing* field far more valuable without changing its shape.

---

## 3. Revision Critique + Optimal Workflow

**Should revision continue to operate with vague instructions?** No — and the codebase's own adjacent design doc (recognizability-design.md) and process doc (testing-log.md) already agree; the gap is that neither the schema nor the revision route were ever updated to act on that agreement (§1.6).

**Optimal revision workflow, described (not coded):**

1. When a revision is requested against an existing trait, the backend loads that trait's stored `evaluation` (already available via `getTraitAsset`) and constructs a **structured repair brief**: the prior `blindDescription` (once Phase 2 ships), the prior `missingFeatures` list, and the prior `notes` — presented as a checklist, not prose to re-parse.
2. The human's free-text revision instructions are layered *on top of* that checklist, not as a full replacement for it — both are real signal and neither should silently override the other. If the human's text and the stored checklist conflict (e.g. human asks for a change that would undo a previously-fixed item), that's surfaced, not silently resolved.
3. The revision job's seed turn requires the model to state which checklist items it intends to address before making its first edit — mirroring the describe → diff → edit shape recognizability-design.md already specified for evaluation, applied here to revision instead.
4. At the end of the revision's refine loop, the same (Phase 2) blind-description + evaluation step runs again, and the new `missingFeatures`/`blindDescription` is **diffed against the prior record's**, so the stored result can state plainly which specific prior complaints were resolved and which, if any, persist — this is what turns "we revised it" into "we verified the thing that was wrong is no longer wrong."
5. Human approval remains the only path to `approved`, unchanged — this workflow makes the signal feeding that human decision honest, it does not remove the human gate.

This is entirely a wiring + prompt-construction change against data that already exists in `TraitAsset` — no new storage, no new endpoints beyond what Phase 2/3 already need.

---

## 4. Pixel Forge V3 — Phased Design

Each phase is independently deployable. Dependencies are called out explicitly; where absent, assume none.

### Phase 1 — Generation Prompt V3

**Goal:** close the 1.1 gaps that are pure prompt-content problems (visual hierarchy, cluster discipline, hue-shift instruction, material separation, shape language, outline philosophy, palette economy, eyes-specific guidance, draft-time feature counting).

**What changes:**
- Restructure `buildSystemPrompt()` into clearly labeled sections (it's currently one undifferentiated block of prose): Construction Order, Outline Philosophy, Palette & Hue, Material Rendering, Visual Hierarchy & Shape Language, then the existing per-`layerType` branches extended to cover `eyes` (new) alongside the existing `icon`/`accessory` branches.
- Add the outline-philosophy paragraph (object-boundary-only rule; internal-vs-external weight; small-object outline waiver) — flagged Critical in 1.1, cheapest fix relative to impact.
- Add the hue-shift instruction, scoped to work with an arbitrary supplied palette (e.g. "when shading a form, prefer palette entries that shift hue toward warmer/cooler as well as lighter/darker, not just the nearest darker index") — paired with the `DEFAULT_PALETTE` restructuring below.
- Add visual-hierarchy and shape-language paragraphs (both are single, well-scoped additions per 1.1).
- Add cluster-discipline vocabulary (map: regular rectilinear → machined; soft irregular blob → glossy specular; pseudo-random irregular → organic/camo; concentric radial (never outlined) → energy/glow; repeated small clusters shaped to hair-type → fur/hair).
- Add draft-time feature counting for count-sensitive shapes (1.2).
- Restructure `DEFAULT_PALETTE` from a flat 16-hex list into named ramp groups (e.g. skin/cloth/metal/accent), each internally ordered dark→light — a data change, not a prompt change, but required for the hue-shift instruction to have something concrete to point at. Custom palettes supplied by a caller remain free-form; the ramp grouping is a *default-palette* improvement, not a new constraint on user-supplied palettes.

**Non-goals:** no change to tool schemas, no change to the loop, no change to evaluation.

**Testing:** reuse the existing recognizability-testing-log.md process — generate, human-judges, log, promote only on recurring evidence. Add columns for outline consistency and hue-shift presence specifically, since those are net-new checks nothing has ever tracked.

### Phase 2 — Evaluation Prompt + Schema V3

**Goal:** close 1.4/1.5 — make the self-graded signal honest and specific.

**What changes:**
- Add `blindDescription: string` (required, written before any boolean field, describing the render cold with no reference to the original prompt) — exactly as recognizability-design.md already specified, now actually implemented.
- Add `recognizableAsSubject: boolean`, derived by explicitly comparing `blindDescription` against the intended subject (not asserted independently).
- Split `matchesLayerType` into two fields: `matchesLayerRole` (icon vs. accessory vs. eyes, etc. — the structural question) and keep subject-specific matching entirely inside `recognizableAsSubject`/`missingFeatures` — removing the conflation identified in 1.5.
- Add `paletteDisciplineOk`, `outlineConsistencyOk`, `materialSeparationOk`, `visualHierarchyClear` — booleans + shared `notes`, directly instrumenting the new Phase 1 prompt content so the evaluator can actually fail a generation for ignoring it (today, nothing checks whether the new Phase 1 guidance was followed).
- Add a `schemaVersion` stamp on every stored evaluation, fixing the silent-schema-drift issue found in the second stored record.
- Change the evaluation call to run in a **fresh, minimal message list**: system prompt + the intended subject/prompt text + the final rendered image only — not the full draft/refine transcript. This is the concrete fix for the anchoring-bias gap in 1.4/1.8. It costs exactly one small additional consideration (constructing a short message list instead of reusing `messages`) — no new API surface, no new model, no new architecture.

**Dependencies:** none on other phases, but Phase 3 consumes this phase's new fields, so shipping order should put this before or alongside Phase 3.

**Testing:** re-run the exact two stored records (or equivalents) through the new evaluator and confirm the Nyan Cat case now produces `recognizableAsSubject: false` with a blind description that plainly doesn't mention a rainbow trail — a concrete, checkable regression test for this phase.

### Phase 3 — Revision Prompt V3

**Goal:** implement the workflow in §3 — structured repair brief in, diffed verification out.

**What changes:**
- `runRevisionJob`/`/traits/:id/revise` load the existing trait's stored evaluation and fold `blindDescription` + `missingFeatures` + `notes` into the seed message as a labeled checklist, alongside (not replacing) the human's free-text `revisionPrompt`.
- Seed message requires the model to state which checklist items it will address before its first tool call.
- Final evaluation (using Phase 2's mechanism) is diffed against the prior stored evaluation and the diff (resolved / persisting / new) is stored alongside the new record.

**Dependencies:** requires Phase 2's schema fields to exist.

**Non-goals:** no change to how a human approves/rejects — the gate is untouched.

### Phase 4 — Agent Loop V3

**Goal:** wire Phases 1–3 together and close the two loop-level gaps from 1.3/1.8 that aren't pure prompt content: a mid-refine silhouette-lock checkpoint, and the fresh-context evaluation call's plumbing.

**What changes:**
- At roughly the midpoint of a job's turn budget, inject one structured checkpoint message into the existing loop (not a new API call — it rides on the next turn's user message) instructing the model to re-state, in one line, whether the silhouette still reads as the intended subject before continuing into further detail passes. This operationalizes recognizability-design.md's describe-first discipline *during* drawing, not only at the end.
- Implement the fresh-context call plumbing for Phase 2's evaluation step (build the trimmed message list described there).
- Everything else — render-once-per-turn, `shouldStop` semantics, `HARD_MAX_TURNS`, draft/seed/refine/evaluate phase structure — is confirmed sound in 1.7 and stays as-is.

**Dependencies:** Phases 1–3 define *what* gets injected; this phase is the orchestration that carries it.

### Phase 5 — Style Packs

**Goal:** implement `docs/pixel-forge-style-lab-plan.md` as designed — it is sound and currently the only mechanism that can carry per-collection art direction (as opposed to global system-prompt rules) into a job.

**What changes:**
- Build exactly the `StyleProfile` schema already specified (storage, manual-upload-only reference packs, human-gated draft→approved promotion, the one-off vision-analysis job with its own `submit_style_analysis` forced tool call).
- Populate `silhouetteRules`/`paletteAnalysis`/`promptTemplates` using the vocabulary this audit's Phase 1 introduces (ramp discipline, outline rule, shape-language accent, material inventory, accessory-hierarchy archetype tag, background-complexity-budget policy) so a style profile is expressive enough to encode, e.g., "this collection uses saturated-background/desaturated-character logic" (reference-pack-002's solcity-family exception) as a per-collection override of the Phase-1 global default — rather than that exception living nowhere or being hard-coded globally.
- The analysis-time-vision / generation-time-text-only boundary, and every manual-gate requirement in the existing design, are preserved exactly as specified — this phase is implementation of an already-approved design, not a redesign.

**Dependencies:** benefits from Phase 1's vocabulary existing first (so profiles have a shared language to write rules in) but is not blocked by it — could ship in parallel.

### Phase 6 — Future Trait Intelligence (evidence-gated, largest remaining lift)

**Goal:** the items that are either explicitly deferred pending evidence in the existing design docs, or that require an actual data-model extension rather than a prompt/schema change. Do not start this phase until Phases 1–2 have shipped and produced at least one testing-log cycle of evidence, per the existing process discipline in `pixel-forge-testing-log.md`.

**What's in scope, and why it's gated:**
- `subjectCategory` + the shape-language library (recognizability-design.md's Stages 2–4): explicitly designed to stay free-text/unlocked "until the four stages show what vocabulary actually recurs" — this audit does not override that decision, it reaffirms it. Proceed in the order that document already specifies.
- A systemic, named anchor-point/proportion-lock mechanism (fixed neck/collar/waist coordinates shared across a trait "set," mirroring LPC's body-analysis.md invariant) — this is the largest true gap found in this audit (1.9 #3) and the only item in this whole document that plausibly requires a genuine data-model addition (something like a `CollectionSpec` record naming shared anchors that traits register against). It is still describable entirely as a data-model/schema extension, not ML/embeddings/training, and should be scoped carefully once Phase 5 (which needs related plumbing for style profiles) has shipped.
- Companion/secondary-element trait handling and the background-complexity-budget formula (reference-pack-002 principles 13/14): needs a `complexityHint` mechanism so a `background` job can reason about sibling traits' stored complexity without seeing their pixels directly (e.g. a small numeric/text summary already computed and stored on the character traits it will pair with) — a small, well-scoped addition once Phase 1's vocabulary (material-technique count, focal-point count) gives something concrete to summarize.

**Explicitly not in scope, here or ever, per the brief:** ML classifiers, embeddings, external vision models, fine-tuning, training data collection, or any "similarity to reference" scoring — all explicitly rejected already in `pixel-forge-style-lab-plan.md` and reaffirmed by this audit for the same reason: nothing in either research corpus requires them, and the brief asks for prompting/reasoning/evaluation/engineering-constraint improvements specifically.

---

## 5. Non-goals / feature-creep guardrails

Restating explicitly, since this document's charter demands it: no new databases, no ML, no embeddings, no training/fine-tuning, no external vision models, no multi-agent critic swarm, no best-of-N default generation. The one new API call this design introduces (Phase 2's fresh-context evaluation) is a second call to the *same* model already in use, with a shorter message list — not a new model, not a new service, not a cost-multiplying pattern, and it directly serves an intent already written into the existing code's own comments.

## 6. Sequencing summary

| Phase | Depends on | Can ship independently? |
|---|---|---|
| 1. Generation Prompt V3 | — | Yes |
| 2. Evaluation Prompt + Schema V3 | — | Yes |
| 3. Revision Prompt V3 | Phase 2's schema fields | No — ship with or after 2 |
| 4. Agent Loop V3 | Phases 1–3 (wires their content in) | No — ship after 1–3 are defined |
| 5. Style Packs | — (benefits from Phase 1's vocabulary) | Yes |
| 6. Future Trait Intelligence | Evidence from Phases 1–2's testing-log cycles | No — evidence-gated by design |

Recommended order: **1 and 2 in parallel → 3 → 4 → 5 (any time after 1) → 6 once evidence exists.**
