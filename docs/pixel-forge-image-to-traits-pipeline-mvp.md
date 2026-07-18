# Pixel Forge — Image-to-Traits Pipeline MVP

Status: **design only, no code, no API calls, no deploy.** Grounded directly
in code paths and artifacts already exercised this session: the raster
conversion prototype (`src/scripts/pixel-forge-raster-to-pixel.ts`), the
one-off import script (`src/scripts/pixel-forge-import-raster-trait.ts`, and
its real output, trait `675f9875-962f-48a7-87d0-03a8ff3829d6`), and the
existing trait store (`src/pixel-agent/store.ts`). Every claim about "this
already works" below is backed by something that actually ran, not a guess.

---

## 0. Why this direction change makes sense

The old approach (Claude drawing from scratch with `set_pixel`/`fill_rect`)
produced a genuinely bad result this week — a raccoon body request came back
as, in the model's own blind evaluation, "a robot, TV, or a boxy toaster."
The raster-conversion prototype built this session, run on a real
already-pixel-art-style raccoon PNG, produced a clean, recognizable,
on-model 48×48 result on the first try, algorithmically, for zero API cost.
That comparison is the whole argument for this pivot — not a hypothesis.

---

## 1. Is this feasible with the current codebase?

**Yes**, and unusually concretely so: the two hardest, most novel pieces are
already built and validated, not just designed:

- **Raster→grid conversion** — `pixel-forge-raster-to-pixel.ts` already does
  square-fit, nearest/area resize, palette quantization, and best-effort
  background removal, and was run against a real 1254×1254 source image
  this session with good results at 48×48.
- **Trait storage/schema** — `saveTraitAsset` already accepts a
  non-generated, imported trait and makes it fully indistinguishable, on
  disk and in `listTraitAssets`, from a real Claude-drawn one. Proven this
  session (trait `675f9875-...`, status `candidate`, correct
  `collectionId`).

What's genuinely new: **source-derived palette extraction** (small
algorithmic upgrade — see §6's honest caveat), **deterministic cleanup**
(new but well-understood techniques), **trait splitting** (new, medium
complexity, partially reliable — see §11), **artifact-only Claude review**
(new tool schema, reuses an existing calling pattern), and **ZIP export**
(new, standard). None of this requires new infrastructure *classes* — it's
extension of patterns this codebase already has.

---

## 2. Reusable pieces

| Piece | Reusable as-is? | Notes |
|---|---|---|
| `pixel-forge-raster-to-pixel.ts` | Mostly | Resize/bg-removal port directly into a route; palette step needs to change from generic `DEFAULT_PALETTE` to source-derived (new function, same shape) |
| `TraitAsset` store (`store.ts`) | **Yes, fully** | `saveTraitAsset`/`listTraitAssets`/`getTraitAsset`/`patchTraitAssetMeta` — already proven this session to accept and correctly surface an imported trait |
| Layer Stack Preview (`layer-stack.ts`) | **Yes, fully** | Its `groupTraitsForStack`/warnings logic operates purely on `{id, name, layerType, zIndex, size, status, collectionId}` — imported/split traits have this shape identically to generated ones; explicitly designed to be generation-source-agnostic already |
| Collection storage (`collections-store.ts`) | **Yes, fully** | An imported NFT's traits file under a real `Collection` exactly like the session's raccoon import did |
| `sharp` | **Yes, fully** | Already the engine for every new step (resize, raw-pixel access for connected-components, cleanup, palette extraction) |
| Validation preview UI (`validation-previews.ts`) | **Pattern only, not the module** | That module's own doc comment states previews "cannot be represented as a real TraitAsset without fabricating data" — the opposite of what this pipeline needs (its outputs MUST become real traits). Build a new, small variant-comparison component instead — closer in spirit to the existing reference-image upload/preview UI already in `page.tsx` |

---

## 3. New backend routes

Recommend a **new companion router file**, `src/server/tools-pixel-forge-raster.ts`
(mounted alongside the existing one in `app.ts`) — `tools-pixel-forge.ts` is
already ~780 lines; six more routes belong in their own file, matching this
codebase's own convention of splitting by concern
(`collections-store.ts`, `validation-previews.ts` are already separate
modules off the same parent feature).

