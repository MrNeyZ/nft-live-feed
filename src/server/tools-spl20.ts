/**
 * SPL-20 NFT⇄Token arb scanner — read-only.
 *
 * The BRC-20-style "spl-20" inscription program (8bvPnYE5Pvz2Z9dE6RAqWr1rzLknTndZ9hwvRE6kPDXP)
 * stores every deploy inscription as a plain on-chain account owned by a
 * per-ticker deploy PDA. That same PDA is the pool: `getTokenAccountsByOwner`
 * on it returns the pool's fungible token holdings (the redeemable balance)
 * plus every not-yet-redeemed NFT inscription it still holds (decimals=0,
 * amount=1 each — this count is the NFT→token liquidity depth). This
 * mechanically answers "what's the CA for ticker X" without ever paging
 * transaction history.
 *
 * `GET /tools/spl20/scan-stream` is the primary entry point — an SSE
 * "Pool Feed"-style full scan (same shape as tools-mmm-pools.ts's
 * `pool-stream`): walks the whole 729-ticker registry, batches Jupiter
 * pricing, resolves each ticker's marketplace collection from a sample NFT
 * it still holds (via the existing ME mint→slug cache), pulls the ME floor
 * (shared `me-stats.ts` client), and reports a spread + a VALUE score
 * (spread% × redeemable liquidity depth) so real opportunities aren't
 * drowned out by a huge spread on a near-empty pool. Cached 20 min,
 * `force=1` bypasses. `GET /tools/spl20/resolve` stays as a single-
 * ticker manual lookup (also auto-resolves the slug the same way when none
 * is given) for tickers not in the static snapshot (a `pda` override).
 *
 * The 729-ticker → deployPda registry (`data/spl20-registry.json`) was
 * built once offline via `getProgramAccounts` over the whole program and is
 * loaded statically — re-scanning ~18k+ accounts per ticker on every
 * request would be a large, unnecessary RPC/credit spend for data that
 * only grows via new deploys.
 *
 * No wallet connect, no signing, no tx building — this only reads balances
 * and prices, then reports a spread. Executing the actual redeem/mint
 * instruction against this program is out of scope (its ix set isn't
 * reverse-engineered).
 */
import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { ensureFresh, getByCollection } from './listings-store';
import { computeCrossMarketGap } from '../analytics/cross-market';
import { getMeTokenData } from '../enrichment/me-token-cache';
import { getMeStats } from '../enrichment/me-stats';
import { meCooldownActive, meCooldownRemainMs } from '../me-api-cooldown';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
// A single getTokenAccountsByOwner for a busy pool (GH0ST: 20k+ accounts,
// sols: 17k+) takes ~400ms in isolation but can exceed the old 8s budget
// under the full scan's concurrent load — that's what made GH0ST's pool
// come back empty on some scans and populated on others. 20s gives real
// headroom; a genuinely dead RPC call still fails fast enough not to stall
// the scan (mapLimit workers move independently).
const RPC_TIMEOUT_MS = 20_000;
const POOL_TTL_MS = 60_000;
const PRICE_TTL_MS = 30_000;
const SCAN_CACHE_TTL_MS = 20 * 60 * 1000; // matches tools-mmm-pools.ts's TRIAGE_CACHE_TTL_MS
// Each unit of pool-resolution work fires 2 concurrent RPC calls (legacy +
// Token-2022), so this is really up to 2× concurrent large requests at
// once. A few of these pools are enormous (GH0ST 20k+ accounts, sols 17k+)
// — 8 workers (16 concurrent large calls) was enough contention to make
// those specific ones flake even with a timeout bump and a retry. Halved
// for headroom; the pool-resolution phase is fast regardless (~20-30s for
// 729 tickers even at this concurrency).
const POOL_CONCURRENCY = 4;
// ME's 429 is not a simple "N requests, then cooldown" bucket — confirmed by
// live-lock: 3 concurrent workers resuming together right after a cooldown
// wait immediately re-tripped it, over and over (10 separate 429s in one
// stuck scan, zero net progress). A reactive burst-then-wait strategy can't
// converge against a limiter shaped like that. Serial + a fixed pace
// between requests avoids ever tripping it in the first place.
const ME_PACE_MS = 400;
const JUP_CHUNK = 40;

interface RegistryEntry {
  tick: string;
  max: string;
  limit: string;
  deployPda: string;
}

