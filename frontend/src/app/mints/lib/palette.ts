// VictoryLabs — Mints: deterministic per-address palettes.
// Extracted verbatim from page.tsx. Same FNV-1a hash, same palette
// arrays, same muted-blend math, same neutral-fallback colour for
// `colorForWallet` when no minter is on the wire. No behaviour
// changes — moved purely so the page file stays under the maintenance
// ceiling and per-row sub-components can import what they need.

/** Deterministic accent color per collection. Same address → same
 *  color across reloads, across collection-row + live-feed-card
 *  surfaces. Palette stays in the dark VictoryLabs purple-leaning
 *  family so accents read as "tag", not "alert". FNV-1a over the
 *  address gives a stable index without per-render allocation. */
export const COLLECTION_PALETTE: readonly string[] = [
  '#5fc8dd',  // cyan
  '#7bc88a',  // green
  '#e0c067',  // amber
  '#e2906f',  // orange
  '#dd8cb7',  // pink
  '#7c93e0',  // blue
  '#9c8be0',  // violet
  '#e07683',  // red
  '#6dceb9',  // teal
  '#b8d36b',  // lime
  '#5fa8e6',  // sky blue
  '#73d29a',  // mint
];
export function colorForCollection(addr: string | null | undefined): string {
  if (!addr) return COLLECTION_PALETTE[0];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return COLLECTION_PALETTE[h % COLLECTION_PALETTE.length];
}

/** Subtle collection-tinted gray variant of `COLLECTION_PALETTE` for
 *  the Live Mint Feed's collection-name text. Earlier passes painted
 *  this line in the full collection accent (then softened to 80 %
 *  alpha), but the brighter hues still read as a "second headline"
 *  rather than secondary metadata against the bright-white NFT title.
 *
 *  Each entry is computed once at module load by blending the full
 *  palette colour 25 % with a neutral gray (#9c9cb8) — the same gray
 *  the line used to be hardcoded to. The result is a desaturated
 *  hue-tinted gray (S ≈ 10-15 %, L ≈ 60-65 %): same collections still
 *  visually group together, but the line now reads as "gray text
 *  with a subtle collection tint", not as another active colour.
 *
 *  Stripe / tracker / fallback-avatar surfaces keep using
 *  `COLLECTION_PALETTE` directly — only the text surface gets the
 *  muted variant. Same FNV-1a hash + same index so the muted text
 *  always matches the full-strength stripe on the same card. */
export const COLLECTION_PALETTE_MUTED: readonly string[] = COLLECTION_PALETTE.map((hex) => {
  // Neutral substrate the previous static text colour resolved to.
  const NR = 0x9c, NG = 0x9c, NB = 0xb8;
  // Fraction of the original colour preserved; the rest blends to
  // neutral. 0.25 lands the user-requested ~25 % hue / ~75 % gray.
  const MIX = 0.25;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mr = Math.round(r * MIX + NR * (1 - MIX));
  const mg = Math.round(g * MIX + NG * (1 - MIX));
  const mb = Math.round(b * MIX + NB * (1 - MIX));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + toHex(mr) + toHex(mg) + toHex(mb);
});
export function colorForCollectionMuted(addr: string | null | undefined): string {
  if (!addr) return COLLECTION_PALETTE_MUTED[0];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return COLLECTION_PALETTE_MUTED[h % COLLECTION_PALETTE_MUTED.length];
}

/** Per-wallet muted-tint palette for the minter line on the Live Mint
 *  Feed. Deliberately separate from `COLLECTION_PALETTE` so a wallet
 *  hash never visually pairs with a collection hash by coincidence.
 *  Tuned for *hue distance* over a tighter L/S band: the previous
 *  12-entry version clustered five entries in the cool-grey-blue zone
 *  (slate/steel/dust/periwinkle/mauve) and two near-greys (moss /
 *  graphite-green), so distinct wallets read as the same colour. This
 *  10-entry version walks the wheel in ~36° steps — coral, sand,
 *  amber, olive, mint, teal, cyan, blue, lavender, rose — at uniform
 *  L≈60 / S≈25 % so brightness/saturation stay consistent and the
 *  line still reads as muted tertiary metadata. No red, no green, no
 *  neon, no pure white. Same FNV-1a hash family as
 *  `colorForCollection`. */
export const WALLET_PALETTE: readonly string[] = [
  '#b58885',  // coral
  '#b3957a',  // sand
  '#b3a378',  // amber
  '#9aac80',  // olive
  '#7eb59a',  // mint
  '#7baea8',  // teal
  '#7eaab8',  // cyan
  '#8497b8',  // blue
  '#9a8ab8',  // lavender
  '#b08aa0',  // rose
];
export function colorForWallet(addr: string | null | undefined): string {
  // Existing muted-metadata grey is the sentinel when no minter is on
  // the wire — keeps the cell visually neutral until a hash lands.
  if (!addr) return '#9a9ab4';
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return WALLET_PALETTE[h % WALLET_PALETTE.length];
}

/** Strict Solana pubkey check (base58, 32–44 chars). Used as a final
 *  guard before linking to Solscan so we never emit a URL pointing at
 *  a prefix-tagged groupingKey ('authority:…', 'pool:…') or any other
 *  non-pubkey value the wire might carry. */
export const SOL_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isSolPubkey(s: string | null | undefined): s is string {
  return typeof s === 'string' && SOL_PUBKEY_RE.test(s);
}
