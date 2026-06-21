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
 *  Feed. Deliberately separate from `COLLECTION_PALETTE` so a wallet
 *  hash never visually pairs with a collection hash by coincidence.
 *  14 entries spaced ~26° apart across the full hue wheel at S≈42–65%,
 *  L≈62–72% — visibly distinct, premium, never neon, never muddy.
 *  Previous 10-entry version clustered at S≈20–26% which made all
 *  entries read as the same grey-green. Same FNV-1a hash family as
 *  `colorForCollection`. */
export const WALLET_PALETTE: readonly string[] = [
  '#d47777',  // muted red       H≈5
  '#d38a68',  // muted orange    H≈19
  '#c9b46a',  // muted gold      H≈47
  '#c5d175',  // muted chartreuse H≈68
  '#9ac879',  // muted lime      H≈95
  '#79c883',  // muted green     H≈128
  '#77c8a5',  // muted mint      H≈154
  '#74c8d8',  // muted cyan      H≈190
  '#6da4e8',  // muted blue      H≈213
  '#8188da',  // muted indigo    H≈235
  '#b88ce5',  // muted purple    H≈270
  '#d586d5',  // muted magenta   H≈300
  '#d889b7',  // muted pink      H≈325
  '#d77f95',  // muted rose      H≈345
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
