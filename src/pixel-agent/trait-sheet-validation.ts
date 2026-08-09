/**
 * Pixel Forge — Stage 9.4: Trait Sheet validation. Pure deterministic
 * image-processing (sharp + arithmetic only) — no Anthropic call, no
 * OpenAI call, no generation of any kind. Answers one question about an
 * already-generated trait-sheet PNG: is it worth spending a human's time
 * (or the next, more expensive OpenAI call) importing/escalating this
 * sheet, or should it be regenerated?
 *
 * Deliberately does NOT touch Import Trait Sheet
 * (tools-pixel-forge-import-trait-sheet.ts), Compose
 * (tools-pixel-forge-compose-traits.ts), or Normalize/Repair/Split — this
 * module only READS an already-supplied sheet PNG via the existing,
 * unmodified trait-sheet.ts crop/normalize primitives and
 * raster-convert.ts's existing comparePngs/composeTraitPngs, computing
 * measurements. It never creates or mutates a TraitAsset, never writes to
 * disk, never calls saveTraitAsset.
 *
 * Two-resolution design, deliberately: the RAW crop (whatever the actual
 * per-cell pixel size is, e.g. ~256x256 for a 1024x1024 source) is used
 * for checks where real resolution matters (background classification,
 * boundary-bleed, the text/label heuristic — a rendered label's fine
 * strokes are destroyed by downscaling before they'd ever be
 * measurable); the NORMALIZED 48x48 buffer (the same grid the sheet's own
 * generation prompt describes as "one shared 48x48-pixel grid
 * composition") is used for checks that require every cell to share one
 * common coordinate system for comparison (emptiness ratio, alignment vs.
 * the preview cell, and the 8-cell reconstruction compose/diff).
 *
 * Advisory posture, per this stage's own task spec: the text/label
 * heuristic and the 8-cell reconstruction diff NEVER move the numeric
 * score or verdict — they are always surfaced as issues (for a human or
 * the caller to see), never as something that can turn a sheet from
 * pass/warn into fail on their own. The score is computed only from
 * structural checks: active-cell emptiness, inactive-cell leakage,
 * boundary bleed, alignment drift, and background consistency.
 */

import sharp from 'sharp';
import { LayerType } from './agent-loop';
import {
  RgbaImage, loadRawRgba, colorDistance, estimateBackgroundColor,
} from './raster-convert';
import { comparePngs, composeTraitPngs, ComposeTraitLayerInput } from './trait-compositor';
import {
  TraitSheetLayout, cropTraitSheetCells, normalizeTraitSheetCell, CroppedTraitSheetCell, LAYER_SHEET_2X4,
} from './trait-sheet';
import { TraitSheetPromptMode, getActiveCellIdsForMode } from './openai-trait-sheet-prompts';

// ── constants ────────────────────────────────────────────────────────────

const FOREGROUND_ALPHA_THRESHOLD = 128; // matches collection-fit.ts's own convention
// Duplicated locally rather than imported from raster-convert.ts's own
// (unexported) usage — matches this codebase's established per-file
// convention for small shared constants (see raster-split.ts's/
// collection-fit.ts's own header comments on the same choice).
const DEFAULT_BG_THRESHOLD = 24;
const OUTPUT_SIZE = 48; // the shared grid every cell is normalized to for comparison

// A cell's raw-crop transparent-pixel ratio above this counts as "this
// cell genuinely uses alpha transparency" (vs. an opaque/solid-background
// cell that needs corner-color detection instead).
const TRANSPARENCY_SIGNAL_MIN_RATIO = 0.01;

// Foreground-ratio thresholds on the NORMALIZED 48x48 buffer.
const EMPTY_ACTIVE_MAX_FOREGROUND_RATIO = 0.005; // an active cell below this counts as empty (fail-worthy)
const INACTIVE_MAX_FOREGROUND_RATIO = 0.03; // an inactive cell above this counts as "leaked" content

