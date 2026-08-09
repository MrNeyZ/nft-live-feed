/**
 * Pixel Forge — Image-to-Traits Pipeline, Stage 9.1 (Trait Sheet crop
 * foundation). Pure deterministic image-processing (sharp + arithmetic
 * only) — no Anthropic call, no OpenAI call, no generation of any kind.
 * See docs/pixel-forge-trait-sheet-stage9-design.md Part A/A2/A4 for the
 * fuller design this implements the offline half of.
 *
 * Correction baked into this file's design (per Stage 9.1's own task
 * spec): this module does NOT hardcode or assume any particular OpenAI
 * output size (1024x1024, etc.) — `cropTraitSheetCells` reads the actual
 * source PNG's real dimensions via sharp and every layout's cell bounds
 * are stored as FRACTIONS of the full sheet (`bboxFraction`, each in
 * [0,1]), not fixed pixel offsets. The canonical truth this module
 * implements is exactly the task's own correction: crop regions from
 * whatever large sheet/image was generated, normalize each region to
 * 48x48 — the sheet's actual resolution never matters past the crop
 * step. `2x4-layer-sheet`'s fractions were derived assuming a SQUARE
 * source sheet (matching the design doc's 1024x1024 example) but the
 * crop math itself works unchanged against any other square or non-
 * square source.
 *
 * Deliberately does NOT touch Normalize/Repair/Split/Import — those stay
 * exactly as they are in tools-pixel-forge-raster.ts/raster-repair.ts.
 * This module only reuses raster-convert.ts's existing square-fit/
 * resize/background-removal primitives (pure helpers, not pipeline
 * logic) the same way collection-fit.ts and raster-upscale.ts already
 * do — not new pixel algorithms, just new geometry (grid layouts) wired
 * onto proven building blocks.
 */

import sharp from 'sharp';
import { LayerType } from './agent-loop';
import { loadRawRgba, squareFit, hexToRgb, applyBackgroundRemoval, estimateBackgroundColor, colorDistance, RgbaImage } from './raster-convert';

// Mirrors the convention already established in tools-pixel-forge-raster.ts
// and raster-split.ts (both DEFAULT_BG_THRESHOLD = 24) and collection-fit.ts
// (FOREGROUND_ALPHA_THRESHOLD = 128) — duplicated locally rather than
// imported, matching this codebase's own established per-file convention
// (see raster-split.ts's own comment on why its labelMask isn't shared
// either; collection-fit.ts's header comment says the same about its own
// constants).
const DEFAULT_BG_THRESHOLD = 24;
const FOREGROUND_ALPHA_THRESHOLD = 128;
const DEFAULT_OUTPUT_SIZE = 48;

export interface TraitSheetBBoxPx { x: number; y: number; w: number; h: number; }
export interface TraitSheetBBoxFraction { x: number; y: number; w: number; h: number; }

/**
 * Stage 10.2 — the richer trait-family vocabulary for
 * `TRAIT_FAMILY_SHEET_10X8` below (see docs/pixel-forge-stage10-trait-
 * family-sheet and project memory project_pixel_forge_stage10_pivot).
 * Deliberately NOT merged into `LayerType` (agent-loop.ts) — that enum is
 * already load-bearing for every existing saved `TraitAsset` and the
 * Composer's z-index/grouping logic; widening it is a real schema
 * migration this stage explicitly defers. Each category instead maps
 * onto an existing `LayerType` via `suggestedLayerType` on its cells
 * (lossy but safe — see `TRAIT_FAMILY_CATEGORY_TO_LAYER_TYPE` below), so
 * today's store/compositor need zero changes, while the full category is
 * still preserved on the cell def and in cellId/label for tagging in a
 * later stage.
 */
export type TraitFamilyCategory =
  | 'hat' | 'hoodie' | 'eyes' | 'mouth' | 'face_mask' | 'accessory' | 'head_fur' | 'background';

export const TRAIT_FAMILY_CATEGORIES: readonly TraitFamilyCategory[] = [
  'hat', 'hoodie', 'eyes', 'mouth', 'face_mask', 'accessory', 'head_fur', 'background',
];

