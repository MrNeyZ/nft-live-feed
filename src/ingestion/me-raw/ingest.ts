/**
 * ME raw ingestion helper.
 *
 * Fetches a raw Solana transaction from the RPC, runs it through the ME raw
 * parser, and inserts the result. Designed to run alongside (not replace) the
 * Helius enhanced parser — ON CONFLICT (signature) DO NOTHING handles dedup.
 *
 * Fast path
 * ─────────
 * When an optional HeliusEnhancedTransaction is supplied (always the case for
 * webhook-triggered ingests), a preliminary SaleEvent is inserted immediately
 * using the enriched fields Helius already computed (buyer, seller, amount,
 * mint).  This emits an SSE card without waiting for the RPC round-trip.
 *
 * Once the raw RPC fetch + parse completes, patchSaleEventRaw() updates the
 * DB row with the corrected raw-parser data (accurate saleType, nftType,
 * marketplace, seller for pNFT escrow cases) and pushes a `rawpatch` SSE
 * event so connected clients update their cards in place.
 */
import { parseRawMeTransaction } from './parser';
import { RawSolanaTx } from './types';
import { insertSaleEvent, patchSaleEventRaw } from '../../db/insert';
import { HeliusEnhancedTransaction } from '../helius/types';
import { SaleEvent, Marketplace, NftType } from '../../models/sale-event';
import { trace } from '../../trace';
import { extractPaymentInfo, extractNftMint, extractNftMintsInvolved, extractPartiesFromTokenFlow } from './price';
import { extractCoreAssetFromInnerIx } from './decoder';
import { ME_V2_PROGRAM, ME_AMM_PROGRAM } from './programs';
import bs58 from 'bs58';
import { Limiter, Priority } from '../concurrency';
import { incTxFetch, incTxNull, startTelemetry } from '../telemetry';
import { saleEventBus } from '../../events/emitter';
import { getMode } from '../../runtime/mode';

// ─── RPC fetch ────────────────────────────────────────────────────────────────

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

// Shared across ALL callers of fetchRawTx (ingestMeRaw + ingestTensorRaw,
// from both listener and poller paths). 4 concurrent with a 75ms inter-call
// gap — avoids HTTP 429 on Helius Developer plan without reintroducing the
// old serial bottleneck. Priority queues give WS notifications the fast lane
// over poller catch-up; low-priority tasks (amm-poller pages-2+) that wait
// longer than STALE_LOW_MS are dropped at admission instead of spending a
// `getTransaction` credit on a sig that no longer matters during a burst.
const STALE_LOW_MS = 20_000;
const rpcLimiter = new Limiter(4, 75, STALE_LOW_MS);

/**
 * `budget` mode disables listing_refresh_hint emission in the DROP-branch
 * below — listings become TTL-driven but the sale path is unchanged.
 * `full` / `sales_only` keep real-time refresh hints. Mode is read via
 * `getMode()` so a runtime switch takes effect on the next call.
 */

startTelemetry(rpcLimiter);

// ─── Pre-fetch signature dedupe ───────────────────────────────────────────────
//
// Prevents repeated getTransaction calls for the same signature that arrives
// via multiple paths (listener × N subscriptions, raw-poller, webhook).
//
// Two layers:
//   inFlight    — signature is currently being fetched (Set)
//   recentSigs  — signature was fetched within the TTL window (Map → expiry ms)
//
// Both checks are synchronous, so the check+mark sequence is atomic under
// Node.js's single-threaded event loop — no race between concurrent callers.

const SIG_TTL_MS   = 3 * 60_000; // 3 minutes
const inFlight     = new Set<string>();
const recentSigs   = new Map<string, number>(); // sig → expiresAt

function sigSeen(sig: string): boolean {
  if (inFlight.has(sig)) return true;
  const exp = recentSigs.get(sig);
  if (exp === undefined) return false;
  if (Date.now() < exp)  return true;
  recentSigs.delete(sig); // expired entry — clean up inline
  return false;
}

// Periodic sweep for any remaining expired entries (runs every 2 minutes).
setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of recentSigs) {
    if (now >= exp) recentSigs.delete(sig);
  }
}, 2 * 60_000).unref();

/**
 * Mark a signature as already processed so listener/poller paths skip the raw
 * fetch. Call this when an accurate fast-path event was inserted (e.g. from the
 * Helius webhook) and the raw RPC fetch is intentionally bypassed.
 * Used by tensor-raw/ingest.ts which shares this dedupe layer.
 */