// Boundary-bleed margin, as a fraction of the RAW crop's own (possibly
// non-48x48) width/height — matches the sheet generation prompt's own "8%
// inset" instruction's order of magnitude, checked well inside it (3-5%
// per this stage's own task spec) so genuine minor drift doesn't
// over-trigger.
const BOUNDARY_MARGIN_FRACTION = 0.04;

// Alignment drift, measured in pixels on the shared 48x48 grid — same
// order of magnitude as collection-fit.ts's own
// DEFAULT_ALLOWED_CENTER_DRIFT_PX/DEFAULT_ALLOWED_BBOX_DRIFT_PX (3px/4px),
// widened slightly since this compares raw OpenAI output, not a curated
// reference image.
const ALIGNMENT_WARN_DRIFT_PX = 4;
const ALIGNMENT_FAIL_DRIFT_PX = 10;

// Text/label heuristic — advisory only (never affects score/verdict).
const TEXT_DARK_LUMINANCE_THRESHOLD = 70; // matches collection-fit.ts's own DARK_LUMINANCE_THRESHOLD
const TEXT_EDGE_BAND_FRACTION = 0.15; // scan only the outer 15% band (edges/corners) of the raw crop
const TEXT_TINY_COMPONENT_MAX_AREA_FRACTION = 0.0015; // vs crop area
const TEXT_TINY_COMPONENT_MIN_COUNT = 3;
const TEXT_STROKE_MIN_TRANSITIONS = 6; // dark/light sign changes along one edge-band scanline
const TEXT_STROKE_MIN_LINES = 2;

const SCORE_PASS_THRESHOLD = 80;
const SCORE_WARN_THRESHOLD = 50;

// Same "sensible layer order" map as
// tools-pixel-forge-import-trait-sheet.ts's own SHEET_CELL_Z_INDEX,
// duplicated locally per this codebase's established per-file convention
// (see that file's own comment on why store.ts's generic per-LayerType
// DEFAULT_Z_INDEX collides for body_hoodie/head_fur). Only used here to
// order layers for the 8-cell reconstruction compose step below — this
// module never creates or touches a TraitAsset, so it never needs the
// real zIndex a saved trait would get.
const SHEET_CELL_Z_INDEX: Record<string, number> = {
  background: 0, body_hoodie: 10, head_fur: 15, face_mask: 20, eyes: 25, nose_mouth: 30, hat_accessory: 35,
};

// ── public types ─────────────────────────────────────────────────────────

export type TraitSheetVerdict = 'pass' | 'warn' | 'fail';
export type TraitSheetIssueSeverity = 'warn' | 'fail';
export type TraitSheetRecommendedNextStep = 'try_import' | 'regenerate' | 'run_4_cell' | 'run_8_cell';

export interface TraitSheetIssue {
  code:
    | 'sheet_undecodable' | 'layout_mode_mismatch' | 'cell_crop_warning'
    | 'active_cell_empty' | 'inactive_cell_not_empty'
    | 'boundary_bleed' | 'alignment_drift'
    | 'possible_text_or_label' | 'mixed_backgrounds'
    | 'reconstruction_mismatch';
  severity: TraitSheetIssueSeverity;
  cellId?: string;
  message: string;
}

export interface TraitSheetCellReport {
  cellId: string;
  label: string;
  active: boolean;
  suggestedLayerType: LayerType | null;
  /** Foreground pixel ratio (0..1) on the NORMALIZED 48x48 buffer. */
  foregroundRatio: number;
  backgroundKind: 'transparent' | 'solid-key' | 'opaque-unknown';
  detectedKeyColorHex: string | null;
  boundaryBleed: boolean;
  /** Distance (px, on the shared 48x48 grid) between this cell's own
   *  foreground bbox center and the preview cell's — null for the preview
   *  cell itself, the background cell (no "character position" concept),
   *  an inactive cell, or when either side has no detectable foreground. */
  alignmentDriftPx: number | null;
  possibleTextOrLabel: boolean;
  issues: TraitSheetIssue[];
}