| Route | Stage | Anthropic call? | Notes |
|---|---|---|---|
| `POST /api/tools/pixel-forge/raster/normalize` | 1 | No | `{ imageBase64, mimeType, sizes[] }` → variants (base64 PNGs + palettes), **not persisted** — mirrors `analyzeReferenceImage`'s "validate, don't persist" pattern |
| `POST /api/tools/pixel-forge/raster/import` | 1 | No | `{ chosen variant, name, layerType, tags, notes, collectionId }` → `saveTraitAsset`, returns the new `TraitAsset` |
| `POST /api/tools/pixel-forge/raster/:id/artifact-review` | 2 | **Yes, one call** | Narrow, forced-tool-call, fresh-context vision review — defects only, no drawing tools |
| `POST /api/tools/pixel-forge/raster/:id/cleanup` | 2 | No | Deterministic despeckle/outline-repair; either previews or writes via `updateTraitAsset` |
| `POST /api/tools/pixel-forge/raster/:id/split` | 3 | No | Mask/connected-components proposal; returns candidate layers for human accept/reject — no `saveTraitAsset` call until accepted |
| `GET /api/tools/pixel-forge/raster/:id/export` | 4 | No | Streams the ZIP |

Rate limiting: everything except `artifact-review` is local compute only, so
use the existing `limit` bucket (90/min, matching every other read/write
route in `tools-pixel-forge.ts`); `artifact-review` is the only one that
should share `startLimit` (10/min) since it's the only one spending real
Anthropic budget.

---

## 4. New frontend UI

Given `page.tsx` is already ~2200 lines and grew twice this week, **don't**
add this inline. New pieces, likely under a new sub-route
(`/tools/pixel-forge/raster`, see §5):

- Upload dropzone — mirrors the existing reference-image upload/validation
  UI in `page.tsx` almost exactly (same client-side mime/size checks, same
  preview pattern).
- Variant comparison grid (2×2 or 2×4: nearest/quantized × 32/48) —
  visually the same comparison I produced manually this session, rendered
  in-browser instead of by hand.
- "Import as candidate" button → calls the new import route, then the trait
  appears in the *existing* gallery/Layer Stack Preview immediately (it's a
  real `TraitAsset` — no new display path needed).
- (Stage 2+) Artifact report panel — reuse the existing `Evaluation`/repair-plan
  display components already in `page.tsx`, same visual language.
- (Stage 3+) Split panel — mask overlay per proposed layer, accept/reject
  each independently.
- (Stage 4+) Export button — reuse the existing `downloadBlob` pattern
  already used for single-trait PNG download.

---

## 5. Separate tab/panel from Claude trait generation?

**Yes, clearly separate.** This is a structurally different workflow — no
prompt, no model preset, no `maxTurns`, none of the reference-mode
checkboxes apply. Mixing it into the same form compounds a page that's
already showing sprawl warning signs. Recommend: "Draw" tab (existing
Claude flow) vs. "Import & Convert" tab (this pipeline), both feeding the
same trait gallery/Layer Stack Preview underneath, since both produce plain
`TraitAsset` records.

---

## 6. What should be fully deterministic

Everything except the one narrow, optional review step (§7):

- Square-fit/crop, resize (nearest + area-average)
- Source-derived palette extraction
- Background removal (corner-color heuristic already built; extendable to
  user-marked-color later)
- Despeckle / isolated-artifact cleanup (recolor orphan pixels to their
  dominant neighbor — standard morphological technique)
- Connected-components labeling (for split proposals)
- Bounding-box computation
- Upscale/export rendering, ZIP assembly

**Honest caveat on palette extraction specifically**: this session's real
raccoon import extracted a 675-color "palette" from the *nearest* variant
(no forced quantization) — every anti-aliasing shade survived as its own
entry. That's fine for a faithful pixel-for-pixel import (which is what was
asked for then), but the *pipeline's* palette step should target a small,
curated derived palette (e.g. top-K dominant colors via simple
frequency/median-cut clustering — still zero ML, zero API calls) rather
than "every distinct color," specifically to avoid repeating that outcome
as the default going forward.