export function markSigFetched(sig: string): void {
  recentSigs.set(sig, Date.now() + SIG_TTL_MS);
}

// ─── Retry parameters ─────────────────────────────────────────────────────────

// Timeout retries only — 429s are never retried (they release the slot immediately).
// Primary path (bestEffort=false): up to 2 retries, delays 500ms → 1000ms.
// Rawpatch path (bestEffort=true): up to 1 retry, delay 500ms.
const PRIMARY_RETRY_ATTEMPTS  = 2;
const RAWPATCH_RETRY_ATTEMPTS = 1;
const RETRY_BASE_MS            = 500;  // delay for attempt N = RETRY_BASE_MS * 2^(N-1)
const FETCH_TIMEOUT_MS         = 8_000; // abort each attempt after 8s

function isRateLimit(status: number, errMsg?: string): boolean {
  if (status === 429) return true;
  if (errMsg && /rate.limit|too many request/i.test(errMsg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 429 circuit-breaker ──────────────────────────────────────────────────────
//
// Raw-patch fetches are best-effort: the fast-path SSE card already fired, so
// skipping a raw-parse correction during a rate-limit window costs nothing
// visible to users.
//
// After COOLDOWN_THRESH consecutive fully-exhausted 429 failures, all raw
// fetches are suspended for COOLDOWN_MS. This breaks the spiral:
//   retries → 429s → retries → 429s → ...
// and lets Helius recover before we try again.
//
// One log line is emitted per cooldown entry; the repeated per-sig warn is
// suppressed while the cooldown is active.

const COOLDOWN_MS    = 30_000;  // 30 seconds
const COOLDOWN_THRESH = 2;      // consecutive 429 failures before cooldown (low = fast response)

let consecutive429s = 0;
let cooldownUntil   = 0;        // epoch ms; 0 = inactive
let cooldownLogged  = false;    // suppress duplicate log lines per cooldown window

function onRateLimitExhausted(): void {
  consecutive429s++;
  if (consecutive429s >= COOLDOWN_THRESH) {
    cooldownUntil   = Date.now() + COOLDOWN_MS;
    consecutive429s = 0;
    if (!cooldownLogged) {
      console.warn(`[rawpatch] paused due to rate limit — resuming in ${COOLDOWN_MS / 1000}s`);
      cooldownLogged = true;
    }
  }
}

function onFetchSuccess(): void {
  consecutive429s = 0;
  // Re-arm the log once cooldown has fully expired so the next episode logs again.
  if (cooldownLogged && Date.now() >= cooldownUntil) cooldownLogged = false;
}

/**
 * Fetch a raw transaction from the RPC.
 *
 * bestEffort = true  → rawpatch path: a sale card was already emitted; this
 *                       fetch only corrects metadata. Skipped during 429 cooldown.
 * bestEffort = false → primary path: no sale emitted yet; this fetch IS the
 *                       ingestion. Never skipped due to cooldown.
 */
export async function fetchRawTx(
  sig: string,
  bestEffort = false,
  priority: Priority = 'medium',
): Promise<RawSolanaTx | null> {
  // Circuit-breaker applies only to best-effort (rawpatch) callers.
  // Primary callers must never be silenced by a rawpatch-triggered cooldown.
  if (bestEffort && Date.now() < cooldownUntil) return null;

  // Dedup guards run before the limiter — duplicate calls are rejected without
  // consuming an rpcLimiter slot or making any network request.
  if (sigSeen(sig)) return null;
  inFlight.add(sig);

  try {
    // rpcLimiter.run resolves to `null` when a low-priority task is stale-dropped
    // at admission — the same contract as dedup hits, so callers handle it with
    // their existing `if (!tx) return` guard.
    const tx = await rpcLimiter.run(async () => {
      // Re-check after waiting in queue: cooldown may have activated while this
      // sig was queued. Only bail for best-effort callers.
      if (bestEffort && Date.now() < cooldownUntil) return null;
      const maxRetries = bestEffort ? RAWPATCH_RETRY_ATTEMPTS : PRIMARY_RETRY_ATTEMPTS;
      return _fetchRawTxRpc(sig, maxRetries);
    }, priority);
    // Only record a TTL dedup entry when the RPC actually returned a tx.
    // Transient failures (429, timeout, non-JSON, null result, stale-drop)
    // must stay retryable by subsequent poller / listener passes.
    if (tx) recentSigs.set(sig, Date.now() + SIG_TTL_MS);
    return tx;
  } finally {
    inFlight.delete(sig);
  }
}

async function _fetchRawTxRpc(sig: string, maxRetries: number): Promise<RawSolanaTx | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [sig, {
      encoding: 'json',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }],
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Per-attempt timeout — prevents hanging indefinitely on slow RPC nodes.
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        incTxFetch();
        res = await fetch(rpcUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timerId);
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          if (attempt < maxRetries) {
            const delay = RETRY_BASE_MS * (2 ** attempt);
            console.warn(`[fetchRawTx] timeout (${FETCH_TIMEOUT_MS}ms), retrying in ${delay}ms  sig=${sig.slice(0, 12)}...`);
            await sleep(delay);
            continue;
          }
          throw new Error(`RPC timeout after ${maxRetries + 1} attempts`);
        }
        throw fetchErr;
      }
      clearTimeout(timerId);

      // Guard against HTML error pages (Cloudflare, proxy errors, etc.)
      // that would throw a SyntaxError on res.json().
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        const preview = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
        console.warn(`[fetchRawTx] non-JSON response  status=${res.status}  body="${preview}"  sig=${sig.slice(0, 12)}...`);
        return null;
      }

      // HTTP-level rate limit — no retry, release slot immediately, circuit-breaker decides cooldown.
      if (isRateLimit(res.status)) {
        console.warn(`[fetchRawTx] rate limited  sig=${sig.slice(0, 12)}...`);
        onRateLimitExhausted();
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await res.json() as { result?: any; error?: { code?: number; message: string } };

      // RPC-level rate limit — same: no retry, release immediately.
      if (json.error && isRateLimit(0, json.error.message)) {
        console.warn(`[fetchRawTx] rate limited  sig=${sig.slice(0, 12)}...`);
        onRateLimitExhausted();
        return null;
      }

      if (json.error) throw new Error(`RPC: ${json.error.message}`);
      if (!json.result) { incTxNull(); return null; }

      onFetchSuccess();
      const tx = json.result;

      // Versioned (v0) transactions load extra accounts from address lookup tables.
      // With raw 'json' encoding they arrive in meta.loadedAddresses, NOT in
      // transaction.message.accountKeys. Merge them so all programIdIndex and
      // accounts[] lookups in the decoder resolve correctly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loaded = (tx.meta as any)?.loadedAddresses ?? {};
      const loadedWritable: string[] = loaded.writable ?? [];
      const loadedReadonly: string[] = loaded.readonly  ?? [];

      tx.transaction.message.accountKeys = [
        ...staticKeys.map((k: string | { pubkey: string }) =>
          typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : k
        ),
        ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true  })),
        ...loadedReadonly.map( (pk: string) => ({ pubkey: pk, signer: false, writable: false })),
      ];

      tx.signature = sig;
      return tx as RawSolanaTx;
    }

  // Exhausted retries without returning — should not be reached
  throw new Error(`fetchRawTx: exhausted ${maxRetries} retries for sig=${sig.slice(0, 12)}...`);
}

