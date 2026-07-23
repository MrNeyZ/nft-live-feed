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
    case 'Metaplex Core':
    case 'Core Candy Machine':
    case 'Candy Labs': {
      // Magic Eden item-details. Prefer stableMintAddress (a mid-collection
      // mint, aged ~1h / ~15min for brand-new collections) so the user
      // lands on a loaded page. Falls back to lastMintAddress when stable
      // isn't populated yet. Candy Labs mints are still plain MPL Core
      // assets underneath, so the same ME deep link works.
      const addr = row.stableMintAddress ?? row.lastMintAddress;
      if (!isSolPubkey(addr)) return null;
      return `https://magiceden.io/item-details/${addr}`;
    }
    default:
      return null;
  }
}

// Badge scheme (operator spec, 2026-07-20):
//   pink   CORE — real Core Candy Machine / Candy Guard mint only
//   pink   NFT  — real legacy (Token Metadata) Candy Machine mint only
//   pink   CANDY — Candy Labs (`foRGE…`) specifically — named for the
//                 actual project ("Candy Labs"), NOT for Metaplex Candy
//                 Machine; same pink as CORE/NFT above — text is the only
//                 differentiator across all three now
//   green  CORE — bare/direct Core mint, no candy machine, no known wrapper
//   green  NFT  — bare/direct legacy Token Metadata mint, ditto
//   purple CORE — any OTHER unenumerated custom wrapper CPI-ing into
//                 mpl-core Create (the generic-fallback detector) — purple
//                 so it's never confused with a real Candy Guard mint
//                 (pink) or a bare one (green)
const PINK = rgb(VL.pink); // CANDY-family pink — real Candy Machine (+ Candy Labs)
export function sourceBadge(s: SourceLabel, coreLaunchpad?: boolean): { label: string; bg: string; fg: string } {
  // By elimination: 'Core Candy Machine' and 'Candy Labs' both carry their
  // own sourceLabel now, so the only thing left hitting 'Metaplex Core' +
  // coreLaunchpad===true is a genuinely unenumerated custom wrapper (no
  // dedicated tx-shape detector) — the generic Core-launchpad fallback.
  // VL.purpleTint — distinct from the pink (real Candy Machine) / green
  // (bare) badges, so an unidentified wrapper reads as its own thing.
  if (coreLaunchpad && s === 'Metaplex Core') {
    return { label: 'CORE', bg: alpha(VL.purpleTint, ALPHA.tint), fg: rgb(VL.purpleTint) };
  }
  switch (s) {
    // Real Core Candy Machine v3 (Candy Guard) mint — CORE_CANDY_MACHINE_PROGRAM
    // confirmed invoked, not just an inner mpl-core Create some other wrapper
    // drove. Pink — paired with the legacy Candy Machine's pink NFT badge
    // below so "this is a real Candy Machine mint" reads as one colour
    // family regardless of NFT standard; CORE vs NFT text is the only
    // differentiator between the two candy machine flavours.
    case 'Core Candy Machine':     return { label: 'CORE',     bg: alpha(VL.pink, 0.15), fg: PINK };
    // Candy Labs (`foRGE…`) — unrelated program/team despite the name
    // coincidence with Metaplex Candy Machine; CANDY is the more honest name
    // for it since it's the literal project name, whereas real Candy
    // Machine mints are now labelled by NFT standard (CORE/NFT) instead.
    // Same pink as the real Candy Machine badges — CORE/NFT/CANDY are one
    // colour family now, text is the only differentiator between them.
    case 'Candy Labs':             return { label: 'CANDY',    bg: alpha(VL.pink, 0.15), fg: PINK };
    case 'LaunchMyNFT':            return { label: 'LMNFT',    bg: 'rgba(232,193,74,0.15)',  fg: rgb(VL.gold) };
    case 'VVV':                    return { label: 'VVV',      bg: alpha(VL.blue, 0.15),     fg: rgb(VL.blue) };
    case 'GRAVE':                  return { label: 'GRAVE',    bg: alpha(VL.gray, 0.15),     fg: rgb(VL.gray) };
    case 'ME':                     return { label: 'ME',       bg: 'rgba(232,122,176,0.15)', fg: VLText.muted };
    // Real legacy (Token Metadata) Candy Machine mint — pink NFT, pairs
    // with 'Core Candy Machine' → pink CORE above (same family = real
    // Candy Machine mint; text is the only thing distinguishing standard).
    case 'Metaplex Candy Machine': return { label: 'NFT',      bg: alpha(VL.pink, 0.15), fg: PINK };
    // Bare/direct Core mint — no candy machine, no known or unknown
    // wrapper. Muted green (not the brighter cNFT green below) marks it
    // as NOT a Candy Machine mint.
    case 'Metaplex Core':          return { label: 'CORE',     bg: alpha(VL.greenMuted, ALPHA.tint), fg: rgb(VL.greenMuted) };
    // Bare/direct legacy Token Metadata mint (no candy machine involved) —
    // NFT text pairs with bare Core's green NFT-standard-only meaning.
    case 'Metaplex':               return { label: 'NFT',      bg: alpha(VL.greenMuted, ALPHA.tint), fg: rgb(VL.greenMuted) };
    case 'SFT':                    return { label: 'SFT',      bg: alpha(VL.purpleTint, 0.15), fg: rgb(VL.purpleTint) };
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