---

## 7. Where should Claude still be used

Narrowly, optionally, and **never for redrawing**:

- **Artifact-only review** (Stage 2+, opt-in) — one forced-tool-call vision
  pass: "list what's wrong, don't fix it." Structurally similar to
  `analyzeReferenceImage` (thinking disabled, forced `tool_choice`, fresh
  single-turn context — same calling convention, reused), but a brand-new
  tool schema scoped to: white/transparent specks, broken outline, off-grid
  blocks, lost facial features, unreadable subject, bad symmetry. Explicitly
  **not** given `set_pixel`/`fill_rect`/`flood_fill` — it can describe a
  problem, never touch a pixel.
- **Optional small edit-plan suggestion** (user's own "optional later" —
  keep it optional): Claude proposes a small, human-reviewed instruction
  ("left ear has 3 stray pixels near x=12,y=4"); a human or a constrained
  deterministic tool applies it. Never a free-form redraw. This is the
  direct lesson from the old approach's failure: reviewing/pointing is a
  much cheaper, much more bounded task for a vision model than generating
  pixel-perfect art blind.
- Text-only reference guidance (`analyzeReferenceImage`, already shipped)
  stays available for the *old* from-scratch flow — not part of this
  pipeline, not being removed either.

---

## 8. Where OpenAI/ChatGPT image generation integrates later

