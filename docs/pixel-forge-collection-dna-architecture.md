# Pixel Forge — Collection DNA Architecture (v2, supersedes the monolithic profile)

Status: **design review only. No code, no API calls, no deploy, no PM2
restart.** This document critiques and replaces the `CollectionStyleProfile`
data model from `pixel-forge-collection-style-agent.md` — that doc's §§2–7,
9–12 (creation sequencing, UI reuse patterns, cost discipline, storage
conventions, risk register, first step) are still largely valid and are
called out explicitly where they carry over unchanged. What changes is
the shape of the object itself: from one flat profile to six
independently-versioned "Collection DNA" layers (five collection-wide
values plus one per-job-selectable archetype library — see §2/§3F) plus a
thin manifest that points at them. Nothing about already-shipped
Reference Mode code
(`analyzeReferenceImage`, `ReferenceGuidance`, `validateReferenceImage`)
needs to change — it becomes one input into a richer composition step,
not something this redesign touches or replaces.

---

## 1. Critique of the current `CollectionStyleProfile` architecture

Being genuinely critical, not protective of prior work:

**It is one object with one version counter covering unrelated concerns.**
`CollectionStyleProfile` bundled canvas size, palette, outline rules,
composition grid, per-layer bboxes, compatibility rules, shape vocabulary,
and exclusions into a single flat interface with one `revision` number.
Editing the palette bumps the same counter as editing a bounding box —
there is no way to answer "what actually changed between v3 and v4" at
anything finer than "the whole profile." For a system meant to still make
sense in two years, across many collections, this is the wrong shape:

- **No independent evolution.** A studio running several collections off
  the same base rig (same head/body geometry) but different moods
  ("cute mascot line" vs. "serious battle-pass line") has no way to share
  the thing that's actually shared (geometry) while letting the thing
  that actually differs (art direction) diverge — the old design forces
  either full duplication or manual re-entry every time.
- **No editing story that matches how humans actually want to work.** The
  old §7 UI proposed one big edit form with different field groups inside
  it. That's not the same as independently-editable, independently-
  versioned Geometry/Construction/Palette/Art-Direction modules — it's
  one object wearing a form with section headers.
- **Hard constraints and soft mood were the same kind of text.** The old
  design's §3 folded `shapeVocabulary` + `exclusions` + `outlineRules` +
  `compositionGrid` notes into one `collectionStyleGuidance` string. A
  geometry violation (a misaligned hat that breaks every future composite)
  and an art-direction drift ("this one came out a bit less playful than
  the others") are not remotely the same severity of problem, but nothing
  in the old prompt structure told the model — or a future evaluator —
  that one category of instruction is load-bearing and another is a
  nudge. This is the single most important structural weakness: it will
  keep producing traits that violate geometry no more rarely than they
  violate mood, because the model has no signal that one matters more.
- **"Compatibility" was static per-type rule lists, not a real
  relationship.** `mayOverlap`/`mustNotCover` were stored as fixed lists
  keyed by `LayerType`, mixed into the same structure as raw bbox
  coordinates. A compatibility rule ("headwear may overlap head, and must
  extend beyond it") is really a *relationship between two geometry
  anchors*, not a property that lives independently of geometry — but it
  also isn't purely derived from geometry either (two collections could
  share identical head/eye/mouth bboxes and still have genuinely
  different compatibility philosophies, e.g. whether an eyepatch-style
  accessory covering one eye is allowed at all). The old model didn't
  have a clean place for "a rule that references geometry anchors by name
  but is itself an independent editorial decision."
- **No versioning model beyond a flat counter** — no forking, no shared
  layers, no "pin this collection to geometry v3 even after v4 exists."
  Any future upgrade to shared geometry would either force every
  dependent collection to change simultaneously (dangerous) or require
  duplicating the whole profile per collection (defeats the point of
  sharing at all).
- **Palette had no distinct identity.** It was a top-level array field,
  not wrong exactly, but with the same versioning/editing problem as
  everything else — a palette rebalance (e.g. accessibility pass, print
  color correction) bumps the same counter as a geometry change, even
  though palette actually has a different edit cadence and different
  stakeholders than geometry does.
- **Art direction had no home at all.** Mood/personality words ("cute,"
  "chunky," "mascot-like") didn't fit `shapeVocabulary` (which — per the
  earlier concreteness-focused prompt work on Reference Mode — is
  supposed to be measurable, not adjectives) and would have either been
  jammed into free-text `description` (unstructured, unusable by the
  pipeline) or bled back into `shapeVocabulary`, undoing the exact
  concreteness discipline that was deliberately built into
  `ReferenceGuidance`'s prompt earlier.

