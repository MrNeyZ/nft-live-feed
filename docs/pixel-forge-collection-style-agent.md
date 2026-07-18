# Pixel Forge — Collection Style Agent (design only, no code)

Status: **design only. No code, no API calls, no deploy, no PM2 restart.**
This is the concrete realization of two things already deferred in earlier
design docs — `pixel-forge-style-lab-plan.md`'s `StyleProfile` (persistent,
multi-reference, human-gated) and `pixel-forge-v3-design.md`'s Phase 6
`CollectionSpec` (named anchor-points/bounding-boxes shared across a trait
set) — now that single-reference Reference Mode has actually shipped and
given this project real, working plumbing (`validateReferenceImage`,
`analyzeReferenceImage`, the `submit_reference_guidance` forced-tool-call
pattern, the `buildSystemPrompt` optional-text-section convention) to
extend rather than reinvent. Read this alongside those two docs; §0 below
is the only new synthesis, everything downstream reuses their mechanisms.

## 0. What this actually is, in one paragraph

A **Collection Style Profile** is a persisted, human-approved object that
plays the same role for a whole collection that a single reference image's
`ReferenceGuidance` plays for one generation — except it also adds the one
thing single-reference mode explicitly cannot: named, per-layer-type
anchors/bounding-boxes shared across every trait drawn under it, so a hat
drawn today and eyes drawn next week land in the same place. Every
mechanism this design needs (image validation, forced-tool-call vision
analysis, text-only prompt injection, RepairPlan-based soft enforcement,
human draft→approved gating) already exists in this codebase in some form;
this design's job is to say precisely which existing piece each new
requirement reuses, and which few things are genuinely new.

---

## 1. The Collection Style Profile object

```ts
interface CollectionStyleProfile {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'approved' | 'archived';   // never auto-approved — same gate as TraitAsset/StyleProfile
  schemaVersion: number;
  revision: number;                             // bumped on every manual edit or re-extraction

  canvasSize: number;                           // must match every trait drawn under this profile
  palette: string[];                            // hex, canonical form — pre-fills a job's existing `palette` param

  outlineRules: {
    weightPx: number;                           // e.g. 1
    color: string | 'auto';                     // near-black default, or per-material
    consistency: string;                        // free text, e.g. "same weight on silhouette and internal seams"
  };

  compositionGrid: {
    marginPct: number;                          // e.g. 0.08 — subject margin from canvas edge, as a fraction
    canvasFillPct: number;                       // e.g. 0.85 — how much of the canvas the subject should occupy
    centering: 'strict' | 'loose';
  };

  // Fractional bboxes (0..1 of canvasSize) — resolution-independent, so the
  // profile still makes sense if canvasSize differs slightly per trait.
  layerAnchors: Partial<Record<LayerType, {
    bboxPct: { x: number; y: number; width: number; height: number };
    zIndex: number;
    notes: string;                              // e.g. "eyes centered horizontally, lower half of head bbox"
  }>>;

  compatibilityRules: Partial<Record<LayerType, {
    mayOverlap: LayerType[];                    // e.g. headwear may overlap body(head)
    mustNotCover: LayerType[];                  // e.g. accessory must not cover eyes/mouth
    transparentOutsideBbox: boolean;            // true for every non-background layer
  }>>;

  shapeVocabulary: string[];                    // same semantics as ReferenceGuidance.inherit — construction rules only
  exclusions: string[];                         // same semantics as ReferenceGuidance.exclusions — mandatory, non-empty

  referencePacks: Array<{
    id: string;
    sourceNote: string;                         // REQUIRED — provenance/rights, mirrors Style Lab exactly
    imageCount: number;
    importedAt: number;
  }>;

  createdAt: number;
  updatedAt: number;
}
```

