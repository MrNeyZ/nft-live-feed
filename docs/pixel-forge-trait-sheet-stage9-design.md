# Pixel Forge — Stage 9 Design: Trait Sheet Generation + Sheet Import + Compositor

Status: **design/planning only. No code, no API calls, no OpenAI calls, no
deploy, no PM2 restart.** Grounded directly in the current working tree —
every claim below cites a real file:line, not an assumption. Where this
doc disagrees with the task's own suggested defaults (grid size, cell
count), that's stated explicitly with the reasoning, same convention as
`pixel-forge-layer-stack-compositor-mvp.md`.

---

## 0. Grounding — what's actually true in the repo right now

| Claim | Confirmed at |
|---|---|
| `gpt-image-1` via `/v1/images/edits` is the only image-generation call site; it's a single deterministic edit call, not a multi-turn loop | `src/pixel-agent/openai-image-source.ts:1-27` |
| Current fixed params: `model=gpt-image-1`, `size=1024x1024`, `quality=medium`, `n=1`, no `background` param set at all | `openai-image-source.ts:36-44,114-120` |
| A server-side `DO_NOT_COPY_SUFFIX` is unconditionally appended to every prompt sent, never overridable by the client | `openai-image-source.ts:46-56,112` |
| Stage 6's storage already writes `source.png` + `meta.json` (prompt, model, size, quality, tokenUsage, estimatedCostUsd, referenceImageHash) per generation, never persists the reference image itself | `src/server/tools-pixel-forge-generate-source.ts:104-123` |
| Heuristic color-based split (`raster-split.ts`) already exists and works, but is explicitly tuned to ONE fixed portrait layout (hat top / body bottom / face center) via hardcoded hue rules — not a general per-NFT decomposer | `src/pixel-agent/raster-split.ts:1-12,106-133` |
| Real, already-shipped project history: decomposing a bust into **separately-generated** `body`/`eyes`/`mouth`/`accessory` calls — each with **zero visual awareness of its siblings** — is the layer-first workflow's *"central, currently-unmitigated risk"*, and is the *same failure mode* that already forced one reversal (`_020`/`_021`/`_007`/`_002`: decomposed generation was skipping head/face/hat/beard entirely, fixed by going back to one monolithic bust) | `docs/pixel-forge-generation-quality-bottleneck-audit.md:131-147` |
| `saveTraitAsset` stores a **palette-index quantized** representation (`{size, palette: string[], pixels: number[]}`), never raw RGBA — every existing import path (`/raster/import`, `/raster/import-split`) already runs `deriveSourcePalette` + `quantizeToPalette` before calling it | `src/pixel-agent/store.ts:72-123,321`; `src/server/tools-pixel-forge-raster.ts:521-530,700-707` |
| Every raster-imported trait uses fixed placeholder generation fields (`modelPreset:'fast'`, `actualModel:'none (... — no AI call)'`, `maxTurns:0`, `tokenUsage:null`, `estimatedCostUsd:0`, `evaluation: importPlaceholderEvaluation()`) and always lands `status:'candidate'`, tagged `raster-import` (+ `split-import` for the split path) — never auto-approved, never overwrites | `tools-pixel-forge-raster.ts:82-83,193,521-539,700-716` |
| `import-split` already imports **multiple traits from one route call**, one `saveTraitAsset` per accepted layer, with per-layer provenance text folded into `notes`, skips empty layers, returns `{created, skipped, warnings}` | `tools-pixel-forge-raster.ts:608-763` |
| Deterministic cleanup (`cleanupRasterImage`) and repair (`repairRasterImage`, `strength: 'safe'\|'medium'`) already exist and are pure/local, no AI | `raster-convert.ts:296-406`; `raster-repair.ts:26-33,169` |
| Stage 8's `computeCollectionFitMetrics` already computes, per 48×48 PNG: foreground bbox, coverage %, subject center, dark-outline ratio, dominant palette — all pure/local | `src/pixel-agent/collection-fit.ts` (whole module) |
| `LayerType` today is `background\|body\|eyes\|mouth\|accessory\|icon\|other` — **no `head`/`headwear`**, already twice-flagged as a real gap, explicitly out of scope for a no-code task | `agent-loop.ts:29-30`; `pixel-forge-layer-stack-compositor-mvp.md:122-196` |
| `DEFAULT_Z_INDEX`: background 0, body 10, eyes 20, mouth 30, accessory 40, icon 40 (tie), other 50 — a per-trait override, not enforced | `store.ts:46-54` |
| A **client-side, CSS-`<img>`-stack** compositor (selection/sort/warning logic only, no real PNG output) is already built as pure functions, explicitly deferring "export the composite as one flattened PNG" as future `<canvas>` work | `frontend/src/app/tools/pixel-forge/layer-stack.ts` (whole file); `docs/pixel-forge-layer-stack-compositor-mvp.md:251-283,322-324` |
| `Collection` records have no `canvasSize` lock and no sheet-layout pointer — a thin `{id, name, presetId, paletteOverride}` | `collections-store.ts:27-33` |
| Every existing raster/export/collection-fit route follows the same shape: `requireAuth`, a dedicated `rateLimit({limit:90,windowMs:60_000,...})` bucket, strict id-regex validation, own small router file mounted in `app.ts`, never touching `tools-pixel-forge-raster.ts` itself | `tools-pixel-forge-export.ts`, `tools-pixel-forge-collection-fit.ts`, `app.ts:170-200` |

**The single most important grounded fact for this whole design:** this
project already tried "generate layers separately" and it made quality
*worse*, not better, because each call loses sight of the other layers.
The trait-sheet idea is not a variation on that failed approach — it's
the fix for it, done the right way round: **one generation call that sees
the whole character at once** (so the model has full visual context,
exactly like the monolithic-bust approach that already works), decomposed
into separate importable layers **after the fact, by JS cropping**, not
by asking the model to draw each part blind. That reframing is the
rationale for everything below.

