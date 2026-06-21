// VictoryLabs — Mints: deterministic per-address palettes.
// Extracted verbatim from page.tsx. Same FNV-1a hash, same neutral-
// fallback colour for `colorForWallet` when no minter is on the wire.
// The collection accent palette now sources the approved CATEGORY_LAYER
// (see mock-data.ts) so generated identity colors stay in the 8-hue set.

import { CATEGORY_LAYER } from '@/soloist/mock-data';
import { VLText } from '@/lib/palette';

/** Deterministic accent color per collection. Same address → same
 *  color across reloads, across collection-row + live-feed-card
 *  surfaces. Sourced from the approved CATEGORY_LAYER (single source of
 *  truth) so generated identity accents — left bars, marker dots,
 *  fallback avatar chips — stay within the 8 approved hues. FNV-1a over
 *  the address gives a stable index without per-render allocation. */
export const COLLECTION_PALETTE: readonly string[] = CATEGORY_LAYER;
export function colorForCollection(addr: string | null | undefined): string {
  if (!addr) return COLLECTION_PALETTE[0];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h ^= addr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return COLLECTION_PALETTE[h % COLLECTION_PALETTE.length];
}

// Collection-name text is intentionally NOT collection-tinted: category
// colors are reserved for the identity bar / marker / avatar surfaces,
// never normal text. The Live Mint Feed name line uses the flat neutral
// TEXT_MUTED (#9a9ab4) directly — the prior `colorForCollectionMuted`
// hue-tint helper was retired with that decision.

/** Per-wallet muted-tint palette for the minter line on the Live Mint
 *  Feed. Derived directly from CATEGORY_LAYER — same 7 hues used for
 *  collection border/bar/avatar accents, but S reduced ~25pp and L
 *  raised to ~63–73% so wallet text reads as softer metadata and never
 *  visually competes with a collection's full-saturation accent.
 *  Same FNV-1a hash family as `colorForCollection`. */
export const WALLET_PALETTE: readonly string[] = [
  '#ce8a87',  // muted red     ← #DD6A66 (CAT_RED)    S 64→42%, L 63→67%
  '#d19f7b',  // muted orange  ← #E08A4B (CAT_ORANGE) S 71→48%, L 59→65%
  '#d8c783',  // muted yellow  ← #E6C84F (CAT_YELLOW) S 75→52%, L 61→68%
  '#80c2a4',  // muted green   ← #46C08A (CAT_GREEN)  S 49→35%, L 51→63%
  '#7bb0d1',  // muted blue    ← #4AA6E0 (CAT_BLUE)   S 71→48%, L 58→65%
  '#a898dd',  // muted purple  ← #8C6CF2 (CAT_PURPLE) S 84→50%, L 69→73%
  '#d095b7',  // muted pink    ← #D77AB0 (CAT_PINK)   S 54→38%, L 66→70%
];
export function colorForWallet(addr: string | null | undefined): string {
  // Existing muted-metadata grey is the sentinel when no minter is on
  // the wire — keeps the cell visually neutral until a hash lands.
  if (!addr) return VLText.muted;
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
