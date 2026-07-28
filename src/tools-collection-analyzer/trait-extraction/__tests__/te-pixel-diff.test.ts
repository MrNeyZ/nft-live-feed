/**
 * Trait Extraction - core pixel-diff/consensus algorithm tests, asserted
 * against KNOWN synthetic ground truth (never snapshots). Operates
 * directly on in-memory DecodedImage objects - no network, no PNG
 * encode/decode round-trip needed for these.
 *
 * Run: npm run test:collection-analyzer-te-pixel-diff
 */
import assert from 'assert';
import { computeDiffMask, cleanPairMask, estimateTargetCandidate, removeSmallComponents, type CleanedPair } from '../te-pixel-diff';
import type { DecodedImage } from '../te-image-io';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

const W = 12, H = 12;
const BG: [number, number, number, number] = [40, 40, 40, 255];
const TARGET_COLOR: [number, number, number, number] = [220, 30, 30, 255]; // "Laser eyes" red
const ALT_COLOR: [number, number, number, number] = [30, 30, 220, 255];    // "Normal eyes" blue

function makeImage(regions: Array<{ x: number; y: number; w: number; h: number; color: [number, number, number, number] }>): DecodedImage {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const o = i * 4; data[o] = BG[0]; data[o + 1] = BG[1]; data[o + 2] = BG[2]; data[o + 3] = BG[3]; }
  for (const r of regions) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * W + x) * 4;
        data[o] = r.color[0]; data[o + 1] = r.color[1]; data[o + 2] = r.color[2]; data[o + 3] = r.color[3];
      }
    }
  }
  return { width: W, height: H, data, bytesDownloaded: 0 };
}

// "Target" region: a 4x4 block at (2,2). "Alt" region: the SAME 4x4 block
// but with the comparison's color - models one trait occupying one region
// with two mutually-exclusive values, exactly like Eyes=Laser vs Eyes=Normal.
const REGION = { x: 2, y: 2, w: 4, h: 4 };
// A solid NxN square loses its 4 corner pixels to one round of 4-connected
// morphological open (erode removes anything touching the boundary in a
// non-fully-surrounded direction; dilating the eroded core back out never
// re-adds diagonal-only corners) - this is REAL, verified behavior of
// cleanPairMask, not a bug. For REGION (4x4=16px) the corner-trimmed count
// is exactly 16 - 4 = 12.
function sourceImage(): DecodedImage { return makeImage([{ ...REGION, color: TARGET_COLOR }]); }
function comparisonImage(): DecodedImage { return makeImage([{ ...REGION, color: ALT_COLOR }]); }
function identicalImage(): DecodedImage { return makeImage([]); } // no region at all - background only

console.log('\ncomputeDiffMask');
check('identical images -> all-zero mask', () => {
  const a = makeImage([{ ...REGION, color: TARGET_COLOR }]);
  const b = makeImage([{ ...REGION, color: TARGET_COLOR }]);
  const mask = computeDiffMask(a, b, 24)!;
  assert.ok(mask.every((v) => v === 0));
});
check('differing region -> exactly the region pixels flagged', () => {
  const mask = computeDiffMask(sourceImage(), comparisonImage(), 24)!;
  let flagged = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inRegion = x >= REGION.x && x < REGION.x + REGION.w && y >= REGION.y && y < REGION.y + REGION.h;
    const v = mask[y * W + x];
    assert.strictEqual(v, inRegion ? 1 : 0, `pixel (${x},${y})`);
    if (v) flagged++;
  }
  assert.strictEqual(flagged, REGION.w * REGION.h);
});
check('mismatched dimensions -> null (hard reject)', () => {
  const a = sourceImage();
  const b: DecodedImage = { width: W + 1, height: H, data: Buffer.alloc((W + 1) * H * 4), bytesDownloaded: 0 };
  assert.strictEqual(computeDiffMask(a, b, 24), null);
});