export interface TraitSheetValidationResult {
  ok: true;
  sourceMode: TraitSheetPromptMode;
  layoutId: string;
  sourceWidth: number;
  sourceHeight: number;
  verdict: TraitSheetVerdict;
  score: number;
  cellReports: TraitSheetCellReport[];
  /** Sheet-level issues only (not attached to one specific cell) — e.g.
   *  mixed backgrounds, reconstruction mismatch, undecodable source. */
  issues: TraitSheetIssue[];
  reconstruction: { diffPct: number; comparedAgainstPreview: true } | null;
  recommendedNextStep: TraitSheetRecommendedNextStep;
}

// ── small local helpers (deliberately duplicated, not shared — see this
//    codebase's own established per-file convention for tiny raster
//    helpers, e.g. raster-split.ts's/collection-fit.ts's own comments) ──

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function rgbToHexLocal([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}

function foregroundMaskAndRatio(img: RgbaImage): { mask: Uint8Array; ratio: number } {
  const n = img.width * img.height;
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] >= FOREGROUND_ALPHA_THRESHOLD) { mask[i] = 1; count++; }
  }
  return { mask, ratio: n > 0 ? count / n : 0 };
}

function foregroundBBoxCenter(mask: Uint8Array, width: number, height: number): { x: number; y: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return found ? { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 } : null;
}

function hasBoundaryBleed(mask: Uint8Array, width: number, height: number, marginFraction: number): boolean {
  const mx = Math.max(1, Math.round(width * marginFraction));
  const my = Math.max(1, Math.round(height * marginFraction));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < mx || x >= width - mx || y < my || y >= height - my) return true;
    }
  }
  return false;
}

/** Classifies the RAW crop's own background style by sampling its actual
 *  alpha channel first (real transparency signal), falling back to
 *  raster-convert.ts's existing corner-sampled `estimateBackgroundColor` +
 *  `colorDistance` only when the crop is (near-)fully opaque — the exact
 *  same primitives Normalize's own background removal already uses,
 *  reused here for MEASUREMENT only (this function never mutates the
 *  image or writes anything back). */
function classifyBackground(img: RgbaImage): { kind: 'transparent' | 'solid-key' | 'opaque-unknown'; keyColorHex: string | null; mask: Uint8Array } {
  const n = img.width * img.height;
  let transparentCount = 0;
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] < FOREGROUND_ALPHA_THRESHOLD) transparentCount++;
  }
  if (n > 0 && transparentCount / n > TRANSPARENCY_SIGNAL_MIN_RATIO) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = img.data[i * 4 + 3] >= FOREGROUND_ALPHA_THRESHOLD ? 1 : 0;
    return { kind: 'transparent', keyColorHex: null, mask };
  }
  const bg = estimateBackgroundColor(img);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const rgb: [number, number, number] = [img.data[off], img.data[off + 1], img.data[off + 2]];
    mask[i] = colorDistance(rgb, bg) > DEFAULT_BG_THRESHOLD ? 1 : 0;
  }
  // 'solid-key' when a real, single flat corner color was found and most
  // of the crop isn't already transparent; 'opaque-unknown' would only
  // arise if estimateBackgroundColor's own corner sample is itself absent
  // (never happens for a valid decoded image — corners always exist), so
  // this branch is always 'solid-key' in practice; the third enum value
  // is kept for forward-compatibility with a future ambiguous case rather
  // than removed, matching this codebase's own "leave a named slot for a
  // known future gap" convention (e.g. collection-fit.ts's LayerType gap
  // note).
  return { kind: 'solid-key', keyColorHex: rgbToHexLocal(bg), mask };
}