None of this means the old doc's *non-architectural* content was wrong —
its creation-sequencing (§2), UI-reuse strategy (§7), cost discipline
(§9), storage conventions (§8), and risk register (§11) all still apply
and are reused below without re-litigating them. What's wrong is
specifically the shape of the profile object and the flat prompt-injection
it produced.

---

## 2. Recommended Collection DNA architecture

Replace one monolithic profile with **six independently-stored,
independently-versioned layers**, plus a thin **manifest** that points at
a specific version of each:

```
CollectionDNA (manifest)
 ├─ geometryRef        → { layerId, version }   ─┐
 ├─ constructionRef    → { layerId, version }    │
 ├─ artDirectionRef     → { layerId, version }    │  each ref is a pointer,
 ├─ paletteRef          → { layerId, version }    │  not embedded content —
 ├─ compatibilityRef    → { layerId, version }    │  the same layer can be
 └─ archetypesRef        → { layerId, version }   ─┘  pointed to by many manifests
```

Five of these six resolve to **one fixed collection-wide value** per
manifest — you don't choose between multiple geometries or multiple
palettes for a given collection, there's just the one it currently points
to. **Archetypes is structurally different: it's a library, not a single
value.** `archetypesRef` points at a versioned *set* of named archetype
definitions (e.g. this collection supports `{animal, robot, undead}`), and
a specific generation job then **selects one archetype from that set** —
the same way a job already selects a `layerType` or writes a `prompt`,
not the way it resolves a fixed Geometry/Palette. This distinction matters
enough to carry through the rest of this document explicitly (see §3F,
§4, §5, §6) rather than pretend Archetypes is "just a sixth layer of the
same shape as the other five."

Each layer type is its own store, versioned **immutably** — editing a
layer never mutates the version another manifest might be pinned to; it
creates a new version and the editor decides whether to move the pointer.
This is the same discipline a package-lock file already gives you, and
it's the only shape that makes "many collections, some sharing DNA, safe
independent upgrades" actually work.