export interface TraitSheetCellDef {
  cellId: string;
  label: string;
  /** null for a cell that isn't itself an importable layer — e.g. the
   *  2x4 layout's own "preview" cell (design doc A2/B2 step 11: never
   *  imported as a trait by default), or every cell of the 4x4 family
   *  sheet (whole-character thumbnails, not decomposed layers — see this
   *  file's FAMILY_SHEET_4X4 doc comment below). */
  suggestedLayerType: LayerType | null;
  row: number;
  col: number;
  /** Fraction of the FULL sheet's own width/height, each in [0,1] —
   *  never a fixed pixel offset (see this file's header comment). */
  bboxFraction: TraitSheetBBoxFraction;
  /** Stage 10.2 only — the richer trait-family category this cell
   *  belongs to, when the layout is `TRAIT_FAMILY_SHEET_10X8`. Optional
   *  and absent on every pre-Stage-10.2 layout's cells (2x4/4x4), so
   *  existing cell defs/consumers are untouched. */
  familyCategory?: TraitFamilyCategory;
}

export interface TraitSheetLayout {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: TraitSheetCellDef[];
}

/**
 * `2x4-layer-sheet` — see docs/pixel-forge-trait-sheet-stage9-design.md
 * Part A2's table (8 cells: cell 0 preview + 7 real layers, 2 columns ×
 * 4 rows) and Part A4 (each cell's LOGICAL subject is a centered square
 * sub-region, not the full non-square cell — squashing a non-square
 * region straight to 48x48 would distort the character). Cell width
 * fraction is 1/cols = 0.5, height fraction is 1/rows = 0.25; the
 * centered square sub-region takes the smaller of the two (0.25) and is
 * inset by (0.5-0.25)/2 = 0.125 horizontally, 0 vertically. `cellId`
 * values reused verbatim from raster-split.ts's own `SplitLayerId`
 * vocabulary (`background`, `hat_accessory`, `body_hoodie`, `face_mask`,
 * `eyes`, `nose_mouth`, `head_fur`) and each cell's `suggestedLayerType`
 * matches that file's own `suggestedLayerType` mapping exactly
 * (raster-split.ts:275,321,344,395,436,465,496) — same layer vocabulary
 * this codebase already established, not a new one.
 */
export const LAYER_SHEET_2X4: TraitSheetLayout = {
  id: '2x4-layer-sheet',
  name: '2×4 layer sheet (preview + 7 layers)',
  rows: 4,
  cols: 2,
  cells: [
    { cellId: 'preview', label: 'Full composed preview', suggestedLayerType: null, row: 0, col: 0, bboxFraction: { x: 0.125, y: 0, w: 0.25, h: 0.25 } },
    { cellId: 'background', label: 'Background', suggestedLayerType: 'background', row: 0, col: 1, bboxFraction: { x: 0.625, y: 0, w: 0.25, h: 0.25 } },
    { cellId: 'body_hoodie', label: 'Body / Hoodie', suggestedLayerType: 'body', row: 1, col: 0, bboxFraction: { x: 0.125, y: 0.25, w: 0.25, h: 0.25 } },
    { cellId: 'head_fur', label: 'Head / Fur', suggestedLayerType: 'body', row: 1, col: 1, bboxFraction: { x: 0.625, y: 0.25, w: 0.25, h: 0.25 } },
    { cellId: 'face_mask', label: 'Face Mask', suggestedLayerType: 'other', row: 2, col: 0, bboxFraction: { x: 0.125, y: 0.5, w: 0.25, h: 0.25 } },
    { cellId: 'eyes', label: 'Eyes', suggestedLayerType: 'eyes', row: 2, col: 1, bboxFraction: { x: 0.625, y: 0.5, w: 0.25, h: 0.25 } },
    { cellId: 'nose_mouth', label: 'Nose / Mouth', suggestedLayerType: 'mouth', row: 3, col: 0, bboxFraction: { x: 0.125, y: 0.75, w: 0.25, h: 0.25 } },
    { cellId: 'hat_accessory', label: 'Hat / Accessory', suggestedLayerType: 'accessory', row: 3, col: 1, bboxFraction: { x: 0.625, y: 0.75, w: 0.25, h: 0.25 } },
  ],
};

/** Builds an evenly-spaced rows×cols grid with no centered-square inset
 *  (every cell fraction is already square: 1/cols wide, 1/rows tall) —
 *  used for FAMILY_SHEET_4X4 below and as the geometry base for Stage
 *  10.2's TRAIT_FAMILY_SHEET_10X8 (which relabels/re-ids/re-categorizes
 *  the generic cells this returns; the grid math itself is unchanged and
 *  not duplicated). Every cell already occupies its own full square
 *  region, unlike 2x4-layer-sheet's non-square cells. Not exported —
 *  only this file's own layout builders call it. */