/** Small local 4-connectivity connected-components labeler over a binary
 *  mask — same shape as collection-fit.ts's own labelDarkComponents,
 *  duplicated per this codebase's established per-file convention (see
 *  that file's own header comment on why it isn't shared either). */
function labelComponents(mask: Uint8Array, width: number, height: number): { size: number }[] {
  const labels = new Int32Array(width * height).fill(-1);
  const comps: { size: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    labels[start] = comps.length;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      size++;
      const x = idx % width, y = Math.floor(idx / width);
      if (x > 0 && mask[idx - 1] === 1 && labels[idx - 1] === -1) { labels[idx - 1] = comps.length; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] === 1 && labels[idx + 1] === -1) { labels[idx + 1] = comps.length; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] === 1 && labels[idx - width] === -1) { labels[idx - width] = comps.length; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] === 1 && labels[idx + width] === -1) { labels[idx + width] = comps.length; stack.push(idx + width); }
    }
    comps.push({ size });
  }
  return comps;
}

/** Advisory-only heuristic (never affects score/verdict — see this file's
 *  header comment): looks for signs of rendered text/labels confined to
 *  the outer edge/corner band of the RAW crop — (a) many tiny dark
 *  connected components (glyph-sized marks), or (b) scanlines with an
 *  unusually high count of dark/light transitions (dense stroke
 *  patterns). Both are weak signals by design; either one flips the
 *  boolean, and the detail string always reports both raw counts so a
 *  human reviewing `issues[]` can judge for themselves. */
function detectPossibleTextOrLabel(img: RgbaImage, foregroundMask: Uint8Array): { detected: boolean; detail: string } {
  const { width, height, data } = img;
  const bandX = Math.max(1, Math.round(width * TEXT_EDGE_BAND_FRACTION));
  const bandY = Math.max(1, Math.round(height * TEXT_EDGE_BAND_FRACTION));

  const darkMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!foregroundMask[i]) continue;
      const inBand = x < bandX || x >= width - bandX || y < bandY || y >= height - bandY;
      if (!inBand) continue;
      const off = i * 4;
      if (luminance(data[off], data[off + 1], data[off + 2]) < TEXT_DARK_LUMINANCE_THRESHOLD) darkMask[i] = 1;
    }
  }
  const areaCeil = width * height * TEXT_TINY_COMPONENT_MAX_AREA_FRACTION;
  const tinyCount = labelComponents(darkMask, width, height).filter(c => c.size > 0 && c.size <= areaCeil).length;

  function scanlineDark(x: number, y: number): boolean {
    const i = y * width + x;
    if (!foregroundMask[i]) return false;
    const off = i * 4;
    return luminance(data[off], data[off + 1], data[off + 2]) < TEXT_DARK_LUMINANCE_THRESHOLD;
  }
  let highTransitionLines = 0;
  for (let y = 0; y < height; y++) {
    if (y >= bandY && y < height - bandY) continue;
    let transitions = 0, prevDark = false;
    for (let x = 0; x < width; x++) {
      const dark = scanlineDark(x, y);
      if (x > 0 && dark !== prevDark) transitions++;
      prevDark = dark;
    }
    if (transitions >= TEXT_STROKE_MIN_TRANSITIONS) highTransitionLines++;
  }
  for (let x = 0; x < width; x++) {
    if (x >= bandX && x < width - bandX) continue;
    let transitions = 0, prevDark = false;
    for (let y = 0; y < height; y++) {
      const dark = scanlineDark(x, y);
      if (y > 0 && dark !== prevDark) transitions++;
      prevDark = dark;
    }
    if (transitions >= TEXT_STROKE_MIN_TRANSITIONS) highTransitionLines++;
  }

  const detected = tinyCount >= TEXT_TINY_COMPONENT_MIN_COUNT || highTransitionLines >= TEXT_STROKE_MIN_LINES;
  return {
    detected,
    detail: `${tinyCount} tiny dark component(s), ${highTransitionLines} high-contrast scanline(s) near cell edges/corners`,
  };
}

