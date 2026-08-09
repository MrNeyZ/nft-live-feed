/**
 * Pixel Forge — Stage 9 diagnosis tooling: Trait Sheet import debug
 * capture. DIAGNOSIS ONLY — no crop/background-removal/squareFit/
 * normalize logic lives here, and none of it is modified. This module is
 * a read-only "shadow" observer: it calls the exact same exported,
 * UNMODIFIED primitives trait-sheet.ts's own `normalizeTraitSheetCell`
 * uses internally (`squareFit`, `loadRawRgba`, `normalizeTraitSheetCell`
 * itself), in the same order, purely to snapshot intermediate buffers as
 * PNGs — it never changes what those functions compute or how.
 *
 * IMPORTANT — actual execution order (verified against
 * trait-sheet.ts's `normalizeTraitSheetCell`, unmodified): the real
 * pipeline is crop -> squareFit (pad to square) -> resize to
 * outputSize x outputSize -> background removal, applied LAST, to the
 * already-resized buffer. Background removal is NEVER applied to the raw
 * crop or to the pre-resize squareFit output. The four stages captured
 * below are named to reflect this real order, not a guessed one.
 *
 * Stage 4 ("final") is not a reimplementation — it is the literal return
 * value of calling the real, untouched `normalizeTraitSheetCell()`, so
 * that PNG is guaranteed byte-identical to what would actually be
 * imported (or would have been, for a cell like `preview` that
 * production normally never calls normalize on at all).
 */

import sharp from 'sharp';
import { promises as fsp } from 'fs';
import * as path from 'path';
import {
  CroppedTraitSheetCell, NormalizeTraitSheetCellOptions, normalizeTraitSheetCell,
} from './trait-sheet';
import { RgbaImage, loadRawRgba, squareFit } from './raster-convert';

// Matches every other raster-*/trait-sheet-*.ts file's own
// FOREGROUND_ALPHA_THRESHOLD convention (duplicated locally, not
// imported — same established per-file pattern collection-fit.ts and
// trait-sheet-validation.ts already use).
const FOREGROUND_ALPHA_THRESHOLD = 128;
const DEFAULT_OUTPUT_SIZE = 48;
// Debug-log-only heuristic for "print a warning" — NOT a pipeline
// threshold (DEFAULT_BG_THRESHOLD/FOREGROUND_ALPHA_THRESHOLD are never
// touched by this file). A relative foreground-pixel loss above this
// between two consecutive captured stages gets an explicit warning line.
const HUGE_DROP_RATIO = 0.5;

function countForeground(img: RgbaImage): number {
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3] >= FOREGROUND_ALPHA_THRESHOLD) n++;
  }
  return n;
}

async function writeRawPng(img: RgbaImage, filePath: string): Promise<void> {
  const buf = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
  await fsp.writeFile(filePath, buf);
}

export interface DebugStageInfo {
  stage: 'crop' | 'squarefit' | 'resized_before_bg_removal' | 'final';
  filename: string;
  foregroundPixels: number;
  width: number;
  height: number;
}

export interface DebugCellResult {
  cellId: string;
  cropWidth: number;
  cropHeight: number;
  stages: DebugStageInfo[];
  /** Human-readable "huge drop between stage X and stage Y" lines — empty
   *  if no consecutive-stage drop exceeded HUGE_DROP_RATIO. */
  warnings: string[];
}

/**
 * Captures all 4 diagnostic stages for one cell into `outputDir`
 * (created if missing) and returns per-stage foreground-pixel counts +
 * any huge-drop warnings. Pure side effect (disk writes) + return value —
 * never mutates `cell`, never calls saveTraitAsset, never affects the
 * real import result. Safe to call for ANY cropped cell, including
 * `preview` (which production's own import loop always skips — see
 * tools-pixel-forge-import-trait-sheet.ts's own "cell 0 is never imported
 * by default" comment) since this is diagnostic-only and creates no
 * TraitAsset either way.
 */