Every field maps onto something the brief asked for: canvas size, palette,
outline rules, composition grid, head/body bboxes and eye/mouth anchors
(`layerAnchors`), layer z-index rules (`layerAnchors[...].zIndex`), trait
category rules (`compatibilityRules`), shape vocabulary, do-not-copy
exclusions, example references (`referencePacks` — pointers/provenance
only, mirroring Style Lab's staging area, never embedded pixels), and
versioning (`schemaVersion` for the code shape, `revision` for edit
history). No field here is a new *kind* of data this codebase hasn't
already stored — `shapeVocabulary`/`exclusions` are literally
`ReferenceGuidance.inherit`/`.exclusions`'s shape reused verbatim.

**A real, existing gap this surfaces:** `LayerType` today is only
`background | body | eyes | mouth | accessory | icon | other`
(`agent-loop.ts:72`) — there is no distinct `head` or `headwear` value.
Today a "bust" prompt's head is bundled into `body`, and a hat would have
to live under `accessory`, whose own system-prompt branch explicitly says
*"give it a strap, chain, or clear attachment point"* — correct advice for
a held/worn accessory, wrong for a hat that just sits on a head. This is
the same category of mismatch already found and fixed once this session
(the `bust`/`body` layerType conflict). Recommendation: extend `LayerType`
to add `'head'` and `'headwear'` — a small, contained enum change (add two
values + two `DEFAULT_Z_INDEX` entries + update the four places that
enumerate `LAYER_TYPES`), not a redesign.

---

## 2. How the profile is created

| Option | What it costs | What it risks |
|---|---|---|
| A. 1 reference | Cheapest, fastest to ship | Weakest signal — one image can't tell you what's incidental vs. load-bearing across a "family" |
| B. 3–10 references | Better signal, closer to what the brief is actually asking for (a *collection* style) | More upload/validation surface, more vision-call cost per profile |
| C. Manual only | Zero AI cost, zero extraction-quality risk | All the tedious bbox/palette/vocabulary entry falls on the human |
| D. Hybrid (auto-extract + mandatory human review) | Best of B + C's safety | Slightly more implementation surface than A or C alone |

**Recommendation, in two explicit steps, not one:**

**Step 1 (first MVP cut): manual-only (Option C).** Ship pure data-entry —
a human fills in `canvasSize`/`palette`/`outlineRules`/`layerAnchors`/
`compatibilityRules`/`shapeVocabulary`/`exclusions` directly, no AI call
anywhere in this step. This is deliberately more conservative than the
brief's own Q10 framing might suggest, and for a specific reason: it lets
every *consuming* piece of plumbing (profile storage, job resolution,
prompt injection, bbox rendering into `anchor`, RepairPlan-based soft
enforcement) get built and tested against a profile whose contents are
100% known and controlled — zero paid API risk — before automated
extraction is added on top of it. Building extraction first would mean
debugging two new things (extraction quality *and* consumption plumbing)
at once.

**Step 2 (right after, hybrid per Option D): 1–3 references** analyzed via
up to 3 individual forced-tool-calls (directly reusing
`analyzeReferenceImage`/`SUBMIT_REFERENCE_GUIDANCE_TOOL`'s already-shipped
pattern, one call per image), landing as a `status: 'draft'` profile a
human must edit/confirm before `approved` — never auto-promoted, exactly
mirroring the trait `candidate→approved` gate and Style Lab's own
draft→approved gate. 3–10 references (Option B) stays explicitly out of
scope for now — more images bought as extraction inputs is a tuning
question the design doesn't need to pre-answer, and it multiplies vision
cost per profile for a benefit (signal quality) that hasn't been measured
yet.

---

## 3. How trait generation uses the profile

**One new optional parameter, not a new architecture.** `DrawingJobParams`
gains `collectionId?: string`, resolved server-side by the route (never
sent as raw profile data from the frontend). Once resolved to an
`approved` profile, the route does exactly three things, each reusing an
existing mechanism:

1. **Text guidance** — folds `shapeVocabulary` + `exclusions` +
   `outlineRules`/`compositionGrid` notes into one new optional
   `buildSystemPrompt` section, `collectionStyleGuidance?: string` —
   structurally identical to how `anchor` and `referenceGuidance` are
   already appended today (`if (x && x.trim()) lines.push(...)`). This is
   a **separate** param from `referenceGuidance`, not a reuse of it: a
   one-off uploaded reference is job-scoped and ephemeral; a collection
   profile is durable and shared — collapsing them into one field would
   make it impossible to reason about which is in effect, and a job could
   legitimately want a *locked* collection style plus a small ad hoc
   nudge at the same time (see the mutual-exclusion cost rule in §9 for
   the one case where that combination is explicitly disallowed).
2. **Bbox/anchor for this job's target `layerType`** — rendered into the
   *existing* free-text `anchor` param (e.g. *"Eyes layer for a locked
   collection style: draw only within x=12..20, y=10..16 of a 32x32
   canvas; do not extend outside this box."*), auto-filled as a default
   the human can still override, exactly like `anchor` behaves today. No
   `DrawingJobParams` schema change here at all.
3. **Palette** — `profile.palette` pre-fills the job's existing `palette`
   array param, still overridable per job. No schema change.

Net new backend surface for this whole feature: **one new optional
string** (`collectionStyleGuidance`) threaded through `buildSystemPrompt`
exactly like `anchor`/`referenceGuidance` were, plus `collectionId`
resolved at the route layer. That's it — this is intentionally the third
instance of an already twice-proven pattern, not a new one.

---

## 4. Layer types, expected geometry, and constraints

| Layer | Expected bbox (fraction of canvas) | z-index | Transparent outside bbox | May cover | Must never cover |
|---|---|---|---|---|---|
| `background` | full canvas | 0 | no (it *is* the background) | nothing (drawn first) | — |
| `body` | lower ~60% height, centered, full width budget | 10 | yes | — | eyes, mouth |
| `head` *(new)* | upper ~40–50% height (per universal-principles.md's own bust convention), centered | 15 | yes | — | — |
| `eyes` | inner ~50% width, lower half of head bbox | 20 | yes | — | nothing outside its own box |
| `mouth` | inner ~40% width, lower third of head bbox | 30 | yes | — | eyes |
| `headwear` *(new)* | strictly larger than head bbox, anchored above it, may extend past head's own silhouette (mirrors universal-principles.md principle 2 — "headwear is an outer frame, not a flush layer") | 25 | yes | head (by design — that's the point) | eyes, mouth |
| `accessory` | anywhere not already claimed by eyes/mouth | 40 | yes | body, head | eyes, mouth (principle: an accessory occluding a feature must fully replace it, never partially obscure it — see universal-principles.md #9/#15) |
| `icon` | standalone, self-contained, ignores body/head bboxes entirely (it isn't part of a bust composite) | 40 | yes | — | — |

This table *is* `layerAnchors`/`compatibilityRules` for a sensible default
profile — a new profile can start from these defaults and only override
what a specific collection actually does differently (e.g. a
`headwear`-as-halo elemental archetype per universal-principles.md
principle 12's own named exception).

---

## 5. Keeping traits compatible

Three layers of enforcement, weakest-to-strongest, all already-proven
mechanisms:

1. **Prompt-time (soft, cheap, works today's way):** §3's
   `collectionStyleGuidance` + pre-filled `anchor` are the *only* thing
   enforced at draft time — same strength guarantee the `anchor` field
   already has today (advisory, not physically enforced). This alone is
   what most single-trait generations will run on.
2. **Evaluate-time, via RepairPlan (soft, but self-correcting) — see §6.**
3. **Post-hoc, code-only, non-AI (cheap, deferred past first MVP but
   worth building soon after):** the exact same bbox-diff arithmetic
   `tools.ts`'s `diffSummary` already computes for every edit (a Canvas's
   actual non-transparent pixel bounding box) can be computed once on the
   *finished* trait and compared against `layerAnchors[layerType].bboxPct`
   — flag (not block) a deviation beyond tolerance. Zero new AI call,
   reuses an already-shipped, already-tested arithmetic primitive. This
   is the strongest low-cost guarantee available and should follow
   shortly after the first MVP, not be bundled into it.

Concrete rules this enables: same head position across traits (head/body
bbox fixed by the profile, checked in step 3 once built), eyes always
align (eyes bbox fixed relative to head bbox), hats fit over heads
(headwear bbox defined *relative to* head bbox, per §4's "strictly larger,
anchored above" rule), mouths fit the face (mouth bbox inside head bbox,
below eyes), accessories don't cover key features
(`compatibilityRules.mustNotCover`), body/head attachment (adjacent,
non-overlapping bboxes with a shared boundary y-coordinate), transparent
background (already a hard rule in `buildSystemPrompt` today — *"index 0
is always transparent — leave any area that is not part of the subject
transparent"* — unchanged, just now also true within a bbox's own
surrounding padding).

---

## 6. Revision under a style profile

**Both, via the existing RepairPlan categories — not a new parallel
mechanism.** This directly reuses `pixel-forge-reference-system-v1.md`
§4's own already-settled conclusion for the single-reference case, applied
identically here: a style-profile bbox/anchor violation is not a new kind
of problem — it maps onto categories `RepairPlan` already has
(`silhouette`, `composition`, `other` are already in `REPAIR_CATEGORIES`,
`tools.ts:132`). When a trait was generated under a `collectionId`, the
**evaluate** call (not the revision call) gets one more optional prompt
section describing the profile's relevant bbox/anchor/compatibility rules
for that `layerType`, so the model's own self-assessment can catch a
violation and emit it as an ordinary `RepairItem` — no schema change to
`Evaluation`/`RepairPlan`/`RepairItem` at all. Revision V4's existing
surgical-repair discipline (region-scoped, smallest-edit-first, tiered by
severity) then handles it exactly like any other issue.

**Explicitly rejected:** a second, separate "style-constraint checking"
mechanism running alongside RepairPlan. `pixel-forge-reference-system-v1.md`
§6 already argued why this is actively dangerous — sharper diagnosis fed
into an unreliable repair mechanism produces *more confident regressions*,
not better traits. The difference now: that doc's own precondition ("fix
Revision V4 first") has already been satisfied — V4 has been the
production revision mechanism for a while — so adding one more specific
category of RepairItem to a now-trustworthy pipeline is a much safer bet
than it would have been when that doc was written.

---

## 7. UI flow (MVP)

Extend the existing `/tools/pixel-forge` page rather than building a new
route — smaller diff, and the page already has the exact visual/
interaction language (`PANEL`, collapsible sections, candidate/approved/
rejected status badges) this needs:

1. **New collapsible panel, "Collection style"** (same visual pattern as
   the existing "Style reference" panel): a dropdown to select an
   existing profile (or "none"), a **Create new** button.
2. **Create/edit form** (manual-only for the first cut, per §2): plain
   inputs for `canvasSize`, `palette` (reuse the existing comma-separated
   hex text field pattern already on the draw form), `outlineRules`/
   `compositionGrid` as a few labeled text/number fields, and — the one
   genuinely new interaction — a **per-layer-type bbox editor**: for each
   `LayerType`, four number inputs (x/y/width/height as 0–1 fractions) plus
   a notes text field. No canvas-overlay drag UI in the first cut — that's
   exactly the "interactive calibration UI" `pixel-forge-reference-
   system-v1.md` already deferred, for the same reasons.
3. **Reference upload + extract** (step 2 of §2, added right after step
   1 ships): 1–3 file inputs, reusing the exact `onReferenceFileChange`/
   preview/rights-checkbox pattern already built for single-reference
   mode, plus an **Extract profile** button that runs the one-off
   analysis and lands the results as `draft` — editable in the same form
   from point 2 before promoting to `approved`.
4. **Status badge** — `DRAFT`/`APPROVED`/`ARCHIVED`, identical visual
   treatment to the existing `STATUS_META` trait badges.
5. **On the existing "Draw a new trait" form:** one new dropdown,
   **"Collection"** (blank = none, matching how `layerType` already
   defaults to blank/required). Only `approved` profiles are selectable.
   When set, the `anchor`/`palette` fields auto-fill from the profile
   (still user-editable) — same UX as any other auto-filled-but-
   overridable field already on this form.
6. **Preview layered stack** — explicitly a fast-follow, not day one:
   once a few traits share a `collectionId`, a client-side-only composite
   (stack each layer's already-fetched `pngBase64` at its `zIndex`,
   `<canvas>` or stacked `<img>`s with `position: absolute`) costs no new
   backend work at all — this is cheap enough to justify building soon
   after MVP, unlike a full AI-free collection *compositor* (unaffected,
   unrelated, still future work per `agent-loop.ts`'s own header comment).

---

## 8. Storage / API design

**Storage**, mirroring `data/pixel-forge/traits/`'s exact atomic-write
convention:

```
data/pixel-forge/collections/<collectionId>/
  profile.json                  — the CollectionStyleProfile, atomic write
  references/<n>.png            — staged reference images (see below)
```

**Deliberate divergence from Reference Mode's "never persisted" rule, and
why:** single-reference mode never writes the uploaded image to disk,
because it exists for exactly one ephemeral job. A collection profile is
a durable asset a human will want to revisit, re-extract, or hand off —
so here, the original reference images **are** persisted to
`references/<n>.png`, a staging area the drawing/revision pipeline never
reads from directly (identical role to Style Lab's own
`data/pixel-forge/style-refs/<packId>/`). The hard rule that *does* carry
over unchanged: these images are **never** sent to `runDrawingJob`/
`runRevisionJob` — only to the one-off extraction call(s), and only the
derived text (`shapeVocabulary`/`exclusions`/etc.) ever reaches a
generation job.

**`TraitAsset` gets one new optional field:**
```ts
collectionId: string | null;   // null = not part of any collection (100% of today's traits)
```
Normalized/defaulted `null` for legacy records — the exact same pattern
already used for `referenceGuidanceNote`. Every other `TraitAsset` field,
every existing route, and every trait with `collectionId: null` behaves
byte-for-byte identically to today — this is the same backward-
compatibility guarantee Reference Mode already shipped and proved.

**New routes** (`requireAuth`-gated, same rate-limit buckets as existing
routes — profile CRUD on the cheap `limit` bucket, `extract` on the
`startLimit` bucket since it's the one route that spends money):

```
POST   /api/tools/pixel-forge/collections                 — create draft (name/description only)
GET    /api/tools/pixel-forge/collections                 — list
GET    /api/tools/pixel-forge/collections/:id              — full profile
PATCH  /api/tools/pixel-forge/collections/:id              — manual edits (no AI call) — mirrors patchTraitAssetMeta
DELETE /api/tools/pixel-forge/collections/:id              — discard
POST   /api/tools/pixel-forge/collections/:id/references   — upload 1–3 images (reuses validateReferenceImage as-is)
POST   /api/tools/pixel-forge/collections/:id/extract       — the ONE AI-call route in this whole feature
```

`POST /api/tools/pixel-forge/jobs` gains one new optional body field,
`collectionId?: string` — resolved server-side exactly as described in §3.

---

## 9. Cost strategy

- **Extraction runs once per profile lifecycle event** (create, or an
  explicit re-extract), never per generation — this is the core saving
  versus today's Reference Mode, where the vision call repeats on every
  single reference-guided job. A profile's extraction cost amortizes
  across every future trait generated under it.
- **Model selection reuses the exact already-shipped mechanism**: the
  same single-constant-switch pattern as `REFERENCE_ANALYSIS_MODEL`
  (Sonnet default, swap to Haiku to benchmark) — no new architecture
  needed for this question at all.
- **Cheap dry-runs**: add a `dryRun?: boolean` flag to `POST /jobs` (and/
  or a dedicated debug endpoint) that resolves and returns the fully-
  composed `anchor`/`palette`/`collectionStyleGuidance` text **without**
  calling any model — lets a human sanity-check bbox-fraction math and
  prompt composition for free before spending money on an actual draw.
  Directly mirrors the existing CLI validation harness's own `--dry-run`
  flag (`pixel-forge-validation.ts`'s documented usage).
- **No per-generation reference analysis once a profile exists**: a job
  with `collectionId` set must not *also* trigger `analyzeReferenceImage`
  — the two are mutually exclusive per job. If a request somehow supplies
  both, the profile takes precedence and the ad hoc reference upload
  should be rejected with a clear error, not silently double-billed.

---

## 10. MVP vs. deferred

**MVP (small, per the brief's own framing, refined by §2's two-step
sequencing):**
- One profile creation flow, **manual-only first** (§2 step 1) — zero AI
  cost to prove the plumbing — then hybrid auto-extract from 1–3
  references (§2 step 2) as the very next increment, not bundled in.
- Manual edit of every profile field, always available (mirrors the
  trait-approval precedent: extraction is a draft, never authoritative).
- Generate `head`/`body`/`eyes`/`mouth`/`headwear`/`accessory` traits
  against an approved profile — the core ask.
- `LayerType` extended with `head`/`headwear` (small, contained schema
  change, four files touched in lockstep).
- Soft enforcement only: prompt-time guidance + RepairPlan-via-evaluator
  (§6). No code-level post-hoc bbox validator yet (§5 tier 3) — fast
  follow, not MVP.
- No full mint/collection-build pipeline, no automatic rarity, no batch
  generation (one trait per job, exactly as today) — all explicitly
  out per the brief.
- No "preview layered stack" compositor UI on day one — cheap client-
  side version is a fast-follow (§7 point 6), not MVP.

**Deferred, explicitly and for the same reasons every prior Pixel Forge
design doc already gives:**
- ML/embeddings/training/similarity-scoring — never; reaffirmed here same
  as every prior doc's own non-goals section.
- Interactive grid-calibration UI — still `pixel-forge-reference-
  system-v1.md`'s territory, still not needed (this design uses fractional
  bboxes entered as plain numbers, not a calibrated pixel grid).
- Multi-agent orchestration.
- 3–10 reference extraction (Option B) — revisit only once 1–3-reference
  quality has actually been measured.
- The AI-free collection compositor itself — unrelated, unaffected,
  already future work per `agent-loop.ts`'s own header comment; this
  design only gets the trait library closer to being compositor-ready.

---

## 11. Risks

- **Enum extension touches multiple files in lockstep.** `LayerType` is a
  hard union referenced in `agent-loop.ts` (`DEFAULT_Z_INDEX`-equivalent),
  `store.ts`, `tools-pixel-forge.ts` (`ALLOWED_LAYER_TYPES`), and the
  frontend's own `LAYER_TYPES` const — a partial update would let an
  invalid value pass validation in one layer but not another. Small
  change, but must land atomically across all four.
- **Free-text anchor rendering is advisory, not enforced**, same
  limitation `anchor` already has today — a model can still ignore a
  bbox instruction. §5's tiered mitigation (prompt → RepairPlan → future
  post-hoc code check) is a staged answer, not a guarantee, until tier 3
  ships.
- **Re-extraction cost creep** — must stay an explicit, confirmed user
  action, never triggered automatically (e.g. never re-run on every
  profile *view*).
- **Sharper evaluation into an unreliable revision mechanism** — the
  exact risk `pixel-forge-reference-system-v1.md` flagged for the
  single-reference case. Materially lower here since Revision V4 is
  already proven, but still a reason to land §6 exactly as "existing
  RepairPlan categories, no new mechanism" rather than inventing a
  separate, looser enforcement path.
- **Rights/provenance** — same mandatory, non-optional `sourceNote` per
  reference pack as Style Lab already specified; no scraping, manual
  upload only.
- **Backward compatibility** — `collectionId: null` must be verified to
  behave identically everywhere (gallery listing/filtering, revision,
  deletion) — low risk given the established optional-field pattern, but
  worth an explicit check before calling this feature done, same as
  `referenceGuidanceNote`'s own rollout.

---

## 12. First MVP implementation step

One small, self-contained, zero-AI-call step that unblocks everything
else: add `src/pixel-agent/collections-store.ts` (mirroring `store.ts`'s
exact atomic-write/normalize conventions) plus the manual-only CRUD routes
(`POST/GET/PATCH/DELETE /collections` — no `extract` route yet, no AI call
anywhere in this step), and extend `LayerType` with `'head'`/`'headwear'`
across all four files that enumerate it. This alone proves the storage
shape, the API shape, and the schema extension end-to-end with zero paid
risk, and is the precondition every later step (extraction, job-resolution
plumbing, UI) builds on.
