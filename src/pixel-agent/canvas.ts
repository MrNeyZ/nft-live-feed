/**
 * Pixel-forge canvas — a grid of palette-index integers, not raw RGB.
 * Index 0 is always transparent; index i (1-based) resolves against the
 * palette hex array supplied by the caller. Keeping the agent's color
 * choices to a fixed small palette (vs. free RGB) avoids color drift
 * across edits and keeps compositing simple later.
 */

import sharp from 'sharp';

export class OutOfBoundsError extends Error {}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  private grid: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height); // 0 = transparent
  }

  private assertInBounds(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new OutOfBoundsError(
        `(${x}, ${y}) is out of bounds for a ${this.width}x${this.height} canvas`,
      );
    }
  }

  get(x: number, y: number): number {
    this.assertInBounds(x, y);
    return this.grid[y * this.width + x];
  }

  setPixel(x: number, y: number, colorIndex: number): void {
    this.assertInBounds(x, y);
    this.grid[y * this.width + x] = colorIndex;
  }

  fillRect(x: number, y: number, w: number, h: number, colorIndex: number): void {
    const x1 = Math.max(0, x);
    const y1 = Math.max(0, y);
    const x2 = Math.min(this.width, x + w);
    const y2 = Math.min(this.height, y + h);
    for (let cy = y1; cy < y2; cy++) {
      for (let cx = x1; cx < x2; cx++) {
        this.grid[cy * this.width + cx] = colorIndex;
      }
    }
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, colorIndex: number): void {
    // Bresenham's line algorithm.
    let cx = x1, cy = y1;
    const dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (cx >= 0 && cy >= 0 && cx < this.width && cy < this.height) {
        this.grid[cy * this.width + cx] = colorIndex;
      }
      if (cx === x2 && cy === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
  }

  floodFill(x: number, y: number, colorIndex: number): void {
    this.assertInBounds(x, y);
    const target = this.get(x, y);
    if (target === colorIndex) return;
    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) continue;
      const idx = cy * this.width + cx;
      if (this.grid[idx] !== target) continue;
      this.grid[idx] = colorIndex;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  clear(colorIndex = 0): void {
    this.grid.fill(colorIndex);
  }

  /** Raw RGBA buffer, one index -> transparent, i (1-based) -> palette[i-1]. */
  toRawRgba(palette: readonly string[]): Buffer {
    const buf = Buffer.alloc(this.width * this.height * 4);
    for (let i = 0; i < this.grid.length; i++) {
      const idx = this.grid[i];
      const o = i * 4;
      if (idx === 0 || idx > palette.length) {
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0;
        continue;
      }
      const [r, g, b] = hexToRgb(palette[idx - 1]);
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
    return buf;
  }

  async toPng(palette: readonly string[], upscale = 1): Promise<Buffer> {
    const raw = this.toRawRgba(palette);
    let img = sharp(raw, { raw: { width: this.width, height: this.height, channels: 4 } });
    if (upscale > 1) {
      img = img.resize(this.width * upscale, this.height * upscale, { kernel: 'nearest' });
    }
    return img.png().toBuffer();
  }

  /** Flat, row-major pixel array — the canonical on-disk representation. */
  toFlatArray(): number[] {
    return Array.from(this.grid);
  }

  /** Cheap copy of the current grid, for before/after no-op-turn detection
   *  (see agent-loop.ts's refineAndEvaluate) — a typed-array copy, not the
   *  boxed-number `toFlatArray()`, since this is only ever compared with
   *  `gridsEqual`, never serialized. */
  snapshotGrid(): Uint8Array {
    return this.grid.slice();
  }

  /** True if two snapshots (from `snapshotGrid`) represent identical pixel
   *  data — used to detect a refine turn whose tool calls produced no
   *  visual change (e.g. a repeat/no-op edit, or all calls errored), so the
   *  caller can skip re-rendering and re-attaching an identical image. */
  static gridsEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  static fromFlatArray(size: number, pixels: readonly number[]): Canvas {
    if (pixels.length !== size * size) {
      throw new Error(`expected ${size * size} pixels for a ${size}x${size} canvas, got ${pixels.length}`);
    }
    const canvas = new Canvas(size, size);
    canvas.grid.set(pixels);
    return canvas;
  }
}
