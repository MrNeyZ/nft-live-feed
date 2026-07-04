// Shared NFT-name shortening — single source of truth for the Live Feed Sales
// cards and the compact /multi Rare strip, so both shorten names identically.
// Splits "<Collection> #<num>" into base + number, caps the visible title at
// `maxLen`, and (when over) returns a sliced "...":
//   "Loud Lords #911"            → baseName "Loud Lords", num "911"
//   "Some Very Long Name #12345" → shortName "Some Very Long Nam..."

export interface ShortNftName {
  baseName: string;
  num: string;
  fullName: string;        // `${baseName} #${num}` trimmed
  shortName: string | null; // sliced+ellipsis when fullName exceeds maxLen, else null
}

// maxLen=18 was overly conservative for the /feed Sales card: it's a fixed
// character cap applied regardless of the actual rendered width, which
// varies a lot across the responsive tiers (mobile ~390px card vs. PC
// ~1560px card). At wider tiers the name row has plenty of room, but the
// hard 18-char cut still fired (e.g. "CoinGames Rising Legends #1895" →
// "CoinGames Rising L..." with visible dead space after it) — the row
// already has real CSS ellipsis (FC_NAME_LINK_STYLE/FC_NAME_SPAN_STYLE:
// overflow:hidden + textOverflow:ellipsis + whiteSpace:nowrap) as the
// actual, viewport-aware truncation backstop, so this JS-level cut only
// needs to guard against pathological input, not do the real truncation.
// Raised to 40 — comfortably covers real collection names while CSS still
// clips anything that doesn't fit a given card's rendered width.
export function shortenNftName(nftName: string | null | undefined, maxLen = 40): ShortNftName {
  const m = nftName?.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : (nftName ?? '');
  const num = m ? m[2] : '';
  const fullName = (baseName + (num ? ` #${num}` : '')).trim();
  const shortName = fullName.length > maxLen ? fullName.slice(0, maxLen).trim() + '...' : null;
  return { baseName, num, fullName, shortName };
}
