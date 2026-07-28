/**
 * Trait Extraction (Stage 5.1) - category visual-impact weight tests.
 * Ground truth comes from SYNTHETIC images with KNOWN footprints (spec
 * section 13): Background changes 100% of the canvas, Shirt a large
 * lower region, Eyes a medium localized region, Eyebrows a small
 * localized region - exactly the contamination pattern the Retardio
 * Cousins pilot exposed.
 *
 * Run: npm run test:collection-analyzer-te-impact
 */
import assert from 'assert';
import { computeDiffMask, cleanPairMask } from '../te-pixel-diff';
import { CategoryImpactModel, weightFromMedianPercent } from '../te-impact';
import { buildCollectionIndex } from '../te-index';
import type { DecodedImage } from '../te-image-io';
import type { NormalizedAsset } from '../../types';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

const W = 100, H = 100;
const BG: [number, number, number, number] = [40, 40, 40, 255];

function makeImage(regions: Array<{ x: number; y: number; w: number; h: number; color: [number, number, number, number] }>): DecodedImage {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const o = i * 4; data[o] = BG[0]; data[o + 1] = BG[1]; data[o + 2] = BG[2]; data[o + 3] = BG[3]; }
  for (const r of regions) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const o = (y * W + x) * 4;
      data[o] = r.color[0]; data[o + 1] = r.color[1]; data[o + 2] = r.color[2]; data[o + 3] = r.color[3];
    }
  }
  return { width: W, height: H, data, bytesDownloaded: 0 };
}

function changedAreaPercentForRegion(region: { x: number; y: number; w: number; h: number } | 'full'): number {
  const colorA: [number, number, number, number] = [200, 30, 30, 255];
  const colorB: [number, number, number, number] = [30, 30, 200, 255];
  const src = region === 'full' ? makeImage([{ x: 0, y: 0, w: W, h: H, color: colorA }]) : makeImage([{ ...region, color: colorA }]);
  const cmp = region === 'full' ? makeImage([{ x: 0, y: 0, w: W, h: H, color: colorB }]) : makeImage([{ ...region, color: colorB }]);
  const raw = computeDiffMask(src, cmp, 24)!;
  const cleaned = cleanPairMask(raw, W, H, 6);
  let count = 0;
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i]) count++;
  return (count / (W * H)) * 100;
}

function asset(mint: string, attrs: Record<string, string>): NormalizedAsset {
  return { mint, name: mint, image: `https://img/${mint}.png`, jsonUri: null, collectionAddress: 'COLL', compressed: false, standard: 'legacy', attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) };
}

console.log('\nweightFromMedianPercent - monotonic curve');
check('higher changed-area% always yields a higher (or equal) weight', () => {
  assert.ok(weightFromMedianPercent(100) > weightFromMedianPercent(40));
  assert.ok(weightFromMedianPercent(40) > weightFromMedianPercent(1));
  assert.ok(weightFromMedianPercent(1) > weightFromMedianPercent(0.1));
});