let REGISTRY: RegistryEntry[] = [];
let BY_TICK: Map<string, RegistryEntry> = new Map();
try {
  const raw = readFileSync(join(__dirname, '..', '..', 'data', 'spl20-registry.json'), 'utf-8');
  const parsed = JSON.parse(raw) as RegistryEntry[];
  // Same on-chain deploy PDA can carry two different recorded tick strings
  // (confirmed: the account's binary `ticker` field vs. its separate mint-op
  // JSON "tick" text disagree on some deploys, e.g. "GAU" vs "$GAU") — a
  // registry-building bug once let both through as separate rows sharing one
  // deployPda, which broke the frontend's per-row React key and made sorted
  // order look scrambled. Dedupe by deployPda here so a bad regeneration of
  // the registry file can't silently reintroduce that class of bug.
  const seenPda = new Set<string>();
  REGISTRY = parsed.filter(e => {
    if (seenPda.has(e.deployPda)) return false;
    seenPda.add(e.deployPda);
    return true;
  });
  BY_TICK = new Map(REGISTRY.map(e => [e.tick.toLowerCase(), e]));
} catch (err) {
  console.error('[tools/spl20] failed to load registry', err);
}

function tokensPerNftOf(entry: RegistryEntry): number | null {
  return /^\d+(\.\d+)?$/.test(entry.limit) ? Number(entry.limit) : null;
}

/** Blocks until any active ME cooldown clears. Called before every
 *  individual getMeTokenData/getMeStats call in the bulk scan — without
 *  this, a 429 tripped by one concurrent call mid-phase silently nulls out
 *  every OTHER in-flight call for the rest of that phase too (confirmed:
 *  the same ticker, e.g. GH0ST, resolved correctly on one scan pass and
 *  came back empty on the very next one, purely depending on whether its
 *  call happened to land before or after the 429). */
async function waitOutMeCooldown(): Promise<void> {
  // Bounded, not indefinite — a pathological run of back-to-back 429s should
  // degrade (this one call proceeds and likely comes back empty) rather than
  // hang the whole scan forever.
  const deadline = Date.now() + 90_000;
  while (meCooldownActive() && Date.now() < deadline) {
    const waitMs = Math.min(meCooldownRemainMs() + 500, 20_000);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

/** Runs `work` while emitting a heartbeat every ~15s. Needed because
 *  `waitOutMeCooldown` can leave every concurrent worker blocked at once
 *  with no natural progress to report — without a heartbeat that reads as
 *  total silence to the client, and nginx's proxy_read_timeout will kill
 *  an upstream connection that goes quiet that long. */
async function withHeartbeat<T>(emit: (type: string, data: Record<string, unknown>) => void, label: string, work: Promise<T>): Promise<T> {
  let done = false;
  const tick = (async () => {
    while (!done) {
      await new Promise(r => setTimeout(r, 15_000));
      if (!done) emit('progress', { msg: `${label}…` });
    }
  })();
  try {
    return await work;
  } finally {
    done = true;
    await tick;
  }
}

/**
 * Fallback for deploy PDAs not in the static registry (e.g. `sols`, whose
 * deploy account uses an older inscription schema the offline bulk scan's
 * fixed `max=…|limit=…` parser didn't match — confirmed on-chain: its
 * deploy JSON is `{"op":"deploy","tick":"sols","amt":"1000"}`, no
 * `max`/`limit` fields at all, vs. the newer schema's
 * `{"op":"deploy","tick":"bozo","max":"800000000","limit":"800000"}`).
 * Decodes the deploy account's raw bytes directly and normalizes either
 * schema to the same {tick,max,limit} shape — `amt` doubles as `limit`
 * (both mean "tokens per mint/redeem") when the newer fields are absent.
 */
// Anchor account discriminator for libreplex_fair_launch's "Deployment" struct
// (sha256("account:Deployment")[0:8]) — confirmed by direct decode against
// bozo, sols, GH0ST, pepe, MAFIA, and VICE: every deploy on this program uses
// this exact struct regardless of "deploy_raw" vs Token-2022/"hybrid" type.
// Field order verified against libreplex_fair_launch/src/state.rs.
const DEPLOYMENT_DISCRIMINATOR = Buffer.from('425a6859b78240b2', 'hex');

interface DecodedDeployment {
  tick: string;
  max: string;
  limit: string;
  fungibleMint: string | null;
}

/**
 * Precise binary decode of the on-chain `Deployment` account — no text
 * scanning, no guessing. Gives `ticker`/`limit_per_mint`/`fungible_mint`
 * directly, which is what let MAFIA and VICE (pure Token-2022 "hybrid"
 * deploys with zero embedded JSON text — libreplex_liquidity's
 * `swap_to_fungible22` path) resolve correctly for the first time, and
 * confirmed byte-exact against bozo's known values (limit_per_mint=800000,
 * max_number_of_tokens×limit_per_mint=800,000,000 matching its deploy JSON).
 */
function decodeDeploymentAccount(buf: Buffer): DecodedDeployment | null {
  try {
    if (buf.length < 90 || !buf.subarray(0, 8).equals(DEPLOYMENT_DISCRIMINATOR)) return null;
    let off = 8 + 32; // discriminator + creator
    const limitPerMint = buf.readBigUInt64LE(off); off += 8;
    const maxNumberOfTokens = buf.readBigUInt64LE(off); off += 8;
    off += 8; // number_of_tokens_issued
    off += 1 + 1 + 1 + 1 + 1; // decimals, use_inscriptions, deployment_type, require_creator_cosign, migrated_from_legacy
    off += 8; // escrow_non_fungible_count
    const tickerLen = buf.readUInt32LE(off); off += 4;
    if (tickerLen > 64 || off + tickerLen > buf.length) return null;
    const tick = buf.subarray(off, off + tickerLen).toString('utf8'); off += tickerLen;
    if (!tick || /[\x00-\x08\x0e-\x1f]/.test(tick)) return null;
    const tmplLen = buf.readUInt32LE(off); off += 4;
    if (off + tmplLen > buf.length) return null;
    off += tmplLen; // deployment_template
    const mtmplLen = buf.readUInt32LE(off); off += 4;
    if (off + mtmplLen > buf.length) return null;
    off += mtmplLen; // mint_template
    if (off + 32 > buf.length) return null;
    const fungibleMint = new PublicKey(buf.subarray(off, off + 32)).toBase58();
    return {
      tick,
      max: (limitPerMint * maxNumberOfTokens).toString(),
      limit: limitPerMint.toString(),
      fungibleMint,
    };
  } catch {
    return null;
  }
}

async function decodeDeployJson(pda: string): Promise<{ tick: string; max: string; limit: string } | null> {
  const result = await rpc('getAccountInfo', [pda, { encoding: 'base64' }]) as { value?: { data?: [string, string] } } | null;
  const data = result?.value?.data;
  if (!data?.[0]) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(data[0], 'base64');
  } catch {
    return null;
  }

  const decoded = decodeDeploymentAccount(buf);
  if (decoded) return { tick: decoded.tick, max: decoded.max, limit: decoded.limit };

  // Fallback for anything that somehow isn't a "Deployment"-discriminator
  // account (shouldn't happen on this program, kept for defense in depth).
  const text = buf.toString('utf8');
  const m = text.match(/\{"p":"spl-20","op":"deploy"[^}]*\}/);
  if (!m) return null;
  try {
    const json = JSON.parse(m[0]) as { tick?: string; max?: string; limit?: string; amt?: string };
    if (!json.tick) return null;
    return { tick: json.tick, max: json.max ?? '', limit: json.limit ?? json.amt ?? '' };
  } catch {
    return null;
  }
}