As a single, cleanly isolated **Stage 0** producer: a later, optional route
(e.g. `POST /api/tools/pixel-forge/raster/generate-source`) that calls an
external image API and feeds its PNG straight into the *same* `normalize`
step the manual-upload path already uses. Stages 1–4 (normalize → preview →
import → cleanup/split/export) are 100% agnostic to whether the source PNG
came from a file upload or an API call, as long as the upload contract (raw
PNG bytes in) stays identical. Practically: build and validate the whole
pipeline against manual uploads first (exactly what's being asked for), and
OpenAI integration becomes a small, late, additive change — a new upstream
producer, not a pipeline rewrite. It needs its own gating (real external API
key, its own cost/rate limits, its own explicit consent screen given a
different vendor's ToS/data-handling) — but architecturally it's a leaf.

---

## 9. What's MVP without OpenAI, manual upload only

Exactly the user's own "Then:" line: **upload → normalize (nearest/area,
optional source-derived palette, background keep/remove) → preview
variants → choose best → import as candidate.** This alone delivers the
full value already proven manually this session (the raccoon import),
through the UI instead of by hand. Splitting, cleanup automation, artifact
review, and export are all legitimately post-MVP — none of them are
required to get "a converted image visible as a real candidate trait in the
gallery," which is the actual MVP bar.

---

## 10. Safest staged plan

1. **Stage 1** (this doc's concrete deliverable, §12): normalize + preview +
   import, manual upload, no Claude, no split, no export.
2. **Stage 2**: deterministic cleanup pass + optional, feature-flagged
   Claude artifact-only review — still zero redraw capability given to
   Claude.
3. **Stage 3**: semi-automatic trait splitting (masks + connected
   components), mandatory human accept/reject per proposed layer before any
   child trait is saved.
4. **Stage 4**: ZIP export (final + per-trait PNGs + raw grids +
   metadata/palette/manifest JSON).
5. **Stage 5** (much later, explicitly deferred): OpenAI image-generation
   integration as a new "Generate Source" producer feeding Stage 1.

---

## 11. Data model

New concepts needed, kept deliberately minimal:

- **Stage 1**: none. `normalize` is a pure computation endpoint — nothing
  persisted server-side beyond the request/response, exactly like
  `analyzeReferenceImage` today. The chosen variant becomes a normal
  `TraitAsset` the moment `import` is called; no new stored shape.
- **Stage 3+**: a `SplitManifest`, worth persisting since a user may revisit
  a split — `{ sourceTraitId, proposedLayers: [{ layerType,
  boundingBox: {x,y,w,h}, confidence: 'auto'|'needs-review', pixels,
  palette }], createdAt }`, stored as
  `data/pixel-forge/raster-splits/<sourceTraitId>.json` — one JSON-per-id
  file, mirroring `collections-store.ts`'s own convention. Only promoted
  into real per-layer `TraitAsset`s once a user accepts each proposed layer.

**Important architectural point**: the pipeline's *output* is always a
plain `TraitAsset` — no schema change to that type is needed anywhere in
this plan. Only the *in-progress* intermediate state (variant choices,
split proposals) needs new, disposable/staging structures.

---

## 12. Export format (Stage 4)

One ZIP:
- `nft-final.png` — composed, upscaled (480×480 or 512×512)
- `traits/<layerType>-<slug>.png` — upscaled preview, per accepted layer
- `traits/<layerType>-<slug>-raw.png` — 48×48 raw, per accepted layer
- `metadata.json` — NFT-level: name, `collectionId`, source provenance
  (uploaded filename, timestamp), list of trait ids/layerTypes
- `palette.json` — the source-derived palette actually used
- `split-manifest.json` — the accepted split record (bounding boxes,
  layerType assignments, confidence flags)

---

## 13. Risks / limitations (honest, evidence-based)

- **Trait splitting will not reliably isolate small, low-contrast features**
  (eyes, nose/mouth) by color/connected-components alone — proven concretely
  on the real raccoon image this session (see the earlier feasibility
  report). These need a manual-correction UI or, later, a narrow
  AI-assisted mask-*suggestion* pass — never full redraw.
- **Source-derived palette extraction can still misfire** on gradient-heavy
  or heavily anti-aliased sources — the 675-color "palette" from this
  session's raccoon import (nearest variant, no quantization) is a real,
  concrete example of the cliff this design's §6 caveat is meant to avoid.
- **Deterministic cleanup fixes noise, not structure** — despeckle/outline
  repair can't fix a badly cropped ear or squashed proportion; those need a
  better source image or human editing. This is exactly why the artifact
  review step is valuable even though nothing downstream can auto-fix what
  it flags yet.
- **IP/copy-risk carries over from Direct Reference Mode's own audit**
  (`docs/pixel-forge-direct-reference-mode-audit.md`) — an externally
  generated "SMB-like style" image raises the same concerns already
  documented there, arguably more directly here since this pipeline
  converts the actual external image rather than merely showing it as
  inspiration.
- **File growth** — `tools-pixel-forge.ts` is already large; start the new
  companion router file from Stage 1, not as a later refactor.

---

## 14. Exact Stage 1 implementation task

Concrete enough to hand off directly:

**Backend** — new `src/server/tools-pixel-forge-raster.ts`:
- `POST /api/tools/pixel-forge/raster/normalize` — accepts
  `{ imageBase64, mimeType, sizes[] }`, returns for each size: `nearest` +
  a new source-derived-palette `quantized` variant. Port the resize +
  background-removal logic straight from
  `pixel-forge-raster-to-pixel.ts`; replace its `DEFAULT_PALETTE` fallback
  with a small top-K dominant-color extraction function (new, ~20-30 lines,
  offline-testable with a synthetic buffer — no image I/O needed in the
  test).
- `POST /api/tools/pixel-forge/raster/import` — accepts a chosen variant's
  `size`/`palette`/`pixels`/`pngBase64` + `name`/`layerType`/`tags`/`notes`/
  `collectionId`, calls `saveTraitAsset` exactly as
  `pixel-forge-import-raster-trait.ts` already does this session (port that
  script's logic directly into the route handler — it's already proven
  correct end-to-end).

**Frontend** — new panel/tab in the Pixel Forge area (or new sub-route):
upload dropzone (mirrors the existing reference-image upload pattern in
`page.tsx`), a variant grid, and an "Import as candidate" action that calls
the new import route and refreshes the existing trait list.

**Explicitly out of scope for Stage 1**: Claude, splitting, export, OpenAI
integration. Just the manual-upload → normalize → choose → import loop —
already proven end-to-end this session, just not yet wired through the UI
instead of a CLI script.
