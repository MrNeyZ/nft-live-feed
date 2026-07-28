/**
 * Trait Extraction - deterministic per-category contact sheet builder.
 * Preview-only composition via Sharp (raster cells + SVG text labels) -
 * the full-canvas transparent PNGs remain the reusable assets.
 */
import sharp from 'sharp';
import type { ConfidenceStatus, PixelBoundingBox } from './te-types';

export interface ContactSheetCell {
  traitValue: string;
  occurrenceCount: number;
  confidenceStatus: ConfidenceStatus;
  score: number;
  candidatePng: Buffer | null;
  boundingBox: PixelBoundingBox | null;
}

const CELL_SIZE = 200;
const LABEL_HEIGHT = 36;
const PADDING = 10;
const MAX_COLS = 4;
const BG_COLOR: [number, number, number] = [0x1a, 0x15, 0x30];

function checkerboard(width: number, height: number, cell = 8): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const light = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = light ? 235 : 205;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function labelSvg(cell: ContactSheetCell): Buffer {
  const line1 = escapeXml(`${cell.traitValue} x${cell.occurrenceCount}`).slice(0, 32);
  const line2 = escapeXml(`${cell.confidenceStatus} ${cell.score}`);
  const bboxText = cell.boundingBox ? `${cell.boundingBox.width}x${cell.boundingBox.height}px` : 'no bbox';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_SIZE}" height="${LABEL_HEIGHT}">
    <rect width="100%" height="100%" fill="#1a1530"/>
    <text x="4" y="14" font-size="11" fill="#f0eef8" font-family="monospace">${line1}</text>
    <text x="4" y="27" font-size="9.5" fill="#9a9ab4" font-family="monospace">${line2} · ${bboxText}</text>
  </svg>`;
  return Buffer.from(svg);
}

/** Cells are rendered in the exact order given by the caller - callers are
 *  responsible for deterministic ordering (spec section 14: "use
 *  deterministic value ordering"). */
export async function buildContactSheet(cells: ContactSheetCell[]): Promise<Buffer> {
  if (cells.length === 0) {
    const empty = Buffer.alloc(CELL_SIZE * LABEL_HEIGHT * 4);
    return sharp(empty, { raw: { width: CELL_SIZE, height: LABEL_HEIGHT, channels: 4 } }).png().toBuffer();
  }

  const cols = Math.min(MAX_COLS, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const sheetWidth = cols * (CELL_SIZE + PADDING) + PADDING;
  const sheetHeight = rows * (CELL_SIZE + LABEL_HEIGHT + PADDING) + PADDING;

  const compositeOps: Array<{ input: Buffer; left: number; top: number }> = [];

  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = PADDING + col * (CELL_SIZE + PADDING);
    const y = PADDING + row * (CELL_SIZE + LABEL_HEIGHT + PADDING);

    const bg = checkerboard(CELL_SIZE, CELL_SIZE);
    let cellPipeline = sharp(bg, { raw: { width: CELL_SIZE, height: CELL_SIZE, channels: 4 } });
    if (cell.candidatePng) {
      const resized = await sharp(cell.candidatePng)
        .resize(CELL_SIZE, CELL_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      cellPipeline = cellPipeline.composite([{ input: resized }]);
    }
    const cellBuffer = await cellPipeline.png().toBuffer();
    compositeOps.push({ input: cellBuffer, left: x, top: y });
    compositeOps.push({ input: labelSvg(cell), left: x, top: y + CELL_SIZE });
  }

  const base = Buffer.alloc(sheetWidth * sheetHeight * 4);
  for (let i = 0; i < sheetWidth * sheetHeight; i++) {
    const o = i * 4;
    base[o] = BG_COLOR[0]; base[o + 1] = BG_COLOR[1]; base[o + 2] = BG_COLOR[2]; base[o + 3] = 255;
  }

  return sharp(base, { raw: { width: sheetWidth, height: sheetHeight, channels: 4 } })
    .composite(compositeOps)
    .png()
    .toBuffer();
}
