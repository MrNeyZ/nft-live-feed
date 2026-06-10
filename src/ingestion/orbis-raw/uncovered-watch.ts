/**
 * Observability-only watcher for UNCOVERED Orbis settlements.
 *
 * Our Orbis parser supports only `BuyCoreV2` (Core) and `BuyNft` (legacy). A
 * recent audit found Orbis also lists compressed NFTs (`ListCnft`,
 * `ApproveCnftList`, `ReplaceLeaf`), which implies a cNFT-buy settlement path
 * we don't yet parse — and accepted-offer settlement is likewise unmodeled. No
 * real example of either has been captured.
 *
 * This watcher piggybacks on Orbis txs ALREADY fetched by normal ingestion and
 * fires only on the DROP path (parser returned !ok), so it can NEVER trigger on
 * a covered BuyCoreV2/BuyNft sale (those return on the accept branch upstream).
 * It logs when a dropped Orbis tx either:
 *   - emits a deterministic "sold for" settlement log our strict parser regex
 *     didn't match (a real sale shape we miss), OR
 *   - invokes a suspicious settlement-like instruction name (BuyCnft / Accept*
 *     / Fulfill* / TakeBid* / Collect* — excluding the covered buys and the
 *     CollectionOffer create/cancel ops).
 *
 * Pure logging: no extra RPC, no parser/DB/SSE/frontend change. Capped at
 * MAX_LOGS per process so it can never spam.
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

/**
 * Called from ingestOrbisRaw on the parser-drop path with the original tx and
 * the parser's reject reason. No-op unless something settlement-like is present
 * and the per-process cap hasn't been hit.
 */
export function noteOrbisUncovered(tx: RawSolanaTx, parserReason: string): void {
  if (logged >= MAX_LOGS) return;

  const logs = tx.meta?.logMessages ?? [];
  const soldLine = logs.find((l) => /sold for/i.test(l));
  const ixNames = [...new Set(
    logs.filter((l) => l.includes('Instruction:')).map((l) => l.split('Instruction:').pop()!.trim()),
  )];
  const suspects = suspectIxNames(ixNames);

  if (!soldLine && suspects.length === 0) return; // nothing settlement-like

  logged++;
  const compactSold = soldLine ? soldLine.replace(/^Program log:\s*/, '').slice(0, 200) : '(none)';
  console.log(
    `[orbis/uncovered-settlement-watch] sig=${tx.signature} reason=${parserReason}` +
    ` hasSoldLog=${!!soldLine} suspectIx=[${suspects.join(',')}]` +
    ` ixNames=[${ixNames.join(',')}] settlementLog="${compactSold}"`,
  );
}