The manifest itself carries its own thin version too — not because its
content is large, but because *which layers it points to* is itself a
fact worth having history for (e.g. "this collection moved from
Geometry v3 to v4 on this date").

```ts
interface CollectionDNA {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'approved' | 'archived';
  manifestVersion: number;              // bumps when ANY layer pointer changes
  baseCollectionId: string | null;       // inheritance — see §9
  layers: {
    geometry: LayerRef;
    construction: LayerRef;
    artDirection: LayerRef;
    palette: LayerRef;
    compatibility: LayerRef;
    archetypes: LayerRef;               // points at an ArchetypeLibrary — see §3F
  };
  createdAt: number;
  updatedAt: number;
}

interface LayerRef {
  layerId: string;
  version: number;
}
```

---

## 3. Layer breakdown

**Layer A — Geometry.** Objective, hard constraints. Canvas size,
transparent margins, per-`LayerType` bbox (`head`, `body`, `eyes`,
`mouth`, `headwear`, `accessory`, `icon` — see the enum-extension
recommendation already made in the prior doc, unchanged), pivot points,
z-index. This is the layer that almost never needs to change once locked
— a studio typically fixes its base rig early and rarely touches it
again, which is exactly why it deserves to be shared/pinned independently
rather than re-entered per collection.

**Layer B — Construction Rules.** Describes HOW to draw: outline
thickness, cluster density/rhythm, silhouette philosophy, palette-ramp
*behavior* (step count, hue-shift direction — not literal colors, see
Layer D), shading philosophy, taper rules, edge treatment, material
construction rules. This is exactly the vocabulary already built for
`ReferenceGuidance.inherit` in Reference Mode — same concreteness
discipline applies here (measurable rules, not adjectives).

**Layer C — Art Direction.** Mood/personality only: cute, serious,
playful, chunky, realistic, exaggerated, mascot-like, expressive. **Never
influences compatibility** — this is the layer's defining property, and
the reason it must be structurally separate from Geometry/Compatibility:
an art-direction edit should be *impossible* to accidentally break trait
alignment, which is only true if the two live in genuinely different
records.

**Layer D — Palette.** Yes, it deserves its own layer, for a concrete
reason beyond "feels tidier": palette has its own edit cadence
(accessibility pass, print-color correction, a deliberate "let's try
warmer" experiment) and its own stakeholder (often a colorist, distinct
from whoever owns geometry or mood). Bundling it with Construction Rules
means every palette tweak also touches — and risks accidentally
overwriting — outline/shading rules it has nothing to do with. Recommend:
`palette: string[]` (hex, canonical form, same shape `TraitAsset.palette`
already uses) plus `rampBehaviorNotes: string[]` describing shared ramp
conventions in the abstract (step count, hue-shift direction) — the
*behavior* half of what used to live in Construction Rules' palette-ramp
mention moves here, since it's really about the palette's own identity,
not drawing technique.

**Layer E — Layer Compatibility.** Relationship rules between `LayerType`
pairs, expressed by referencing Geometry's anchor *names*, never raw
coordinates: `{ from: 'headwear', to: 'head', relation: 'overlaps', notes:
'headwear extends beyond head silhouette' }`, `{ from: 'accessory', to:
'eyes', relation: 'excludes' }`. Because relations reference anchor names
rather than coordinates, editing Geometry (e.g. nudging the head bbox)
never invalidates Compatibility — the rule "headwear overlaps head" stays
true regardless of where "head" currently is. This is also why
Compatibility is its own layer rather than a derived/computed view over
Geometry alone: two collections can share identical Geometry and still
have different Compatibility philosophies (e.g. whether an eye-occluding
accessory type is allowed at all is an editorial call, not a geometric
fact).

**Layer F — Archetypes.** A **library** of named subject-family
definitions — `animal`, `human/humanoid`, `robot`, `undead/zombie`,
`ghost`, `helmeted character`, `masked character`, `creature/monster`, and
whatever else a given collection needs. Unlike Layers A–E, a job doesn't
resolve one fixed Archetype for the whole collection — it **selects one
entry from the library**, per generation, the same way it already selects
a `layerType`. Each entry:

```ts
interface ArchetypeDefinition {
  id: string;                 // e.g. 'robot'
  label: string;               // human display name
  requiredFeatures: string[];  // e.g. "single round eye-lens or visor" for Robot
  optionalFeatures: string[];  // e.g. "visible antenna" for Robot
  forbiddenFeatures: string[]; // e.g. "organic skin texture, visible fur" for Robot
  constructionRules: string[]; // archetype-conditional HOW, layered on top of Layer B —
                                // e.g. Undead: "skin ramp is hue-locked, no warm shadow
                                // drift" (directly the same signal
                                // pixel-forge-universal-principles.md principle 5 already
                                // names as the "is this alive" cue)
  allowedAsymmetry: string;    // free-text policy, e.g. "symmetric by default; asymmetry
                                // only for a named feature (scar, eyepatch, missing limb)"
  materialRules: string[];     // e.g. Helmeted: "helmet reads as rigid material — hard
                                // specular highlight, no cloth-fold softness"
  shapeVocabulary: string[];   // archetype-specific silhouette cues, e.g. Robot: "boxy/
                                // rectangular joints, visible panel-seam lines"; Creature:
                                // "asymmetric limb count/size permitted, jagged silhouette
                                // accents allowed where Layer E would otherwise expect symmetry"
  compatibilityOverrides: Array<{ from: LayerType; to: LayerType; relation: string; notes: string }>;
                                // conditional additions to Layer E, active ONLY when this
                                // archetype is selected — e.g. Helmeted flips headwear-vs-
                                // head from "overlaps" to "replaces" (the helmet becomes a
                                // full replacement of the head's face region, not an overlay
                                // — reusing universal-principles.md principle #15's existing
                                // "occlusion accessories are full replacements, not overlays" rule)
  affectedLayerTypes: LayerType[]; // which layers this archetype actually constrains —
                                     // e.g. Masked character mainly touches head/eyes/
                                     // accessory, not body; Robot touches nearly everything
}

interface ArchetypeLibrary {
  layerId: string;
  version: number;
  archetypes: ArchetypeDefinition[];   // a small named set, typically 3–8 entries
}
```

**Why this must not be mixed into Construction Rules (Layer B).**
Construction Rules describes universal, collection-wide drawing technique
— it applies identically to *every* trait regardless of subject. Archetype
rules are conditional on WHICH subject family a specific trait belongs
to, and — critically — **a single collection routinely mixes archetypes**
(a "Halloween drop" might generate zombies, ghosts, and monsters side by
side; even a nominally single-archetype collection often wants one
off-archetype mascot). Folding archetype rules into Layer B would force a
choice between two bad outcomes: either B becomes a sprawling
if-this-subject-then-that-rule document that no longer describes one
coherent drawing technique, or every archetype-specific rule gets
generalized down to the lowest common denominator and loses the exact
specificity that makes a robot read as a robot and a ghost read as a
ghost (a `forbiddenFeatures: ["organic skin texture"]` rule is actively
wrong to apply collection-wide the moment the same collection also
contains a `human/humanoid` trait). Layer F keeps subject-family identity
rules selectable per job and versioned independently of universal
technique — the same separation-of-concerns argument that already
justified splitting Palette (D) and Art Direction (C) out of Layer B,
just for a different axis (WHAT this subject family requires, not HOW
anything is drawn or WHAT mood it carries).

---

## 4. Interaction between Collection DNA and NFT Reference

**Both should apply — not one replacing the other — and the brief's own
proposed ordering is directionally right but too coarse once "Collection
DNA" is decomposed into layers of different strictness.** Treating all of
DNA as one precedence tier hides the fact that Geometry/Compatibility/
Palette are genuinely non-negotiable while Construction Rules and Art
Direction are not equally strict — a flat "DNA beats Reference" rule
would incorrectly forbid a reference from ever influencing mood, which is
exactly the one thing it should be allowed to do freely.

**Refined precedence, hard → soft:**

```
1. Safety                    (rights/provenance/no-real-IP — a gate, not a prompt tier)
2. Geometry           (A)    — never overridden by anything below
3. Compatibility      (E)    — never overridden by anything below
   + Archetype compatibilityOverrides (F, conditional)
                                — active ONLY for the job's selected archetype;
                                  folds INTO tier 3, not a separate tier, since an
                                  archetype-conditional overlap/exclude rule is just
                                  as load-bearing as Layer E's base rules once that
                                  archetype is chosen (e.g. Helmeted's head↔headwear
                                  "replaces" override is as hard as any Layer E rule)
4. Palette            (D)    — never overridden by anything below
──────────────────────────── (hard floor — nothing below may violate 2–4)
5. Archetype identity  (F)   — the job's SELECTED archetype's requiredFeatures/
                                forbiddenFeatures/constructionRules/materialRules/
                                shapeVocabulary/allowedAsymmetry. Binding once an
                                archetype is chosen (a "robot" trait growing organic
                                fur is a real defect, not a style nuance) — but the
                                CHOICE of archetype is itself a per-job selection,
                                not a collection-wide constant (see §2/§3F)
6. Construction Rules  (B)    — universal HOW, binding by default; explicitly, visibly
                                overridable per-job for a documented "variant/legendary"
                                case (same mechanism `intentionalChoices` already
                                provides — not a new one). Ordered after Archetype (5)
                                because a subject-family identity requirement (e.g. "no
                                organic fur" for Robot) is more specific and should
                                dominate if it and a generic universal technique note
                                ever appear to conflict — in practice they operate on
                                different axes (WHAT vs. HOW) and rarely do
──────────────────────────── (semi-hard — overridable only on purpose, never silently)
7. NFT Reference (optional)  — filtered through everything above; a reference
                                suggestion that conflicts with 2–6 is dropped
                                (not blended), same as Reference Mode's existing
                                exclusions mechanism already guarantees
8. Art Direction   (C)       — freely blendable with Reference; this is the
                                one place a reference is allowed to actually
                                move the needle, by design (§3's own definition
                                of Layer C)
9. User Prompt                — most specific, always present, still bounded by 2–6;
                                Archetype CONSTRAINS/GUIDES this, it never generates
                                or replaces it — the user's own subject description is
                                still what's actually drawn
──────────────────────────── (soft — flavor only, never load-bearing for compatibility)
```

This is a genuine refinement of the brief's proposed order, not a
rejection of it: Safety-first and DNA-before-Reference-before-Prompt are
both preserved. What changes is that "Collection DNA" is no longer one
step, and Archetypes is no longer one step either — it splits across two
places: its `compatibilityOverrides` fold into the hard floor (tier 3,
alongside Layer E), while its identity rules (required/forbidden/
construction/material/shape/asymmetry) sit at tier 5, immediately above
generic Construction Rules and below the hard floor, with Reference and
Art Direction sharing the bottom, most-flexible tier alongside the user's
own prompt.

---

## 5. Updated generation pipeline

```
Resolve Collection DNA
  (load Geometry@vX, Compatibility@vY, Palette@vZ, Construction@vW,
   ArtDirection@vV, and the ArchetypeLibrary@vU per the manifest's
   current pointers)
        │
        ▼
Resolve selected Archetype
  (NEW — per-job input, not a collection-wide constant: look up ONE
   ArchetypeDefinition by id from the resolved ArchetypeLibrary, e.g.
   'robot'. Optional — a job may specify no archetype at all, in which
   case tiers 5/3-override from §4 simply contribute nothing)
        │
        ▼
Optional NFT Reference analysis
  (unchanged mechanism — one forced-tool-call, ephemeral, image never
   persisted, never shown to the drawing model — its output is filtered:
   any suggestion conflicting with Geometry/Compatibility/Palette/the
   selected Archetype's identity rules is dropped before composition,
   not blended)
        │
        ▼
Tiered prompt composition
  (five clearly labeled sections, in the §4 order — HARD CONSTRAINTS
   [Geometry+Compatibility+Archetype compatibilityOverrides+Palette] /
   ARCHETYPE IDENTITY [the selected archetype's required/forbidden/
   construction/material/shape/asymmetry rules, if one was selected] /
   STANDARD CONSTRUCTION [Construction Rules, flagged if a variant
   override is active] / STYLE NUDGES [Reference guidance + Art
   Direction] / SUBJECT [user prompt — Archetype constrains this, it
   never replaces or generates it] — never merged into one
   undifferentiated block, which is the direct fix for §1's core
   critique)
        │
        ▼
Drawing Agent   (runDrawingJob — unchanged tool-calling loop)
        │
        ▼
Evaluate   (submit_evaluation — unchanged schema, now ALSO given the
            resolved Geometry/Compatibility summary AND the selected
            Archetype's required/forbidden features, so a violation of
            either can be graded at least "major," not folded in at the
            same weight as a style-nudge miss)
        │
        ▼
RepairPlan   (unchanged schema/categories — a geometry/compatibility
              violation OR a missing-required/present-forbidden
              archetype feature lands as an ordinary RepairItem, just
              reliably tagged with elevated severity because Evaluate
              now knows what's load-bearing)
        │
        ▼
Validation   (NEW, explicit pipeline stage — a code-only, non-AI bbox/
              compatibility check reusing tools.ts's already-shipped
              diffSummary-style pixel-bbox arithmetic against Geometry's
              actual bboxes; flags for MVP, can become a hard gate later.
              Archetype required/forbidden features are NOT checked here
              — that needs vision, not arithmetic, so it stays an Evaluate-
              time concern, not a Validation-stage one)
        │
        ▼
Approved Trait   (human review gate, unchanged — status candidate→
                  approved — now stamped with the exact layer versions
                  {geometry: v3, construction: v1, archetypes: v2, ...}
                  AND which archetype id was selected, for permanent
                  audit/back-compat)
```

The only structurally new stages versus the previous doc's pipeline are
**Validation** as its own named step, the explicit **tiering** inside
prompt composition (previously one flat text block), and now **Resolve
selected Archetype** as an explicit per-job step distinct from the
collection-wide DNA resolution before it.

---

## 6. Storage implications

```
data/pixel-forge/dna/
  geometry/<layerId>/<version>.json        — immutable per version
  construction/<layerId>/<version>.json
  art-direction/<layerId>/<version>.json
  palette/<layerId>/<version>.json
  compatibility/<layerId>/<version>.json
  archetypes/<layerId>/<version>.json       — an ArchetypeLibrary (a SET of named
                                              ArchetypeDefinitions), still versioned
                                              immutably as one file per version —
                                              adding/editing one archetype entry in
                                              the library still produces a new whole-
                                              library version, same as any other layer
  collections/<collectionId>.json          — the CollectionDNA manifest (mutable —
                                              only the pointers change, atomic write,
                                              same convention as every other JSON
                                              store in this codebase)
```

Archetypes is versioned the same way as every other layer (one immutable
file per version, referenced by a pointer in the manifest) even though
its *content* is a small library rather than a single value — the
difference that actually matters is at generation time, not storage time:
storage doesn't need a new mechanism, but the job request does (below).

Immutable-per-version files (not one mutable file with an embedded
history array) for the same reason a package-lock never rewrites a
published version in place: a manifest pinned at `geometry/g1/3.json`
must stay valid forever, even after `geometry/g1/4.json` exists — nothing
should ever be able to retroactively change what a past trait was
generated against. This is a firmer guarantee than an append-only
history array inside one mutable file would give (a bug could still
truncate/corrupt that array; a bug can't retroactively un-write an
already-committed immutable file).

**`TraitAsset` gains one richer optional field, replacing the flatter
`collectionId: string | null` proposed previously:**

```ts
collectionRef: {
  collectionId: string;
  manifestVersion: number;
  layers: {
    geometry: LayerRef; construction: LayerRef; artDirection: LayerRef;
    palette: LayerRef; compatibility: LayerRef; archetypes: LayerRef;
  };
  selectedArchetypeId: string | null;   // which library entry this specific trait used —
                                          // null if the job specified no archetype at all
} | null;   // null = not part of any collection — 100% of today's traits, unchanged behavior
```

`selectedArchetypeId` is per-trait, not per-collection, for the same
reason it's a per-job input rather than a manifest pointer (§2/§3F): two
traits in the same collection, generated against the same
`archetypesRef` version, can legitimately have selected different
entries (`'robot'` vs. `'animal'`) from that one shared library.

Same backward-compatibility guarantee as every optional field this
project has added so far (`referenceGuidanceNote`, the previously-proposed
`collectionId`): normalized/defaulted `null` for legacy records, every
existing route/trait behaves byte-for-byte identically.

**Referential integrity is a real, new risk this shape introduces** (see
§8) — a Compatibility layer can reference a `LayerType` a pointed-to
Geometry layer never defines an anchor for. This needs a load-time check
whenever a manifest's layers are resolved together (not just when each
layer is edited alone) — cheap, code-only, no AI call, but must exist
before this is trusted.

