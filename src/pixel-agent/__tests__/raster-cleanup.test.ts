/**
 * Pixel Forge — Image-to-Traits Stage 2 (deterministic raster cleanup)
 * offline unit tests. Pure functions only, no network, no Anthropic call,
 * no sharp/file I/O — synthetic RgbaImage buffers only. Run: `npx ts-node
 * src/pixel-agent/__tests__/raster-cleanup.test.ts`.
 */
import assert from 'assert';
import { cleanupRasterImage, RgbaImage } from '../raster-convert';

const SIZE = 10;

function blankImg(): RgbaImage {
  return { width: SIZE, height: SIZE, data: Buffer.alloc(SIZE * SIZE * 4) };
}
function setPx(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const off = (y * img.width + x) * 4;
  img.data[off] = r; img.data[off + 1] = g; img.data[off + 2] = b; img.data[off + 3] = a;
}
function getPx(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const off = (y * img.width + x) * 4;
  return [img.data[off], img.data[off + 1], img.data[off + 2], img.data[off + 3]];
}

/** 6x6 opaque "character" blob (rows/cols 2-7) on an otherwise fully
 *  transparent 10x10 canvas — the shared fixture every case below starts
 *  from and mutates a specific pixel of. */
function characterFixture(): RgbaImage {
  const img = blankImg();
  for (let y = 2; y <= 7; y++) {
    for (let x = 2; x <= 7; x++) setPx(img, x, y, 100, 80, 60, 255); // dark fur
  }
  return img;
}

// ── 1. eye highlight (light pixel INSIDE the opaque blob) is preserved ──
{
  const img = characterFixture();
  setPx(img, 4, 4, 255, 255, 255, 255); // white highlight, surrounded by dark fur
  const stats = cleanupRasterImage(img, { minComponentSize: 2 });
  assert.deepStrictEqual(getPx(img, 4, 4), [255, 255, 255, 255], 'eye highlight must survive unchanged — it is opaque and connected to the main mass');
  assert.deepStrictEqual(getPx(img, 2, 2), [100, 80, 60, 255], 'untouched fur must stay untouched');
  assert.strictEqual(stats.pixelsChanged, 0);
  assert.strictEqual(stats.componentsRemoved, 0);
}

// ── 2. isolated opaque speck OUTSIDE the blob is removed ─────────────────
{
  const img = characterFixture();
  setPx(img, 0, 0, 200, 200, 200, 255); // 1px speck, far from the blob
  const stats = cleanupRasterImage(img, { minComponentSize: 2 });
  assert.strictEqual(getPx(img, 0, 0)[3], 0, 'isolated background speck must become transparent');
  assert.strictEqual(stats.pixelsChanged, 1);
  assert.strictEqual(stats.componentsRemoved, 1);
}

// ── 3. tiny transparent hole INSIDE the blob is filled ───────────────────
{
  const img = characterFixture();
  setPx(img, 5, 5, 0, 0, 0, 0); // 1px hole, surrounded by fur on all 4 sides
  const stats = cleanupRasterImage(img, { minComponentSize: 2 });
  assert.deepStrictEqual(getPx(img, 5, 5), [100, 80, 60, 255], 'hole must be filled with the surrounding fur color');
  assert.strictEqual(stats.pixelsChanged, 1);
  assert.strictEqual(stats.componentsRemoved, 1);
}

// ── 4. transparent region touching the image border is NEVER filled,
//     regardless of size — that's legitimate background, not a hole ─────
{
  const img = blankImg();
  setPx(img, 0, 0, 0, 0, 0, 0); // already transparent; explicit for clarity
  const stats = cleanupRasterImage(img, { minComponentSize: 100 });
  assert.strictEqual(getPx(img, 0, 0)[3], 0, 'border-touching transparent area must never be filled');
  assert.strictEqual(stats.pixelsChanged, 0);
}

// ── 5. preserveSmallDarkDetails: a small DARK background speck survives
//     when the guard is on, and is removed when it's off ────────────────
{
  const imgOn = characterFixture();
  setPx(imgOn, 0, 0, 20, 15, 10, 255); // very dark, isolated speck
  const statsOn = cleanupRasterImage(imgOn, { minComponentSize: 2, preserveSmallDarkDetails: true });
  assert.strictEqual(getPx(imgOn, 0, 0)[3], 255, 'dark speck must be preserved when preserveSmallDarkDetails is on');
  assert.strictEqual(statsOn.componentsRemoved, 0);

  const imgOff = characterFixture();
  setPx(imgOff, 0, 0, 20, 15, 10, 255);
  const statsOff = cleanupRasterImage(imgOff, { minComponentSize: 2, preserveSmallDarkDetails: false });
  assert.strictEqual(getPx(imgOff, 0, 0)[3], 0, 'dark speck must be removed when preserveSmallDarkDetails is off');
  assert.strictEqual(statsOff.componentsRemoved, 1);
}

// ── 6. a component AT OR ABOVE minComponentSize is left alone ───────────
{
  const img = characterFixture();
  // 3-pixel speck (size 3) outside the blob, with minComponentSize=3 — not
  // < minSize, so must survive; a 2-pixel speck would correctly be removed.
  setPx(img, 0, 0, 200, 200, 200, 255);
  setPx(img, 1, 0, 200, 200, 200, 255);
  setPx(img, 2, 0, 200, 200, 200, 255);
  const stats = cleanupRasterImage(img, { minComponentSize: 3 });
  assert.strictEqual(getPx(img, 0, 0)[3], 255, 'a component at/above minComponentSize must not be removed');
  assert.strictEqual(getPx(img, 1, 0)[3], 255);
  assert.strictEqual(getPx(img, 2, 0)[3], 255);
  assert.strictEqual(stats.componentsRemoved, 0);
}

// ── 7. determinism — identical input always produces identical output ──
{
  const a = characterFixture(); setPx(a, 0, 0, 200, 200, 200, 255); setPx(a, 5, 5, 0, 0, 0, 0);
  const b = characterFixture(); setPx(b, 0, 0, 200, 200, 200, 255); setPx(b, 5, 5, 0, 0, 0, 0);
  const statsA = cleanupRasterImage(a, { minComponentSize: 2 });
  const statsB = cleanupRasterImage(b, { minComponentSize: 2 });
  assert.strictEqual(Buffer.compare(a.data, b.data), 0, 'identical input must produce byte-identical output');
  assert.deepStrictEqual(statsA, statsB);
}

// ── 8. no options → safe defaults (minComponentSize 2, preserve dark on) ─
{
  const img = characterFixture();
  setPx(img, 4, 4, 255, 255, 255, 255); // highlight
  setPx(img, 0, 0, 200, 200, 200, 255); // light speck — should be removed by default
  const stats = cleanupRasterImage(img);
  assert.deepStrictEqual(getPx(img, 4, 4), [255, 255, 255, 255]);
  assert.strictEqual(getPx(img, 0, 0)[3], 0);
  assert.ok(stats.componentsRemoved >= 1);
}

console.log('raster-cleanup.test.ts: all assertions passed');