function buildEvenGridLayout(id: string, name: string, rows: number, cols: number, cellIdPrefix: string, labelPrefix: string): TraitSheetLayout {
  const cells: TraitSheetCellDef[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      cells.push({
        cellId: `${cellIdPrefix}-${index}`,
        label: `${labelPrefix} ${index + 1}`,
        suggestedLayerType: null,
        row, col,
        bboxFraction: { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows },
      });
    }
  }
  return { id, name, rows, cols, cells };
}

/**
 * `4x4-family-sheet` — 16 WHOLE-CHARACTER thumbnails (a "family" of
 * variations), not decomposed layers of one character. Every cell's
 * `suggestedLayerType` is `null` deliberately: a family-sheet cell isn't
 * a layer at all, so there is nothing sensible to import it as via
 * Stage 9.3's future import route — this layout exists for a later,
 * different workflow (batch variant browsing/comparison), not for
 * `/raster/import-trait-sheet`. Not designed in
 * pixel-forge-trait-sheet-stage9-design.md (that doc only designed
 * 2x4-layer-sheet in detail) — included here per this stage's own task
 * spec ("include MVP layouts: 2x4-layer-sheet, 4x4-family-sheet"), kept
 * intentionally simple (a plain even grid, no centered-square inset
 * needed since every cell is already square) since its actual usage is
 * future work.
 */
export const FAMILY_SHEET_4X4: TraitSheetLayout = buildEvenGridLayout(
  '4x4-family-sheet', '4×4 family sheet (16 whole-character thumbnails, not layers)', 4, 4, 'family', 'Family member',
);

/**
 * Stage 10.2 — the 10×8 Trait Family Sheet layout: 80 cells, no preview
 * cell, each row a fixed trait category (see docs/pixel-forge-stage10-
 * trait-family-sheet and TraitFamilyCategory above). Unlike
 * `LAYER_SHEET_2X4`, every cell already occupies its own full square-ish
 * region of the grid (same as `FAMILY_SHEET_4X4`) — no centered-square
 * inset is needed, since the pivot's whole premise is that each cell is
 * ALREADY one isolated component, not a sub-region of a larger composed
 * character. `row` index 0-7 corresponds 1:1 to the fixed row order below
 * (`TRAIT_FAMILY_ROW_DEFS`); `col` index 0-9 is just that row's Nth
 * variant slot, with no per-slot meaning of its own yet (later stages may
 * give columns their own semantics — out of scope here).
 *
 * Geometry only reuses `buildEvenGridLayout`'s existing fraction math
 * (`x=col/cols, y=row/rows, w=1/cols, h=1/rows`) — this function's own
 * job is purely to relabel/re-id/re-categorize those generic cells per
 * the fixed row→category table, not to invent new crop math.
 */
interface TraitFamilyRowDef {
  category: TraitFamilyCategory;
  label: string;
  cellIdPrefix: string;
  /** See TraitFamilyCategory's own doc comment — a deliberately lossy,
   *  temporary mapping onto the existing, unwidened LayerType enum. */
  suggestedLayerType: LayerType;
}

const TRAIT_FAMILY_SHEET_ROWS = 8;
const TRAIT_FAMILY_SHEET_COLS = 10;

// Fixed row order per the Stage 10.2 task spec — row index is this
// array's own index, so TRAIT_FAMILY_ROW_DEFS[cell.row] always resolves
// the right category for any cell built off buildEvenGridLayout's
// row/col numbering.
const TRAIT_FAMILY_ROW_DEFS: readonly TraitFamilyRowDef[] = [
  { category: 'hat', label: 'Hats', cellIdPrefix: 'hat', suggestedLayerType: 'accessory' },
  { category: 'hoodie', label: 'Hoodies / Bodies', cellIdPrefix: 'hoodie', suggestedLayerType: 'body' },
  { category: 'eyes', label: 'Eyes', cellIdPrefix: 'eyes', suggestedLayerType: 'eyes' },
  { category: 'mouth', label: 'Mouths / Noses', cellIdPrefix: 'mouth', suggestedLayerType: 'mouth' },
  { category: 'face_mask', label: 'Face Masks / Fur Markings', cellIdPrefix: 'face_mask', suggestedLayerType: 'other' },
  { category: 'accessory', label: 'Accessories', cellIdPrefix: 'accessory', suggestedLayerType: 'accessory' },
  { category: 'head_fur', label: 'Head / Fur Variants', cellIdPrefix: 'head_fur', suggestedLayerType: 'body' },
  { category: 'background', label: 'Backgrounds / Misc', cellIdPrefix: 'background', suggestedLayerType: 'background' },
];

