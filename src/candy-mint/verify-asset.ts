/**
 * Candy Mint tool — post-confirmation mint verification (H1).
 *
 * A landed Candy Guard *bot-tax* transaction has `err == null` but mints
 * nothing (the guard CPIs the tax and short-circuits). So a confirmed
 * signature is NOT proof of a mint.
 *
 * ── Why account-null alone is NOT proof of "no mint" ────────────────────────
 * tx-status (getSignatureStatuses, "confirmed") and this check (getAccountInfo,
 * "confirmed") both go to `beta.helius-rpc.com/?api-key=…`, but Helius
 * load-balances that URL across many nodes — the two calls are NOT guaranteed
 * to hit the same node, and each node has its own `confirmed` slot watermark.
 * A brand-new account can legitimately read back as a CLEAN `null` for several
 * seconds after its creating transaction is `confirmed`, on a node whose bank
 * is a few slots behind. So a null — even repeated across a short retry
 * window — proves only "not visible at this RPC during this window", never
 * "the mint did not happen".
 *
 * ── Corrected classification ───────────────────────────────────────────────
 *   found + expected owner
 *     -> minted (the only counter bump)
 *   not found, but the confirmed tx's own logs carry the Candy Guard bot-tax
 *   marker
 *     -> tax_no_mint  (STRONG evidence from the transaction itself, not from
 *        an absent account)
 *   not found, everything else (logs clean / tx not fetchable / RPC error)
 *     -> not_observed  (NEITHER minted NOR bot-tax — the caller keeps the
 *        signature and allows an exact re-check; never bumps the counter)
 */

import { fetchTransaction } from '../mint-analyzer/fetch-tx';

const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Same marker the pre-sign simulator uses (simulate.ts BOT_TAX_RE). The Candy
// Guard bot-tax fallback emits "Botting is taxed …" / "bot tax" in program
// logs. A false negative here is safe (caller stays in `not_observed`); a
// false positive would need an unrelated candy-mint tx to log "bot"/"tax",
// which does not happen.
const BOT_TAX_LOG_RE = /bot(ting)?\s*(is\s*)?tax/i;

export function looksLikeBotTax(logs: readonly string[] | null | undefined): boolean {
  return !!logs && logs.some((l) => BOT_TAX_LOG_RE.test(l));
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export type MintVerdict = 'minted' | 'tax_no_mint' | 'not_observed';

export interface VerifyMintResult {
  verdict: MintVerdict;
  owner: string | null;
  attempts: number;
  /** true iff the confirmed tx was fetched and its logs were inspected. */
  logsInspected: boolean;
}

export type OneRead =
  | { kind: 'found'; owner: string | null }
  | { kind: 'absent' }
  | { kind: 'error' };

async function readOnce(asset: string): Promise<OneRead> {
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'cm-verify', method: 'getAccountInfo',
        params: [asset, { encoding: 'base64', commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { kind: 'error' };
    const body = await res.json() as { result?: { value?: { owner?: string } | null }; error?: unknown };
    if (body.error) return { kind: 'error' };
    if (!body.result || !('value' in body.result)) return { kind: 'error' };
    const v = body.result.value;
    if (v == null) return { kind: 'absent' };
    return { kind: 'found', owner: v.owner ?? null };
  } catch {
    return { kind: 'error' };
  }
}

export function expectedOwnersFor(family: 'core' | 'legacy'): string[] {
  return family === 'core' ? [MPL_CORE_PROGRAM] : [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
}

// ── pure classification ────────────────────────────────────────────────────
// `reads` is the account-read sequence (short-circuits on first `found`).
// `txLogs` is the confirmed transaction's logMessages, or null when it could
// not be fetched. Account-absence NEVER by itself yields `tax_no_mint` — only
// the bot-tax log marker does.
export function classifyMint(
  reads: OneRead[],
  expectedOwners: string[],
  txLogs: readonly string[] | null,
): VerifyMintResult {
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i];
    if (r.kind === 'found') {
      return {
        verdict: expectedOwners.includes(r.owner ?? '') ? 'minted' : 'not_observed',
        owner: r.owner, attempts: i + 1, logsInspected: false,
      };
    }
  }
  // asset not observed across the whole read window
  if (txLogs != null && looksLikeBotTax(txLogs)) {
    return { verdict: 'tax_no_mint', owner: null, attempts: reads.length, logsInspected: true };
  }
  return { verdict: 'not_observed', owner: null, attempts: reads.length, logsInspected: txLogs != null };
}

export async function verifyMintAsset(
  family: 'core' | 'legacy',
  asset: string,
  signature: string,
  opts: {
    maxAttempts?: number;
    delayMs?: number;
    readFn?: (asset: string) => Promise<OneRead>;
    logsFn?: (sig: string) => Promise<readonly string[] | null>;
  } = {},
): Promise<VerifyMintResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const delayMs = opts.delayMs ?? 700;
  const read = opts.readFn ?? readOnce;
  const expectedOwners = expectedOwnersFor(family);

  const reads: OneRead[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    const r = await read(asset);
    reads.push(r);
    if (r.kind === 'found') break;
  }
  if (reads.some((r) => r.kind === 'found')) {
    return classifyMint(reads, expectedOwners, null);
  }

  // Not observed — inspect the confirmed transaction's own logs for the
  // bot-tax marker (STRONG evidence), best-effort.
  let txLogs: readonly string[] | null = null;
  const getLogs = opts.logsFn ?? (async (sig: string) => {
    try {
      const tx = await fetchTransaction(sig);
      return tx?.meta?.logMessages ?? null;
    } catch {
      return null;
    }
  });
  txLogs = await getLogs(signature);

  return classifyMint(reads, expectedOwners, txLogs);
}