---

## 7. UI implications

Genuinely separate editor modules, not one form with section headers —
this is the direct UI consequence of §1's core critique:

- **Geometry editor** — per-`LayerType` bbox fields (x/y/width/height as
  0–1 fractions, same plain-number-input approach the prior doc already
  settled on — no canvas-overlay drag UI yet, still deferred per that
  doc's reasoning), canvas size, margins, z-index, pivot points.
- **Construction editor** — outline/cluster/shading/taper/material rule
  text fields.
- **Palette editor** — hex list (reuse the exact comma-separated text
  field already on the draw form) + ramp-behavior notes.
- **Art Direction editor** — a simple tag list (cute/serious/playful/...),
  genuinely just words, the lightest editor of the five.
- **Compatibility editor** — a small rule-builder: pick `from` layer type,
  `to` layer type, relation (`overlaps`/`excludes`/`adjacent`/`contains`),
  optional note. References Geometry's anchor names via a dropdown, not
  free text, so a rule can't silently drift out of sync with what
  Geometry actually defines.
- **Archetype library editor** — structurally different from the other
  four: a list manager, not a single-record form. Add/remove/edit named
  archetype entries (`animal`, `robot`, `undead`, ...), each with its own
  required/optional/forbidden-feature tag lists, construction/material/
  shape-vocabulary text fields, an asymmetry-policy text field, and a
  small compatibility-override rule-builder (same `from`/`to`/`relation`
  widget as the standalone Compatibility editor, scoped to "only active
  when this archetype is selected"). Editing any one entry still produces
  one new version of the whole library (§6) — the UI can hide that detail
  behind a single "Save archetype" action per entry.
- **Archetype picker on the draw form** — one new dropdown next to the
  existing `layerType` selector on the "Draw a new trait" form: blank
  ("no archetype") or one entry from the current collection's resolved
  archetype library. This is the per-job selection §2/§3F describe —
  distinct from every other DNA control on this page, which pick a
  *collection*, not a value within one.
- **Collection DNA dashboard** — one lightweight screen per collection
  showing which version of each layer it currently points to (Geometry,
  Construction, Art Direction, Palette, Compatibility, **and
  Archetypes** — the dashboard treats `archetypesRef` as just another
  pointer row, same Edit/Change actions; the *contents* of that pointer
  happen to be a library, which is the archetype editor's concern, not
  the dashboard's), with two actions per layer: **Edit** (creates a new
  version of the currently-pointed layer and repoints to it) and
  **Change** (repoint to a different existing layer/version — the
  mechanism that makes sharing DNA across collections visible and
  intentional). Plus **Clone collection** (shallow: new manifest, same
  pointers; or fork: new manifest + new copies of specific chosen layers)
  and, once `baseCollectionId` exists, an **Inherit from** picker.

Each editor saves independently and bumps only its own layer's version —
the manifest's `manifestVersion` only bumps when a *pointer* changes, not
when a layer's own content does (that's the layer's own version bumping,
a separate number, on purpose).

---

## 8. Risks

- **Structural complexity is real, not imagined.** Six independently-
  versioned layer types (one of them a library with its own per-job
  selection step) plus a pointer-based manifest is a materially bigger
  data model than one flat profile. This is the correct trade for a
  "still makes sense in two years, many collections" answer, but it is
  more moving parts than a single-user, few-collections reality needs on
  day one — the MVP in §9 exists specifically to admit this honestly
  rather than build all the sharing/inheritance machinery before there's
  a second collection to actually share with.
- **Archetype/Compatibility interaction is a new, specific consistency
  risk.** An archetype's `compatibilityOverrides` and Layer E's base
  rules must be checked together, not independently — an archetype could
  in principle define an override that contradicts a Layer E rule for a
  layer-type pair Layer E already governs strictly (e.g. Layer E says
  `accessory excludes eyes` globally, an archetype says `accessory
  overlaps eyes` for a "masked character" whose mask legitimately covers
  the eye region). This isn't necessarily a bug — a masked archetype
  *should* be able to carve out that exception — but it means override
  resolution needs an explicit, documented conflict rule (recommend:
  archetype overrides win when they name the exact same `from`/`to` pair
  Layer E does, since the whole point of Layer F is subject-family-
  specific exception to the collection-wide default), not silent
  first-write-wins or an error.
- **Referential integrity across layers.** A Compatibility rule can
  reference a `LayerType` Geometry doesn't define, or a manifest can pin
  layer versions that individually validate fine but produce an
  inconsistent combination (e.g. Geometry's head bbox and Compatibility's
  "headwear extends beyond head" rule technically resolve, but Palette's
  ramp-behavior notes assume a step count Construction Rules contradicts).
  Needs a load-time cross-layer validation pass, not just per-layer
  validation — genuinely new work, not present in the flat design because
  a flat design can't have this specific failure mode (everything was one
  object, always internally consistent by construction, at the cost of
  everything else this critique names).
