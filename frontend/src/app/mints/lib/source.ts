// VictoryLabs — Mints: launchpad source attribution helpers.
// Extracted verbatim from page.tsx. Pairs:
//   sourceBadge(SourceLabel) → display style descriptor
//   sourceHref(MintStatus)   → outbound launchpad deep-link (or null)
// plus the per-launchpad URL builders. The `<SourceBadge>` component
// in `../components/MintsSourceBadge.tsx` is the rendering surface
// on top of these helpers.

import type { MintStatus, SourceLabel } from './types';
import { vvvSlugify } from './format';
import { SOL_PUBKEY_RE, isSolPubkey } from './palette';

// LMNFT URL pattern:
//   https://www.launchmynft.io/collections/{lmntfOwner}/{lmntfCollectionId}
// Both fields must be present and look like a safe path segment for
// the link to render — defends against XSS / open-redirect via wire-
// injected paths even if the backend scraper ever misbehaves.
export const SAFE_URL_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function buildLaunchMyNftUrl(row: MintStatus): string | null {
  const owner = row.lmntfOwner;
  const id    = row.lmntfCollectionId;
  // Direct per-collection mint page — preferred when both fragments
  // resolved (LMNFT featured-set scrape or on-chain state decode).
  if (owner && id && SAFE_URL_SEGMENT_RE.test(owner) && SAFE_URL_SEGMENT_RE.test(id)) {
    return `https://www.launchmynft.io/collections/${owner}/${id}`;
  }
  // Fallback: LMNFT `/explore` Algolia-search by deployer wallet.
  // We deliberately do NOT fall back to `collectionAddress` as the
  // search query — Algolia returns the wrong/empty result for the
  // on-chain collection address (it indexes by deployer + collection
  // name, not by token address). Instead the backend resolves the
  // owner from three sources, in order:
  //   1. LMNFT featured-set scraper (`getLmnftInfoByMint`)
  //   2. on-chain LMNFT state-account decoder (`getLmnftStateForCollection`)
  //   3. DAS collection-asset owner (`getCollectionOwner`)
  // (3) is the safety net — for MPL Core collections it reads
  // `getAsset(collectionAddress).ownership.owner` which IS the
  // deployer wallet. By the time the user clicks the pill `lmntfOwner`
  // is virtually always populated.
  if (owner && SOL_PUBKEY_RE.test(owner)) {
    return `https://www.launchmynft.io/explore?` +
      `query=${encodeURIComponent(owner)}` +
      `&toggle%5BtwitterVerified%5D=false` +
      `&toggle%5BsoldOut%5D=false` +
      `&page=1` +
      `&sortBy=collections%2Fsort%2FlastMintedAt%3Adesc` +
      `&refinementList%5Btype%5D%5B0%5D=Solana`;
  }
  return null;
}

/** Build the per-collection vvv.so URL from the row's collection name.
 *  Returns null when the name is missing or slugifies to empty. */
export function buildVvvCollectionUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = vvvSlugify(name);
  return slug ? `https://www.vvv.so/${slug}` : null;
}

/** Outbound link target for launchpad source badges. Returns null for
 *  sources where we can't safely build a per-collection deep link —
 *  the badge then renders as a plain pill (no anchor). LMNFT requires
 *  per-row owner + collectionId from the wire; VVV uses the collection
 *  name slugified into the vvv.so per-collection URL shape; GRAVE
 *  uses the on-chain collection address (the Core CollectionV1
 *  account) directly. */
export function sourceHref(row: MintStatus): string | null {
  switch (row.sourceLabel) {
    case 'LaunchMyNFT':
      // Build the per-collection mint page when we have the LMNFT
      // owner + collectionId fields. Falls through to null (plain
      // pill, no link) when either is missing — never the homepage,
      // per the targeted-mode spec.
      return buildLaunchMyNftUrl(row);
    case 'VVV':
      // Per-collection vvv.so URL derived from the collection name.
      // Plain pill when no name yet (mirrors the LMNFT "wait for the
      // wire to populate" pattern — no point linking to a homepage).
      return buildVvvCollectionUrl(row.name);
    case 'GRAVE': {
      // gravemint.io per-collection mint page. The launchpad's path
      // shape is `/mint/<collectionAddress>` where collectionAddress
      // is the Core collection (`CollectionV1`) pubkey — NOT the
      // individual asset mint. Skip when we don't have one, or when
      // the grouping key is one of the synthetic prefixed forms
      // (`authority:` / `program:` / `owner:` / `pool:`) the
      // accumulator sometimes emits before a real collection key is
      // resolved — those aren't valid gravemint.io URLs.
      const c = row.collectionAddress;
      if (!c) return null;
      if (/^(authority|program|owner|pool):/.test(c)) return null;
      return `https://gravemint.io/mint/${c}`;
    }
    case 'Metaplex Core': {
      // Magic Eden item-details using the row's `lastMintAddress` — the
      // most-recent accepted on-chain mint for the group. Same URL
      // shape the small ME icon-anchor in the title row already uses,
      // so the CORE source pill and the ME icon resolve to the same
      // destination. Skipped when no real mint address is on the wire
      // yet (e.g. cNFT placeholder rows whose first sample didn't
      // carry a leaf address) — the badge falls back to a plain pill
      // rather than emitting a dead link.
      if (!isSolPubkey(row.lastMintAddress)) return null;
      return `https://magiceden.io/item-details/${row.lastMintAddress}`;
    }
    default:
      return null;
  }
}

export function sourceBadge(s: SourceLabel, coreLaunchpad?: boolean): { label: string; bg: string; fg: string } {
  // Core Candy Machine v3 launchpad mints keep the CORE label + semantics but
  // borrow the CANDY pink palette so launchpad Core reads differently from raw
  // Core ecosystem activity. Colours only — exact CANDY bg/fg.
  if (coreLaunchpad && s === 'Metaplex Core') {
    return { label: 'CORE', bg: 'rgba(229,138,163,0.15)', fg: '#e58aa3' };
  }
  switch (s) {
    case 'LaunchMyNFT':            return { label: 'LMNFT',    bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' };
    case 'VVV':                    return { label: 'VVV',      bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' };
    case 'GRAVE':                  return { label: 'GRAVE',    bg: 'rgba(160,160,168,0.15)', fg: '#a0a0a8' };
    case 'ME':                     return { label: 'ME',       bg: 'rgba(232,122,176,0.15)', fg: '#e87ab0' };
    case 'Metaplex Candy Machine': return { label: 'CANDY',    bg: 'rgba(229,138,163,0.15)', fg: '#e58aa3' };
    case 'Metaplex Core':          return { label: 'CORE',     bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Metaplex':               return { label: 'METAPLEX', bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Bubblegum':              return { label: 'cNFT',     bg: 'rgba(92,224,160,0.15)',  fg: '#5ce0a0' };
    // nfts.gay — Candy Guard mint with a top-level fee transfer to the
    // platform treasury. Distinct fuchsia palette so the row reads
    // separately from generic CANDY without competing visually.
    case 'nfts.gay':               return { label: 'GAY',      bg: 'rgba(232,122,200,0.18)', fg: '#ff7fd0' };
    default:                       return { label: 'UNKNOWN',  bg: 'rgba(255,255,255,0.05)', fg: '#7a7a94' };
  }
}
