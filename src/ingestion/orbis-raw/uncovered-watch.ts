/**
 * Observability-only watcher for UNCOVERED Orbis settlements.
 *
 * Our Orbis parser supports only `BuyCoreV2` (Core) and `BuyNft` (legacy). A
 * recent audit found Orbis also lists compressed NFTs (`ListCnft`,
 * `ApproveCnftList`, `ReplaceLeaf`), implying a cNFT-buy settlement path we
 * don't parse; accepted-offer settlement is likewise unmodeled. No real example
 * of either has been captured.
 *
 * IMPORTANT — layering: the listener's Orbis WS prefilter sheds any tx whose
 * logs lack `BuyCoreV2`/`BuyNft` (markSigFetched + return) BEFORE fetchRawTx, so
 * an uncovered settlement (e.g. `BuyCnft`) never reaches `ingestOrbisRaw`. The
 * primary observation point is therefore the PREFILTER (`noteOrbisUncoveredFromLogs`,
 * fed the WS-delivered `value.logs` — zero extra RPC). The ingest-path entry
 * (`noteOrbisUncovered`) is kept as a poller-fallback backstop for sigs the WS
 * missed (stale socket) that the gap-healer fetched fresh.
 *
 * Pure logging: no extra RPC, no parser/DB/SSE/frontend change. Capped at
 * MAX_LOGS total per process across both entry points so it can never spam.
 */
import type { RawSolanaTx } from './types';

const MAX_LOGS = 3;
let logged = 0;

/** Instruction names that look like an uncovered sale/settlement. Excludes the
 *  two covered buys and the offer create/cancel ops (which are not sales). */
function suspectIxNames(ixNames: string[]): string[] {
  return ixNames.filter((n) => {
    const l = n.toLowerCase();
    if (l === 'buycorev2' || l === 'buynft') return false; // covered
    if (l.includes('collectionoffer')) return false;       // Make/Cancel offer — not a sale
    return l.startsWith('buy')          // BuyCnft / any uncovered buy
      || l.includes('accept')           // AcceptOffer / AcceptBid
      || l.includes('fulfill')
      || l.includes('takebid')
      || (l.includes('collect') && !l.includes('collection')); // a real Collect, not CollectionOffer
  });
}

/** Shared core: emit one capped line if `logs` show a settlement-like signal
 *  that is NOT one of the covered buys. */
function emit(sig: string, logs: string[], source: string, reason: string): void {
  if (logged >= MAX_LOGS) return;

  const ixNames = [...new Set(
    logs.filter((l) => typeof l === 'string' && l.includes('Instruction:'))
        .map((l) => l.split('Instruction:').pop()!.trim()),
  )];
  // Covered buys must stay silent even if a "sold for" line is present.
  if (ixNames.some((n) => n === 'BuyCoreV2' || n === 'BuyNft')) return;

  const soldLine = logs.find((l) => typeof l === 'string' && /sold for/i.test(l));
  const suspects = suspectIxNames(ixNames);
  if (!soldLine && suspects.length === 0) return; // nothing settlement-like

  logged++;
  const compactSold = soldLine ? soldLine.replace(/^Program log:\s*/, '').slice(0, 200) : '(none)';
  console.log(
    `[orbis/uncovered-settlement-watch] sig=${sig} source=${source} reason=${reason}` +
    ` hasSoldLog=${!!soldLine} suspectIx=[${suspects.join(',')}]` +
    ` ixNames=[${ixNames.join(',')}] settlementLog="${compactSold}"`,
  );
}

/**
 * PREFILTER entry — inspect the WS-delivered log array directly (no tx object,
 * no RPC). Call from the listener's Orbis prefilter BEFORE the tx is shed, so
 * uncovered settlement candidates are observed even though they never reach
 * ingestOrbisRaw. `logs` is the raw `value.logs` (unknown-typed).
 */
export function noteOrbisUncoveredFromLogs(sig: string, logs: unknown, reason: string): void {
  if (!Array.isArray(logs)) return;
  emit(sig, logs as string[], 'prefilter', reason);
}

/**
 * INGEST backstop entry — called from ingestOrbisRaw's DROP path for sigs the
 * WS missed and the poller fetched fresh. No-op for covered buys (they return
 * on the accept branch upstream).
 */
export function noteOrbisUncovered(tx: RawSolanaTx, parserReason: string): void {
  emit(tx.signature, tx.meta?.logMessages ?? [], 'ingest_drop', parserReason);
}