- **Precedence-tier bugs are more likely than a flat-blob bug.** Four
  differently-labeled prompt sections composed in a specific order is a
  more complex thing to get right than one string concatenation — worth
  validating with the project's existing dry-run/no-API-call verification
  discipline before ever trusting it against a paid call.
- **Version sprawl.** Immutable-per-version files mean every small edit
  creates a new file, forever. Cheap in absolute storage terms (same
  "atomic write is cheap" ethos already true everywhere in this project)
  but worth a pruning/archival story eventually — not urgent, not MVP.
- **Migration is additive only, and must stay that way.** Reference
  Mode's already-shipped code (`analyzeReferenceImage`, `ReferenceGuidance`,
  `validateReferenceImage`) must not be touched by this redesign — it
  becomes one input filtered through §4's precedence stack, not replaced
  or rewritten. Any implementation plan that starts by modifying those
  files has misread this design.
- **Inheritance/cloning is a real feature with real edge cases**
  (what happens to a derived collection when its base's pinned layer
  version is later archived? — recommend: archiving a layer version never
  deletes it, only marks it non-selectable for *new* pointers; existing
  pointers keep resolving) — deferred to §10, but worth naming now so a
  future implementer doesn't have to rediscover it.

---

## 9. Recommended MVP

Not a watered-down architecture — the same six-layer shape from day one,
just a small slice of what it enables:

