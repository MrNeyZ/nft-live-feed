/**
 * Strict "WS proved this sig is not a sale" verdict for the amm-poller.
 *
 * ⚠️  DO NOT REVERT / DISABLE / LOOSEN WITHOUT ASKING THE USER FIRST. ⚠️
 * History: until 2026-09-15 the WS log prefilters called markSigFetched on a
 * log-name guess, so the poller skipped every WS-shed sig. Commit 584c0a5
 * (merged 2026-09-15) removed that to stop rare lost sales — and the poller
 * started paying getTransaction for every list/bid/pool-edit tx: Helius
 * usage roughly doubled (~150-200k → ~300-400k requests/day). This module
 * restores the saving WITHOUT the correctness hole 584c0a5 closed:
 *   - separate marker, never touches the shared fetch dedup (recentByScope);
 *   - only set when the WS logs are COMPLETE (no "Log truncated"), EVERY
 *     invocation of the target program logged an Anchor `Instruction:` line
 *     as its first log, and EVERY such name is in an explicit known-non-sale
 *     set below. Unknown/new names, non-Anchor invocations, missing logs →
 *     no verdict → the poller fetches as before.
 * If a future change to the poller / listener / prefilters seems to need
 * removing or bypassing this, stop and ask the user whether they really want
 * to (it costs ~5M Helius credits/month).
 *
 * Adding a name to a set: only a name confirmed to be a non-sale instruction
 * of that program (IDL + observed txs). Never add a sale / fill / take-bid.
 */

const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_MAX    = 200_000;

/** Known non-sale Anchor instruction names (lower-cased), per listener target. */
export const KNOWN_NON_SALE: Readonly<Record<string, ReadonlySet<string>>> = {
  tcomp: new Set(['bid', 'cancelbid', 'edit', 'list', 'listcore', 'listlegacy', 'listt22', 'listwns',
    'delist', 'delistcore', 'delistlegacy', 'delistt22', 'delistwns', 'tcompnoop',
    'closeexpiredbid', 'closeexpiredlisting', 'closeexpiredlistingcore', 'closeexpiredlistinglegacy']),
  tamm: new Set(['tammnoop', 'createpool', 'editpool', 'closepool', 'depositsol', 'withdrawsol',
    'depositnft', 'withdrawnft', 'depositnftcore', 'withdrawnftcore']),
  me_v2: new Set(['buyv2', 'cancelbuy', 'cancelbuyv2', 'sell', 'mip1sell', 'coresell',
    'cancelsell', 'mip1cancelsell', 'corecancelsell']),
  mmm: new Set(['updatepool', 'createpool', 'solclosepool', 'soldepositbuy', 'solwithdrawbuy',
    'withdrawsell', 'depositsell', 'soldepositsell', 'solwithdrawsell', 'setsharedescrow',
    'updateallowlists']),
};

const verdicts = new Map<string, number>();   // sig → expiry
export const verdictStats = { marked: 0, used: 0 };
setInterval(() => {
  console.log(`[ws-nonsale] marked=${verdictStats.marked} used=${verdictStats.used} live=${verdicts.size}`);
  verdictStats.marked = verdictStats.used = 0;
}, 5 * 60_000).unref();

/**
 * True only when `logs` prove every invocation of `program` in the tx was a
 * known non-sale instruction for `target`. Any doubt → false.
 */
export function logsProveNonSale(target: string, program: string, logs: unknown): boolean {
  const known = KNOWN_NON_SALE[target];
  if (!known || !Array.isArray(logs) || logs.length === 0) return false;
  const stack: string[] = [];
  let invocations = 0;
  let awaitingFirstLog = false;
  for (const raw of logs as string[]) {
    const line = raw ?? '';
    if (/log truncated/i.test(line)) return false;
    const inv = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (inv) {
      if (awaitingFirstLog) return false;          // target invoked something before naming its ix
      stack.push(inv[1]);
      if (inv[1] === program) { invocations++; awaitingFirstLog = true; }
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      if (awaitingFirstLog) return false;          // target invocation that never logged an ix
      stack.pop();
      continue;
    }
    if (awaitingFirstLog && stack[stack.length - 1] === program) {
      const ix = /^Program log: Instruction: (.+)$/.exec(line);
      if (!ix || !known.has(ix[1].trim().toLowerCase())) return false;
      awaitingFirstLog = false;
    }
  }
  return invocations > 0 && !awaitingFirstLog;
}

export function markWsNonSale(sig: string): void {
  if (verdicts.size >= VERDICT_MAX) {
    const now = Date.now();
    for (const [s, exp] of verdicts) { if (exp < now) verdicts.delete(s); }
    if (verdicts.size >= VERDICT_MAX) verdicts.delete(verdicts.keys().next().value!);
  }
  verdicts.set(sig, Date.now() + VERDICT_TTL_MS);
  verdictStats.marked++;
}

export function wasWsNonSale(sig: string): boolean {
  const exp = verdicts.get(sig);
  if (exp === undefined) return false;
  if (Date.now() > exp) { verdicts.delete(sig); return false; }
  return true;
}
