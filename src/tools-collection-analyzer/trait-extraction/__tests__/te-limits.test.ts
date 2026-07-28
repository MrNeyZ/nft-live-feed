/**
 * Trait Extraction (Stage 5.2) - safety-limit consistency regression.
 *
 * Root cause: TE_MAX_IMAGE_PIXELS was a fixed 8,000,000 (~2828x2828),
 * LOWER than TE_MAX_IMAGE_WIDTH * TE_MAX_IMAGE_HEIGHT (4096x4096 =
 * 16,777,216). A real collection-agnostic image size (e.g. a common
 * 3000x3000 PNG, confirmed on Cets on Creck) passed both individual
 * width/height checks but was still rejected as "oversized_dimensions"
 * by the pixel-count check - the whole collection was unusable. The
 * pixel cap must never be tighter than what width/height already allow.
 *
 * Run: npm run test:collection-analyzer-te-limits
 */
import assert from 'assert';
import { TE_MAX_IMAGE_HEIGHT, TE_MAX_IMAGE_PIXELS, TE_MAX_IMAGE_WIDTH } from '../te-limits';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

console.log('\nimage size safety-limit consistency');
check('TE_MAX_IMAGE_PIXELS is never tighter than TE_MAX_IMAGE_WIDTH * TE_MAX_IMAGE_HEIGHT', () => {
  assert.ok(
    TE_MAX_IMAGE_PIXELS >= TE_MAX_IMAGE_WIDTH * TE_MAX_IMAGE_HEIGHT,
    `pixel cap ${TE_MAX_IMAGE_PIXELS} is tighter than the width*height bound ${TE_MAX_IMAGE_WIDTH * TE_MAX_IMAGE_HEIGHT} - a valid in-bounds image would be silently rejected`,
  );
});
check('a common 3000x3000 image is within the default pixel cap (Cets on Creck regression)', () => {
  assert.ok(3000 * 3000 <= TE_MAX_IMAGE_PIXELS, `3000x3000=${3000 * 3000} exceeds TE_MAX_IMAGE_PIXELS=${TE_MAX_IMAGE_PIXELS}`);
});
check('the maximum allowed width x height itself never exceeds the pixel cap', () => {
  assert.ok(TE_MAX_IMAGE_WIDTH * TE_MAX_IMAGE_HEIGHT <= TE_MAX_IMAGE_PIXELS);
});

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