- **All six layer stores exist from the start**, each with real
  immutable versioning — including Archetypes. This is structurally cheap
  (six small JSON stores, same atomic-write pattern already used
  everywhere in this codebase) — collapsing them back into one file to
  "save time" would reproduce exactly the mistake §1 critiques, for no
  real savings.
- **Archetypes ships in MVP, manual-only, both for authoring and
  selection** — per the brief's own explicit instruction. A human writes
  the archetype library entries directly (required/optional/forbidden
  features, construction/material/shape-vocabulary text, asymmetry
  policy, compatibility overrides — all plain text/tag-list fields, no
  new interaction pattern beyond what the other four content-bearing
  layers already need), and a human picks one entry per generation job
  from the draw form's new dropdown (§7). This is a real, load-bearing
  MVP feature, not a stub — the separation-of-concerns argument in §3F is
  the actual point of this whole redesign, and skipping Archetypes would
  leave subject-family rules with nowhere to live except back inside
  Construction Rules, reproducing the exact problem being fixed.
- **Archetype auto-classification is deferred, explicitly** (see §10) —
  automatically suggesting an archetype from a reference image, or from
  the user's own prompt text, is a real feature but strictly sequenced
  after manual selection proves the rest of the pipeline (identical
  reasoning to why reference-based layer extraction generally is
  sequenced after manual layer content in this same document).
