/**
 * Targeted sale-pipeline diagnostics.
 *
 * Lights up unsampled `[sale-debug]` log lines for a specific allowlist
 * of signatures and/or wallets so the operator can trace a single
 * dump-batch through every stage of ingestion (WS arrival → prefilter
 * pass/skip → fetch start/ok/null → parse ok/skip → insert ok/skip →
 * sse emit) without flipping a global debug flag and without touching
 * non-target traffic.
 *
 * Configure via env (read once at module load — restart to change):
 *
 *   SALE_DEBUG_SIGS="<sig1>,<sig2>,..."
 *     Full Solana signatures (comma-separated). Each is matched
 *     case-insensitively against the WS / poller / parser inputs.
 *
 *   SALE_DEBUG_WALLETS="<wallet1>,<wallet2_prefix>,..."
 *     Wallet pubkeys OR prefixes (≥ 4 chars). When the parsed sale
 *     event has a seller / buyer / signer address that startsWith one
 *     of these entries, the row also enters the trace stream — useful
 *     for tracking a known dumper across many sigs.
 *
 * Usage in code:
 *
 *   if (isSigTarget(sig)) {
 *     saleDebug('ws_arrival', sig, { program: target.name });
 *   }
 *
 *   const accs = tx.transaction.message.accountKeys;
 *   if (txTouchesTargetWallet(accs)) {
 *     // promote this tx into the trace stream so subsequent stages log
 *     promoteSigToTarget(sig);
 *     saleDebug('parse_ok', sig, { saleType, source });
 *   }
 *
 * No allocation in the hot path when no targets are configured: the
 * `enabled` flag short-circuits all checks. When configured, each
 * check is one Set lookup.
 */

const RAW_SIGS    = (process.env.SALE_DEBUG_SIGS    ?? '').trim();
const RAW_WALLETS = (process.env.SALE_DEBUG_WALLETS ?? '').trim();

const sigAllowlist: Set<string> = new Set(
  RAW_SIGS.length > 0
    ? RAW_SIGS.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [],
);
const walletAllowlist: string[] =
  RAW_WALLETS.length > 0
    ? RAW_WALLETS.split(',').map((s) => s.trim()).filter((s) => s.length >= 4)
    : [];

/** Sigs promoted into the trace stream because their parsed tx involved
 *  a target wallet. Bounded so a long-running dump from a target wallet
 *  can't grow this set indefinitely; FIFO eviction at the cap. */
const PROMOTED_MAX = 1_000;
const promotedSigs: Set<string> = new Set();
const promotedQueue: string[] = [];

const enabled = sigAllowlist.size > 0 || walletAllowlist.length > 0;

if (enabled) {
  console.log(
    `[sale-debug] init  sigs=${sigAllowlist.size}  walletPrefixes=${walletAllowlist.length}  ` +
    `(set SALE_DEBUG_SIGS / SALE_DEBUG_WALLETS to retarget; restart required)`,
  );
}

/** True when targeted diagnostics are configured. Hot-path callers
 *  may use this to skip even cheap allocation when no targets exist. */
export function isSaleDebugEnabled(): boolean {
  return enabled;
}

/** Test whether `sig` is in the configured allowlist OR was promoted
 *  into the trace stream by an earlier wallet match. Single Set lookup. */
export function isSigTarget(sig: string | null | undefined): boolean {
  if (!enabled || !sig) return false;
  return sigAllowlist.has(sig) || promotedSigs.has(sig);
}

/** Test whether `wallet` matches any prefix in the configured allowlist.
 *  `wallet` may be null/empty; both return false. Linear scan over the
 *  small wallet-prefix array — typical N is 1-3 entries. */
export function isWalletTarget(wallet: string | null | undefined): boolean {
  if (!enabled || !wallet) return false;
  for (const p of walletAllowlist) {
    if (wallet === p || wallet.startsWith(p)) return true;
  }
  return false;
}

/** Scan an accountKeys array (raw strings or `{pubkey}` objects) for
 *  any wallet in the allowlist. Used when we have a tx in hand but
 *  don't yet know which sig is interesting. */
export function txTouchesTargetWallet(
  accountKeys: ReadonlyArray<string | { pubkey?: string }>,
): boolean {
  if (!enabled || walletAllowlist.length === 0) return false;
  for (const k of accountKeys) {
    const pk = typeof k === 'string' ? k : k?.pubkey;
    if (pk && isWalletTarget(pk)) return true;
  }
  return false;
}

/** Promote a sig into the trace stream — typically called after a tx
 *  parse reveals it touches a target wallet, so subsequent pipeline
 *  stages for the same sig also log. Idempotent. */
export function promoteSigToTarget(sig: string): void {
  if (!enabled || !sig || promotedSigs.has(sig)) return;
  promotedSigs.add(sig);
  promotedQueue.push(sig);
  if (promotedQueue.length > PROMOTED_MAX) {
    const evict = promotedQueue.shift();
    if (evict) promotedSigs.delete(evict);
  }
}

/** Emit a single `[sale-debug]` line with the given stage + sig + an
 *  optional bag of fields. Stage names follow the spec:
 *    ws_arrival, prefilter_pass, prefilter_skip,
 *    fetch_start, fetch_ok, fetch_null,
 *    parse_ok, parse_skip,
 *    insert_ok, insert_skip,
 *    sse_emit,
 *    dedupe_check, mark_fetched,
 *    poll_dispatch, defer_resolve, defer_fallback.
 *  Caller is responsible for the gating check (typically via
 *  `isSigTarget(sig)`); this function does not re-check so promoted
 *  sigs and wallet-matched tx logs both surface. */
export function saleDebug(
  stage: string,
  sig: string,
  fields: Record<string, unknown> = {},
): void {
  const parts: string[] = [`stage=${stage}`, `sig=${sig.slice(0, 16)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    const s = typeof v === 'string'
      ? (v.length > 64 ? v.slice(0, 64) + '…' : v)
      : String(v);
    parts.push(`${k}=${s}`);
  }
  console.log(`[sale-debug] ${parts.join(' ')}`);
}
