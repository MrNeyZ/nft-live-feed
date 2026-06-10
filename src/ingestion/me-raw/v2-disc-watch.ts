/**
 * Observability-only watcher for the DORMANT MMM discriminator
 * `2a90cb9137290b8a` (mapped as `coreFulfillBuyV2`).
 *
 * Background: a coverage audit found this disc has zero ground-truth coverage —
 * it never appeared in ~2,800 recent MMM txs and the mapping comment marks its
 * IDL name "unconfirmed". Rather than burn RPC on a deep historical scan, this
 * watcher piggybacks on txs ALREADY fetched by normal ingestion and logs the
 * first few live occurrences so a real signature can be hand-added to
 * verify-known.ts later.
 *
 * Strictly side-effect-free w.r.t. parsing: it only reads the parse result and
 * console.logs. No extra getTransaction, no DB/SSE, no behavior change. Capped
 * at MAX_LOGS per process so it can never spam the log.
 */
import type { ParseResult } from './parser';
import { deriveSaleType } from '../../domain/sale-type';

const TARGET_DISC = '2a90cb9137290b8a';
const MAX_LOGS = 3;
let logged = 0;

/**
 * Called from the MMM dispatch in parseRawMeTransaction with the matched
 * instruction name and the parse result. No-ops unless the matched instruction
 * is `coreFulfillBuyV2` (i.e. the target disc fired) and the per-process cap
 * hasn't been hit.
 */
export function noteMmmV2Disc(sig: string, instructionName: string, result: ParseResult): void {
  if (instructionName !== 'coreFulfillBuyV2') return;
  if (logged >= MAX_LOGS) return;
  logged++;

  const head = `[mmm/v2-disc-watch] sig=${sig} disc=${TARGET_DISC} matched=coreFulfillBuyV2`;
  if (result.ok) {
    const e = result.event;
    const saleType = deriveSaleType({
      parser:    e.rawData._parser as string,
      direction: e.rawData._direction as string,
    });
    console.log(
      `${head} confirmed_sale instruction=coreFulfillBuyV2` +
      ` buyer=${e.buyer} seller=${e.seller} mint=${e.mintAddress}` +
      ` price=${e.priceSol} saleType=${saleType} nftType=${e.nftType}`,
    );
  } else {
    console.log(`${head} seen_but_parse_failed reason=${result.reason}`);
  }
}