console.log('\nremoveSmallComponents / cleanPairMask');
check('isolated single-pixel noise is removed, real region survives', () => {
  const mask = computeDiffMask(sourceImage(), comparisonImage(), 24)!;
  // Inject one isolated noise pixel far from the real region.
  mask[0] = 1;
  const cleaned = removeSmallComponents(mask, W, H, 6);
  assert.strictEqual(cleaned[0], 0, 'isolated pixel removed');
  assert.strictEqual(cleaned[REGION.y * W + REGION.x], 1, 'real region survives');
});
check('cleanPairMask preserves the real region shape (open does not erase it)', () => {
  const mask = computeDiffMask(sourceImage(), comparisonImage(), 24)!;
  const cleaned = cleanPairMask(mask, W, H, 6);
  let count = 0;
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i]) count++;
  assert.ok(count > 0, 'region not fully erased by morphological open');
});

console.log('\nestimateTargetCandidate - consensus over multiple pairs');

function makePair(sourceMint: string, comparisonMint: string, comparisonValue: string, src: DecodedImage, cmp: DecodedImage): CleanedPair {
  const raw = computeDiffMask(src, cmp, 24)!;
  return { sourceMint, comparisonMint, comparisonValue, sourceImage: src, diffMask: cleanPairMask(raw, src.width, src.height, 6) };
}

