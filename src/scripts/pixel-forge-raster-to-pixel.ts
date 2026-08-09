/**
 * Pixel Forge — Raster-to-Pixel-Art Converter (offline experiment).
 *
 * Algorithmic prototype ONLY — no Anthropic call, no OpenAI call, no
 * network access at all. Converts an externally-sourced PNG (e.g. an
 * "almost pixel art but not grid-clean" AI-generated image) into a clean,
 * fixed-grid pixel-art PNG using pure image-processing techniques: square
 * crop/pad, downscale, palette quantization, best-effort flat-background
 * removal, nearest-neighbor upscale for preview.
 *
 * Conversion primitives live in ../pixel-agent/raster-convert.ts, shared
 * with the Stage 1 HTTP route (src/server/tools-pixel-forge-raster.ts) —
 * see docs/pixel-forge-image-to-traits-pipeline-mvp.md. This file is now
 * just the CLI wrapper (arg parsing + file I/O) around that shared logic.
 *
 * This does NOT touch the real trait library. Output is written to an
 * isolated scratch directory (`data/pixel-forge/raster-experiments/`),
 * never `data/pixel-forge/traits/`.
 *
 * Usage:
 *   npx ts-node src/scripts/pixel-forge-raster-to-pixel.ts --input <path.png> \
 *     [--sizes 32,48] [--palette "#112233,#445566,..."] \
 *     [--output-dir data/pixel-forge/raster-experiments/<name>] \
 *     [--bg-threshold 24] [--upscale 8]
 *
 *   --sizes         comma-separated target grid sizes (default: 32,48)
 *   --palette       comma-separated hex colors for the quantized variant
 *                    (default: agent-loop.ts's own DEFAULT_PALETTE, so the
 *                    quantized output is directly comparable to a real
 *                    Pixel Forge trait's color range — the HTTP route uses
 *                    a source-derived palette instead; see
 *                    raster-convert.ts's `deriveSourcePalette`)
 *   --output-dir    default: data/pixel-forge/raster-experiments/<ISO timestamp>/
 *   --bg-threshold  RGB Euclidean distance from the sampled corner color
 *                    under which a pixel is treated as background and
 *                    forced transparent. 0 disables background removal.
 *   --upscale       nearest-neighbor preview upscale factor (default: 8,
 *                    matching agent-loop.ts's own PREVIEW_UPSCALE)
 *
 * For each requested size, writes TWO variants:
 *   - "nearest"   — square-fit, then a single nearest-neighbor resize
 *                    straight to the target grid. No forced palette; keeps
 *                    whatever colors survive the resize verbatim.
 *   - "quantized" — square-fit, then a smooth (area-average) resize to the
 *                    target grid, then every pixel snapped to the nearest
 *                    color in the fixed palette (simple Euclidean RGB
 *                    distance — no ML, no clustering).
 *
 * Each variant produces:
 *   <size>-<variant>-raw.png       the actual <size>x<size> pixel PNG
 *   <size>-<variant>-preview.png   nearest-neighbor upscaled for eyeballing
 *   <size>-<variant>.json          { size, palette, pixels } — palette
 *                                   index 0 is always "transparent", 1..N
 *                                   are hex, matching the real trait
 *                                   store's own convention
 *                                   (TraitDrawResult.palette in
 *                                   agent-loop.ts).
 */

import 'dotenv/config';
import { promises as fsp } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { DEFAULT_PALETTE } from '../pixel-agent/agent-loop';
import {
  loadRawRgba, squareFit, estimateBackgroundColor, buildNearestVariant, buildQuantizedVariant,
  writeRgbaPng, writePreview,
} from '../pixel-agent/raster-convert';

interface CliArgs {
  input: string;
  sizes: number[];
  palette: string[];
  outputDir: string;
  bgThreshold: number;
  upscale: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const input = get('--input');
  if (!input) throw new Error('missing required --input <path.png>');

  const sizesRaw = get('--sizes') ?? '32,48';
  const sizes = sizesRaw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  if (sizes.length === 0) throw new Error('invalid --sizes');

  const paletteRaw = get('--palette');
  const palette = paletteRaw
    ? paletteRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [...DEFAULT_PALETTE];

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = get('--output-dir')
    ?? path.join(process.cwd(), 'data', 'pixel-forge', 'raster-experiments', timestamp);

  const bgThreshold = Number(get('--bg-threshold') ?? '24');
  const upscale = Number(get('--upscale') ?? '8');

  return { input, sizes, palette, outputDir, bgThreshold, upscale };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await fsp.mkdir(args.outputDir, { recursive: true });

  console.log('[raster-to-pixel] input', args.input);
  console.log('[raster-to-pixel] output dir', args.outputDir);
  console.log('[raster-to-pixel] sizes', args.sizes, 'palette colors', args.palette.length, 'bgThreshold', args.bgThreshold);

  // Background color is sampled from the ORIGINAL image's corners, before
  // squareFit's own padding — sampling after squareFit would read the
  // padding color itself (transparent black) for any non-square input,
  // not the real background.
  const originalRaw = await loadRawRgba(sharp(args.input).ensureAlpha());
  const bgColor = estimateBackgroundColor(originalRaw);
  console.log('[raster-to-pixel] estimated background color (corner avg, pre-pad)', bgColor.map(n => Math.round(n)));

  const squareFitImg = await squareFit(args.input);

  for (const size of args.sizes) {
    // ── nearest ──────────────────────────────────────────────────────
    const nearest = await buildNearestVariant(squareFitImg, size, bgColor, args.bgThreshold);
    await writeRgbaPng(nearest, path.join(args.outputDir, `${size}-nearest-raw.png`));
    await writePreview(nearest, args.upscale, path.join(args.outputDir, `${size}-nearest-preview.png`));

    // ── quantized ────────────────────────────────────────────────────
    const { img: quantized, pixelPaletteIndex } = await buildQuantizedVariant(
      squareFitImg, size, args.palette, bgColor, args.bgThreshold,
    );
    await writeRgbaPng(quantized, path.join(args.outputDir, `${size}-quantized-raw.png`));
    await writePreview(quantized, args.upscale, path.join(args.outputDir, `${size}-quantized-preview.png`));
    await fsp.writeFile(
      path.join(args.outputDir, `${size}-quantized.json`),
      JSON.stringify({ size, palette: ['transparent', ...args.palette], pixels: pixelPaletteIndex }, null, 2),
    );

    console.log(`[raster-to-pixel] wrote ${size}x${size} nearest + quantized variants`);
  }

  console.log('[raster-to-pixel] done ->', args.outputDir);
}

main().catch(err => {
  console.error('[raster-to-pixel] failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