/** cellId format: `${prefix}_${NN}`, zero-padded 2-digit column index —
 *  e.g. `hat_00` … `hat_09`. Pure string formatting, no layout lookup, so
 *  a later stage can compute an expected cellId without holding the full
 *  layout object. */
export function getTraitFamilyCellName(category: TraitFamilyCategory, index: number): string {
  const rowDef = TRAIT_FAMILY_ROW_DEFS.find(r => r.category === category);
  const prefix = rowDef?.cellIdPrefix ?? category;
  return `${prefix}_${String(index).padStart(2, '0')}`;
}

function buildTraitFamilySheetLayout(): TraitSheetLayout {
  const base = buildEvenGridLayout(
    'trait-family-sheet-10x8', '10×8 trait family sheet (80 isolated components, no preview cell)',
    TRAIT_FAMILY_SHEET_ROWS, TRAIT_FAMILY_SHEET_COLS, 'cell', 'Cell',
  );
  const cells: TraitSheetCellDef[] = base.cells.map(cell => {
    const rowDef = TRAIT_FAMILY_ROW_DEFS[cell.row];
    return {
      ...cell,
      cellId: getTraitFamilyCellName(rowDef.category, cell.col),
      label: `${rowDef.label} ${cell.col + 1}`,
      suggestedLayerType: rowDef.suggestedLayerType,
      familyCategory: rowDef.category,
    };
  });
  return { ...base, cells };
}

export const TRAIT_FAMILY_SHEET_10X8: TraitSheetLayout = buildTraitFamilySheetLayout();

export const TRAIT_SHEET_LAYOUTS: readonly TraitSheetLayout[] = [LAYER_SHEET_2X4, FAMILY_SHEET_4X4, TRAIT_FAMILY_SHEET_10X8];

export function getTraitSheetLayout(id: string): TraitSheetLayout | undefined {
  return TRAIT_SHEET_LAYOUTS.find(l => l.id === id);
}

/**
 * Stage 10.2 pure helpers — no IO, deterministic, operate on
 * `TRAIT_FAMILY_SHEET_10X8` by default (or any layout with
 * `familyCategory`-bearing cells, e.g. a future variant layout).
 */
export function getTraitFamilyCategoryForCell(cellId: string, layout: TraitSheetLayout = TRAIT_FAMILY_SHEET_10X8): TraitFamilyCategory | undefined {
  return layout.cells.find(c => c.cellId === cellId)?.familyCategory;
}

export function getTraitFamilyRowForCategory(category: TraitFamilyCategory): number {
  return TRAIT_FAMILY_ROW_DEFS.findIndex(r => r.category === category);
}

export function getTraitFamilyCellsByCategory(layout: TraitSheetLayout = TRAIT_FAMILY_SHEET_10X8): Record<TraitFamilyCategory, TraitSheetCellDef[]> {
  const grouped = Object.fromEntries(TRAIT_FAMILY_CATEGORIES.map(c => [c, [] as TraitSheetCellDef[]])) as Record<TraitFamilyCategory, TraitSheetCellDef[]>;
  for (const cell of layout.cells) {
    if (cell.familyCategory) grouped[cell.familyCategory].push(cell);
  }
  return grouped;
}

export interface CroppedTraitSheetCell {
  cellId: string;
  label: string;
  suggestedLayerType: LayerType | null;
  row: number;
  col: number;
  cropBBoxPx: TraitSheetBBoxPx;
  sourceWidth: number;
  sourceHeight: number;
  pngBuffer: Buffer;
  warnings: string[];
}

