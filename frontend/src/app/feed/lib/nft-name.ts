// Shared NFT-name shortening — single source of truth for the Live Feed Sales
// cards and the compact /multi Rare strip, so both shorten names identically.
// Splits "<Collection> #<num>" into base + number, caps the visible title at
// a real rendered-pixel budget, and (when over) returns a sliced "...":
//   "Loud Lords #911"            → baseName "Loud Lords", num "911"
//   "Some Very Long Name #12345" → shortName "Some Very Long Nam..."

export interface ShortNftName {
  baseName: string;
  num: string;
  fullName: string;        // `${baseName} #${num}` trimmed
  shortName: string | null; // sliced+ellipsis when fullName exceeds the budget, else null
}

// DotLand plots (MPL Core collection) — operator request: drop the
// "DotLand Plot " prefix so cards show just "(16, 86)" instead of
// "DotLand Plot (16, 86)". Scoped to this one collection by on-chain
// collection address, not name matching.
const DOTLAND_COLLECTION_ADDRESS = 'FASMrm8q4Z9xSejvpbyZP6uzuory8DCwqRskhuGJV2MX';

export function applyCollectionNameOverride(
  nftName: string | null | undefined,
  collectionAddress: string | null | undefined,
): string | null | undefined {
  if (collectionAddress === DOTLAND_COLLECTION_ADDRESS && nftName) {
    return nftName.replace(/^DotLand Plot\s*/, '');
  }
  return nftName;
}

// ── Real pixel measurement ──────────────────────────────────────────────
//
// Three rounds of hand-picked per-character weights (caps wider, digits
// wider, "1"/"i"/"l" narrower, ...) each fixed one reported name at the
// cost of another — "BR1 Weapon #29090" underweighted, then "Klout
// Genesis Hash..." overshot the ellipsis, then "Degen Degen #1615" vs.
// "Dactyl Flight Sq..." flipped again once digits were rebalanced. A flat
// weight table can't track real glyph metrics for every character
// combination. A cached offscreen <canvas> + `measureText()` against the
// card's ACTUAL font sizes/weights that string precisely, no more tuning.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === 'undefined') { measureCtx = null; return measureCtx; }
  const canvas = document.createElement('canvas');
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

function measurePx(text: string, font: string): number | null {
  const ctx = getMeasureCtx();
  if (!ctx) return null; // SSR / no canvas support — caller falls back
  ctx.font = font;
  return ctx.measureText(text).width;
}

// SSR-only fallback (no `document`, canvas unavailable): a plain char
// count against `maxLen` treated as a character budget. Coarser than the
// real measurement, but only ever used for the very first server-rendered
// paint before the client takes over — never what the user actually sees
// scrolling the live feed.
function fallbackSlice(fullName: string, maxLen: number): string | null {
  return fullName.length > maxLen ? fullName.slice(0, maxLen).trim() + '...' : null;
}

/**
 * @param maxLen  Budget in "chars at fontPx/fontWeight" — kept as the same
 *                numeric knob every call site already tunes (13/17/18…);
 *                converted to a real pixel target by measuring that many
 *                lowercase "e"s in the actual font, so the budget always
 *                means the same thing the font really renders instead of
 *                an assumed average character width.
 * @param fontPx      Card's title font-size in px (default: Live Feed Sales
 *                    card, see FC_NAME_LINK_STYLE in feed-card.tsx).
 * @param fontWeight  Card's title font-weight (default: matches feed-card).
 */
export function shortenNftName(
  nftName: string | null | undefined,
  maxLen = 14,
  fontPx = 15,
  fontWeight = 700,
): ShortNftName {
  const m = nftName?.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : (nftName ?? '');
  const num = m ? m[2] : '';
  const fullName = (baseName + (num ? ` #${num}` : '')).trim();

  const font = `${fontWeight} ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const targetPx = measurePx('e'.repeat(maxLen), font);
  const fullPx = measurePx(fullName, font);

  if (targetPx == null || fullPx == null) {
    return { baseName, num, fullName, shortName: fallbackSlice(fullName, maxLen) };
  }
  if (fullPx <= targetPx) {
    return { baseName, num, fullName, shortName: null };
  }
  const ellipsisPx = measurePx('...', font) ?? 0;
  const budget = targetPx - ellipsisPx;
  let cut = fullName.length;
  // Real per-character measurement, so this lands on the exact glyph
  // where the rendered width would cross the budget — no weight table.
  while (cut > 0 && (measurePx(fullName.slice(0, cut), font) ?? 0) > budget) cut--;
  return { baseName, num, fullName, shortName: fullName.slice(0, cut).trim() + '...' };
}
