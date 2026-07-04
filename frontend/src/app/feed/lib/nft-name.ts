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

export function shortenNftName(nftName: string | null | undefined, maxLen = 18): ShortNftName {
  const m = nftName?.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : (nftName ?? '');
  const num = m ? m[2] : '';
  const fullName = (baseName + (num ? ` #${num}` : '')).trim();
  const shortName = fullName.length > maxLen ? fullName.slice(0, maxLen).trim() + '...' : null;
  return { baseName, num, fullName, shortName };
}