console.log('\nCategoryImpactModel - learned from synthetic image footprints');
check('Background (full-canvas) receives a MUCH larger impact weight than Eyebrows (small localized region)', () => {
  const backgroundPct = changedAreaPercentForRegion('full');
  const eyebrowsPct = changedAreaPercentForRegion({ x: 10, y: 10, w: 4, h: 4 });
  assert.ok(backgroundPct > 90, `expected background footprint near 100%, got ${backgroundPct}`);
  assert.ok(eyebrowsPct > 0 && eyebrowsPct < 2, `expected a small eyebrows footprint, got ${eyebrowsPct}`);

  const model = new CategoryImpactModel();
  model.recordObservation('Background', backgroundPct);
  model.recordObservation('Eyebrows', eyebrowsPct);
  const index = buildCollectionIndex([asset('A', { Background: 'Blue', Eyebrows: 'Confused' })]);
  const bgEstimate = model.estimate('Background', index);
  const ebEstimate = model.estimate('Eyebrows', index);
  assert.ok(bgEstimate.impactWeight > ebEstimate.impactWeight, `Background weight ${bgEstimate.impactWeight} should exceed Eyebrows weight ${ebEstimate.impactWeight}`);
  assert.strictEqual(bgEstimate.source, 'level0_pixel_evidence');
  assert.strictEqual(bgEstimate.confidence, 'estimated'); // only 1 sample each
});
check('ordering holds across all four synthetic footprint sizes: Background > Shirt > Eyes > Eyebrows', () => {
  const backgroundPct = changedAreaPercentForRegion('full');
  const shirtPct = changedAreaPercentForRegion({ x: 0, y: 60, w: 100, h: 40 });
  const eyesPct = changedAreaPercentForRegion({ x: 20, y: 20, w: 10, h: 10 });
  const eyebrowsPct = changedAreaPercentForRegion({ x: 10, y: 10, w: 4, h: 4 });
  assert.ok(backgroundPct > shirtPct && shirtPct > eyesPct && eyesPct > eyebrowsPct, `expected background>shirt>eyes>eyebrows, got ${backgroundPct},${shirtPct},${eyesPct},${eyebrowsPct}`);

  const model = new CategoryImpactModel();
  model.recordObservation('Background', backgroundPct);
  model.recordObservation('Shirt', shirtPct);
  model.recordObservation('Eyes', eyesPct);
  model.recordObservation('Eyebrows', eyebrowsPct);
  const index = buildCollectionIndex([asset('A', { Background: 'Blue' })]);
  const w = (cat: string) => model.estimate(cat, index).impactWeight;
  assert.ok(w('Background') > w('Shirt'), 'Background > Shirt');
  assert.ok(w('Shirt') > w('Eyes'), 'Shirt > Eyes');
  assert.ok(w('Eyes') > w('Eyebrows'), 'Eyes > Eyebrows');
});
check('median/percentile aggregation is robust to one outlier sample', () => {
  const model = new CategoryImpactModel();
  model.recordObservation('Eyes', 5); model.recordObservation('Eyes', 5.2); model.recordObservation('Eyes', 4.8);
  model.recordObservation('Eyes', 95); // one contaminated/occluded outlier pair
  const index = buildCollectionIndex([asset('A', { Eyes: 'Laser' })]);
  const est = model.estimate('Eyes', index);
  assert.ok(est.medianChangedAreaPercent! < 10, `median should stay near the cluster, got ${est.medianChangedAreaPercent}`);
  assert.strictEqual(est.confidence, 'measured'); // >= 3 samples
});

console.log('\nCategoryImpactModel - fallback when no direct pixel evidence exists');
check('metadata-frequency fallback: near-universal, few-valued category gets an elevated weight', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 100; i++) assets.push(asset(`M${i}`, { Body: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C' }));
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const est = model.estimate('Body', index);
  assert.strictEqual(est.sampleCount, 0);
  assert.strictEqual(est.source, 'metadata_frequency_fallback');
  assert.ok(est.impactWeight > 1.0, `expected an elevated fallback weight, got ${est.impactWeight}`);
});
check('metadata-frequency fallback: many-valued category gets a reduced weight', () => {
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 100; i++) assets.push(asset(`M${i}`, { Accessory: `Item${i % 30}` }));
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const est = model.estimate('Accessory', index);
  assert.ok(est.impactWeight < 1.0, `expected a reduced fallback weight, got ${est.impactWeight}`);
});
check('no evidence and no strong metadata signal -> neutral weight 1.0', () => {
  // Present on only half the assets (not near-universal) with a moderate
  // (not tiny, not huge) number of distinct values - no heuristic fires.
  const assets: NormalizedAsset[] = [];
  for (let i = 0; i < 100; i++) {
    const attrs: Record<string, string> = i < 50 ? { Mid: `V${i % 10}` } : {};
    assets.push(asset(`M${i}`, attrs));
  }
  const index = buildCollectionIndex(assets);
  const model = new CategoryImpactModel();
  const est = model.estimate('Mid', index);
  assert.strictEqual(est.impactWeight, 1.0);
  assert.strictEqual(est.confidence, 'neutral');
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