/**
 * Crops every cell in `layout` from `inputPngBuffer`, using the actual
 * decoded source dimensions (never a hardcoded size — see this file's
 * header comment). Each cell's fractional bbox is converted to pixels
 * independently (`Math.round(fraction * sourceDimension)`), then clamped
 * to stay inside the source in case of a rounding edge case at an
 * unusual source resolution — clamping only ever shrinks a cell and
 * records a warning, it never throws for a 1px rounding difference.
 * Throws only if a cell's resulting crop region is empty (width or
 * height <= 0), which a well-formed layout against any reasonably-sized
 * source should never hit. Never mutates `inputPngBuffer`.
 */
export async function cropTraitSheetCells(inputPngBuffer: Buffer, layout: TraitSheetLayout): Promise<CroppedTraitSheetCell[]> {
  const metadata = await sharp(inputPngBuffer).metadata();
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (!sourceWidth || !sourceHeight) {
    throw new Error('trait_sheet_source_unreadable');
  }

  const results: CroppedTraitSheetCell[] = [];
  for (const cell of layout.cells) {
    const warnings: string[] = [];
    let x = Math.round(cell.bboxFraction.x * sourceWidth);
    let y = Math.round(cell.bboxFraction.y * sourceHeight);
    let w = Math.round(cell.bboxFraction.w * sourceWidth);
    let h = Math.round(cell.bboxFraction.h * sourceHeight);

    if (x + w > sourceWidth) { w = sourceWidth - x; warnings.push('cell width clamped to source bounds'); }
    if (y + h > sourceHeight) { h = sourceHeight - y; warnings.push('cell height clamped to source bounds'); }
    if (w <= 0 || h <= 0) {
      throw new Error(`trait_sheet_cell_out_of_bounds: cell "${cell.cellId}" resolved to a non-positive crop region`);
    }

    const pngBuffer = await sharp(inputPngBuffer)
      .extract({ left: x, top: y, width: w, height: h })
      .png()
      .toBuffer();

    results.push({
      cellId: cell.cellId,
      label: cell.label,
      suggestedLayerType: cell.suggestedLayerType,
      row: cell.row,
      col: cell.col,
      cropBBoxPx: { x, y, w, h },
      sourceWidth, sourceHeight,
      pngBuffer,
      warnings,
    });
  }
  return results;
}

export interface TightenTraitSheetCellBBoxOptions {
  /** Same three modes `normalizeTraitSheetCell` accepts, and same
   *  meaning — 'none' trusts the cell's own alpha channel as the
   *  foreground mask (the `background=transparent` generation
   *  strategy); 'keyColor'/'autoDetect' derive a background RGB (fixed
   *  or corner-sampled) and treat pixels within `bgThreshold` of it as
   *  background regardless of alpha. Default 'none'. */
  backgroundMode?: 'none' | 'keyColor' | 'autoDetect';
  /** Required iff backgroundMode === 'keyColor'. */
  keyColorHex?: string;
  /** Default 24 — mirrors normalizeTraitSheetCell's own default. */
  bgThreshold?: number;
  /** Transparent/background margin (px) kept around the detected
   *  foreground bbox so anti-aliased edges survive the tighten. Default
   *  2 — small on purpose; this is a content-bounds crop, not a hard
   *  matte. */
  padding?: number;
}

/**
 * Stage 10.6 — shrinks an already grid-cropped cell (the fixed
 * fractional rectangle `cropTraitSheetCells` produces) down to the
 * actual foreground content's bounding box, before square-fit/resize
 * ever runs. `cropTraitSheetCells` alone crops by GEOMETRY only — a
 * cell whose drawn trait doesn't fill its allotted grid rectangle
 * carries that empty margin all the way into `normalizeTraitSheetCell`,
 * which then burns resize budget on it (worst on the dense 10x8 family
 * sheet, where each cell already starts small). This is a bounding-box
 * tighten, not a contour/matte extraction — the true per-pixel silhouette
 * is whatever alpha the source already carries; this only stops wasting
 * the 48x48 target on the cell's unused margin.
 *
 * A cell with no detected foreground (fully empty — e.g. a deliberately
 * skipped family-sheet slot) is returned UNCHANGED but with a warning
 * appended; `normalizeTraitSheetCell`'s own `foregroundCount === 0`
 * check downstream still catches it as `empty_layer`, exactly as before
 * this function existed.
 */
