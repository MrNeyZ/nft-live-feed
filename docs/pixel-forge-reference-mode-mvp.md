# Pixel Forge — Reference Upload / Reference Mode (MVP)

Status: **design only, no code, no API calls, no deploy.** Scoped
deliberately smaller than `pixel-forge-reference-system-v1.md` (the
calibrated, persistent `ReferencePack` design) — this is the "upload one
image, get a style nudge on one generation" version, per explicit
instruction to keep MVP small. Read this alongside that doc rather than
instead of it; §7 explains exactly how they relate and why this is not a
half-built version of it.

---

## Relationship to `pixel-forge-reference-system-v1.md`

That document designed a persistent, calibrated, collection-wide
`ReferencePack` — interactive grid calibration, mechanical (Layer A) +
semantic (Layer B) analysis, a stored object reusable across many
generations — and explicitly recommended **not** building it yet,
sequenced behind generic construction-principle prompt work and Revision
V4. Its own conclusion was structural, not just "too early": **more
specific evaluation fed into an unreliable revision mechanism produces
more confident regressions, not better traits.**

This MVP is a different, much smaller thing that happens to share some
DNA with that doc's Layer B (semantic, qualitative) analysis:

| | Reference System V1 | This MVP |
|---|---|---|
| Scope | one pack, reusable across every future generation | one image, used once, for one generation job |
| Calibration | interactive grid overlay, logical-pixel extraction | none — image analyzed as-is |
| Analysis | Layer A (mechanical arithmetic) + Layer B (one vision call) | Layer B only, simplified |
| Storage | new `ReferencePack` store, versioned, approvable | none — image discarded after one analysis call |
| Applies to | generation *and* revision (revision reuses the pack's standard) | generation only |
| New UI | grid-calibration workspace | one file input + preview on the existing form |

Everything in reference-system-v1.md §1 ("inherit vs. never inherit",
"the user is calibrating an instrument, not uploading a picture") still
applies conceptually — this MVP just skips calibration and persistence,
because a one-shot per-generation nudge doesn't need either.

---

## 1. UI flow

On the existing "Draw a new trait" panel only (**not** the revise-trait
flow — see §6 for why):

1. A new optional field: **"Style reference (optional, image)"** — a
   file input +, once a file is chosen, a small preview thumbnail next
   to a "Remove" button. Plain HTML file input, no drag-drop
   infrastructure needed for v1.
2. A short static line under it: *"Used once, as a style hint for this
   generation only — never reused, never saved. Structure/mood only:
   proportions, outline weight, palette-ramp behavior, silhouette. The
   specific subject, accessories, symbols, and exact colors of your
   reference are never copied."* This is the same "inherit vs. never
   inherit" framing as the full Reference System, just written for a
   one-shot context.
3. A one-line rights checkbox: *"I have the right to use this image as a
   style reference."* — unchecked by default, required to enable
   Generate when a reference is attached. Cheap, matches this project's
   existing "provenance/rights is a blocking field, not metadata"
   pattern from Style Lab, scaled down for a non-persistent upload.
4. On Generate (with a reference attached): the button label changes to
   *"Analyzing reference…"* briefly before *"Drawing…"* — one extra,
   visible phase distinct from the existing draw/refine loop, so the
   user knows an extra model call happened and isn't confused by the
   slightly longer wait.
5. On completion, the result panel (and the saved trait's card, if we
   include §8's optional note field) shows a small collapsible
   **"Reference guidance used"** block with the derived text — never the
   uploaded image itself (it was never stored). Full transparency into
   what was actually inherited, same spirit as Style Lab's
   human-reviewable analysis draft.
6. No "reference gallery," no way to pick a previously-uploaded
   reference — every generation that wants one requires a fresh upload.
   This single decision is what avoids building any persistent store at
   all.

---

## 2. Backend API shape

Extend the **existing** `POST /api/tools/pixel-forge/jobs` route rather
than adding a new endpoint — a reference is an input to one generation
job, not an independent resource.

```
POST /api/tools/pixel-forge/jobs
{
  prompt, layerType, canvasSize, palette, modelPreset, maxTurns, anchor,
  tags, notes, name, zIndex,        // ← all unchanged, existing fields
  referenceImage?: {                // ← new, optional
    base64: string,                 // raw image bytes, base64 — no data: URL prefix
    mimeType: 'image/png' | 'image/jpeg',
  },
  referenceRightsConfirmed?: boolean,  // must be true if referenceImage is present
}
```

Base64-inline-in-JSON, not multipart/`multer` — this repo has no upload
middleware anywhere, the global body parser is already
`express.json({ limit: '10mb' })` (`app.ts`), and `store.ts` already
established the precedent that this app returns/accepts image bytes as
inline base64, never a separate binary route. A capped reference image
(see validation below) fits comfortably inside the existing 10 MB limit
with room to spare.

**Server-side validation** (new, in `tools-pixel-forge.ts`, same style as
existing `normalizePalette`/`parseZIndex` helpers):
- `mimeType` must be `image/png` or `image/jpeg`.
- Decoded byte length capped (e.g. **≤ 2 MB**).
- Actual image dimensions checked via `sharp(...).metadata()` (already a
  dependency) after decoding — cap width/height (e.g. **≤ 1024×1024**);
  reject rather than silently resize a huge upload.
- Magic-byte sniff via `sharp` itself (it throws on a non-image buffer) —
  don't trust the declared `mimeType` alone.
- `referenceRightsConfirmed !== true` when `referenceImage` is present →
  `400 reference_rights_not_confirmed`.

**New internal step**, before `runDrawingJob` is called:
```ts
const guidance = await analyzeReferenceImage(referenceImage.base64, referenceImage.mimeType);
// guidance: { inherit: string[], exclusions: string[], note: string }
```
`referenceImage.base64` is **not** kept past this call — no variable
holding it survives into the `runDrawingJob` call or the job's stored
state. `guidance` (short text) is what continues on.

---

## 3. Storage location

**None, durably.** The uploaded image:
- is never written to `data/pixel-forge/traits/` (that's finished trait
  assets only),
- is never written to `data/pixel-forge/validation-runs/` (unrelated),
- is never given a new directory of its own,
- lives only in the request body and the one `analyzeReferenceImage`
  call's memory, for the duration of that single HTTP request.

If `sharp` needs a temp file for any decode step (it doesn't — it
operates on in-memory buffers fine), nothing would persist past the
request regardless. This is the single biggest simplification versus the
full Reference System, and it's what makes "no rights/provenance store,
no re-review workflow, no schema drift on a new stored object" all true
for free.

The only thing that *may* persist (see §8, proposed but skippable) is the
short derived **text** guidance on the resulting `TraitAsset` — never the
image.

---

## 4. How the reference is passed to `runDrawingJob` / `runRevisionJob`

**Never as image bytes to the drawing/refining model.** Only the
derived text guidance reaches it, appended to `buildSystemPrompt` as one
more optional labeled section — structurally identical to how `anchor`
is already appended today:

```ts
// agent-loop.ts — buildSystemPrompt gains one new optional param
function buildSystemPrompt(
  canvasSize: number, palette: readonly string[], layerType: LayerType,
  anchor?: string, referenceGuidance?: string,   // ← new
): string {
  // ...existing lines...
  if (referenceGuidance && referenceGuidance.trim()) {
    lines.push(
      '',
      'Style reference (structure only — the source image itself is not',
      'shown to you and must not be guessed at or reconstructed):',
      referenceGuidance.trim(),
    );
  }
  if (anchor && anchor.trim()) {
    lines.push('', `Anchor / alignment requirement: ${anchor.trim()}`);
  }
  return lines.join('\n');
}
```

`runDrawingJob` gains one new optional parameter (`referenceGuidance?:
string`) threaded straight through to this call — no change to its
tool-calling loop, no change to `runRevisionJob` at all (out of scope,
see §6).

---

## 5. Preventing literal IP/style copying

Layered, not a single control:

1. **Structural (the real guarantee):** the draft/refine model never
   receives the reference image — only text. It cannot copy pixels it
   is never shown. This is the same argument reference-system-v1.md
   makes for its own design, and it's the one that actually matters;
   everything below is reinforcement, not the load-bearing part.
2. **The analysis call's own instructions** (a new forced-tool-call
   prompt, structurally identical to `SUBMIT_EVALUATION_TOOL`) explicitly
   separate what to extract:
   - **Inherit:** proportions/silhouette shape, outline weight and
     consistency, palette-ramp *behavior* (step count, hue-shift
     direction — never literal hex values), shading/cluster density,
     construction hierarchy (e.g. does headwear sit as an outer frame).
   - **Never inherit / must list as exclusions:** the specific subject,
     named accessories or symbols, exact color values, exact
     composition/pose. Directly reused from reference-system-v1.md §1's
     inherit/never-inherit split.
3. **An explicit negative-guidance line is mandatory in the analysis
   output** (`exclusions: string[]`, non-empty), folded into the prompt
   as active instruction — *"the following must NOT be reproduced: the
   reference's specific subject; do not attempt to recreate its
   composition or exact palette"* — not merely omitted by leaving it out.
4. **Palette stays under the user's control.** The job's existing
   `palette` param is what the model actually draws with; reference
   guidance may describe ramp *shape* ("3-4 steps, hue shifts warmer at
   the highlight") applied to whatever palette is already supplied, but
   never supplies literal colors of its own.

---

## 6. Structure/style guidance vs. pixel cloning — and why revision is out of scope

The analysis output schema itself enforces this by only having fields for
qualitative properties — there's no field for coordinates, no field for
"reproduce this exact shape," nothing that could smuggle a literal
description of pixel positions through:

```ts
interface ReferenceGuidance {
  inherit: string[];       // e.g. "consistent near-black outline, no color variation"
  exclusions: string[];    // e.g. "do not reproduce the reference's own subject/character"
  note: string;            // one-line free-text summary, shown in the UI (§1.5)
}
```

**Revision is explicitly out of scope for this MVP** — same conclusion
reference-system-v1.md §4 already reached for the full system: attaching
a style reference to an *existing* trait and asking revision to "match
it better" is regeneration, not repair, and collides with Revision V4's
surgical, region-scoped philosophy (`buildRevisionSystemPrompt`'s DEFAULT
RULE: untouched regions are off-limits). A reference belongs at
draft-time, when there's no existing trait to accidentally restyle.

---

## 7. Interaction with existing `prompt` / `palette` / `anchor` / `layerType`

- **`prompt`** — unchanged and still primary; reference guidance is
  supplementary text appended after everything else already in the
  prompt (§4), never replacing or reinterpreting the requested subject.
- **`palette`** — unchanged; see §5.4. Reference never supplies colors.
- **`anchor`** — orthogonal, coexists fine; anchor governs
  positioning/alignment, reference governs style/construction. Rendered
  as two separate labeled sections, no merging logic needed.
- **`layerType`** — no gating for MVP. Reference-system-v1.md's
  `applicableArchetype`-vs-`layerType` soft-mismatch warning is real but
  adds a whole classification field to the analysis output for a problem
  that, worst case, just makes the guidance a little less relevant — not
  harmful. Explicitly deferred (§9).

---

## 8. What MVP should include

1. File input + preview + remove + rights checkbox on the **fresh-draft
   form only**.
2. Server-side validation: mime type, byte-size cap, dimension cap,
   `sharp`-based real-image sniff, rights-confirmed flag required.
3. One new forced-tool-call analysis function, `analyzeReferenceImage`,
   modeled directly on `SUBMIT_EVALUATION_TOOL`/`parseEvaluation`'s
   existing pattern (schema, defensive parse, never throw on a
   malformed model response).
4. **Always use the `fast` (Haiku) preset for this one analysis call,
   regardless of the job's chosen `modelPreset`** — it's a qualitative
   description task, not the hard part of the job; keeps the added cost
   small and predictable and decoupled from the user's quality choice for
   the actual drawing.
5. `buildSystemPrompt` gains the optional `referenceGuidance` param
   (§4). `buildRevisionSystemPrompt` does **not** change.
6. The original image is discarded the moment `analyzeReferenceImage`
   returns — no code path holds onto it afterward.
7. **Proposed, cheap, worth including:** `TraitAsset` gains one new
   optional field, `referenceGuidanceNote: string | null` (the `note`
   text only, never the image) — same shape as `anchor`/
   `lastRevisionPrompt`, defaulted to `null` on normalize for legacy
   records. Gives provenance/transparency on the saved trait for near-
   zero cost. Skippable if even that feels like too much for v1 — the
   UI can show the note from the live job result without persisting it.
8. Cost estimate/logging for the extra call follows the exact existing
   convention (`estimateJobCostUsd`-style pre-flight log, actual-usage
   log after, same as every other call in this router).

---

## 9. What should be explicitly deferred

- Interactive grid-calibration UI (zoom/pan/origin-drag/logical-
  resolution confirmation) — reference-system-v1.md territory, not
  needed here since nothing is measured pixel-precisely.
- Persistent `ReferencePack` store / reuse across multiple generations —
  re-upload every time, by design, for MVP.
- Any collection-wide "shared reference for this whole set" mechanism.
- Layer A mechanical arithmetic (palette/ramp/outline measurement via
  code over an extracted logical grid).
- Reference support on the revision/`traits/:id/revise` flow (§6).
- `applicableArchetype` / `layerType` soft-mismatch warning (§7).
- Background-region marking, negative-space measurement.
- Any training, embeddings, segmentation model, or multi-agent
  orchestration — explicitly excluded by the request; nothing above
  needs any of these, one more forced-tool-call Claude request is the
  only new model interaction, same pattern as `submit_draft`/
  `submit_evaluation` already establish.

---

## 10. Recommended architecture (summary)

```
Upload (ephemeral, request-scoped)
        │
        ▼
validate (mime/size/dimensions, sharp sniff)
        │
        ▼
analyzeReferenceImage()  ── one Haiku forced-tool-call, image shown ONCE, here only
        │  (image discarded after this call — nothing downstream ever sees it)
        ▼
ReferenceGuidance { inherit[], exclusions[], note }
        │
        ▼
buildSystemPrompt(..., referenceGuidance)  ── text only, folded in like `anchor`
        │
        ▼
runDrawingJob()  ── existing draw/refine/evaluate loop, unchanged otherwise
        │
        ▼
TraitAsset { ..., referenceGuidanceNote: note }   ← optional, text only
```

---

## 11. Exact files likely touched (implementation, later)

- `src/pixel-agent/agent-loop.ts` — `buildSystemPrompt` gains
  `referenceGuidance?: string` param + section; `runDrawingJob` gains and
  threads the same param through. `buildRevisionSystemPrompt` unchanged.
- `src/pixel-agent/tools.ts` (or a small new
  `src/pixel-agent/reference-analysis.ts`, kept separate since it's a
  distinct forced-tool-call, not part of the draw/refine/evaluate
  toolset) — `REFERENCE_ANALYSIS_TOOL` schema, `parseReferenceGuidance`
  defensive parser, `analyzeReferenceImage()` function.
- `src/server/tools-pixel-forge.ts` — `POST /jobs` body gains
  `referenceImage`/`referenceRightsConfirmed`, new validation helpers,
  calls `analyzeReferenceImage` before `runDrawingJob`.
- `src/pixel-agent/store.ts` — optional `referenceGuidanceNote: string |
  null` on `TraitAsset`/`TraitAssetSummary`, normalized/defaulted in
  `normalizeTraitAsset` (only if §8.7 is included).
- `frontend/src/app/tools/pixel-forge/page.tsx` — file input + preview +
  remove + rights checkbox on the draw form; "Analyzing reference…"
  status; "Reference guidance used" collapsible display on the result
  and (if §8.7 included) on saved trait cards.
- No new files under `data/pixel-forge/` — nothing durable to store.

---

## 12. Risks

- **Guarantee erosion over time** — the anti-copying property depends
  entirely on the image never reaching the draw/refine call. This must
  stay a hard architectural rule (image variable never threaded past
  `analyzeReferenceImage`), not just a comment, or a future "simplify
  this" pass could accidentally attach the raw image directly to the
  draft call.
- **Extra cost/latency per reference-guided generation** — one more
  model call (mitigated by always forcing `fast`/Haiku for it,
  independent of the job's own preset).
- **Analysis quality/consistency** — a single cheap-model qualitative
  description may be shallow or inconsistent run to run; acceptable for
  a soft style nudge, not acceptable if this were ever treated as a hard
  constraint (it shouldn't be, for this MVP).
- **Rights/provenance** — no durable storage lowers the stakes
  significantly versus a persistent `ReferencePack`, but the checkbox in
  §1.3 is still the only guard; low bar, appropriate for a personal-use
  tool, not appropriate to skip entirely.
- **Upload validation gaps** — must actually decode/sniff via `sharp`,
  not just trust the declared `mimeType`/extension; a crafted non-image
  payload must fail cleanly, not crash the job.
- **Scope creep during implementation** — easiest failure mode is
  drifting toward rebuilding calibration/persistence mid-build. §9's
  deferred list exists specifically to be re-checked against before
  adding anything not already named above.

---

## 13. Testing plan — no Anthropic calls first

**Pure-function / no-API tier** (all of this is checkable before any
paid call):
1. Upload-validation helper — unit-test with a valid small PNG buffer, an
   oversized buffer, a non-image buffer with a `.png` name, an
   over-dimension image — assert accept/reject matches expectations.
   Same style as existing `normalizePalette`/`parseZIndex` tests-by-
   inspection in this router.
2. `buildSystemPrompt` with and without `referenceGuidance` — assert the
   new section appears/doesn't appear and doesn't disturb existing
   sections (anchor, layerType conditionals) — pure string assembly, no
   model call, same as verifying the hair/beard shape-vocabulary addition
   was inserted correctly in the prior session.
3. `normalizeTraitAsset` with a record that has/lacks
   `referenceGuidanceNote` — confirm legacy records still load with
   `null`, matching every other optional-field precedent in that file.
4. Frontend: render the form with the new file input, select a local
   dummy PNG, confirm the preview/remove/checkbox state machine behaves
   (enable/disable Generate correctly) — no network call, no Generate
   click, pure component-state check (`npx tsc --noEmit` + a manual
   click-through, same as this session's gallery verification).
5. `npx tsc --noEmit` (root + frontend) and `npm run build` (both) —
   same gate every other change in this project has passed through.

**First paid check, only after the above is green and only with explicit
go-ahead** (same convention as every prior smoke test in this project):
one small, genuinely pixel-art reference image, one simple prompt,
`analyzeReferenceImage` forced to `fast`/Haiku regardless of draw preset,
`--max-turns`/cost-limited draw job, single prompt only. Compare the
resulting trait's `blindDescription`/rendered silhouette against a
no-reference baseline draft of the same prompt to check the guidance
produced a *visible, plausible* style nudge (not a no-op, not a literal
copy of the reference's subject) — same "run id / cost / before-after"
report shape this project already uses for every other smoke test.