// ── main entry point ─────────────────────────────────────────────────────

/** Everything computed per-cell before scoring — kept internal; the
 *  public `TraitSheetCellReport` is the trimmed, serializable subset. */
interface InternalCellResult {
  report: TraitSheetCellReport;
  normalizedPngBuffer: Buffer | null; // null only if the cell failed to normalize
}

/**
 * Validates an already-generated trait-sheet PNG against `layoutId`
 * (currently only `'2x4-layer-sheet'` is supported — the only layout
 * openai-trait-sheet-prompts.ts's `getActiveCellIdsForMode` knows the
 * active-cell vocabulary for) and `sourceMode` (which cells that mode's
 * prompt asked the model to actually populate). Never throws — a
 * genuinely undecodable image or an unsupported layout/mode combination
 * comes back as a `verdict: 'fail'` result with an explanatory issue,
 * not an exception, so a caller never needs a second error-handling path
 * on top of the returned shape.
 */
export async function validateTraitSheet(
  sourcePngBuffer: Buffer,
  sourceMode: TraitSheetPromptMode,
  layoutId: string = LAYER_SHEET_2X4.id,
): Promise<TraitSheetValidationResult> {
  const layout: TraitSheetLayout = LAYER_SHEET_2X4; // only supported layout for now (see doc comment)
  if (layoutId !== LAYER_SHEET_2X4.id) {
    return {
      ok: true, sourceMode, layoutId, sourceWidth: 0, sourceHeight: 0, verdict: 'fail', score: 0,
      cellReports: [],
      issues: [{ code: 'layout_mode_mismatch', severity: 'fail', message: `Unsupported layoutId "${layoutId}" — trait-sheet validation only supports "${LAYER_SHEET_2X4.id}".` }],
      reconstruction: null, recommendedNextStep: 'regenerate',
    };
  }

  const activeCellIds = new Set(getActiveCellIdsForMode(sourceMode));
  const knownCellIds = new Set(layout.cells.map(c => c.cellId));
  const hasOverlap = [...activeCellIds].some(id => knownCellIds.has(id));
  if (!hasOverlap) {
    return {
      ok: true, sourceMode, layoutId, sourceWidth: 0, sourceHeight: 0, verdict: 'fail', score: 0,
      cellReports: [],
      issues: [{ code: 'layout_mode_mismatch', severity: 'fail', message: `sourceMode "${sourceMode}" has no active cells in layout "${layoutId}".` }],
      reconstruction: null, recommendedNextStep: 'regenerate',
    };
  }

  let cropped: CroppedTraitSheetCell[];
  try {
    cropped = await cropTraitSheetCells(sourcePngBuffer, layout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: true, sourceMode, layoutId, sourceWidth: 0, sourceHeight: 0, verdict: 'fail', score: 0,
      cellReports: [],
      issues: [{ code: 'sheet_undecodable', severity: 'fail', message: `Source image could not be decoded/cropped: ${msg}` }],
      reconstruction: null, recommendedNextStep: 'regenerate',
    };
  }
  const sourceWidth = cropped[0]?.sourceWidth ?? 0;
  const sourceHeight = cropped[0]?.sourceHeight ?? 0;

  const sheetIssues: TraitSheetIssue[] = [];
  const results: InternalCellResult[] = [];

  for (const cell of cropped) {
    const active = activeCellIds.has(cell.cellId);
    const cellIssues: TraitSheetIssue[] = [];

    if (cell.warnings.length > 0) {
      for (const w of cell.warnings) {
        cellIssues.push({ code: 'cell_crop_warning', severity: 'warn', cellId: cell.cellId, message: `Cell "${cell.cellId}": ${w}` });
      }
    }

    const rawImg = await loadRawRgba(sharp(cell.pngBuffer).ensureAlpha());
    const bg = classifyBackground(rawImg);

    const textCheck = detectPossibleTextOrLabel(rawImg, bg.mask);
    if (textCheck.detected) {
      cellIssues.push({
        code: 'possible_text_or_label', severity: 'warn', cellId: cell.cellId,
        message: `Cell "${cell.cellId}": possible text/label detected (heuristic, advisory only) — ${textCheck.detail}.`,
      });
    }

    const rawBoundaryBleed = cell.cellId === 'background'
      ? false // background is expected to fill the whole crop — see this stage's own task spec
      : hasBoundaryBleed(bg.mask, rawImg.width, rawImg.height, BOUNDARY_MARGIN_FRACTION);
    if (rawBoundaryBleed) {
      cellIssues.push({
        code: 'boundary_bleed', severity: 'warn', cellId: cell.cellId,
        message: `Cell "${cell.cellId}": opaque content extends within ${(BOUNDARY_MARGIN_FRACTION * 100).toFixed(0)}% of the crop edge — may have been clipped or drawn without the requested inset.`,
      });
    }

    let normalizedPngBuffer: Buffer | null = null;
    let normalizedImg: RgbaImage | null = null;
    try {
      // 'background' and 'preview' are the two cells naturally expected to
      // carry real fill across most of their own area — 'background' IS
      // the background layer; 'preview' is "every layer... composed
      // together" (the prompt's own wording, openai-trait-sheet-prompts.ts),
      // which includes the background layer's own content too. Neither is
      // something to corner-sample and strip: 'autoDetect' would treat a
      // legitimately opaque fill as "background to remove" and wrongly
      // zero it out (an empty 'background' cell, or a preview stripped
      // down to only its subject, which would then read as a spurious
      // reconstruction mismatch against the real composed background+
      // subject stack). Every other (real layer) cell still uses
      // classifyBackground's own verdict (raw-crop transparent -> trust
      // alpha; opaque/solid -> corner-sample and strip it), since THOSE
      // cells are supposed to be transparent outside their own subject
      // per the prompt, and an opaque one is the actual failure mode this
      // module needs to see through to measure emptiness/alignment.
      const normalizeBackgroundMode = (cell.cellId === 'background' || cell.cellId === 'preview')
        ? 'none'
        : (bg.kind === 'transparent' ? 'none' : 'autoDetect');
      const normalized = await normalizeTraitSheetCell(cell, {
        outputSize: OUTPUT_SIZE,
        backgroundMode: normalizeBackgroundMode,
        bgThreshold: DEFAULT_BG_THRESHOLD,
      });
      normalizedPngBuffer = normalized.pngBuffer;
      normalizedImg = await loadRawRgba(sharp(normalized.pngBuffer).ensureAlpha());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cellIssues.push({ code: 'cell_crop_warning', severity: 'fail', cellId: cell.cellId, message: `Cell "${cell.cellId}" failed to normalize: ${msg}` });
    }

    const { ratio: foregroundRatio } = normalizedImg
      ? foregroundMaskAndRatio(normalizedImg)
      : { ratio: 0 };

    if (active && foregroundRatio < EMPTY_ACTIVE_MAX_FOREGROUND_RATIO) {
      cellIssues.push({
        code: 'active_cell_empty', severity: 'fail', cellId: cell.cellId,
        message: `Cell "${cell.cellId}" is expected to contain content for sourceMode "${sourceMode}" but is effectively empty (${(foregroundRatio * 100).toFixed(2)}% foreground).`,
      });
    }
    if (!active && foregroundRatio > INACTIVE_MAX_FOREGROUND_RATIO) {
      cellIssues.push({
        code: 'inactive_cell_not_empty', severity: 'warn', cellId: cell.cellId,
        message: `Cell "${cell.cellId}" was supposed to stay empty for sourceMode "${sourceMode}" but has ${(foregroundRatio * 100).toFixed(1)}% foreground — the model may have drawn into an unused cell.`,
      });
    }

    results.push({
      normalizedPngBuffer,
      report: {
        cellId: cell.cellId, label: cell.label, active, suggestedLayerType: cell.suggestedLayerType,
        foregroundRatio, backgroundKind: bg.kind, detectedKeyColorHex: bg.keyColorHex,
        boundaryBleed: rawBoundaryBleed, alignmentDriftPx: null, possibleTextOrLabel: textCheck.detected,
        issues: cellIssues,
      },
    });
  }

  // ── alignment: every active, non-preview, non-background cell vs the
  //    preview cell's own subject center, both measured on the shared
  //    48x48 grid ──
  const previewResult = results.find(r => r.report.cellId === 'preview');
  const previewNormalizedImg = previewResult?.normalizedPngBuffer
    ? await loadRawRgba(sharp(previewResult.normalizedPngBuffer).ensureAlpha())
    : null;
  const previewCenter = previewNormalizedImg ? foregroundBBoxCenter(foregroundMaskAndRatio(previewNormalizedImg).mask, OUTPUT_SIZE, OUTPUT_SIZE) : null;

  for (const r of results) {
    const { cellId } = r.report;
    if (!r.report.active || cellId === 'preview' || cellId === 'background' || !r.normalizedPngBuffer) continue;
    const img = await loadRawRgba(sharp(r.normalizedPngBuffer).ensureAlpha());
    const center = foregroundBBoxCenter(foregroundMaskAndRatio(img).mask, OUTPUT_SIZE, OUTPUT_SIZE);
    if (!center || !previewCenter) continue;
    const drift = Math.hypot(center.x - previewCenter.x, center.y - previewCenter.y);
    r.report.alignmentDriftPx = drift;
    if (drift > ALIGNMENT_WARN_DRIFT_PX) {
      r.report.issues.push({
        code: 'alignment_drift', severity: drift > ALIGNMENT_FAIL_DRIFT_PX ? 'fail' : 'warn', cellId,
        message: `Cell "${cellId}" subject center is ${drift.toFixed(1)}px from the preview cell's own center on the shared 48x48 grid (warn > ${ALIGNMENT_WARN_DRIFT_PX}px, fail > ${ALIGNMENT_FAIL_DRIFT_PX}px).`,
      });
    }
  }

  // ── background consistency across ACTIVE cells only ──
  const activeBgKinds = results.filter(r => r.report.active).map(r => r.report.backgroundKind);
  const activeKeyColors = results.filter(r => r.report.active && r.report.detectedKeyColorHex).map(r => r.report.detectedKeyColorHex as string);
  let mixedBackgrounds = false;
  if (new Set(activeBgKinds).size > 1) {
    mixedBackgrounds = true;
  } else if (activeKeyColors.length > 1) {
    const [first, ...rest] = activeKeyColors;
    const firstRgb = [parseInt(first.slice(1, 3), 16), parseInt(first.slice(3, 5), 16), parseInt(first.slice(5, 7), 16)] as [number, number, number];
    for (const hex of rest) {
      const rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as [number, number, number];
      if (colorDistance(firstRgb, rgb) > DEFAULT_BG_THRESHOLD * 2) { mixedBackgrounds = true; break; }
    }
  }
  if (mixedBackgrounds) {
    sheetIssues.push({
      code: 'mixed_backgrounds', severity: 'warn',
      message: 'Active cells do not share a consistent background style (some transparent, some solid, or differing key colors) — background removal may behave inconsistently per cell on import.',
    });
  }

  // ── 8-cell reconstruction (advisory only — never affects score) ──
  let reconstruction: TraitSheetValidationResult['reconstruction'] = null;
  if (sourceMode === 'trait-sheet-8-cell' && previewResult?.normalizedPngBuffer) {
    const composeLayers: ComposeTraitLayerInput[] = results
      .filter(r => r.report.active && r.report.cellId !== 'preview' && r.normalizedPngBuffer)
      .map(r => ({
        id: r.report.cellId, name: r.report.label, pngBuffer: r.normalizedPngBuffer as Buffer,
        zIndex: SHEET_CELL_Z_INDEX[r.report.cellId] ?? 50, layerType: (r.report.suggestedLayerType ?? 'other') as LayerType,
      }));
    if (composeLayers.length > 0) {
      try {
        const composedBuffer = await composeTraitPngs(composeLayers, OUTPUT_SIZE);
        const { diffPct } = await comparePngs(composedBuffer, previewResult.normalizedPngBuffer);
        reconstruction = { diffPct, comparedAgainstPreview: true };
        if (diffPct > 15) {
          sheetIssues.push({
            code: 'reconstruction_mismatch', severity: 'warn',
            message: `Stacking all 7 layer cells and comparing against the preview cell shows ${diffPct.toFixed(1)}% pixel difference — advisory only, does not block import.`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sheetIssues.push({ code: 'reconstruction_mismatch', severity: 'warn', message: `Reconstruction check could not run: ${msg}` });
      }
    }
  }

  // ── scoring — structural dimensions only (see this file's header
  //    comment: text/label + reconstruction are advisory, excluded here) ──
  const activeReports = results.filter(r => r.report.active);
  const inactiveReports = results.filter(r => !r.report.active);
  const alignedReports = results.filter(r => r.report.alignmentDriftPx !== null);
  const nonBackgroundActive = activeReports.filter(r => r.report.cellId !== 'background');

  const activeEmptyBadness = activeReports.length > 0
    ? activeReports.filter(r => r.report.foregroundRatio < EMPTY_ACTIVE_MAX_FOREGROUND_RATIO).length / activeReports.length
    : 1;
  const inactiveLeakBadness = inactiveReports.length > 0
    ? inactiveReports.filter(r => r.report.foregroundRatio > INACTIVE_MAX_FOREGROUND_RATIO).length / inactiveReports.length
    : 0;
  const boundaryBadness = nonBackgroundActive.length > 0
    ? nonBackgroundActive.filter(r => r.report.boundaryBleed).length / nonBackgroundActive.length
    : 0;
  const alignmentBadness = alignedReports.length > 0
    ? alignedReports.reduce((sum, r) => sum + Math.min(1, (r.report.alignmentDriftPx as number) / ALIGNMENT_FAIL_DRIFT_PX), 0) / alignedReports.length
    : 0;
  const backgroundBadness = mixedBackgrounds ? 1 : 0;

  const badnesses = [activeEmptyBadness, inactiveLeakBadness, boundaryBadness, alignmentBadness, backgroundBadness];
  const avgBadness = badnesses.reduce((a, b) => a + b, 0) / badnesses.length;
  let score = Math.round(100 * (1 - avgBadness));

  // Hard floor: without a usable preview cell, alignment and
  // reconstruction can never be trusted for anything downstream — this is
  // foundational, not just one bad dimension among several.
  const previewEmpty = previewResult ? previewResult.report.foregroundRatio < EMPTY_ACTIVE_MAX_FOREGROUND_RATIO : true;
  if (previewEmpty) score = Math.min(score, 20);

  const verdict: TraitSheetVerdict = score >= SCORE_PASS_THRESHOLD ? 'pass' : (score >= SCORE_WARN_THRESHOLD ? 'warn' : 'fail');

  const recommendedNextStep: TraitSheetRecommendedNextStep = verdict === 'fail'
    ? 'regenerate'
    : sourceMode === 'trait-sheet-2-cell'
      ? 'run_4_cell'
      : sourceMode === 'trait-sheet-4-cell'
        ? 'run_8_cell'
        : 'try_import';

  return {
    ok: true, sourceMode, layoutId, sourceWidth, sourceHeight, verdict, score,
    cellReports: results.map(r => r.report),
    issues: sheetIssues, reconstruction, recommendedNextStep,
  };
}