export async function tightenTraitSheetCellBBox(
  cell: CroppedTraitSheetCell, options: TightenTraitSheetCellBBoxOptions = {},
): Promise<CroppedTraitSheetCell> {
  const backgroundMode = options.backgroundMode ?? 'none';
  const bgThreshold = options.bgThreshold ?? DEFAULT_BG_THRESHOLD;
  const padding = options.padding ?? 2;
  if (backgroundMode === 'keyColor' && !options.keyColorHex) {
    throw new Error('trait_sheet_key_color_required');
  }

  const img = await loadRawRgba(sharp(cell.pngBuffer).ensureAlpha());

  // Mirrors normalizeTraitSheetCell's own three backgroundMode branches,
  // but evaluated against the RAW cropped cell (pre-square-fit,
  // pre-resize) — the whole point is to tighten BEFORE any padding or
  // downscale happens, not after.
  const bgColor = backgroundMode === 'keyColor' ? hexToRgb(options.keyColorHex as string)
    : backgroundMode === 'autoDetect' ? estimateBackgroundColor(img)
    : null;
  const isForeground = (off: number): boolean => {
    if (img.data[off + 3] < FOREGROUND_ALPHA_THRESHOLD) return false;
    if (!bgColor) return true;
    const rgb: [number, number, number] = [img.data[off], img.data[off + 1], img.data[off + 2]];
    return colorDistance(rgb, bgColor) > bgThreshold;
  };

  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const off = (y * img.width + x) * 4;
      if (!isForeground(off)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return { ...cell, warnings: [...cell.warnings, 'bbox tighten skipped — no foreground pixels detected'] };
  }

  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const w = Math.min(img.width, maxX + 1 + padding) - x;
  const h = Math.min(img.height, maxY + 1 + padding) - y;

  // Already as tight as it gets — skip the extra sharp round-trip.
  if (x === 0 && y === 0 && w === img.width && h === img.height) return cell;

  const pngBuffer = await sharp(cell.pngBuffer).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();

  return {
    ...cell,
    cropBBoxPx: { x: cell.cropBBoxPx.x + x, y: cell.cropBBoxPx.y + y, w, h },
    pngBuffer,
    warnings: [...cell.warnings, `bbox tightened ${img.width}x${img.height} -> ${w}x${h}`],
  };
}

export interface NormalizeTraitSheetCellOptions {
  /** Final square grid size. Default 48 — the pipeline's canonical raw
   *  grid (see raster-upscale.ts's own doc comment: 48 × 8 = 384). */
  outputSize?: number;
  /** 'none': the crop's own alpha is trusted as-is (the
   *  `background=transparent` strategy from the design doc's Part A1 Q4
   *  — nothing to remove here). 'keyColor': a fixed flat color (the
   *  design doc's magenta-key fallback) is treated as background and
   *  made transparent, via the exact same
   *  estimateBackgroundColor/applyBackgroundRemoval mechanism
   *  raster-convert.ts's own normalize path already uses — just given a
   *  known fixed color instead of a sampled corner color. 'autoDetect':
   *  same removal mechanism, but the background color is SAMPLED from
   *  the cell's own four corners (via raster-convert.ts's existing,
   *  unmodified `estimateBackgroundColor`) rather than a caller-supplied
   *  hex — added for Stage 9.2's "remove" backgroundMode, sampling the
   *  ORIGINAL cropped cell's corners (before square-fit's transparent
   *  padding), matching raster-convert.ts's own documented pitfall
   *  warning about sampling a padded image instead. Default 'none'. */
  backgroundMode?: 'none' | 'keyColor' | 'autoDetect';
  /** Required iff backgroundMode === 'keyColor'. */
  keyColorHex?: string;
  /** RGB distance under which a pixel counts as the key color. Default
   *  24 — mirrors tools-pixel-forge-raster.ts's own DEFAULT_BG_THRESHOLD. */
  bgThreshold?: number;
}

export interface NormalizedTraitSheetCell {
  cellId: string;
  label: string;
  suggestedLayerType: LayerType | null;
  row: number;
  col: number;
  cropBBoxPx: TraitSheetBBoxPx;
  sourceWidth: number;
  sourceHeight: number;
  outputSize: number;
  pngBuffer: Buffer;
  warnings: string[];
}