---

## Part A — Trait Sheet Generation

### A1. Direct answers to the eight questions

**1. Is one 3×3 sheet realistic with gpt-image-1?**
Unproven, and this project's own history (§0, bottleneck #4) is a
concrete reason for caution, not confidence. A single generation call
staying visually coherent across ONE character is already this project's
hardest solved problem (`generation-quality-bottleneck-audit.md`
bottleneck #1: self-evaluation bias; bottleneck #5: blind draft phase).
Asking the same model, in one shot, to keep **8-9 independently
recognizable sub-images** spatially co-registered to a shared coordinate
system, with correct empty/transparent regions between them, is a strictly
harder constraint that has never been attempted in this codebase. Treat
"3×3 works" as a hypothesis to validate cheaply, not a starting
assumption — see the staged validation plan in A6.

**2. Should we use 3×3, 2×4, or one trait type per call?**
Start with **one full-character generation** (already proven — this is
exactly today's Stage 6 call, zero new risk) as the control. Then
validate a **2×2 sheet (4 cells: full-preview + 3 core layers)** — the
smallest sheet that actually tests "can the model keep 2 non-preview
layers aligned," before ever attempting 8-9 cells. Only escalate to a
bigger grid once a smaller one is proven reliable by the validation
checks in A5. On grid *geometry* specifically (independent of the
reliability question): gpt-image-1 edits only accepts three output
sizes — `1024x1024`, `1024x1536`, `1536x1024` (`auto` also exists but
gives up deterministic cell math). **`1024×1024` does not divide evenly
by 3** (341.33px/cell) — not fatal (floor-boundary cropping is
well-defined and the eventual 48×48 downscale erases any sub-pixel
drift), but it does mean a 3×3 grid's cells are 341/341/342px, not a
clean, easy-to-reason-about number. An **8-cell 2×4 grid on `1024×1024`
divides perfectly** (512×256 or 256×512px/cell, exact integers) and
covers the task's own 8 *required* cells (0-7) without the 9th "optional
extra accessory" cell. **Recommendation: 2×4, 8 cells, `1024×1024`,
non-square cells (crop-safe — see A4) — not 3×3.** Revisit 3×3 only if
2×4 proves reliable and a real 9th-layer need shows up.

**3. How to prompt OpenAI to keep every layer aligned to the same 48×48
coordinate system?**
Three levers, all prompt-only (no technical guarantee — same caveat this
codebase already states for `DO_NOT_COPY_SUFFIX`, `openai-image-source.ts:46-53`):
   - Describe the grid **numerically and exhaustively** in the prompt
     (exact cell pixel bounds for the chosen size, not "top-left" prose)
     — see the template in A3.
   - Anchor every layer's description to **the full-preview cell's own
     geometry** ("draw ONLY the background pixels of the same character
     shown in cell 0, cropped to cell 0's own bounding box, nothing
     shifted") rather than describing each layer in isolation — this is
     the one direct lever against the bottleneck-#4 failure mode, since
     it forces every prompt sentence to reference the shared reference
     composition instead of describing 8 independent things.
   - Explicit **negative instructions** against the two failure modes
     seen elsewhere in this project: nothing drawn outside its own cell's
     bounds (crop-safety), and no resizing/repositioning the character
     between cells (alignment).
   This is fundamentally a prompt-engineering bet, not a guarantee — which
   is exactly why A5's automated validation checks exist: to catch it
   objectively when the bet doesn't pay off, rather than trusting the
   image on sight.

**4. How to handle transparency limitations?**
gpt-image-1 (unlike DALL·E) supports a documented `background` request
parameter — `transparent | opaque | auto` — that this codebase's
`openai-image-source.ts` has never set (always implicitly `auto`,
`openai-image-source.ts:114-120`). Plan: set `background=transparent` as
a new, additive form field on the trait-sheet call specifically (does not
touch the existing single-source route/param — see A7 fallback numbering).
This is unverified in THIS codebase (no prior real call here has ever
tried it) and has a known general caveat even when it works: edge pixels
can come back semi-transparent (anti-aliased alpha, not clean 0/255) —
exactly the shape of noise `cleanupRasterImage`'s alpha-snap pass and
`raster-repair.ts`'s `alphaSnapThreshold` already exist to clean up
(`raster-repair.ts:133-134`), so the existing pipeline is already the
right tool for this, not new code. **Fallback**, if `background=transparent`
proves unreliable in practice: request a **fixed, saturated,
off-palette key color** (e.g. pure magenta `#FF00FF` — chosen because
it's extremely unlikely to appear in an SMB-style fur/hoodie palette,
unlike black/white which the character legitimately uses) as the sheet's
own background via the prompt text itself, then key it out with the
EXACT SAME mechanism `raster-convert.ts` already has —
`estimateBackgroundColor` + `applyBackgroundRemoval` (`raster-convert.ts:64-82`)
— just fed a fixed color instead of a sampled one. No new removal
algorithm needed either way.

**5. Should sheet cells include guide borders or not?**
No borders drawn as part of the artwork (a border would leave residue
pixels that Normalize/repair aren't designed to strip and would visually
contaminate a corner of every imported layer). **Grid lines are entirely
a JS-side crop-math concern, never an image concern** — the cropper knows
the exact pixel bounds of every cell deterministically (A2's fixed
geometry), so it needs no visual guide to find them. The only
image-level ask is a **crop-safety margin**: instruct the model to keep
every character element inset from each cell's edge by a fixed
percentage (e.g. ~8%) specifically so a 1-2px alignment drift doesn't
clip real artwork — this is a prompt instruction, not a rendered line.

**6. What exact prompt template should be used?** — A3, verbatim.

**7. What validation checks can detect bad sheets?** — A5, all
computable from primitives that already exist in this repo (mostly
`collection-fit.ts` and `raster-convert.ts`), no new heavy CV needed.

**8. What is the fallback if sheet generation fails?**
Three-tier, cheapest-first:
   1. **Retry once** with the identical prompt (gpt-image-1 generation is
      not perfectly deterministic call-to-call) — costs one more paid
      call, same pattern as any transient-failure retry elsewhere.
   2. **Fall back to today's Stage 6 single-image call** (already proven,
      zero new risk) plus the **existing heuristic split**
      (`raster-split.ts`) — i.e., sheet generation is additive to the
      current pipeline, never a hard replacement of it. A user who hits
      an unreliable sheet loses nothing they have today.
   3. **Manual raster import** (`/raster/import`, already shipped) always
      remains available regardless — the absolute floor fallback, not
      contingent on anything in this design.

### A2. Recommended sheet layout (MVP)

**2×4 grid, 8 cells, on a `1024×1024` canvas → 512×256px per cell (row) —
i.e. 2 columns × 4 rows, portrait-oriented cells, chosen so the 1024
canvas divides evenly on the axis that carries more cells.**

```
row 0:  [cell 0: full composed preview]  [cell 1: background]
row 1:  [cell 2: body / hoodie]          [cell 3: head / fur]
row 2:  [cell 4: face mask]              [cell 5: eyes]
row 3:  [cell 6: nose / mouth]           [cell 7: hat / accessory]
```

Cell pixel bounds (0-indexed, half-open `[x0,x1) × [y0,y1)`, exact
integers, `colWidth=512, rowHeight=256`):

| cell | col | row | x0 | y0 | x1 | y1 |
|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 | 512 | 256 |
| 1 | 1 | 0 | 512 | 0 | 1024 | 256 |
| 2 | 0 | 1 | 0 | 256 | 512 | 512 |
| 3 | 1 | 1 | 512 | 256 | 1024 | 512 |
| 4 | 0 | 2 | 0 | 512 | 512 | 768 |
| 5 | 1 | 2 | 512 | 512 | 1024 | 768 |
| 6 | 0 | 3 | 0 | 768 | 512 | 1024 |
| 7 | 1 | 3 | 512 | 768 | 1024 | 1024 |

Every cell is a non-square 512×256 region. That's fine: a cell's
**logical** subject is always described to the model, and later cropped,
as if it occupies a centered **256×256 square** within its 512×256 cell
(the remaining 256×256 half of the cell is intentional crop-safety
margin, not wasted space — see A4). The 9th "optional extra accessory"
cell from the task's example is deliberately dropped from the MVP grid
(A1 Q2) — add a 3×3/10-cell variant only after 2×4 is proven, as its own
later stage.

### A3. Exact prompt template

Sent as the `prompt` form field to `/v1/images/edits`, model
`gpt-image-1`, `size=1024x1024`, `background=transparent` (A1 Q4),
`quality=medium` (unchanged from today's `OPENAI_IMAGE_QUALITY`,
`openai-image-source.ts:44`). `{{USER_PROMPT}}` is the caller-supplied
character description (equivalent to today's Stage 6 `prompt` field);
`DO_NOT_COPY_SUFFIX` is still appended unconditionally, unchanged, same
constant, same reasoning (`openai-image-source.ts:46-56`) — not
reproduced below since it's an existing, untouched building block, not
new template text.

```
Generate ONE flat 1024x1024 image divided into an invisible 2-column by
4-row grid of exactly 8 cells, each 512 pixels wide by 256 pixels tall,
with no grid lines, no borders, and no text/labels anywhere in the image.

Cell pixel bounds (x0,y0)-(x1,y1), (0,0) is the top-left corner of the
whole image:
- Cell 1 (512,0)-(1024,256): BACKGROUND layer only.
- Cell 2 (0,256)-(512,512): BODY / HOODIE layer only.
- Cell 3 (512,256)-(1024,512): HEAD / FUR layer only.
- Cell 4 (0,512)-(512,768): FACE MASK layer only.
- Cell 5 (512,512)-(1024,768): EYES layer only.
- Cell 6 (0,768)-(512,1024): NOSE / MOUTH layer only.
- Cell 7 (512,768)-(1024,1024): HAT / ACCESSORY layer only.
- Cell 0 (0,0)-(512,256): the FULL character with every layer above
  composed together, for comparison only.

Character: {{USER_PROMPT}}

Every one of the 8 cells shows a DIFFERENT PART of the exact same single
character, drawn at the exact same scale, the exact same camera angle,
and the exact same position within its own cell — imagine one master
48x48-pixel-grid composition, and each cell is that SAME grid with only
its own layer's pixels kept and everything else left empty. If a body
part shown in cell 0 doesn't belong to a given cell's own layer, that
part must be COMPLETELY ABSENT from that cell, not faded or outlined —
fully empty/transparent there.

Keep every drawn element inset at least 8% from its own cell's edges —
nothing may touch or cross a cell boundary.

Every cell's background — everywhere that isn't part of that cell's own
layer — must be fully transparent. Do not draw a background color, a
checkerboard pattern, a border, or any text or number anywhere in the
image, including inside cell 0.
```

Notes on this template's design: cell bounds are stated numerically
because that's the only unambiguous way to describe "the same coordinate
system" to a model with no true spatial reasoning guarantee (A1 Q3); the
"imagine one master grid" sentence is the direct lever against the
bottleneck-#4 sibling-blindness failure (§0); the inset instruction is
crop-safety (A1 Q5), not a rendered border.

### A4. Crop-safety margin

Each 512×256 cell's *logical* subject area is treated as a centered
**256×256 square** (the cell's shorter axis) — i.e. a `(128,0)-(384,256)`
offset within each cell's own local coordinates — with the remaining
128px strips on either side kept as pure margin. This means: (a) the
final crop step always extracts a square region per layer (needed before
the 48×48 resize anyway, matching every existing normalize path's own
square-fit convention, `raster-convert.ts:29-38`), and (b) a modest
alignment drift from the model doesn't clip real artwork, since real
content is expected to stay within the prompt's own 8%-inset guidance,
well inside the 256×256 square, itself well inside the full 512×256 cell.

### A5. Validation checks (automated, per generated sheet)

All computable with primitives that already exist — no new heavy
computer-vision code, just composition of what `collection-fit.ts` and
`raster-convert.ts` already provide, per cropped-and-normalized cell:

| Check | How | Existing primitive |
|---|---|---|
| **Empty layer** | Foreground pixel count (alpha ≥ threshold) is 0 or near-0 for a cell that shouldn't be empty (all except optionally background) | `computeCollectionFitMetrics`'s own foreground-count loop, `collection-fit.ts` |
| **Object crosses cell boundary** | After crop, foreground pixels touch the crop rectangle's own edge (row 0, col 0, last row, last col) — a real layer should have transparent margin per A4 | New: 1-line border-touch scan over the already-cropped `RgbaImage`, same shape as `raster-convert.ts`'s existing border-touch check in its hole-fill pass (`raster-convert.ts:342-352`) |
| **Layer misalignment** | Each non-background, non-preview cell's foreground bbox center, once mapped back into the shared 512×256-cell coordinate space, should sit within a small tolerance of cell 0's own subject-center-adjusted-per-layer expectation | Compose from `computeCollectionFitMetrics`'s `foregroundBBox`/`subjectCenter` (`collection-fit.ts`) — reuses Stage 8's own center/bbox drift math (`checkCollectionFit`'s `center_drift`/`bbox_drift` dimensions) directly, just against a same-sheet reference instead of a separately-built profile |
| **Full preview not reconstructed by stacking cells** | Composite cells 1-7 (Part C's own compositor, §C1) and diff the result against cell 0 | New: `comparePngs(a,b)` pixel-diff utility (§C4) — same tool this design already needs for the compositor's own "reconstruction score," reused here as a sheet-quality gate, not a second implementation |
| **Labels/text detected** | Heuristic only, stated honestly as unreliable: high-frequency, near-black, thin (1-2px) horizontal-run components in an unexpected region (e.g. within cell 0's own margin) *can* indicate rendered text, but this is a weak signal, not a real OCR check — **recommend treating this as advisory-only (a warning, never an auto-reject)**, same posture Stage 8 already takes with its own low-confidence heuristics (`collection-fit.ts`'s `eyeLineConfidence`/`mouthLineConfidence`) | Reuses the same "dark connected component" scan `collection-fit.ts` already has for eye/mouth candidate detection — a text glyph's stroke-width/aspect signature could be layered on top of that scan later, but is explicitly NOT proposed as a real check here (no evidence it would work, and false-positiving on legitimate thin dark linework — outlines, whiskers — is a real risk) |
| **Palette drift between cells and cell 0** | Each cell's dominant palette (`deriveSourcePalette`) should mostly appear within cell 0's own dominant palette (a layer's colors are a subset of the whole character's colors, structurally) | `deriveSourcePalette` + `colorDistance`/`hexToRgb`, exact same functions Stage 8's `checkCollectionFit` already composes for its own `palette_drift` dimension (`collection-fit.ts`) |

None of these gate the import route in this MVP — Part B is explicitly
**advisory-only, same posture as Stage 8** (never auto-reject, per the
task's own Part B "do not auto-approve"). They're surfaced to the human
reviewer as warnings on the sheet-import preview screen (§B, UI flow),
exactly how Stage 8's `issues[]` are already surfaced today.

### A6. Staged validation plan (before any real spend past the first cheap test)

1. **Control**: today's Stage 6 single-image call, unchanged — confirms
   nothing regressed.
2. **2-cell test**: cell 0 (preview) + ONE real layer (`body`) only, on a
   1024×512 canvas (2 rows, 1 column, still evenly-divisible geometry) —
   the cheapest possible test of "can the model keep even one non-preview
   layer aligned to cell 0." A repeated failure here is a hard stop on
   the whole sheet idea, not just a tuning problem.
3. **4-cell test (2×2)**: preview + `body`/`eyes`/`mouth` (the "3
   unambiguous slots" `layer-stack-compositor-mvp.md` §2 already
   identified as MVP-core) — first real test of *multiple* simultaneous
   siblings.
4. **8-cell (A2's full MVP grid)**: only attempted after step 3 passes
   A5's checks reliably (a specific, stated bar: e.g. ≥ 7/10 sheets pass
   with zero `fail`-severity issues) across a handful of different
   character prompts, not just one.
5. **9-/10-cell 3×3 variant**: explicitly deferred past this design,
   contingent on step 4's real numbers, not assumed.

### A7. Data-model additions needed for Part A

None beyond what generate-source's own `meta.json` already stores
(`tools-pixel-forge-generate-source.ts:104-123`) — a sheet generation is
structurally the same call with a different `size`/`prompt`/optional
`background` param and a `layout` tag recorded in its own `meta.json`
(e.g. `layout: 'sheet-2x4-v1'` vs. today's implicit `layout: 'single'`),
so existing generated-sources storage/list/delete routes
(`tools-pixel-forge-generated-sources.ts`) keep working unmodified —
Stage 9 only needs to additively widen what a "generated source" can be,
not replace its storage shape.

---

## Part B — Sheet Crop/Import

### B1. Route

```
POST /api/tools/pixel-forge/raster/import-trait-sheet
```

**Input:**
```ts
{
  // exactly one of:
  generatedSourceId?: string;              // UUID, from Part A's storage
  imageBase64?: string; mimeType?: 'image/png';  // manual/ad-hoc sheet upload

  layout: 'sheet-2x4-v1';                  // fixed literal for MVP — see B2
  cellMapping: {                           // which cells to import, and as what
    cellIndex: number;                     // 1-7 (cell 0 is the preview, never imported by default — see B3)
    layerType: LayerType;                  // existing enum, unchanged
    name: string;
    include: boolean;                      // per-cell opt-out, mirrors import-split's selectedLayerIds
  }[];

  targetSize?: number;                     // default 48 — the FINAL grid size after crop+resize, same param name as /raster/normalize
  backgroundHandling: 'transparent-param' | 'key-color';  // A1 Q4 — which of the two transparency strategies this sheet used
  keyColorHex?: string;                    // required iff backgroundHandling==='key-color', e.g. "#FF00FF"
  cleanup?: boolean; minComponentSize?: number;   // same shape as /raster/normalize's own cleanup params
  repair?: boolean; repairStrength?: 'safe' | 'medium';  // same shape as /raster/normalize's own repair params

  collectionId?: string;
  baseName: string;                        // same role as import-split's baseName
  tags?: string[];
  notes?: string;
}
```

**Output** (mirrors `import-split`'s own shape, `tools-pixel-forge-raster.ts:762-766`):
```ts
{
  ok: true;
  created: { id: string; name: string; cellIndex: number; layerType: LayerType }[];
  skipped: { cellIndex: number; reason: string }[];  // 'not_included' | 'empty_layer' | 'cell_out_of_range'
  warnings: string[];       // A5's advisory checks — never block import, only inform
  previewCompositeVsCell0DiffPct: number | null;    // A5's "full preview reconstructed?" check, surfaced for the human
}
```

### B2. Behavior, in order

1. Resolve the source PNG: either read `generatedSourceId`'s stored
   `source.png` (reusing `getTraitAssetPngBuffer`-style storage access,
   `tools-pixel-forge-generated-sources.ts`'s own read pattern) or decode
   `imageBase64` directly (same validation shape as
   `tools-pixel-forge-generate-source.ts`'s own reference-image
   validation: allowed mime, size cap).
2. Validate the source is exactly `1024×1024` (fixed for `sheet-2x4-v1` —
   same "reject anything that isn't the expected shape" posture Stage 8's
   `loadVariantPng` already takes for its own fixed 48×48 requirement,
   `tools-pixel-forge-collection-fit.ts:47-63`).
3. **Crop each requested cell** to its fixed pixel bounds (A2's table),
   using `sharp().extract({left,top,width,height})` — a new, small,
   pure function, `cropSheetCell(buffer, cellIndex): Promise<Buffer>`,
   living in a new `src/pixel-agent/trait-sheet.ts` module (mirrors
   `raster-upscale.ts`'s own "one small deterministic image op per file"
   convention).
4. **Extract the centered 256×256 logical square** from each 512×256 cell
   (A4) — same `sharp().extract` call, second pass, or fused into one
   `extract` with the right offset math (`left = 128` relative to the
   cell's own crop origin, `top = 0`).
5. **Background removal**, branching on `backgroundHandling`:
   - `'transparent-param'`: no removal step needed if the model actually
     honored `background=transparent` — but still run `cleanupRasterImage`
     to snap any anti-aliased alpha fringe (A1 Q4's stated caveat),
     exactly the tool this pass already exists for.
   - `'key-color'`: run `applyBackgroundRemoval` against the fixed
     `keyColorHex` (converted via `hexToRgb`), same threshold-based
     removal `raster-convert.ts` already implements, just given a known
     fixed color instead of a sampled corner color.
6. **Resize to `targetSize`** (default 48) via nearest-neighbor, same
   `kernel:'nearest'` convention every existing raster path uses
   (`raster-convert.ts:87-94`).
7. **Optional cleanup/repair** — literally call the existing
   `cleanupRasterImage`/`repairRasterImage` functions, unmodified, same
   options shape `/raster/normalize` already exposes. This satisfies the
   task's "repair each layer" bullet with zero new repair logic.
8. **Quantize for storage** — `deriveSourcePalette` + `quantizeToPalette`,
   exactly the pattern `import-split` already uses per layer
   (`tools-pixel-forge-raster.ts:700-707`), not a new quantization
   scheme.
9. **Provenance** — `notes` gets a generated line analogous to
   `import-split`'s own provenance sentence (`tools-pixel-forge-raster.ts:711-713`):
   `` `Imported from trait sheet — source ${generatedSourceId ?? 'manual upload'}, layout sheet-2x4-v1, cell ${cellIndex}` ``,
   prepended to any user-supplied `notes`. `tags` gets a new
   `trait-sheet-import` tag (parallel to the existing `raster-import`/
   `split-import` tags — same convention, `RASTER_IMPORT_TAG`/
   `SPLIT_IMPORT_TAG`, `tools-pixel-forge-raster.ts:83`).
10. **Save**, one `saveTraitAsset` call per included, non-empty cell —
    same fixed placeholder generation fields every raster import already
    uses (`modelPreset:'fast'`, `actualModel:'none (...)'`, `tokenUsage:
    null`, `evaluation: importPlaceholderEvaluation()`), always
    `status:'candidate'`, never overwrites (`saveTraitAsset` always mints
    a fresh id, `store.ts:321` — task's own "do not overwrite traits" is
    already structurally guaranteed by the existing function, nothing
    new to build there).
11. Cell 0 (the full preview) is **never imported as a trait by default**
    — the input schema's `cellMapping` only accepts `cellIndex` 1-7 (B1);
    a request naming cell 0 is rejected with `cell_out_of_range`, per the
    task's own "full composed preview is only for comparison" rule. It
    IS used internally for A5's diff check (surfaced as
    `previewCompositeVsCell0DiffPct` in the response) and, if the caller
    supplied `generatedSourceId`, can optionally be persisted separately
    later as a plain reference image — out of scope for this route.

### B3. Data-model additions

None to `TraitAsset` itself — every field this route needs
(`layerType`, `zIndex` via existing `DEFAULT_Z_INDEX[layerType]` default,
`tags`, `notes`, `collectionId`) already exists (§0). The only new
*concept*, not a new persisted type, is the fixed `SheetLayout` constant
describing cell bounds/roles (A2's table) — a plain TS `const`, same
shape as `raster-split.ts`'s own `SPLIT_LAYER_IDS`, not a database
record, since the MVP only supports one literal layout value.

---

## Part C — Compositor / Assemble NFT

### C1. Backend compositor utility

New file `src/pixel-agent/trait-compositor.ts`, pure/local, no AI:

```ts
export interface CompositorLayer { pngBase64: string; zIndex: number; }

/** Real alpha-over compositing (Porter-Duff "over", straight alpha) on a
 *  canvasSize x canvasSize transparent RGBA buffer, layers applied in
 *  ascending zIndex order — NOT a CSS/DOM operation, a pixel loop, same
 *  "manual buffer math" style raster-upscale.ts already uses for its own
 *  from-scratch resize (no dependency on libvips's own alpha handling
 *  quirks, which raster-upscale.ts's own doc comment already documents
 *  hitting once — see that file's header). Every input layer MUST already
 *  be exactly canvasSize x canvasSize (the caller's job, same "trust
 *  already-normalized input" contract collection-fit.ts's routes use). */
export async function composeTraitLayers(layers: CompositorLayer[], canvasSize: number): Promise<Buffer>;
```

Straight-alpha "over" compositing, per pixel, per layer (ascending
zIndex): `outRGB = srcRGB*srcA + dstRGB*dstA*(1-srcA)`,
`outA = srcA + dstA*(1-srcA)`, all normalized to [0,1] and back — the
standard, well-known formula; no external library needed beyond decoding
each input PNG to raw RGBA via the existing `loadRawRgba`
(`raster-convert.ts:24-27`) and re-encoding the result the same way
`raster-upscale.ts` already does (`sharp(rawBuffer, {raw:{...}}).png()`).
zIndex ties broken by array input order (caller's responsibility to sort
first — mirrors `layer-stack.ts`'s own `compareForStack` tiebreak logic,
reused for consistency, not reimplemented: the route (§C2) calls the
SAME exported `sortSelectedLayersForPreview`-shaped comparator logic, just
ported to a plain array-of-ids instead of full `LayerStackTrait` objects,
since the frontend module can't be imported by the backend directly —
same *logic*, duplicated across the frontend/backend boundary the same
way this codebase already duplicates connected-components labeling
across `raster-convert.ts`/`raster-split.ts`/`collection-fit.ts`, each
staying self-contained per that established convention).

### C2. Route

```
POST /api/tools/pixel-forge/raster/compose-traits
```

**Input:**
```ts
{
  traitIds: string[];              // 1..N, existing TraitAsset ids
  compareAgainstGeneratedSourceId?: string;  // optional — A5/C3's reconstruction-score check
}
```

**Behavior:**
1. Load each `traitId` via the existing `getTraitAsset`/summary read path
   (`store.ts`) — 404 `trait_not_found` on any miss (fail the whole
   request, don't silently drop one layer — a caller composing a
   specific stack needs to know if one is missing, not get a
   silently-wrong result).
2. **Size-compatibility guard** — every trait's `size` must match the
   first trait's `size`, exact same rule `layer-stack.ts`'s
   `isTraitCanvasCompatible` already defines (`layer-stack.ts:153-158`);
   reject with `canvas_size_mismatch` rather than silently distorting one
   layer to fit (this route is the one place a mismatch becomes a hard
   error, not just a UI warning, since a wrongly-squashed layer baked
   into a PNG export can't be undone the way a CSS mis-scale can just be
   fixed by re-picking).
3. Sort by `zIndex` ascending (ties broken the same way
   `layer-stack.ts`'s `compareForStack` already does).
4. `composeTraitLayers` (§C1) → raw 48×48 (or whatever the shared `size`
   is) RGBA PNG.
5. `upscalePixelArtPng` (already exists, Stage 7,
   `raster-upscale.ts`) → 384×384 export, same ×8 fixed scale, zero new
   upscale code.
6. **Optional reconstruction score**: if
   `compareAgainstGeneratedSourceId` is supplied, crop that source's own
   cell 0 (same `cropSheetCell` from §B2 step 3-4) and diff it against
   the freshly-composed raw output via `comparePngs` (§C4) — surfaced as
   a score, never blocking the response.

**Output:**
```ts
{
  ok: true;
  rawPngBase64: string; outputSize: number;           // e.g. 48
  upscaledPngBase64: string; upscaledOutputSize: number;  // e.g. 384
  reconstructionScore?: { diffPct: number; comparedAgainstCell0: true } | null;
}
```

Same gating as every other Stage 7/8 route: `requireAuth`, own
`rateLimit` bucket, own file (`tools-pixel-forge-compose.ts`), mounted
alongside the others in `app.ts` — never added to
`tools-pixel-forge-raster.ts`.

### C3. Reconstruction score vs. sheet's full-preview cell

`comparePngs(a: RgbaImage, b: RgbaImage): { diffPct: number }` — a new,
small, pure function (natural home: `src/pixel-agent/trait-compositor.ts`,
next to `composeTraitLayers`, since both operate on the same raw-RGBA
shape): per-pixel Euclidean RGBA distance (reusing `colorDistance`'s own
formula, extended to include the alpha channel), a pixel counted as
"different" above a fixed threshold, `diffPct = differentPixelCount /
totalPixelCount * 100`. This is the exact same tool A5 already needs for
the "full preview not reconstructed by stacking cells" sheet-quality
check — one implementation, two call sites (sheet-import-time QA, and
this route's optional post-hoc comparison), not two.

### C4. Frontend

Extends the already-built Assemble panel (`layer-stack.ts` +
`docs/pixel-forge-layer-stack-compositor-mvp.md`'s already-designed UI,
§4 of that doc) rather than replacing it:

- The existing stacked-`<img>` CSS preview (`layer-stack-compositor-mvp.md`
  §5) stays exactly as-is for the **live, interactive, zero-network**
  preview while picking slots — still correct and still free, per that
  doc's own reasoning (§5: "every stored trait PNG already has index-0
  transparent... browser's own alpha compositing... is correct and free
  for display").
- **New**: a **"Compose / Download"** button, enabled once ≥1 slot is
  filled, that calls `POST /raster/compose-traits` with the currently
  selected `traitIds` (from the panel's existing selection state) and
  renders the REAL server-composited result in a second preview area
  labeled distinctly from the CSS-stack preview (e.g. "Live preview
  (approximate)" vs. "Composed export (exact)") — the task's own
  instruction "do not rely only on CSS stacking for final export" is
  satisfied by making the backend PNG the thing that's ever downloaded,
  never the CSS stack itself.
- **"Download 48×48"** / **"Download 384×384"** on the composed result —
  same client-side `downloadBlob` pattern already used for every other
  download button in this file (`page.tsx`'s existing
  `downloadVariantRaw`/`downloadVariantUpscaled`/`downloadLibrarySource`
  functions, Stage 7/Generated-Sources-Library precedent) — no new
  download mechanism, just one more call site.
- If a reconstruction score is available (composing from a known trait
  sheet), show it next to the composed preview the same way Stage 8's
  score/verdict/issues panel already renders (`page.tsx`'s Collection
  DNA / Fit Check section) — same visual language, not a new pattern.

---

## Data model additions — summary

| Addition | Type | Where |
|---|---|---|
| `SheetLayout` (fixed `'sheet-2x4-v1'` cell-bounds table, A2) | plain TS `const`, not persisted | new `src/pixel-agent/trait-sheet.ts` |
| `layout` field in generated-source `meta.json` | optional string, defaults to implicit `'single'` for existing records | additive to `tools-pixel-forge-generate-source.ts`'s existing write |
| `trait-sheet-import` tag | string literal, same convention as `raster-import`/`split-import` | `tools-pixel-forge-import-trait-sheet.ts` |
| Nothing new on `TraitAsset`, `Collection`, or `TraitAssetSummary` | — | all needed fields already exist (§0) |

## Endpoints — summary

| Route | Stage | Mutates? | AI call? |
|---|---|---|---|
| `POST /raster/generate-source` (existing, widened to accept sheet params) | 9.2 | writes `generated-sources/<id>/` | **yes** — the only paid call in this whole design |
| `POST /raster/import-trait-sheet` (new) | 9.3 | creates `TraitAsset`(s), `status:'candidate'` only | no |
| `POST /raster/compose-traits` (new) | 9.4 | none — pure read + compute | no |

## UI flow — summary

1. **Generate tab** (extends existing Stage 6 panel): a `layout`
   selector (`single` — today's default — vs. `sheet-2x4-v1`), reusing
   the existing reference-image/prompt/rights-checkbox inputs verbatim.
2. **Generated Sources Library** (existing, Stage 6 follow-up): sheet
   generations appear alongside single generations, distinguished by a
   `layout` badge on the card.
3. **New "Import Trait Sheet" panel** (Import Image tab, alongside the
   existing manual-upload panel): pick a generated sheet (or upload one),
   see the 8 auto-cropped cells with per-cell layerType dropdowns
   (defaulted per A2's fixed mapping, overridable), A5's warnings shown
   inline per cell, a live diff-vs-cell-0 percentage, then "Import
   Selected Cells" — mirrors the existing Split-preview → Import-Selected
   flow's own two-step shape almost exactly.
4. **Assemble panel** (existing, `layer-stack-compositor-mvp.md`): gains
   the "Compose / Download" button and composed-preview area (§C4).

## Limitations / risks

- **The core, stated-honestly, unproven bet**: gpt-image-1 keeping 7
  distinct sub-layers spatially co-registered in one image call has never
  been tested in this codebase, and this project's own history
  (bottleneck #4, §0) is a real prior case of decomposition making
  generation *worse*. A6's staged validation plan exists specifically to
  catch a "no, it doesn't work" result cheaply (one 2-cell test call)
  rather than discovering it only after building the full pipeline.
- **`background=transparent` reliability is unverified** in this
  codebase — A1 Q4's key-color fallback exists precisely because this is
  a real, not hypothetical, risk.
- **Prompt-only alignment has no technical guarantee** — same caveat this
  project already states for `DO_NOT_COPY_SUFFIX`; A5's automated checks
  are the actual enforcement mechanism, not the prompt itself.
- **Text/label detection (A5) is the weakest check** — stated explicitly
  as advisory-only, not a real OCR gate, to avoid false confidence in a
  heuristic that hasn't been validated.
- **Cost**: a sheet call is priced the same per-call as today's single
  generation (`gpt-image-1`, same `size`/`quality` tier assumptions,
  `openai-image-source.ts`'s existing placeholder pricing table) but
  *replaces* what would otherwise be up to 8 separate generation calls if
  someone tried the (already-rejected, §0) per-layer-generation approach
  — meaning this design, if it works, is a **cost win**, not just a
  quality one; if it doesn't work reliably, A1 Q8's fallback means no
  cost is wasted beyond the validation calls themselves.
- **New `LayerType` gap resurfaces here too**: A2's grid has no cell for
  a real "head" layer distinct from "head/fur" (same `body`-adjacent
  ambiguity `layer-stack-compositor-mvp.md` §2 already flagged) — Option
  A from that doc (ship without a dedicated `head` type, treat "head/fur"
  as `body`) applies unchanged here; Option B (add real
  `head`/`headwear` values) remains the same out-of-scope-for-a-design-doc
  backend enum change it already was.

---

## Recommended stage order

- **9.1** — `trait-sheet.ts`'s pure `SheetLayout`/`cropSheetCell` geometry
  + `trait-compositor.ts`'s `composeTraitLayers`/`comparePngs`, fully
  offline-testable against synthetic buffers, **zero API calls**. See the
  exact kickoff prompt below.
- **9.2** — Widen `generate-source`/`openai-image-source.ts` to accept
  `layout`/`background` params (additive, `layout` defaults to today's
  `'single'` behavior so nothing existing changes) + run A6's staged
  validation (2-cell, then 4-cell, then 8-cell) — **this is the stage
  that spends real money**, and should not proceed past the 2-cell test
  without an explicit go/no-go based on real results.
- **9.3** — `POST /raster/import-trait-sheet` + its Import Trait Sheet UI
  panel, built against whichever sheets 9.2 actually validated — zero API
  calls, pure crop/normalize/quantize/save.
- **9.4** — `POST /raster/compose-traits` + Assemble panel's
  "Compose / Download" button — zero API calls, pure composite/export.

Each stage is independently shippable and independently useful even if a
later one is deferred — e.g. 9.1+9.4 alone already fixes the Layer Stack
doc's own explicitly-deferred "export as flattened PNG" gap for
**already-existing** split-imported traits, with no dependency on sheet
generation working at all.

## Exact Stage 9.1 implementation prompt

```
Implement Pixel Forge Stage 9.1: Trait Sheet geometry + real PNG compositor
(offline utilities only — no route, no UI, no API calls).

No OpenAI calls.
No Anthropic calls.
No generation.
No deploy.
No PM2 restart.
Do not modify Normalize/Repair/Split/Import algorithms.
Do not modify the OpenAI generation route or openai-image-source.ts.

Context: see docs/pixel-forge-trait-sheet-stage9-design.md Part A2 (sheet
layout/cell bounds), Part C1/C3 (compositor/diff design), and the
"Recommended stage order" section — this is stage 9.1 only.

Add two new pure, deterministic modules:

1. src/pixel-agent/trait-sheet.ts
   - SHEET_LAYOUT_2X4_V1: fixed cell-bounds table (8 cells, exact pixel
     bounds per the design doc's A2 table), plus the 256x256
     centered-square logical-subject offset per cell (A4).
   - cropSheetCell(sourcePngBuffer: Buffer, cellIndex: number, layout?):
     Promise<Buffer> — sharp().extract() to the cell's full 512x256
     bounds, then extract() again (or fused) to the centered 256x256
     logical square. Validates sourcePngBuffer is exactly 1024x1024
     first (throw a clear error otherwise). No mutation of input.

2. src/pixel-agent/trait-compositor.ts
   - composeTraitLayers(layers: {pngBase64:string; zIndex:number}[],
     canvasSize: number): Promise<Buffer> — real straight-alpha "over"
     compositing per C1's formula, ascending zIndex (ties broken by
     input array order — caller's job to pre-sort), manual RGBA buffer
     math (no CSS, no DOM), re-encoded via sharp raw->png, same low-level
     style as raster-upscale.ts's own upscalePixelArtPng. Validate every
     layer decodes to exactly canvasSize x canvasSize; throw a clear
     error naming which layer failed if not.
   - comparePngs(aPngBuffer: Buffer, bPngBuffer: Buffer): Promise<{
     diffPct: number }> — per-pixel RGBA Euclidean distance (reuse
     colorDistance's formula from raster-convert.ts, extended for alpha),
     threshold-based different-pixel count / total * 100. Both inputs
     must be the same dimensions; throw a clear error if not.

Testing (offline, no server, no browser):
- cropSheetCell: build a synthetic 1024x1024 PNG with 8 distinct solid
  colors placed exactly at each cell's centered-square location; crop
  all 8; assert each crop is exactly the expected color and exactly
  256x256.
- composeTraitLayers: (a) two 8x8 layers, opaque red zIndex 0 fully
  covered by opaque blue zIndex 10 -> output is pure blue everywhere
  (occlusion correct); (b) a fully-transparent layer changes nothing;
  (c) a half-alpha layer over an opaque one produces the exact expected
  blended RGB (verify the math by hand for one pixel); (d) mismatched
  canvasSize on one input layer throws.
- comparePngs: identical images -> diffPct 0; a single-pixel-different
  pair -> diffPct matches 1/totalPixels exactly; completely different
  images -> diffPct near 100; mismatched dimensions -> throws.

Verification:
- npx tsc --noEmit
- npm run build
- offline tests for both modules (temp ts-node script is fine, same
  pattern used for every prior pixel-forge stage's own offline
  verification in this session — delete the script when done)
- no OpenAI/Anthropic calls anywhere (grep the two new files to confirm)

Report:
- files changed
- exact function signatures
- test results
- confirmation this stage alone makes no network call and touches no
  existing route
```