// ─── Instruction scanner (debug) ─────────────────────────────────────────────
//
// For every ME-program instruction in a raw tx, extract the 8-byte discriminator
// as hex. Used to log what instructions were seen when parsing fails, so we can
// identify gaps in ME_V2_SALE_INSTRUCTIONS / MMM_SALE_INSTRUCTIONS.

const ME_PROGRAM_LABELS: Record<string, string> = {
  [ME_V2_PROGRAM]:  'me_v2',
  [ME_AMM_PROGRAM]: 'mmm',
};

interface IxScan { program: string; disc: string; }

function scanMeInstructions(tx: RawSolanaTx): IxScan[] {
  const keys = tx.transaction.message.accountKeys;
  const allIxs = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const out: IxScan[] = [];
  for (const ix of allIxs) {
    const prog = keys[ix.programIdIndex]?.pubkey ?? '';
    const label = ME_PROGRAM_LABELS[prog];
    if (!label) continue;
    let disc = 'short';
    try {
      const buf = Buffer.from(bs58.decode(ix.data));
      if (buf.length >= 8) disc = buf.subarray(0, 8).toString('hex');
    } catch { /* skip */ }
    out.push({ program: label, disc });
  }
  return out;
}

// Minimum price for an unknown-candidate event: 0.05 SOL.
// Below this, the transaction is almost certainly not a sale (dust, spam, tests).
const CANDIDATE_MIN_LAMPORTS = 50_000_000n;