- **Manifests are pointers only** — no `baseCollectionId`/inheritance, no
  cloning yet. Create, list, edit-a-layer-and-repoint (Archetypes
  included — its pointer behaves like any other for dashboard purposes).
- **Manual-only content for every OTHER layer too** — no auto-extraction
  from references yet (same "prove the plumbing before spending on AI"
  sequencing the prior doc already argued for the monolithic version,
  now applied per-layer instead of per-profile — extraction could later
  even be layer-scoped, e.g. "extract just Geometry from these 3
  references" as a smaller, cheaper call than "extract everything").
- **Tiered prompt composition ships from day one, now five tiers not
  four** — this is the actual point of the redesign and it's cheap
  (restructuring which text goes into which labeled section), so there's
  no reason to defer it the way inheritance/cloning can be deferred.
- **Reference Mode integration is a pure composition change** — zero
  rework of `analyzeReferenceImage`/`ReferenceGuidance` themselves, only
  where their output slots into the new tiered sections and which of its
  suggestions get filtered out by the hard floor.
- **Evaluate-prompt awareness of hard-constraint severity** — one more
  optional section on the existing evaluate call, no schema change,
  cheap.
- **Validation stage runs log-only** — flags a bbox/compatibility
  deviation without blocking anything yet; promoting it to a hard gate is
  explicitly a fast-follow, not MVP.

---

## 10. What should NOT be built yet

- **Layer inheritance (`baseCollectionId`) and cloning/forking.** Real,
  wanted eventually, but there is nothing to inherit *from* until a
  second collection actually exists — building this before that point is
  designing for a hypothetical, not an observed need.
- **Cross-collection layer sharing in practice.** The data model supports
  it from day one (that's the whole point of pointer-based layers), but
  actually exercising "collection B reuses collection A's Geometry" is a
  "when we have 2+ collections" problem, not a launch requirement.
- **Any auto-extraction of a layer from reference images.** Still
  sequenced strictly after manual-only content proves the rest of the
  pipeline, exactly as the prior doc argued — now simply re-scoped to be
  per-layer rather than per-monolith when it does arrive.
- **Archetype auto-classification.** Automatically suggesting/selecting
  an archetype (from a reference image, or by inferring it from the
  user's prompt text — e.g. noticing "robot" in the prompt and
  pre-selecting the `robot` entry) is real and useful eventually, but
  ships strictly after manual per-job selection (§9) proves the rest of
  the Archetype plumbing — same sequencing discipline as every other
  auto-extraction feature in this document, applied to the one layer
  that's selected per-job rather than resolved per-collection.
- **Promoting the Validation stage to a hard gate.** Log-only for MVP;
  turning a flagged deviation into a blocking failure is a deliberate
  later decision, not a default.
- **A visual, canvas-overlay Geometry editor** (drag-to-resize bboxes on
  a rendered grid). Plain fractional-number inputs are enough for MVP,
  same reasoning `pixel-forge-reference-system-v1.md` already gave for
  deferring interactive calibration UI generally.
- **Layer version pruning/archival policy.** Not urgent at current scale;
  revisit once version-file counts are actually large enough to matter.
- **ML/embeddings/training/similarity-scoring, multi-agent orchestration,
  automatic rarity, batch generation, the AI-free collection compositor
  itself** — unchanged from every prior Pixel Forge design doc's own
  non-goals section; nothing in this redesign touches or motivates any
  of these.
