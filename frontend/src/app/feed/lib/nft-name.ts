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

export function shortenNftName(nftName: string | null | undefined, maxLen = 18): ShortNftName {
  const m = nftName?.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : (nftName ?? '');
  const num = m ? m[2] : '';
  const fullName = (baseName + (num ? ` #${num}` : '')).trim();
  const shortName = fullName.length > maxLen ? fullName.slice(0, maxLen).trim() + '...' : null;
  return { baseName, num, fullName, shortName };
}