// ─── Fast-path event builder ──────────────────────────────────────────────────
//
// Builds a SaleEvent from the Helius enhanced webhook body without an RPC fetch.
// Two tiers:
//   1. events.nft present (Helius-classified txs)   → use structured fields directly
//   2. events.nft absent  (type=UNKNOWN txs)         → extract from tokenTransfers / nativeTransfers
// Raw parse patches saleType, nftType, marketplace, seller, and price afterwards.

/** Minimal typed shapes for the untyped Helius transfer arrays. */
interface HTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
  tokenStandard?: string;
}
interface HNativeTransfer {
  amount?: number;
}

/**
 * Fallback: build a fast event from raw transfer arrays when events.nft is absent.
 * Works for type=UNKNOWN ME/Tensor transactions that still carry tokenTransfers
 * (NFT movement) and nativeTransfers (SOL payment).
 */
function tryBuildFastFromTransfers(
  tx: HeliusEnhancedTransaction,
  parser: string,
  defaultMarketplace: Marketplace,
): SaleEvent | null {
  if (!tx.timestamp) return null;

  const tokenTransfers = tx.tokenTransfers as HTokenTransfer[] | undefined;
  const nativeTransfers = tx.nativeTransfers as HNativeTransfer[] | undefined;
  if (!tokenTransfers?.length || !nativeTransfers?.length) return null;

  // NFT transfers: tokenAmount === 1
  const nftTxs = tokenTransfers.filter((t) => t.tokenAmount === 1 && t.mint);
  if (!nftTxs.length) return null;
  const mint = nftTxs[0].mint!;

  // For pNFT double-hop (escrow → destination) the NFT moves twice for the same mint.
  // Buyer = final recipient of the last hop; seller = sender of the first hop.
  const sameMint = nftTxs.filter((t) => t.mint === mint);
  const buyer  = sameMint[sameMint.length - 1].toUserAccount;
  const seller = sameMint[0].fromUserAccount;
  if (!buyer || !seller || buyer === seller) return null;

  // Price = largest single SOL transfer in the transaction (the payment leg).
  const priceLamports = BigInt(
    Math.max(...nativeTransfers.map((t) => t.amount ?? 0)),
  );
  if (priceLamports <= 0n) return null;

  // nftType from tokenStandard (best-effort; raw parse will correct)
  const std = (nftTxs[0].tokenStandard ?? '').toLowerCase();
  const nftType: NftType =
    std.includes('programmable') ? 'pnft' :
    std === 'compressed'         ? 'cnft' :
    'legacy';

  return {
    signature:         tx.signature,
    blockTime:         new Date(tx.timestamp * 1000),
    marketplace:       defaultMarketplace,
    nftType,
    mintAddress:       mint,
    collectionAddress: null,
    seller,
    buyer,
    priceLamports,
    priceSol:          Number(priceLamports) / 1e9,
    currency:          'SOL',
    rawData: { _parser: parser, events: { nft: { saleType: '' } } },
    nftName:           null,
    imageUrl:          null,
    collectionName:    null,
    magicEdenUrl:      null,
  };
}

