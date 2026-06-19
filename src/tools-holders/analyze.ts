/**
 * Holder Count Tool — pure analysis.
 *
 * Deterministic, network-free: turns a CollectionOwnerScan (owner list + scan
 * metadata) into the HoldersAnalysis response. Separated from the fetch layer
 * so it can be unit-tested against a mocked DAS result with zero network.
 *
 * Holder count = number of DISTINCT `ownership.owner` wallets across every
 * asset in the verified collection group (Helius DAS). This is a RAW on-chain
 * owner count, NOT a beneficial/community-holder count: `ownership.owner` can
 * point at marketplace escrow/custody, a project treasury, or a stale index
 * entry (notably for MPL Core / compressed assets). It is also NOT a
 * marketplace stat — ME/Tensor cached holder counts are never used.
 */
import type { CollectionOwnerScan, HoldersAnalysis, HolderEntry, HolderDistribution, HoldersInputType } from './types';

/** Top-N holders surfaced in the table. */
export const TOP_HOLDERS_LIMIT = 25;

/** Top-holder share above which the count is flagged as suspiciously
 *  concentrated — a single wallet owning this much is usually escrow / a
 *  project treasury rather than a real holder. Percent (0–100). */
export const CONCENTRATION_WARN_PCT = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BuildArgs extends CollectionOwnerScan {
  /** On-chain collection address the scan ran against (resolved for slugs). */
  collectionAddress: string;
  /** How the request arrived + the verbatim value supplied. */
  inputType:  HoldersInputType;
  inputValue: string;
  /** Resolved human-readable collection name (slug/name input), if known. */
  resolvedName?: string;
  /** Extra warnings from upstream (e.g. slug resolution notes). Prepended. */
  extraWarnings?: string[];
  /** Injected so the function stays pure/deterministic for tests. */
  nowIso: string;
}

export function buildHoldersAnalysis(args: BuildArgs): HoldersAnalysis {
  const { collectionAddress, inputType, inputValue, resolvedName, extraWarnings, owners, missingOwnerCount, totalAssets, truncated, dasError, nowIso } = args;

  // owner → asset count
  const byOwner = new Map<string, number>();
  for (const o of owners) byOwner.set(o, (byOwner.get(o) ?? 0) + 1);

  const uniqueHolders = byOwner.size;
  const denom = totalAssets > 0 ? totalAssets : 0;

  // Top holders (desc by count, tie-break by wallet for deterministic output).
  const topHolders: HolderEntry[] = [...byOwner.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_HOLDERS_LIMIT)
    .map(([wallet, count]) => ({
      wallet,
      count,
      percent: denom > 0 ? round2((count / denom) * 100) : 0,
    }));

  // Distribution buckets — count of DISTINCT holders per ownership size.
  const holderDistribution: HolderDistribution = { holders1: 0, holders2to5: 0, holders6to10: 0, holders11plus: 0 };
  for (const count of byOwner.values()) {
    if (count >= 11)     holderDistribution.holders11plus++;
    else if (count >= 6) holderDistribution.holders6to10++;
    else if (count >= 2) holderDistribution.holders2to5++;
    else                 holderDistribution.holders1++;
  }

  const warnings: string[] = [];
  if (extraWarnings) warnings.push(...extraWarnings);
  if (totalAssets === 0) {
    warnings.push('No assets found for this collection address — it may be wrong, or not a verified on-chain collection group.');
  }
  if (missingOwnerCount > 0) {
    warnings.push(`${missingOwnerCount} asset(s) had no ownership.owner and were excluded from the holder count.`);
  }
  if (truncated) {
    warnings.push('Asset scan hit the safety cap — totals are a lower bound (collection larger than the MVP page limit).');
  }
  if (dasError) {
    warnings.push(`DAS error during pagination (${dasError}) — results may be incomplete.`);
  }
  // Suspicious concentration: one wallet owning a large share is usually escrow
  // / custody / a project treasury, not a real holder. Flag it and caveat that
  // the count is a raw on-chain owner count, not a community-holder count.
  const topPct = topHolders[0]?.percent ?? 0;
  if (topPct > CONCENTRATION_WARN_PCT) {
    warnings.push(
      `Top holder controls ${topPct}% of supply — unusually concentrated. ` +
      'DAS ownership.owner may include marketplace escrow/custody wallets for ' +
      'listed or compressed assets. Treat holder count as raw on-chain owner count.',
    );
  }

  return {
    inputType,
    inputValue,
    resolvedCollectionAddress: collectionAddress,
    ...(resolvedName ? { resolvedName } : {}),
    collectionAddress,
    totalAssets,
    uniqueHolders,
    updatedAt: nowIso,
    topHolders,
    holderDistribution,
    warnings,
  };
}