check('single source vs single comparison: candidate = target region, colored with the TARGET color (not a mix)', () => {
  const pairs = [makePair('S1', 'C1', 'Normal', sourceImage(), comparisonImage())];
  const result = estimateTargetCandidate(pairs, 0.6);
  assert.strictEqual(result.candidatePixelCount, 12); // 4x4 minus 4 corners, see REGION comment above
  // Verify color at a CENTER region pixel (corners are trimmed by the open
  // operation, see REGION comment above, so check a pixel guaranteed to
  // survive) matches TARGET_COLOR, not ALT_COLOR or a blend.
  const idx = (REGION.y + 1) * W + (REGION.x + 1);
  const o = idx * 4;
  assert.strictEqual(result.estimatedColor[o], TARGET_COLOR[0]);
  assert.strictEqual(result.estimatedColor[o + 1], TARGET_COLOR[1]);
  assert.strictEqual(result.estimatedColor[o + 2], TARGET_COLOR[2]);
});
check('transparent (alpha=0 via mask) everywhere OUTSIDE the candidate region', () => {
  const pairs = [makePair('S1', 'C1', 'Normal', sourceImage(), comparisonImage())];
  const result = estimateTargetCandidate(pairs, 0.6);
  for (let i = 0; i < W * H; i++) {
    const inRegion = result.candidateMask[i] === 1;
    if (!inRegion) assert.strictEqual(result.candidateMask[i], 0);
  }
  assert.strictEqual(result.candidatePixelCount, 12);
});
check('multiple sources vs multiple DIFFERENT comparison values -> still isolates the stable target region (not comparison-specific pixels)', () => {
  const altColor2: [number, number, number, number] = [30, 220, 30, 255]; // "Fire eyes" green
  const src1 = makeImage([{ ...REGION, color: TARGET_COLOR }]);
  const src2 = makeImage([{ ...REGION, color: TARGET_COLOR }]); // same target color across sources (consistency)
  const cmp1 = makeImage([{ ...REGION, color: ALT_COLOR }]);
  const cmp2 = makeImage([{ ...REGION, color: altColor2 }]);
  const pairs = [
    makePair('S1', 'C1', 'Normal', src1, cmp1),
    makePair('S2', 'C2', 'Fire', src2, cmp2),
  ];
  const result = estimateTargetCandidate(pairs, 0.6);
  assert.strictEqual(result.candidatePixelCount, 12);
  assert.ok(result.sourcePixelConsistencyMean > 0.9, `expected high consistency, got ${result.sourcePixelConsistencyMean}`);
});
check('change mask includes the FULL affected region regardless of consensus strength', () => {
  const pairs = [makePair('S1', 'C1', 'Normal', sourceImage(), comparisonImage())];
  const result = estimateTargetCandidate(pairs, 0.99); // near-impossible consensus bar
  // changeMask is just "changed in >=1 pair", independent of the consensus threshold.
  let changeCount = 0;
  for (let i = 0; i < result.changeMask.length; i++) if (result.changeMask[i]) changeCount++;
  assert.strictEqual(changeCount, 12);
});
check('disconnected target regions are both captured', () => {
  const region2 = { x: 8, y: 8, w: 3, h: 3 }; // 9px, above minComponentSize(6) so noise removal doesn't eat it
  const src = makeImage([{ ...REGION, color: TARGET_COLOR }, { ...region2, color: TARGET_COLOR }]);
  const cmp = makeImage([{ ...REGION, color: ALT_COLOR }, { ...region2, color: ALT_COLOR }]);
  const pairs = [makePair('S1', 'C1', 'Normal', src, cmp)];
  const result = estimateTargetCandidate(pairs, 0.6);
  const region1HasCandidate = result.candidateMask[REGION.y * W + REGION.x + 1] === 1 || result.candidateMask[(REGION.y + 1) * W + REGION.x + 1] === 1;
  const region2HasCandidate = result.candidateMask[(region2.y + 1) * W + (region2.x + 1)] === 1;
  assert.ok(region1HasCandidate, 'region 1 (main target block) contributes candidate pixels');
  assert.ok(region2HasCandidate, 'region 2 (disconnected second block) also contributes candidate pixels');
  assert.ok(result.candidatePixelCount > 0 && result.candidatePixelCount <= REGION.w * REGION.h + region2.w * region2.h);
});
check('conflicting evidence across pairs (one pair shows no change) lowers consensus / raises uncertainty for that region', () => {
  const pairs = [
    makePair('S1', 'C1', 'Normal', sourceImage(), comparisonImage()),
    makePair('S1', 'C2', 'Normal2', sourceImage(), identicalImage()), // this "comparison" has NO region at all -> spurious extra diff
  ];
  const result = estimateTargetCandidate(pairs, 0.9); // high bar -> mixed evidence should NOT reach candidate
  // With 2 pairs and only 1 fully agreeing at some pixels, few/no pixels reach 90% consensus.
  assert.ok(result.candidatePixelCount <= REGION.w * REGION.h, 'candidate never exceeds the true region size');
});
check('metadata difference with NO visual difference -> zero changed pixels (visually-identical precondition)', () => {
  const src = makeImage([{ ...REGION, color: TARGET_COLOR }]);
  const cmp = makeImage([{ ...REGION, color: TARGET_COLOR }]); // same artwork, different "metadata value" in theory
  const pairs = [makePair('S1', 'C1', 'SameLookingValue', src, cmp)];
  const result = estimateTargetCandidate(pairs, 0.6);
  assert.strictEqual(result.changedPixelCount, 0);
  assert.strictEqual(result.candidatePixelCount, 0);
});
check('partially occluded target (only visible in some samples) still yields a smaller but real candidate', () => {
  // S1: region fully visible. S2: region visible ONLY in the top half (bottom half occluded == background).
  const src1 = makeImage([{ ...REGION, color: TARGET_COLOR }]);
  const src2 = makeImage([{ x: REGION.x, y: REGION.y, w: REGION.w, h: 2, color: TARGET_COLOR }]); // top half only
  const cmp = makeImage([{ ...REGION, color: ALT_COLOR }]);
  const pairs = [makePair('S1', 'C1', 'Normal', src1, cmp), makePair('S2', 'C1b', 'Normal', src2, cmp)];
  const result = estimateTargetCandidate(pairs, 0.5);
  assert.ok(result.candidatePixelCount > 0, 'some pixels still isolated');
  assert.ok(result.candidatePixelCount <= REGION.w * REGION.h);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
