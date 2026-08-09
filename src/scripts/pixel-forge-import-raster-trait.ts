/**
 * Pixel Forge — one-off importer: turns an already-converted raster PNG
 * (see src/scripts/pixel-forge-raster-to-pixel.ts) into a normal candidate
 * TraitAsset, using the SAME `saveTraitAsset` store function every real
 * generation writes through — not a hand-rolled JSON file — so the record
 * is guaranteed schema-correct and indistinguishable, on disk, from a
 * manually-added validation output.
 *
 * No Anthropic/OpenAI call, no generation — this only reads a local PNG
 * and writes one trait record. `evaluation`/`modelPreset`/`tokenUsage` are
 * filled with honest "not applicable, this wasn't generated" placeholders
 * (see below), never invented grading.
 *
 * Usage:
 *   npx ts-node src/scripts/pixel-forge-import-raster-trait.ts \
 *     --input <path.png> --name "Raster Raccoon 48" --layer-type icon \
 *     --size 48 --tags raster,openai-test,raccoon,48x48 \
 *     --notes "Imported from raster experiment ..." \
 *     [--collection-name "SMB Animals v1"]
 */

import 'dotenv/config';
import { promises as fsp } from 'fs';
import sharp from 'sharp';
import { EVALUATION_SCHEMA_VERSION, Evaluation } from '../pixel-agent/tools';
import { LayerType, LAYER_TYPES } from '../pixel-agent/agent-loop';
import { saveTraitAsset } from '../pixel-agent/store';
import { listCollections } from '../pixel-agent/collections-store';

interface CliArgs {
  input: string;
  name: string;
  layerType: LayerType;
  size: number;
  tags: string[];
  notes: string;
  collectionName?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const input = get('--input');
  if (!input) throw new Error('missing required --input <path.png>');
  const name = get('--name') ?? 'Raster import';
  const layerTypeRaw = get('--layer-type') ?? 'icon';
  if (!(LAYER_TYPES as readonly string[]).includes(layerTypeRaw)) throw new Error(`invalid --layer-type ${layerTypeRaw}`);
  const size = Number(get('--size') ?? '48');
  if (!Number.isInteger(size) || size <= 0) throw new Error('invalid --size');
  const tags = (get('--tags') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const notes = get('--notes') ?? '';
  const collectionName = get('--collection-name');
  return { input, name, layerType: layerTypeRaw as LayerType, size, tags, notes, collectionName };
}

/** Extracts a faithful (not re-quantized) palette + pixel-index grid
 *  directly from the PNG's actual RGBA bytes — index 0 is "transparent"
 *  for any pixel with alpha < 128; every other pixel becomes (or reuses)
 *  a palette entry for its exact RGB, in first-seen order. This is
 *  intentionally NOT a curated small pixel-art palette — a "nearest"
 *  raster conversion (unlike the "quantized" variant) keeps whatever
 *  colors survived the resize verbatim, including source anti-aliasing,
 *  so the extracted palette can be large. It is still 100% consistent
 *  with `pngBase64` (reconstructing `pixels` against `palette` reproduces
 *  the exact same image), which is what the store's schema actually
 *  requires — see store.ts's `normalizeTraitAsset`. */
async function extractPaletteAndPixels(
  pngPath: string, expectedSize: number,
): Promise<{ palette: string[]; pixels: number[] }> {
  const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expectedSize || info.height !== expectedSize) {
    throw new Error(`PNG is ${info.width}x${info.height}, expected ${expectedSize}x${expectedSize}`);
  }
  const colorIndex = new Map<string, number>(); // "r,g,b" -> palette index (1-based; 0 is transparent)
  const hexColors: string[] = [];
  const pixels: number[] = new Array(expectedSize * expectedSize);
  for (let i = 0; i < expectedSize * expectedSize; i++) {
    const off = i * 4;
    const alpha = data[off + 3];
    if (alpha < 128) { pixels[i] = 0; continue; }
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const key = `${r},${g},${b}`;
    let idx = colorIndex.get(key);
    if (idx === undefined) {
      idx = hexColors.length + 1; // +1: index 0 reserved for "transparent"
      colorIndex.set(key, idx);
      hexColors.push(`#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`);
    }
    pixels[i] = idx;
  }
  return { palette: ['transparent', ...hexColors], pixels };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { palette, pixels } = await extractPaletteAndPixels(args.input, args.size);
  console.log('[import-raster-trait] extracted palette size', palette.length, '(includes "transparent" at index 0)');

  const pngBase64 = (await fsp.readFile(args.input)).toString('base64');

  let collectionId: string | null = null;
  let collectionPresetId: string | null = null;
  if (args.collectionName) {
    const collections = await listCollections();
    const match = collections.find(c => c.name === args.collectionName);
    if (match) {
      collectionId = match.id;
      collectionPresetId = match.presetId;
      console.log('[import-raster-trait] resolved collection', match.name, '->', match.id);
    } else {
      console.log('[import-raster-trait] collection name not found — leaving collectionId/collectionPresetId null:', args.collectionName);
    }
  }

  // Honest "not a real generation" placeholder — never invented grading,
  // mirrors agent-loop.ts's own STOPPED_EVALUATION shape/spirit for a
  // trait that was never actually run through the drawing/evaluate loop.
  const evaluation: Evaluation = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    blindDescription: '',
    recognizableAsSubject: false,
    issues: [],
    preserve: [],
    doNotModify: [],
    intentionalChoices: [],
    notes: 'Not evaluated — imported from an external raster conversion; no self-grading was performed.',
  };

  const trait = await saveTraitAsset({
    prompt: 'N/A — imported from an external raster conversion, not generated by Claude. See notes.',
    layerType: args.layerType,
    size: args.size,
    palette,
    pixels,
    modelPreset: 'fast',
    actualModel: 'none (raster import — no AI call)',
    maxTurns: 0,
    anchor: null,
    tokenUsage: null,
    estimatedCostUsd: 0,
    evaluation,
    repairPlan: null,
    tags: args.tags,
    notes: args.notes || null,
    pngBase64,
    name: args.name,
    referenceGuidanceNote: null,
    collectionPresetId,
    collectionId,
  });

  console.log('[import-raster-trait] saved trait', {
    id: trait.id, slug: trait.slug, status: trait.status, size: trait.size,
    layerType: trait.layerType, collectionId: trait.collectionId, collectionPresetId: trait.collectionPresetId,
  });
}

main().catch(err => {
  console.error('[import-raster-trait] failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