function tryBuildFastEvent(tx: HeliusEnhancedTransaction): SaleEvent | null {
  // Tier 1: use events.nft when Helius enhanced-parses the transaction
  const nft = tx.events?.nft;
  if (nft?.buyer && nft?.seller && nft?.amount && nft?.nfts?.[0]?.mint && nft?.timestamp) {
    const priceLamports = BigInt(nft.amount);
    if (priceLamports > 0n) {
      const st = (nft.saleType ?? '').toUpperCase();
      return {
        signature:         tx.signature,
        blockTime:         new Date(nft.timestamp * 1000),
        marketplace:       st.includes('AMM') ? 'magic_eden_amm' : 'magic_eden',
        nftType:           'legacy',
        mintAddress:       nft.nfts[0].mint,
        collectionAddress: null,
        seller:            nft.seller,
        buyer:             nft.buyer,
        priceLamports,
        priceSol:          Number(priceLamports) / 1e9,
        currency:          'SOL',
        rawData: { _parser: 'me_helius_fast', events: { nft: { saleType: nft.saleType ?? '' } } },
        nftName:           null,
        imageUrl:          null,
        collectionName:    null,
        magicEdenUrl:      null,
      };
    }
  }
  // Tier 2: type=UNKNOWN — extract from transfer arrays
  return tryBuildFastFromTransfers(tx, 'me_xfer_fast', 'magic_eden');
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

/**
 * Fetch + parse + insert one ME transaction via the raw parser.
 * When heliusTx is supplied the fast path fires immediately — a preliminary
 * event is emitted via SSE using Helius-enhanced data before the RPC round-trip.
 *
 * Raw RPC fetch is SKIPPED for events.nft-based fast paths: Helius-enhanced
 * data is already accurate enough (correct buyer/seller/price), and triggering
 * an RPC fetch for every such event was saturating the pg Pool queue.
 * Raw fetch runs only for transfer-based fast paths (me_xfer_fast), where
 * buyer/seller/price are approximate and need correction.
 *
 * Never throws — all errors are logged and swallowed so callers can fire-and-forget.
 */
export async function ingestMeRaw(
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
  await _ingestMeRaw(sig, heliusTx, priority);
}

async function _ingestMeRaw(
  sig: string,
  heliusTx?: HeliusEnhancedTransaction,
  priority: Priority = 'medium',
): Promise<void> {
  // ── Fast path ───────────────────────────────────────────────────────────────
  let fastPathInserted = false;
  let fastParser: string | undefined;

  if (heliusTx) {
    const fast = tryBuildFastEvent(heliusTx);
    if (fast) {
      fastParser = fast.rawData._parser as string;
      try {
        const id = await insertSaleEvent(fast);
        fastPathInserted = id !== null;
      } catch (err) {
        console.log(`DEDUPE_DEBUG_SKIP ${fast.signature} insert_condition_failed(fast_path): ${(err as Error)?.message ?? 'unknown'}`);
        // Fast path failure is non-fatal — raw path will insert normally.
      }
    }
  }

  // ── Skip raw RPC fetch when not needed ─────────────────────────────────────
  //
  // me_helius_fast  → built from events.nft (Helius-enhanced, accurate).
  //                   Raw parse would only marginally improve nftType/saleType.
  //                   Skipping eliminates the dominant source of pool-queue growth.
  //
  // me_xfer_fast    → built from nativeTransfers/tokenTransfers (approximate).
  //                   buyer/seller/price may be wrong; raw parse is essential.
  //
  // no fast path    → nothing inserted yet; raw path must insert.
  const needsRawFetch = fastParser === 'me_xfer_fast' || (!fastParser && !fastPathInserted);
  if (!needsRawFetch) {
    if (fastPathInserted) {
      // Accurate fast path inserted the event — mark so listener/poller won't
      // redundantly raw-fetch this sig from a different ingestion path.
      recentSigs.set(sig, Date.now() + SIG_TTL_MS);
    }
    return;
  }

  // ── Slow path: RPC fetch + raw parse ───────────────────────────────────────
  let tx: RawSolanaTx | null;
  try {
    // bestEffort=true only when fast-path already emitted a sale card —
    // in that case the raw fetch is an optional correction, skippable under cooldown.
    tx = await fetchRawTx(sig, fastPathInserted, priority);
  } catch (err) {
    console.error(`[me_raw] fetch error  sig=${sig.slice(0, 12)}...`, err);
    return;
  }

  if (!tx) return;  // deduped or not found — already processed elsewhere

  // ── Per-tx debug: log every ME instruction discriminator seen ───────────────
  const ixScan = scanMeInstructions(tx);
  const discStr = ixScan.map((s) => `${s.program}:${s.disc}`).join(' ');
  const programsStr = [...new Set(ixScan.map((s) => s.program))].join(',') || 'none';

  const result = parseRawMeTransaction(tx);

  if (!result.ok) {
    // Log EVERY failed parse — primary signal for diagnosing missing sales.
    console.log(
      `[me_raw] DROP  sig=${sig.slice(0, 12)}` +
      `  programs=${programsStr}` +
      `  reason="${result.reason}"` +
      (ixScan.length ? `  discs=[${discStr}]` : ''),
    );

    // Non-sale ME/MMM tx: could be list / cancel / pool deposit / pool
    // withdraw / repricing. Signal the listings store so any cached slug
    // touching one of these mints is scheduled for reconciliation.
    const touchedMints = extractNftMintsInvolved(tx);
    if (touchedMints.length > 0) saleEventBus.emitTxMintsTouched({ mints: touchedMints });

    // ── Precise live deltas: classify the ME v2 / MMM outer ix ────────────────
    // Verified anchor discriminators — observed live and matched against
    // anchorDisc(name):
    //   ME v2  sell / mip1_sell / core_sell → user listed an NFT  → immediate refresh
    //   MMM    update_pool                   → pool reprice        → immediate refresh
    // ME v2 cancel_sell variants are NOT included yet — not observed live and
    // not independently verified; falls through to the tx_mints_touched
    // dirty+debounce path (still correct, just 10 s slower).
    const ME_V2_LIST_DISCS = new Set<string>([
      '33e685a4017f83ad', // sell
      '3a32ac6fa697165e', // mip1_sell
      '1ff3f73b8653a5da', // core_sell
    ]);
    const MMM_REPRICE_DISCS = new Set<string>([
      'efd6aa4e24231e22', // update_pool       (pool reprice)
      '2f2a9ce4f9a3feb9', // withdraw_sell     (pool-owner pulls NFT from pool → pool listings change)
      'e992d18ecf6840bc', // create_pool       (new pool seeds new listings)
      // Added via MMM audit (2026-04-23): these were already fetched as DROPs
      // but did not trigger a refresh, leaving the listings/bids panels stale
      // until the 30 s TTL cycle caught up. Including them here converts the
      // existing getTransaction spend into useful real-time refresh hints.
      'f87de814754eeaea', // sol_close_pool    (pool closes → its listings disappear)
      '42e50b366da455ee', // sol_deposit_buy   (buy-side SOL added → pool bid capacity up)
      '9a2950e8ae30f623', // sol_withdraw_buy  (buy-side SOL pulled → pool bid capacity down)
    ]);
    const hasMeV2List   = ixScan.some(s => s.program === 'me_v2' && ME_V2_LIST_DISCS.has(s.disc));
    const hasMmmReprice = ixScan.some(s => s.program === 'mmm'   && MMM_REPRICE_DISCS.has(s.disc));
    if (hasMeV2List || hasMmmReprice) {
      // For MMM update_pool the tx has no token-balance delta → touchedMints
      // is empty. Pass all tx account keys so the store can resolve a slug
      // via its poolKey→slug index. For ME v2 list the mint path (emitted
      // for each touched mint) is the primary resolution — poolKeys is
      // harmless there (won't match any MMM pool entry).
      const poolKeys = hasMmmReprice
        ? tx.transaction.message.accountKeys
            .map(k => typeof k === 'string' ? k : k?.pubkey)
            .filter((k): k is string => !!k)
        : undefined;
      if (getMode() !== 'budget') {
        if (touchedMints.length > 0) {
          for (const m of touchedMints) saleEventBus.emitListingRefreshHint({ mint: m, poolKeys });
        } else if (poolKeys && poolKeys.length > 0) {
          // Reprice with no mint — a single hint carrying just the account keys.
          saleEventBus.emitListingRefreshHint({ poolKeys });
        }
      }
      console.log(
        `[me_raw] ${hasMeV2List ? 'LIST' : 'REPRICE'}  sig=${sig.slice(0, 12)}` +
        `  mints=${touchedMints.length}  poolKeys=${poolKeys?.length ?? 0}`,
      );
    }

    // ── Unknown-candidate path ──────────────────────────────────────────────
    // When the reason is a missing instruction match (not a structural failure
    // like missing blockTime or on-chain error), attempt a best-effort generic
    // extraction. If we can resolve price + mint + parties, insert the event
    // so it shows up in the feed rather than being silently dropped.
    // Disabled for fast-path-inserted cases (the SSE card already exists).
    if (!fastPathInserted && result.reason.includes('no recognised')) {
      const payment = extractPaymentInfo(tx);
      // Mint fallback chain: SPL token movement → MPL Core inner CPI.
      // Covers Core NFTs whose asset id doesn't appear in preTokenBalances.
      const splMint  = extractNftMint(tx);
      const coreMint = splMint ? null : extractCoreAssetFromInnerIx(tx);
      const mint     = splMint ?? coreMint;
      if (!payment || payment.priceLamports < CANDIDATE_MIN_LAMPORTS) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_price(candidate:${payment?.priceLamports ?? 'none'})`);
      } else if (!mint) {
        console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} empty_mint(candidate)`);
      }
      if (payment && payment.priceLamports >= CANDIDATE_MIN_LAMPORTS && mint) {
        const { seller: tkSeller, buyer: tkBuyer } = extractPartiesFromTokenFlow(tx, mint);
        const seller = payment.seller ?? tkSeller;
        const buyer  = tkBuyer ?? payment.buyer;
        if (!(seller && buyer && seller !== buyer)) {
          console.log(`DEDUPE_DEBUG_SKIP ${tx.signature} missing_seller(candidate:seller=${seller ?? 'none'} buyer=${buyer ?? 'none'})`);
        }
        if (seller && buyer && seller !== buyer) {
          console.log(
            `[me_raw] CAND  sig=${sig.slice(0, 12)}` +
            `  discs=[${discStr}]` +
            `  src=${splMint ? 'spl' : 'core'}` +
            `  price=${(Number(payment.priceLamports) / 1e9).toFixed(4)} SOL` +
            `  mint=${mint.slice(0, 8)}...`,
          );
          const event: SaleEvent = {
            signature:         tx.signature,
            blockTime:         new Date(tx.blockTime! * 1000),
            marketplace:       'magic_eden',
            nftType:           coreMint ? 'metaplex_core' : 'legacy',
            mintAddress:       mint,
            collectionAddress: null,
            seller,
            buyer,
            priceLamports:     payment.priceLamports,
            priceSol:          Number(payment.priceLamports) / 1e9,
            currency:          'SOL',
            rawData: {
              _parser:   'unknown_sale_candidate',
              _program:  programsStr,
              _discs:    discStr,
              _mintFrom: splMint ? 'spl_token_balance' : 'mpl_core_inner_cpi',
              saleType:  'unknown',
            },
            nftName:           null,
            imageUrl:          null,
            collectionName:    null,
            magicEdenUrl:      null,
          };
          try {
            const id = await insertSaleEvent(event);
            if (id) console.log(`[me_raw] CAND_INSERTED  sig=${sig.slice(0, 12)}`);
          } catch (err) {
            console.log(`DEDUPE_DEBUG_SKIP ${event.signature} insert_condition_failed(candidate): ${(err as Error)?.message ?? 'unknown'}`);
            console.error(`[me_raw] CAND insert error  sig=${sig.slice(0, 12)}`, err);
          }
        }
      }
    }
    return;
  }

  // Step 4 — raw parser recognised this as a sale.
  trace(sig, 'parse:ok', `parser=me_v2_raw  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`);

  console.log(
    `[me_raw] OK    sig=${sig.slice(0, 12)}` +
    `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}` +
    `  ${result.event.marketplace}/${result.event.nftType}` +
    `  ${result.event.priceSol.toFixed(4)} SOL` +
    `  mint=${result.event.mintAddress.slice(0, 8)}...`,
  );

  console.log(`INSERT_DEBUG_PARSED ${result.event.signature} me_v2_raw ${result.event.marketplace} ${result.event.mintAddress}`);

  try {
    const id = await insertSaleEvent(result.event);
    if (id) {
      console.log(
        `[me_raw] sale  ${result.event.marketplace}/${result.event.nftType}` +
        `  ${result.event.priceSol.toFixed(4)} SOL` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else if (fastPathInserted) {
      await patchSaleEventRaw(result.event);
      console.log(
        `[me_raw] patch ${result.event.marketplace}/${result.event.nftType}` +
        `  mint=${result.event.mintAddress.slice(0, 8)}...` +
        `  ix=${(result.event.rawData as Record<string, unknown>)._instruction}`
      );
    } else {
      console.log(`[me_raw] dup   sig=${sig.slice(0, 12)}...`);
    }
  } catch (err) {
    console.log(`DEDUPE_DEBUG_SKIP ${result.event.signature} insert_condition_failed: ${(err as Error)?.message ?? 'unknown'}`);
    console.error(`[me_raw] insert error  sig=${sig.slice(0, 12)}...`, err);
  }
}
