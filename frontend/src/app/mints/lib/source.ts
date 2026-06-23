// VictoryLabs — Mints: launchpad source attribution helpers.
// Extracted verbatim from page.tsx. Pairs:
//   sourceBadge(SourceLabel) → display style descriptor
//   sourceHref(MintStatus)   → outbound launchpad deep-link (or null)
// plus the per-launchpad URL builders. The `<SourceBadge>` component
// in `../components/MintsSourceBadge.tsx` is the rendering surface
// on top of these helpers.

import type { MintStatus, SourceLabel } from './types';
import { vvvSlugify } from './format';
import { isSolPubkey } from './palette';
import { VL, VLText, rgb, alpha, ALPHA } from '@/lib/palette';

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
  // Fallback: LMNFT `/explore` search by COLLECTION NAME. The prior
  // deployer-wallet fallback (`/explore?query=<owner>`) is removed — LMNFT
  // changed their architecture and wallet/deployer pages no longer resolve, so
  // we never route LMNFT users to a deployer wallet anymore. We search the
  // Explore index by the collection name (sorted by most-recently deployed,
  // Solana-filtered) so the user lands on the collection's search result.
  // Returns null when no name is on the wire yet → plain (unlinked) chip,
  // never a homepage.
  const name = row.name?.trim();
  if (name) {
    return `https://www.launchmynft.io/explore?` +
      `collections%5Bquery%5D=${encodeURIComponent(name)}` +
      `&collections%5BsortBy%5D=collections%2Fsort%2Fdeployed%3Adesc` +
      `&collections%5BrefinementList%5D%5Btype%5D%5B0%5D=Solana`;
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
    case 'LaunchMyNFT':            return { label: 'LMNFT',    bg: 'rgba(232,193,74,0.15)',  fg: rgb(VL.gold) };
    case 'VVV':                    return { label: 'VVV',      bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' };
    case 'GRAVE':                  return { label: 'GRAVE',    bg: 'rgba(160,160,168,0.15)', fg: '#a0a0a8' };
    case 'ME':                     return { label: 'ME',       bg: 'rgba(232,122,176,0.15)', fg: VLText.muted };
    case 'Metaplex Candy Machine': return { label: 'CANDY',    bg: 'rgba(229,138,163,0.15)', fg: '#e58aa3' };
    // CORE polish: slight saturation + alpha lift on bg (0.15 → 0.20)
    // and a brighter fg (#a890e8 → #a890e8) so the badge reads as a
    // legible launchpad pill rather than disabled. Border via the
    // pill's existing bg-tint frame (no glow added).
    case 'Metaplex Core':          return { label: 'CORE',     bg: alpha(VL.purpleTint, ALPHA.border), fg: rgb(VL.purpleTint) };
    case 'Metaplex':               return { label: 'LEGACY',   bg: alpha(VL.purpleTint, 0.15), fg: rgb(VL.purpleTint) };
    case 'Bubblegum':              return { label: 'cNFT',     bg: alpha(VL.greenGlow, 0.15),  fg: rgb(VL.green) };
    // nfts.gay — Candy Guard mint with a top-level fee transfer to the
    // platform treasury. Distinct fuchsia palette so the row reads
    // separately from generic CANDY without competing visually.
    case 'nfts.gay':               return { label: 'GAY',      bg: 'rgba(232,122,200,0.18)', fg: '#ff7fd0' };
    // PRNT mint-pass — Core Candy mint with an SPL722 vesting leg. Teal
    // palette so the pass reads distinctly from generic CORE / CANDY.
    case 'PRNT':                   return { label: 'PRNT',     bg: 'rgba(74,200,190,0.16)',  fg: '#3fd0c4' };
    default:                       return { label: 'UNKNOWN',  bg: 'rgba(255,255,255,0.05)', fg: VLText.muted };
  }
}