export async function captureDebugCellStages(
  cell: CroppedTraitSheetCell,
  options: NormalizeTraitSheetCellOptions,
  outputDir: string,
): Promise<DebugCellResult> {
  await fsp.mkdir(outputDir, { recursive: true });
  const outputSize = options.outputSize ?? DEFAULT_OUTPUT_SIZE;
  const stages: DebugStageInfo[] = [];

  // Stage 1 — original crop, exactly as cropTraitSheetCells (unmodified)
  // produced it. No processing applied.
  const cropImg = await loadRawRgba(sharp(cell.pngBuffer).ensureAlpha());
  const fgCrop = countForeground(cropImg);
  await writeRawPng(cropImg, path.join(outputDir, '01-crop.png'));
  stages.push({ stage: 'crop', filename: '01-crop.png', foregroundPixels: fgCrop, width: cropImg.width, height: cropImg.height });

  // Stage 2 — after squareFit (padded to a square canvas), BEFORE the
  // outputSize x outputSize resize. Uses the real, exported squareFit()
  // — same call trait-sheet.ts's normalizeTraitSheetCell makes.
  const squareFitPipeline = await squareFit(cell.pngBuffer);
  const squareFitImg = await loadRawRgba(squareFitPipeline.clone());
  const fgSquareFit = countForeground(squareFitImg);
  await writeRawPng(squareFitImg, path.join(outputDir, '02-squarefit.png'));
  stages.push({ stage: 'squarefit', filename: '02-squarefit.png', foregroundPixels: fgSquareFit, width: squareFitImg.width, height: squareFitImg.height });

  // Stage 3 — resized to outputSize x outputSize, BEFORE background
  // removal — the real pipeline's own resize step (nearest-neighbor,
  // fit:'fill'), captured before the (possible) removal pass that
  // happens after it in the real function.
  const resized = squareFitPipeline.clone().resize(outputSize, outputSize, { kernel: 'nearest', fit: 'fill' });
  const preRemovalImg = await loadRawRgba(resized);
  const fgBeforeBgRemoval = countForeground(preRemovalImg);
  await writeRawPng(preRemovalImg, path.join(outputDir, '03-resized-before-bg-removal.png'));
  stages.push({ stage: 'resized_before_bg_removal', filename: '03-resized-before-bg-removal.png', foregroundPixels: fgBeforeBgRemoval, width: preRemovalImg.width, height: preRemovalImg.height });

  // Stage 4 — the REAL final output: calls the actual, unmodified
  // normalizeTraitSheetCell() and writes ITS OWN returned buffer
  // verbatim — not a reimplementation.
  const normalized = await normalizeTraitSheetCell(cell, options);
  const finalImg = await loadRawRgba(sharp(normalized.pngBuffer).ensureAlpha());
  const fgFinal = countForeground(finalImg);
  await fsp.writeFile(path.join(outputDir, '04-final-48.png'), normalized.pngBuffer);
  stages.push({ stage: 'final', filename: '04-final-48.png', foregroundPixels: fgFinal, width: finalImg.width, height: finalImg.height });

  // Compared as FOREGROUND RATIO (fg / that stage's own total pixel
  // count), never as raw pixel counts — stage 2->3 alone shrinks total
  // pixel count from cropWidth*cropHeight down to outputSize*outputSize
  // (e.g. 256x256 -> 48x48), so a fully-opaque image legitimately goes
  // from a huge raw count to a much smaller one WITHOUT losing any actual
  // foreground coverage. Comparing raw counts across a resolution change
  // would falsely report a "huge drop" on every single cell, every time.
  const ratioSeq = [
    { ratio: fgCrop / (cropImg.width * cropImg.height), fg: fgCrop },
    { ratio: fgSquareFit / (squareFitImg.width * squareFitImg.height), fg: fgSquareFit },
    { ratio: fgBeforeBgRemoval / (preRemovalImg.width * preRemovalImg.height), fg: fgBeforeBgRemoval },
    { ratio: fgFinal / (finalImg.width * finalImg.height), fg: fgFinal },
  ];
  const labels = ['crop', 'squarefit', 'resized (pre bg-removal)', 'final (post bg-removal)'];
  const warnings: string[] = [];
  if (fgCrop === 0) {
    warnings.push('crop itself has ZERO foreground pixels — nothing to lose downstream; check crop bounds / source sheet content for this cell.');
  }
  for (let i = 1; i < ratioSeq.length; i++) {
    const prev = ratioSeq[i - 1], cur = ratioSeq[i];
    if (prev.ratio > 0 && cur.ratio < prev.ratio * (1 - HUGE_DROP_RATIO)) {
      const lostPct = (100 * (1 - cur.ratio / prev.ratio)).toFixed(0);
      warnings.push(`huge drop from ${labels[i - 1]} (${prev.fg}px, ${(prev.ratio * 100).toFixed(1)}% of frame) to ${labels[i]} (${cur.fg}px, ${(cur.ratio * 100).toFixed(1)}% of frame) — ${lostPct}% relative loss`);
    }
  }

  return { cellId: cell.cellId, cropWidth: cropImg.width, cropHeight: cropImg.height, stages, warnings };
}