function heliusUrl(): string {
  return `https://beta.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await fetch(heliusUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: unknown; error?: unknown };
    if (j.error) return null;
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Bounded-concurrency map — keeps 729-ticker scans from firing 729
 *  simultaneous RPC/API calls. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ParsedTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
        };
      };
    };
  };
}

interface PoolSnapshot {
  fungibleMint: string | null;
  tokenDecimals: number | null;
  tokenBalance: number | null;
  nftInventoryCount: number;
  /** First still-held (decimals=0, amount=1) NFT mint — used to resolve the
   *  ticker's marketplace collection via the existing ME mint→slug cache,
   *  without ever needing a manually-typed slug. */
  sampleNftMint: string | null;
  fetchedAt: number;
}

const poolCache = new Map<string, PoolSnapshot>();

async function fetchPool(deployPda: string): Promise<PoolSnapshot> {
  const cached = poolCache.get(deployPda);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) return cached;

  // Some tickers' pools hold their inventory under Token-2022 rather than
  // the legacy Token program (confirmed on GH0ST: 0 legacy accounts, 20,376
  // Token-2022 accounts — a single-program query silently reported an empty,
  // unresolvable pool for it). Query both and merge, same fix already
  // applied in wallet-quick-balance.ts for the same underlying gap. One
  // retry each: a transient RPC failure on a large (10k+ account) pool
  // reporting as null here reads as "genuinely empty pool" downstream,
  // same class of bug as the timeout that made GH0ST flaky.
  const getAccounts = async (programId: string) => {
    const first = await rpc('getTokenAccountsByOwner', [deployPda, { programId }, { encoding: 'jsonParsed' }]) as { value?: ParsedTokenAccount[] } | null;
    if (first) return first;
    // An immediate retry under the same concurrent burst that caused the
    // first failure just fails the same way again (confirmed: GH0ST's pool
    // came back empty from a bulk scan twice in a row even with the retry
    // in place, yet resolved instantly and correctly outside scan load).
    // Back off briefly so the retry lands after the burst eases.
    await new Promise(r => setTimeout(r, 3_000));
    return await rpc('getTokenAccountsByOwner', [deployPda, { programId }, { encoding: 'jsonParsed' }]) as { value?: ParsedTokenAccount[] } | null;
  };
  const [legacyResult, token2022Result] = await Promise.all([
    getAccounts(TOKEN_PROGRAM),
    getAccounts(TOKEN_2022_PROGRAM),
  ]);

  const accounts = [...(legacyResult?.value ?? []), ...(token2022Result?.value ?? [])];
  let fungibleMint: string | null = null;
  let tokenDecimals: number | null = null;
  let tokenBalance: number | null = null;
  let nftInventoryCount = 0;
  let sampleNftMint: string | null = null;

  for (const a of accounts) {
    const info = a.account?.data?.parsed?.info;
    if (!info) continue;
    const decimals = info.tokenAmount.decimals;
    const uiAmount = info.tokenAmount.uiAmount ?? 0;
    if (decimals > 0) {
      // The pool's single fungible balance. In the observed layout this is
      // exactly one account; if a program variant ever splits it across
      // more than one, keep the largest by balance rather than the last seen.
      if (tokenBalance === null || uiAmount > tokenBalance) {
        fungibleMint = info.mint;
        tokenDecimals = decimals;
        tokenBalance = uiAmount;
      }
    } else if (Number(info.tokenAmount.amount) >= 1) {
      nftInventoryCount += 1;
      if (!sampleNftMint) sampleNftMint = info.mint;
    }
  }

  const snapshot: PoolSnapshot = { fungibleMint, tokenDecimals, tokenBalance, nftInventoryCount, sampleNftMint, fetchedAt: Date.now() };
  poolCache.set(deployPda, snapshot);
  return snapshot;
}

interface PriceEntry { usdPrice: number; liquidityUsd: number | null; fetchedAt: number }
const priceCache = new Map<string, PriceEntry>();

/** Batch-fetches USD prices for many mints (+ SOL) in Jupiter-sized chunks,
 *  populating the shared cache. Used by the full scan so 729 tickers don't
 *  turn into 729 separate Jupiter calls. */
async function fetchPricesBatch(mints: readonly string[]): Promise<void> {
  const now = Date.now();
  const stale = (m: string) => { const e = priceCache.get(m); return !e || now - e.fetchedAt >= PRICE_TTL_MS; };
  const toFetch = [...new Set(mints.filter(stale))];
  if (stale(SOL_MINT)) toFetch.push(SOL_MINT);
  if (toFetch.length === 0) return;

  for (let i = 0; i < toFetch.length; i += JUP_CHUNK) {
    const chunk = toFetch.slice(i, i + JUP_CHUNK);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const r = await fetch(`${JUP_PRICE_URL}?ids=${encodeURIComponent(chunk.join(','))}`, { signal: ctrl.signal });
      if (r.ok) {
        const j = await r.json() as Record<string, { usdPrice?: number; liquidity?: number } | undefined>;
        for (const m of chunk) {
          if (typeof j[m]?.usdPrice === 'number') {
            priceCache.set(m, {
              usdPrice: j[m]!.usdPrice!,
              liquidityUsd: typeof j[m]!.liquidity === 'number' ? j[m]!.liquidity! : null,
              fetchedAt: now,
            });
          }
        }
      }
    } catch {
      // skip this chunk — remaining chunks still get a chance
    } finally {
      clearTimeout(t);
    }
  }
}

function getCachedPriceSol(mint: string): number | null {
  const tokenEntry = priceCache.get(mint);
  const solEntry = priceCache.get(SOL_MINT);
  if (!tokenEntry || !solEntry || solEntry.usdPrice <= 0) return null;
  return tokenEntry.usdPrice / solEntry.usdPrice;
}

/** Jupiter's price-index liquidity figure (USD) — only available when the
 *  mint has an index price at all. Tokens priced only via the swap-quote
 *  fallback (e.g. GH0ST) have no index entry, so this is null for them —
 *  "unknown", not "confirmed zero"; a quote route existing at all already
 *  implies some real pool behind it, just not indexed. */
function getLiquidityUsd(mint: string): number | null {
  return priceCache.get(mint)?.liquidityUsd ?? null;
}

interface QuotePriceEntry { priceSol: number; fetchedAt: number }
const quotePriceCache = new Map<string, QuotePriceEntry>();

/**
 * Fallback for mints Jupiter's price index has no `usdPrice` for at all —
 * confirmed on GH0ST and sols: both are indexed (Jupiter knows the mint,
 * decimals, first-seen slot) but carry no price because nothing recently
 * traded through a route the index trusts. The swap-quote endpoint still
 * finds a route through smaller/newer AMMs (e.g. FluxBeam) that the price
 * index omits. Quotes a single whole token → SOL (not the full
 * tokens-per-NFT amount) so the result is a marginal per-token rate, not
 * distorted by price impact at redemption size.
 */
// Confirmed-dead mints (no swap-quote route at all) get re-checked far less
// often than live ones — a mint with zero DEX liquidity doesn't usually grow
// one within a few hours, and this is normally the majority of the
// "unpriced" set every single scan. Without this, every fresh scan re-hits
// Jupiter for the same known-dead mints it already ruled out 20 minutes ago.
const DEAD_MINT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const deadMintCache = new Map<string, number>(); // mint -> checkedAt

async function fetchQuotePriceSol(mint: string, decimals: number): Promise<number | null> {
  const cached = quotePriceCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.priceSol;

  const deadSince = deadMintCache.get(mint);
  if (deadSince != null && Date.now() - deadSince < DEAD_MINT_TTL_MS) return null;

  const amount = Math.round(10 ** decimals);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const url = `${JUP_QUOTE_URL}?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=100`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) { deadMintCache.set(mint, Date.now()); return null; }
    const j = await r.json() as { outAmount?: string };
    if (!j.outAmount) { deadMintCache.set(mint, Date.now()); return null; }
    const priceSol = Number(j.outAmount) / 1e9;
    if (!Number.isFinite(priceSol) || priceSol <= 0) { deadMintCache.set(mint, Date.now()); return null; }
    quotePriceCache.set(mint, { priceSol, fetchedAt: Date.now() });
    deadMintCache.delete(mint);
    return priceSol;
  } catch {
    deadMintCache.set(mint, Date.now());
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Combined lookup: Jupiter's price index first, quote-route fallback second. */
function resolvedPriceSol(mint: string): number | null {
  const viaIndex = getCachedPriceSol(mint);
  if (viaIndex != null) return viaIndex;
  const viaQuote = quotePriceCache.get(mint);
  return viaQuote ? viaQuote.priceSol : null;
}

async function fetchTokenPriceSol(mint: string, decimals: number | null): Promise<number | null> {
  await fetchPricesBatch([mint]);
  const viaIndex = getCachedPriceSol(mint);
  if (viaIndex != null) return viaIndex;
  if (decimals == null) return null;
  return fetchQuotePriceSol(mint, decimals);
}

type Direction = 'sell_nft_for_token' | 'buy_token_for_nft' | null;

function spreadOf(meFloorSol: number | null, tokenValuePerNftSol: number | null): { spreadPct: number | null; direction: Direction } {
  if (meFloorSol == null || meFloorSol <= 0 || tokenValuePerNftSol == null) return { spreadPct: null, direction: null };
  const spreadPct = ((tokenValuePerNftSol - meFloorSol) / meFloorSol) * 100;
  return { spreadPct, direction: spreadPct > 0 ? 'sell_nft_for_token' : 'buy_token_for_nft' };
}

export interface Spl20Result {
  ok: true;
  tick: string;
  deployPda: string;
  max: string;
  limit: string;
  tokensPerNft: number | null;
  mint: string | null;
  tokenDecimals: number | null;
  tokenBalance: number | null;
  nftInventoryCount: number;
  tokenPriceSol: number | null;
  tokenValuePerNftSol: number | null;
  /** Jupiter price-index liquidity (USD). Null when the token has no index
   *  entry at all (priced via swap-quote fallback instead) — "unknown", not
   *  "zero". Genuinely zero-liquidity tokens (no price obtainable by either
   *  method) never reach this far — tokenPriceSol/tokenValuePerNftSol/
   *  spreadPct all stay null for those, same as before. */
  liquidityUsd: number | null;
  resolvedSlug: string | null;
  meFloorSol: number | null;
  meListedCount: number;
  tensorFloorSol: number | null;
  tensorListedCount: number;
  spreadPct: number | null;
  direction: Direction;
}

export interface Spl20ScanRow {
  tick: string;
  deployPda: string;
  max: string;
  limit: string;
  tokensPerNft: number | null;
  mint: string | null;
  nftInventoryCount: number;
  tokenBalance: number | null;
  tokenPriceSol: number | null;
  tokenValuePerNftSol: number | null;
  liquidityUsd: number | null;
  resolvedSlug: string | null;
  meFloorSol: number | null;
  meListedCount: number;
  spreadPct: number | null;
  direction: Direction;
  valueScore: number;
}

// Disk-persisted so a backend restart/deploy (in-memory state wiped) doesn't
// throw away a recent scan and force the next visitor to wait through a full
// rescan again — same fix already applied to mmm-fvca-info-cache.json for
// the same underlying problem. Still subject to the normal SCAN_CACHE_TTL_MS
// staleness check below; this only survives restarts, it doesn't bypass TTL.
const SCAN_CACHE_FILE = join(__dirname, '..', '..', 'data', 'spl20-scan-cache.json');

function loadScanCacheFromDisk(): { rows: Spl20ScanRow[]; builtAt: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(SCAN_CACHE_FILE, 'utf-8')) as { rows?: unknown; builtAt?: unknown };
    if (Array.isArray(parsed.rows) && typeof parsed.builtAt === 'number') {
      return { rows: parsed.rows as Spl20ScanRow[], builtAt: parsed.builtAt };
    }
  } catch {
    // no persisted cache yet, or corrupt — next scan recreates it
  }
  return null;
}

function saveScanCacheToDisk(cache: { rows: Spl20ScanRow[]; builtAt: number }): void {
  try {
    writeFileSync(SCAN_CACHE_FILE, JSON.stringify(cache));
  } catch (err) {
    console.error('[tools/spl20] failed to persist scan cache', err);
  }
}

let scanCache: { rows: Spl20ScanRow[]; builtAt: number } | null = loadScanCacheFromDisk();
let scanInFlight: Promise<Spl20ScanRow[]> | null = null;

async function runFullScan(emit: (type: string, data: Record<string, unknown>) => void): Promise<Spl20ScanRow[]> {
  emit('progress', { msg: `Resolving ${REGISTRY.length} pools on-chain…` });
  let poolsDone = 0;
  const withPools = await mapLimit(REGISTRY, POOL_CONCURRENCY, async (entry) => {
    const pool = await fetchPool(entry.deployPda);
    poolsDone += 1;
    if (poolsDone % 50 === 0 || poolsDone === REGISTRY.length) {
      emit('progress', { msg: `Resolved pools ${poolsDone}/${REGISTRY.length}…` });
    }
    return { entry, pool };
  });

  // A pool with 1-2 unredeemed NFTs left has no real tradeable depth even if
  // a huge % spread turns up — not worth pricing or an ME lookup. Empirically
  // ~60% of tickers with *any* inventory sit at 1-2 (dust from a single early
  // minter). Filtered before pricing too now, not just before the ME step —
  // no reason to spend a Jupiter quote call on a mint that could never
  // contribute a real row anyway.
  const MIN_INVENTORY_FOR_ME_LOOKUP = 3;
  const withRealInventory = withPools.filter(p => p.pool.nftInventoryCount >= MIN_INVENTORY_FOR_ME_LOOKUP);

  const liveMints = [...new Set(withRealInventory.filter(p => p.pool.fungibleMint).map(p => p.pool.fungibleMint as string))];
  emit('progress', { msg: `Pricing ${liveMints.length} live tokens…` });
  await fetchPricesBatch(liveMints);

  // Jupiter's price index omits plenty of these — it knows the mint exists
  // but has no `usdPrice` for it (confirmed on GH0ST and sols). Fall back to
  // a swap-quote for the ones still unpriced; a route through a smaller AMM
  // often still exists even when the index doesn't trust it enough to price.
  const stillUnpriced = withRealInventory
    .filter(p => p.pool.fungibleMint && p.pool.tokenDecimals != null && getCachedPriceSol(p.pool.fungibleMint) == null)
    .map(p => ({ mint: p.pool.fungibleMint as string, decimals: p.pool.tokenDecimals as number }));
  const uniqueUnpriced = [...new Map(stillUnpriced.map(x => [x.mint, x])).values()];
  if (uniqueUnpriced.length > 0) {
    emit('progress', { msg: `Quoting ${uniqueUnpriced.length} unindexed tokens via swap routes…` });
    await mapLimit(uniqueUnpriced, POOL_CONCURRENCY, async ({ mint, decimals }) => { await fetchQuotePriceSol(mint, decimals); });
  }

  // The big one: skip the ME lookup entirely for tokens that already have NO
  // resolvable price at all (neither indexed nor a swap-quote route) — same
  // situation as MAFIA/VICE/pepe/lamp/free confirmed earlier: real NFT-side
  // activity, completely dead fungible side. A spread can never be computed
  // without a token price, so an ME collection lookup for these is pure
  // wasted time on exactly the slowest, most rate-limit-prone part of the
  // scan. This is normally the majority of "has inventory" tickers, so it's
  // the main lever for scan duration.
  const withInventory = withRealInventory
    .filter(p => p.pool.sampleNftMint && p.pool.fungibleMint && resolvedPriceSol(p.pool.fungibleMint) != null)
    .sort((a, b) => b.pool.nftInventoryCount - a.pool.nftInventoryCount);
  emit('progress', { msg: `Resolving marketplace collection for ${withInventory.length} priced tickers with unredeemed NFTs…` });
  const slugByPda = new Map<string, string | null>();
  let slugsDone = 0;
  await withHeartbeat(emit, 'Resolving marketplace collections', mapLimit(withInventory, 1, async ({ entry, pool }) => {
    await waitOutMeCooldown();
    const data = await getMeTokenData(pool.sampleNftMint as string);
    slugByPda.set(entry.deployPda, data.slug);
    slugsDone += 1;
    if (slugsDone % 50 === 0 || slugsDone === withInventory.length) {
      emit('progress', { msg: `Resolved collections ${slugsDone}/${withInventory.length}…` });
    }
    await new Promise(r => setTimeout(r, ME_PACE_MS));
  }));

  const uniqueSlugs = [...new Set([...slugByPda.values()].filter((s): s is string => !!s))];
  emit('progress', { msg: `Fetching ME floor for ${uniqueSlugs.length} collections…` });
  const statsBySlug = new Map<string, { floorPrice?: number; listedCount?: number } | null>();
  await withHeartbeat(emit, 'Fetching ME floors', mapLimit(uniqueSlugs, 1, async (slug) => {
    await waitOutMeCooldown();
    statsBySlug.set(slug, await getMeStats(slug));
    await new Promise(r => setTimeout(r, ME_PACE_MS));
  }));

  const rows: Spl20ScanRow[] = withPools.map(({ entry, pool }) => {
    const tokensPerNft = tokensPerNftOf(entry);
    const tokenPriceSol = pool.fungibleMint ? resolvedPriceSol(pool.fungibleMint) : null;
    const liquidityUsd = pool.fungibleMint ? getLiquidityUsd(pool.fungibleMint) : null;
    const tokenValuePerNftSol = tokensPerNft != null && tokenPriceSol != null ? tokensPerNft * tokenPriceSol : null;
    const resolvedSlug = slugByPda.get(entry.deployPda) ?? null;
    const stats = resolvedSlug ? statsBySlug.get(resolvedSlug) : null;
    const meFloorSol = typeof stats?.floorPrice === 'number' ? stats.floorPrice / 1e9 : null;
    const meListedCount = typeof stats?.listedCount === 'number' ? stats.listedCount : 0;
    const { spreadPct, direction } = spreadOf(meFloorSol, tokenValuePerNftSol);

    // Depth = how many NFTs' worth of edge is actually available right now
    // in the profitable direction — keeps a huge spread on a nearly-dry
    // pool from outranking a modest spread with real liquidity behind it.
    const depth = direction === 'sell_nft_for_token'
      ? pool.nftInventoryCount
      : direction === 'buy_token_for_nft' && tokensPerNft
        ? Math.floor((pool.tokenBalance ?? 0) / tokensPerNft)
        : 0;
    const valueScore = spreadPct != null ? Math.abs(spreadPct) * depth : 0;

    return {
      tick: entry.tick, deployPda: entry.deployPda, max: entry.max, limit: entry.limit,
      tokensPerNft, mint: pool.fungibleMint, nftInventoryCount: pool.nftInventoryCount,
      tokenBalance: pool.tokenBalance, tokenPriceSol, tokenValuePerNftSol, liquidityUsd,
      resolvedSlug, meFloorSol, meListedCount, spreadPct, direction, valueScore,
    };
  });

  rows.sort((a, b) => b.valueScore - a.valueScore);
  return rows;
}

export function createSpl20Router(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/spl20' });
  const scanLimit = rateLimit({ limit: 6, windowMs: 60_000, label: 'tools/spl20-scan' });

  router.get('/tools/spl20/tickers', limit, (_req: Request, res: Response) => {
    res.json({ ok: true, count: REGISTRY.length, tickers: REGISTRY });
  });

  // Full-registry "Pool Feed"-style scan — SSE, same event contract as
  // tools-mmm-pools.ts's pool-stream (`progress` / `result` / `error`).
  router.get('/tools/spl20/scan-stream', scanLimit, (req: Request, res: Response) => {
    const force = req.query.force === '1';
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (type: string, data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    void (async () => {
      try {
        if (!force && scanCache && Date.now() - scanCache.builtAt < SCAN_CACHE_TTL_MS) {
          const ageMs = Date.now() - scanCache.builtAt;
          emit('progress', { msg: `Cached (${Math.floor(ageMs / 60_000)}m ago) — ${scanCache.rows.length} tickers` });
          emit('result', { rows: scanCache.rows, cached: true, cacheAgeMs: ageMs });
          res.end();
          return;
        }
        if (scanInFlight) {
          emit('progress', { msg: 'A scan is already running — attaching to it…' });
          const rows = await scanInFlight;
          emit('result', { rows, cached: false, cacheAgeMs: 0 });
          res.end();
          return;
        }
        scanInFlight = runFullScan(emit).finally(() => { scanInFlight = null; });
        const rows = await scanInFlight;
        scanCache = { rows, builtAt: Date.now() };
        saveScanCacheToDisk(scanCache);
        emit('progress', { msg: `Done — ${rows.length} tickers scanned` });
        emit('result', { rows, cached: false, cacheAgeMs: 0 });
      } catch (err) {
        console.error('[tools/spl20] scan error', err);
        emit('error', { msg: String(err) });
      }
      res.end();
    })();
  });

  router.get('/tools/spl20/resolve', limit, async (req: Request, res: Response) => {
    const tickRaw = String(req.query.tick ?? '').trim();
    const pdaOverride = String(req.query.pda ?? '').trim();
    const slugRaw = String(req.query.slug ?? '').trim();

    let entry: RegistryEntry | undefined;
    let deployPda: string;
    if (pdaOverride) {
      if (!ADDR_RE.test(pdaOverride)) {
        res.status(400).json({ error: 'invalid_pda' });
        return;
      }
      deployPda = pdaOverride;
      entry = tickRaw ? BY_TICK.get(tickRaw.toLowerCase()) : undefined;
      if (!entry) {
        const decoded = await decodeDeployJson(deployPda);
        if (decoded) entry = { ...decoded, deployPda };
      }
    } else {
      if (!tickRaw) {
        res.status(400).json({ error: 'invalid_input', message: 'Provide a ticker (or a deploy PDA override).' });
        return;
      }
      entry = BY_TICK.get(tickRaw.toLowerCase());
      if (!entry) {
        res.status(404).json({ error: 'ticker_not_found', message: 'Not in the 729-ticker snapshot — paste its deploy PDA manually.' });
        return;
      }
      deployPda = entry.deployPda;
    }

    try {
      const pool = await fetchPool(deployPda);
      const tokenPriceSol = pool.fungibleMint ? await fetchTokenPriceSol(pool.fungibleMint, pool.tokenDecimals) : null;
      const liquidityUsd = pool.fungibleMint ? getLiquidityUsd(pool.fungibleMint) : null;
      const tokensPerNft = entry ? tokensPerNftOf(entry) : null;
      const tokenValuePerNftSol = tokensPerNft != null && tokenPriceSol != null ? tokensPerNft * tokenPriceSol : null;

      // Auto-resolve the marketplace slug from a sample NFT the pool still
      // holds when none was typed manually — same trick the bulk scan uses,
      // so a single-ticker lookup doesn't require knowing the ME slug either.
      let slugToUse = slugRaw;
      if (!slugToUse && pool.sampleNftMint) {
        const data = await getMeTokenData(pool.sampleNftMint);
        if (data.slug) slugToUse = data.slug;
      }

      let resolvedSlug: string | null = null;
      let meFloorSol: number | null = null;
      let meListedCount = 0;
      let tensorFloorSol: number | null = null;
      let tensorListedCount = 0;
      if (slugToUse) {
        resolvedSlug = slugToUse;
        await ensureFresh(slugToUse);
        const rows = getByCollection(slugToUse);
        const gap = computeCrossMarketGap(rows);
        meFloorSol = gap.meDirectFloorSol;
        tensorFloorSol = gap.tensorDirectFloorSol;
        meListedCount = rows.filter(r => r.source === 'ME').length;
        tensorListedCount = rows.filter(r => r.source === 'TENSOR').length;
      }

      const { spreadPct, direction } = spreadOf(meFloorSol, tokenValuePerNftSol);

      const result: Spl20Result = {
        ok: true,
        tick: entry?.tick ?? tickRaw,
        deployPda,
        max: entry?.max ?? '',
        limit: entry?.limit ?? '',
        tokensPerNft,
        mint: pool.fungibleMint,
        tokenDecimals: pool.tokenDecimals,
        tokenBalance: pool.tokenBalance,
        nftInventoryCount: pool.nftInventoryCount,
        tokenPriceSol,
        tokenValuePerNftSol,
        liquidityUsd,
        resolvedSlug,
        meFloorSol,
        meListedCount,
        tensorFloorSol,
        tensorListedCount,
        spreadPct,
        direction,
      };
      res.json(result);
    } catch (err) {
      console.error('[tools/spl20] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