/**
 * Square-fits (pads, never crops further) then nearest-neighbor-resizes
 * one already-cropped cell to `outputSize`×`outputSize`, optionally
 * removing a fixed key color, exactly mirroring raster-convert.ts's own
 * squareFit → resize({kernel:'nearest'}) → applyBackgroundRemoval order
 * (buildNearestVariant, raster-convert.ts:87-94) — background removal
 * runs AFTER the resize, same as every existing raster path in this
 * codebase, not a new ordering choice.
 *
 * Takes the FULL `CroppedTraitSheetCell` (not a bare Buffer) —
 * deliberately: `NormalizedTraitSheetCell` carries the crop-stage
 * metadata (`cellId`/`label`/`cropBBoxPx`/source dimensions) the task's
 * own field list requires on the normalized result too, and a bare PNG
 * buffer has nowhere to carry that from. A caller with only a bare
 * buffer (e.g. a synthetic test with no real crop step) can still call
 * this by constructing a minimal `CroppedTraitSheetCell` object by hand.
 */
export async function normalizeTraitSheetCell(cell: CroppedTraitSheetCell, options: NormalizeTraitSheetCellOptions = {}): Promise<NormalizedTraitSheetCell> {
  const outputSize = options.outputSize ?? DEFAULT_OUTPUT_SIZE;
  const backgroundMode = options.backgroundMode ?? 'none';
  const warnings = [...cell.warnings];

  if (backgroundMode === 'keyColor' && !options.keyColorHex) {
    throw new Error('trait_sheet_key_color_required');
  }

  // Sampled from the ORIGINAL cropped cell (pre-square-fit) when
  // autoDetect is requested — squareFit pads with transparent black, and
  // sampling ITS corners instead would read the padding color, not the
  // real background (the exact pitfall raster-convert.ts's own
  // estimateBackgroundColor doc comment already warns about).
  const autoDetectedBgColor = backgroundMode === 'autoDetect'
    ? estimateBackgroundColor(await loadRawRgba(sharp(cell.pngBuffer).ensureAlpha()))
    : null;

  const squareFitPipeline = await squareFit(cell.pngBuffer);
  const resized = squareFitPipeline.clone().resize(outputSize, outputSize, { kernel: 'nearest', fit: 'fill' });
  const img: RgbaImage = await loadRawRgba(resized);

  if (backgroundMode === 'keyColor') {
    const keyRgb = hexToRgb(options.keyColorHex as string);
    applyBackgroundRemoval(img, keyRgb, options.bgThreshold ?? DEFAULT_BG_THRESHOLD);
  } else if (backgroundMode === 'autoDetect' && autoDetectedBgColor) {
    applyBackgroundRemoval(img, autoDetectedBgColor, options.bgThreshold ?? DEFAULT_BG_THRESHOLD);
  }

  let foregroundCount = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3] >= FOREGROUND_ALPHA_THRESHOLD) foregroundCount++;
  }
  if (foregroundCount === 0) {
    warnings.push('empty layer — no foreground pixels remain after normalize');
  }

  const pngBuffer = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();

  return {
    cellId: cell.cellId,
    label: cell.label,
    suggestedLayerType: cell.suggestedLayerType,
    row: cell.row,
    col: cell.col,
    cropBBoxPx: cell.cropBBoxPx,
    sourceWidth: cell.sourceWidth,
    sourceHeight: cell.sourceHeight,
    outputSize,
    pngBuffer,
    warnings,
  };
}

/**
 * Convenience pipeline: crop every cell of `layout` from `inputPngBuffer`
 * and normalize each one, in one call — useful for a future import route
 * (Stage 9.3) that wants the fully-annotated result set in one step.
 * Equivalent to calling `cropTraitSheetCells` then `normalizeTraitSheetCell`
 * per cell by hand; adds no new image-processing logic of its own.
 */
export async function cropAndNormalizeTraitSheetCells(
  inputPngBuffer: Buffer, layout: TraitSheetLayout, options: NormalizeTraitSheetCellOptions = {},
): Promise<NormalizedTraitSheetCell[]> {
  const cropped = await cropTraitSheetCells(inputPngBuffer, layout);
  const normalized: NormalizedTraitSheetCell[] = [];
  for (const cell of cropped) {
    const tightened = await tightenTraitSheetCellBBox(cell, {
      backgroundMode: options.backgroundMode, keyColorHex: options.keyColorHex, bgThreshold: options.bgThreshold,
    });
    normalized.push(await normalizeTraitSheetCell(tightened, options));
  }
  return normalized;
}
