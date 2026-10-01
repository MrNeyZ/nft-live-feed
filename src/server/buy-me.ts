/**
 * Marketplace buy-now transaction builder (server-side).
 *
 * Defense-in-depth checks run BEFORE we hit the marketplace API:
 *
 *   1. Bearer auth — the route requires a valid signed session token.
 *   2. Marketplace allowlist — only `magic_eden` currently executes.
 *      `tensor` returns 501 unsupported.
 *   3. Collection binding — the requested `collectionSlug` (or
 *      `collectionAddress`) must match what our listings-store /
 *      enrichment cache knows for this mint. If neither side has a
 *      slug, fail closed — we never ship a tx on ambiguous data.
 *   4. Live price + slippage — re-fetch the current ME listing and
 *      reject if it moved above `expectedPriceSol * (1 + slippagePct/100)`
 *      or disappeared entirely.
 *
 * Defense-in-depth checks run AFTER we receive the unsigned tx from ME
 * and BEFORE we return it to the browser:
 *
 *   5. Mint binding — the tx's account keys must include the mint.
 *   6. Lamports bound — every `SystemProgram::Transfer` in the tx must
 *      sum to at most `expectedPriceSol * (1 + slippagePct/100)`
 *      lamports on the buyer's side. Prevents a hostile upstream from
 *      swapping in a drained-wallet instruction.
 *   7. Signer shape — the only required signer is the buyer. Anything
 *      else (the marketplace/seller keys are partial signatures ME
 *      already applied) is forbidden.
 *
 * The buyer signs and submits in the browser — no key material here.
 * Without an `ME_API_KEY` the route returns 503 so the UI can render a
 * clear "buying disabled" message instead of a misleading failure.
 */

import { Router, Request, Response } from 'express';
import { VersionedTransaction, Transaction, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { slugForMint, meListingForBuy, getByCollection } from './listings-store';
import { ME_AMM_PROGRAM } from '../ingestion/me-raw/programs';
import { hasMeApiKey, meAuthHeaders } from '../me-api-cooldown';
import { rpcPost } from './tools-mmm-pools';
import bs58 from 'bs58';
import { createHash } from 'crypto';

const ME_API_BASE      = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 8_000;
// Small fixed priority fee (µLamports per CU) — lands faster than a bare tx
// without competing with snipers. ~0.00002 SOL on a ~200k CU buy.
const BUY_PRIO_FEE_MICROLAMPORTS = Number(process.env.BUY_PRIO_FEE_MICROLAMPORTS) || 100_000;

const ALLOWED_MARKETPLACES = new Set(['magic_eden', 'tensor']);

interface MeListing {
  price?:        number;
  seller?:       string;
  auctionHouse?: string;
  tokenAddress?: string;  // seller's ATA / AH escrow
  collection?:   string;  // slug, present on /tokens/:mint/listings responses
  collectionSymbol?: string;
}

async function fetchMeListing(mint: string): Promise<MeListing | null> {
  try {
    const res = await fetch(
      `${ME_API_BASE}/tokens/${encodeURIComponent(mint)}/listings`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const json = await res.json() as MeListing[];
    if (!Array.isArray(json) || json.length === 0) return null;
    const first = json[0];
    if (typeof first.price !== 'number' || first.price <= 0) return null;
    if (!first.seller || !first.auctionHouse) return null;
    return first;
  } catch {
    return null;
  }
}

async function fetchMeTokenCollection(mint: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${ME_API_BASE}/tokens/${encodeURIComponent(mint)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { collection?: string };
    return typeof json.collection === 'string' && json.collection.length > 0 ? json.collection : null;
  } catch {
    return null;
  }
}

interface MeInstructionResponse {
  tx?:       { type?: string; data?: number[] };
  txSigned?: { type?: string; data?: number[] };
}

function extractTxBytes(json: MeInstructionResponse): Buffer | null {
  const src = json.txSigned ?? json.tx;
  if (!src?.data || !Array.isArray(src.data)) return null;
  return Buffer.from(src.data);
}

/** Decode a raw Solana tx (legacy OR v0). web3.js has distinct types for
 *  each; try v0 first, fall back to legacy — the marketplace may return
 *  either. Returns `null` when neither decoder accepts the bytes. */
function deserializeTx(bytes: Buffer): VersionedTransaction | Transaction | null {
  try { return VersionedTransaction.deserialize(bytes); } catch { /* try legacy */ }
  try { return Transaction.from(bytes); } catch { /* give up */ }
  return null;
}

/** Flatten the account-key list for legacy + v0 into a plain string[]. */
function accountKeyStrings(tx: VersionedTransaction | Transaction): string[] {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map(k => k.toBase58());
  }
  return tx.instructions.flatMap(ix => [ix.programId.toBase58(), ...ix.keys.map(k => k.pubkey.toBase58())]);
}

/** Sum every `SystemProgram.transfer` that drains the buyer, in lamports.
 *  Non–system-program instructions are ignored here — the per-sale price
 *  is the System transfer from buyer to AH / seller / fee accounts. */
function sumBuyerSolOut(tx: VersionedTransaction | Transaction, buyerPk: string): number {
  const systemProgramId = SystemProgram.programId.toBase58();
  let lamportsOut = 0;

  if (tx instanceof VersionedTransaction) {
    const staticKeys = tx.message.staticAccountKeys.map(k => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      const programId = staticKeys[ix.programIdIndex];
      if (programId !== systemProgramId) continue;
      // System transfer: instruction data = [4, lamports_u64_le] (ix enum 2 is Transfer)
      const data = ix.data as Uint8Array;
      if (data.length < 12) continue;
      const variant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
      if (variant !== 2 /* Transfer */) continue;
      const fromIdx = ix.accountKeyIndexes[0];
      if (fromIdx == null) continue;
      if (staticKeys[fromIdx] !== buyerPk) continue;
      // Read u64 little-endian
      const lamports = Number(Buffer.from(data.buffer, data.byteOffset + 4, 8).readBigUInt64LE(0));
      lamportsOut += lamports;
    }
    return lamportsOut;
  }

  for (const ix of tx.instructions) {
    if (ix.programId.toBase58() !== systemProgramId) continue;
    const data = ix.data;
    if (data.length < 12) continue;
    const variant = data.readUInt32LE(0);
    if (variant !== 2) continue;
    const from = ix.keys[0]?.pubkey.toBase58();
    if (from !== buyerPk) continue;
    const lamports = Number(data.readBigUInt64LE(4));
    lamportsOut += lamports;
  }
  return lamportsOut;
}

/** Names of keys the tx requires a signature from. For our safety contract
 *  we require that every *unsatisfied* signer is the buyer; partial
 *  signatures already attached (marketplace authority, seller) don't count. */
function unsatisfiedSigners(tx: VersionedTransaction | Transaction): string[] {
  if (tx instanceof VersionedTransaction) {
    const required = tx.message.staticAccountKeys
      .slice(0, tx.message.header.numRequiredSignatures)
      .map(k => k.toBase58());
    // VersionedTransaction.signatures is a fixed-length Uint8Array[] aligned
    // with the required-signers list. An all-zero entry means "unsigned".
    return required.filter((_pk, i) => {
      const sig = tx.signatures[i];
      return !sig || sig.every(b => b === 0);
    });
  }
  // Legacy Transaction carries its partial sigs as { publicKey, signature }
  return tx.signatures.filter(s => !s.signature).map(s => s.publicKey.toBase58());
}

// ── MMM fulfill-sell validation ──────────────────────────────────────────
// ME's taker fee on pool buys (observed in its built ix args: 200 bp).
const MMM_TAKER_BP = 200;
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
// Anchor discriminators of the MMM sell-side fulfills ME may return.
const MMM_SELL_DISCS: Record<string, 'vanilla' | 'core'> = {
  a4b460c067e169e8: 'vanilla',          // sol_fulfill_sell
  fce7c9b01ed57612: 'core',             // sol_mpl_core_fulfill_sell
};
// sol_mip1_fulfill_sell / sol_ext_fulfill_sell share the vanilla arg prefix
// (asset_amount u64, max_payment_amount u64); resolved by Anchor name hash.
for (const name of ['sol_mip1_fulfill_sell', 'sol_ext_fulfill_sell', 'sol_ocp_fulfill_sell']) {
  MMM_SELL_DISCS[createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex')] = 'vanilla';
}

/** Royalty the program will charge the buyer on top of the price: Core
 *  (plugin) and pNFT royalties are enforced; legacy royalty is optional and
 *  we send buysideCreatorRoyaltyBp=0. Fail-safe high (10%) if DAS is down,
 *  so the cap never under-covers an enforced royalty. */
async function enforcedRoyaltyBp(mint: string): Promise<number> {
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'mmm-roy', method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = await r.json() as { result?: { interface?: string; royalty?: { basis_points?: number } } };
    const iface = j.result?.interface ?? '';
    if (iface !== 'MplCoreAsset' && iface !== 'ProgrammableNFT') return 0;
    return Math.max(0, Math.min(10_000, j.result?.royalty?.basis_points ?? 1_000));
  } catch {
    return 1_000;
  }
}

/** Bind the ME-built tx to exactly what we asked for: only ComputeBudget +
 *  one MMM sell-fulfill touching our pool + mint, fee payer = buyer, the
 *  pool cosigner already signed, only the buyer left to sign, and the
 *  on-chain payment cap within ours. */
function checkMmmFulfillSellTx(
  bytes: Buffer, want: { buyer: string; pool: string; mint: string; maxPaymentLamports: number },
): { ok: true; takerBp: number } | { ok: false; reason: string; detail?: unknown } {
  if (bytes.length > 1232) return { ok: false, reason: 'tx_too_large', detail: bytes.length };
  let tx: Transaction;
  try { tx = Transaction.from(bytes); } catch { return { ok: false, reason: 'tx_decode_failed' }; }
  if (tx.feePayer?.toBase58() !== want.buyer) return { ok: false, reason: 'tx_fee_payer_mismatch' };
  const mmmIxs = tx.instructions.filter(ix => ix.programId.toBase58() === ME_AMM_PROGRAM);
  const others = tx.instructions.filter(ix => {
    const p = ix.programId.toBase58();
    return p !== ME_AMM_PROGRAM && p !== COMPUTE_BUDGET_PROGRAM;
  });
  if (mmmIxs.length !== 1 || others.length > 0) {
    return { ok: false, reason: 'tx_unexpected_instructions', detail: tx.instructions.map(i => i.programId.toBase58()) };
  }
  const ix = mmmIxs[0];
  const kind = MMM_SELL_DISCS[ix.data.subarray(0, 8).toString('hex')];
  if (!kind) return { ok: false, reason: 'tx_not_fulfill_sell', detail: ix.data.subarray(0, 8).toString('hex') };
  const keys = ix.keys.map(k => k.pubkey.toBase58());
  if (keys[0] !== want.buyer || !keys.includes(want.pool) || !keys.includes(want.mint)) {
    return { ok: false, reason: 'tx_account_mismatch' };
  }
  const maxOff = kind === 'core' ? 8 : 16;
  if (ix.data.length < maxOff + 8) return { ok: false, reason: 'tx_args_short' };
  const maxPayment = Number(ix.data.readBigUInt64LE(maxOff));
  if (maxPayment > want.maxPaymentLamports) {
    return { ok: false, reason: 'tx_cap_above_ours', detail: { maxPayment, ours: want.maxPaymentLamports } };
  }
  // taker_fee_bp: after max (u64), buyside royalty (u16), allowlist_aux
  // Option<String>, maker_fee_bp (i16).
  let o = maxOff + 8 + 2;
  const hasAux = ix.data[o]; o += 1;
  if (hasAux) o += 4 + ix.data.readUInt32LE(o);
  o += 2;
  const takerBp = o + 2 <= ix.data.length ? ix.data.readInt16LE(o) : -1;
  const unsigned = tx.signatures.filter(sg => !sg.signature).map(sg => sg.publicKey.toBase58());
  if (unsigned.length !== 1 || unsigned[0] !== want.buyer) return { ok: false, reason: 'tx_unexpected_signers', detail: unsigned };
  return { ok: true, takerBp };
}

// ── Send + confirm ───────────────────────────────────────────────────────
// No preflight/simulation: the tx was just built by ME against live state,
// and a stale listing fails on-chain for the base fee. Sent txs are
// re-broadcast every REBROADCAST_MS until confirmed (the confirm poll marks
// them done) or REBROADCAST_TTL_MS passes — plain sendTransaction with
// maxRetries alone drops more often under load.
const REBROADCAST_MS     = 2_000;
const REBROADCAST_TTL_MS = 60_000;
const CONFIRM_POLL_MS    = 400;
const CONFIRM_WAIT_MS    = 25_000;
const inFlightTx = new Map<string, NodeJS.Timeout>();

function sendRaw(txBase64: string): Promise<unknown> {
  return rpcPost('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
}

function stopRebroadcast(sig: string): void {
  const t = inFlightTx.get(sig);
  if (t) { clearInterval(t); inFlightTx.delete(sig); }
}

type SigStatus = { confirmationStatus: string | null; err: unknown } | null;
async function sigStatus(sig: string): Promise<SigStatus> {
  const r = await rpcPost('getSignatureStatuses', [[sig]]) as { value: SigStatus[] };
  return r.value[0] ?? null;
}

function rejectLog(fields: Record<string, unknown>): void {
  console.warn('[buy/me] REJECTED', JSON.stringify(fields));
}

export function createBuyMeRouter(): Router {
  const router = Router();

  const buyLimit = rateLimit({ limit: 10, windowMs: 60_000, label: 'buy/me' });

  // Capability probe — unauthenticated, cheap; frontend uses it to
  // render the Buy button's disabled state on mount.
  router.get('/me/status', (_req: Request, res: Response) => {
    res.json({ enabled: hasMeApiKey() });
  });

  const sendLimit = rateLimit({ limit: 20, windowMs: 60_000, label: 'buy/me/send' });
  const confirmLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'buy/me/confirm' });

  router.post('/me/send', sendLimit, requireAuth, async (req: Request, res: Response) => {
    const txBase64 = (req.body as { tx?: unknown })?.tx;
    if (typeof txBase64 !== 'string' || !txBase64) {
      res.status(400).json({ ok: false, message: 'missing tx' });
      return;
    }
    const tx = deserializeTx(Buffer.from(txBase64, 'base64'));
    const sigBytes = tx instanceof VersionedTransaction ? tx.signatures[0] : tx?.signatures[0]?.signature;
    if (!tx || !sigBytes || sigBytes.every(b => b === 0)) {
      res.status(400).json({ ok: false, message: 'tx not signed' });
      return;
    }
    const signature = bs58.encode(sigBytes);
    try {
      await sendRaw(txBase64);
    } catch (err) {
      console.warn('[buy/me] send failed', (err as Error).message);
      res.status(502).json({ ok: false, message: (err as Error).message });
      return;
    }
    if (!inFlightTx.has(signature)) {
      const startedAt = Date.now();
      const t = setInterval(() => {
        if (Date.now() - startedAt > REBROADCAST_TTL_MS) { stopRebroadcast(signature); return; }
        sendRaw(txBase64).catch(() => { /* already landed / expired — confirm poll decides */ });
      }, REBROADCAST_MS);
      t.unref?.();
      inFlightTx.set(signature, t);
    }
    console.log(`[buy/me] sent sig=${signature.slice(0, 12)}…`);
    res.json({ ok: true, signature });
  });

  // Long-poll: resolves as soon as the tx is confirmed/failed, else
  // `pending` after CONFIRM_WAIT_MS (caller may call again).
  router.get('/me/confirm', confirmLimit, requireAuth, async (req: Request, res: Response) => {
    const sig = String(req.query.sig ?? '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) {
      res.status(400).json({ ok: false, message: 'invalid sig' });
      return;
    }
    const deadline = Date.now() + CONFIRM_WAIT_MS;
    let closed = false;
    req.on('close', () => { closed = true; });
    while (!closed && Date.now() < deadline) {
      try {
        const st = await sigStatus(sig);
        if (st?.err) {
          stopRebroadcast(sig);
          res.json({ ok: true, status: 'failed', err: st.err });
          return;
        }
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
          stopRebroadcast(sig);
          res.json({ ok: true, status: 'confirmed' });
          return;
        }
      } catch { /* transient — keep polling */ }
      await new Promise(r => setTimeout(r, CONFIRM_POLL_MS));
    }
    if (!closed) res.json({ ok: true, status: 'pending' });
  });

  // ── MMM pool buy (fulfill-sell) ─────────────────────────────────────
  // Every MMM fulfill needs the pool's cosigner (ME's notary) as a signer;
  // ME's instruction endpoint returns the tx already cosigned, so only the
  // buyer signs. The program prices the sale itself (curve step + LP + taker
  // + enforced royalty) and rejects anything above max_payment_amount — that
  // cap is the binding we control: maxPriceSol (the curve price the UI shows
  // for the highest step of this sweep) + taker + royalty + slippage.
  // Own window: a whole-pool sweep builds one tx per NFT.
  const mmmBuyLimit = rateLimit({ limit: 40, windowMs: 60_000, label: 'buy/mmm' });
  router.get('/mmm', mmmBuyLimit, requireAuth, async (req: Request, res: Response) => {
    const pool        = String(req.query.pool ?? '').trim();
    const mint        = String(req.query.mint ?? '').trim();
    const buyer       = String(req.query.buyer ?? '').trim();
    const reqCollSlug = String(req.query.collectionSlug ?? '').trim();
    const maxPrice    = Number(req.query.maxPriceSol);
    const slippagePct = Number(req.query.maxSlippagePct ?? 1);
    let buyerPk: PublicKey, poolPk: PublicKey, mintPk: PublicKey;
    try { buyerPk = new PublicKey(buyer); poolPk = new PublicKey(pool); mintPk = new PublicKey(mint); }
    catch { res.status(400).json({ error: 'bad_request', message: 'pool, mint, buyer must be pubkeys' }); return; }
    if (!reqCollSlug || !Number.isFinite(maxPrice) || maxPrice <= 0 || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 20) {
      res.status(400).json({ error: 'bad_request', message: 'collectionSlug, maxPriceSol, maxSlippagePct required' });
      return;
    }
    // Collection binding: the pool row must be in our store for this slug.
    const row = getByCollection(reqCollSlug).find(l => l.id === `MMM:${pool}:${mint}`);
    if (!row) {
      rejectLog({ reason: 'mmm_not_in_pool', pool, mint, slug: reqCollSlug });
      res.status(404).json({ error: 'not_in_pool', message: 'This NFT is no longer in that pool.' });
      return;
    }
    if (!hasMeApiKey()) { res.status(503).json({ error: 'me_api_key_missing' }); return; }

    const royaltyBp = await enforcedRoyaltyBp(mint);
    const maxPaymentLamports = Math.ceil(
      maxPrice * (1 + (MMM_TAKER_BP + royaltyBp) / 10_000) * (1 + slippagePct / 100) * LAMPORTS_PER_SOL,
    );
    const url = new URL(`${ME_API_BASE}/instructions/mmm/sol-fulfill-sell`);
    url.searchParams.set('pool', pool);
    url.searchParams.set('assetMint', mint);
    url.searchParams.set('assetAmount', '1');
    url.searchParams.set('maxPaymentAmount', (maxPaymentLamports / LAMPORTS_PER_SOL).toFixed(9));
    url.searchParams.set('buysideCreatorRoyaltyBp', '0');
    url.searchParams.set('buyer', buyer);
    let txBytes: Buffer | null = null;
    try {
      const r = await fetch(url.toString(), { headers: { ...meAuthHeaders(), Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 300);
        rejectLog({ reason: 'mmm_me_upstream_error', pool, mint, status: r.status });
        res.status(502).json({ error: 'me_upstream_error', status: r.status, body });
        return;
      }
      const j = await r.json() as MeInstructionResponse;
      txBytes = j.txSigned?.data ? Buffer.from(j.txSigned.data) : null;
    } catch (err) {
      res.status(502).json({ error: 'me_fetch_failed', message: (err as Error).message });
      return;
    }
    if (!txBytes) { res.status(502).json({ error: 'me_response_unparseable' }); return; }

    const check = checkMmmFulfillSellTx(txBytes, { buyer: buyerPk.toBase58(), pool: poolPk.toBase58(), mint: mintPk.toBase58(), maxPaymentLamports });
    if (!check.ok) {
      rejectLog({ reason: `mmm_${check.reason}`, pool, mint, buyer: buyer.slice(0, 8), detail: check.detail });
      res.status(502).json({ error: check.reason, detail: check.detail });
      return;
    }
    console.log(`[buy/mmm] tx_built buyer=${buyer.slice(0, 8)}… pool=${pool.slice(0, 8)}… mint=${mint.slice(0, 8)}… maxPrice=${maxPrice}SOL cap=${maxPaymentLamports} royaltyBp=${royaltyBp} takerBp=${check.takerBp}`);
    res.json({ txBase64: txBytes.toString('base64'), maxPaymentLamports, royaltyBp, takerBp: check.takerBp });
  });

  router.get('/me', buyLimit, requireAuth, async (req: Request, res: Response) => {
    // Note: ME_API_KEY is only required to actually call ME. Input and
    // safety validation runs first so bad requests surface 400/409/501
    // immediately even on misconfigured servers.

    // ── Request-shape validation ─────────────────────────────────────────
    const marketplace   = String(req.query.marketplace      ?? '').trim();
    const mint          = String(req.query.mint             ?? '').trim();
    const buyer         = String(req.query.buyer            ?? '').trim();
    const reqCollSlug   = String(req.query.collectionSlug   ?? '').trim();
    const reqCollAddr   = String(req.query.collectionAddress ?? '').trim();
    const expectedPrice = Number(req.query.expectedPriceSol);
    const slippagePct   = Number(req.query.maxSlippagePct);

    if (!marketplace || !mint || !buyer ||
        !Number.isFinite(expectedPrice) || expectedPrice <= 0 ||
        !Number.isFinite(slippagePct)   || slippagePct < 0  || slippagePct > 100 ||
        (!reqCollSlug && !reqCollAddr)) {
      rejectLog({ reason: 'bad_request', mint, buyer: buyer.slice(0, 8), marketplace });
      res.status(400).json({
        error: 'bad_request',
        message: 'marketplace, mint, buyer, expectedPriceSol, maxSlippagePct, and (collectionSlug | collectionAddress) are required.',
      });
      return;
    }

    // ── Marketplace allowlist ───────────────────────────────────────────
    if (!ALLOWED_MARKETPLACES.has(marketplace)) {
      rejectLog({ reason: 'unknown_marketplace', marketplace, mint });
      res.status(400).json({ error: 'unknown_marketplace', marketplace });
      return;
    }
    if (marketplace === 'tensor') {
      rejectLog({ reason: 'unsupported_marketplace', marketplace, mint });
      res.status(501).json({ error: 'unsupported_marketplace', message: 'Tensor buy execution is not implemented on this server.' });
      return;
    }

    // ── Listing: our store first, ME only as fallback ───────────────────
    // The store row comes from ME's own snapshot or the on-chain listing
    // stream (seller / auction house / token account decoded from the list
    // tx), so it is as fresh as a re-fetch without the ~0.3–1 s round trip.
    // If it is stale anyway, M2 rejects the price mismatch on-chain.
    let listing: MeListing;
    let resolvedSlug: string | null;
    const local = meListingForBuy(mint);
    if (local) {
      listing = { price: local.priceSol, seller: local.seller, auctionHouse: local.auctionHouse, tokenAddress: local.tokenAta };
      resolvedSlug = local.slug;
    } else {
      const fetched = await fetchMeListing(mint);
      if (!fetched) {
        rejectLog({ reason: 'not_listed', mint, buyer: buyer.slice(0, 8) });
        res.status(404).json({ error: 'not_listed', message: 'No active ME listing for this mint.' });
        return;
      }
      listing = fetched;
      // Collection binding: our enriched index, then ME's listing fields,
      // then /v2/tokens/:mint. Fail closed if none resolve.
      resolvedSlug = slugForMint(mint) ?? listing.collection ?? listing.collectionSymbol ?? null;
      if (!resolvedSlug) resolvedSlug = await fetchMeTokenCollection(mint);
    }

    // ── Collection binding ──────────────────────────────────────────────
    if (!resolvedSlug) {
      rejectLog({ reason: 'collection_unverifiable', mint, buyer: buyer.slice(0, 8) });
      res.status(409).json({ error: 'collection_unverifiable', message: 'Could not confirm this mint belongs to a known collection.' });
      return;
    }
    if (reqCollSlug && resolvedSlug.toLowerCase() !== reqCollSlug.toLowerCase()) {
      rejectLog({ reason: 'collection_mismatch', mint, expected: reqCollSlug, resolved: resolvedSlug });
      res.status(409).json({
        error:    'collection_mismatch',
        expected: reqCollSlug,
        resolved: resolvedSlug,
      });
      return;
    }

    // ── Price + slippage ────────────────────────────────────────────────
    const currentPrice = listing.price!;
    const ceiling      = expectedPrice * (1 + slippagePct / 100);
    if (currentPrice > ceiling) {
      rejectLog({
        reason: 'price_above_slippage',
        mint, buyer: buyer.slice(0, 8),
        expectedPriceSol: expectedPrice,
        currentPriceSol:  currentPrice,
        maxSlippagePct:   slippagePct,
      });
      res.status(409).json({
        error: 'price_above_slippage',
        expectedPriceSol: expectedPrice,
        currentPriceSol:  currentPrice,
        maxSlippagePct:   slippagePct,
      });
      return;
    }

    const seller       = listing.seller!;
    const auctionHouse = listing.auctionHouse!;
    const tokenAta     = listing.tokenAddress;
    if (!tokenAta) {
      rejectLog({ reason: 'me_missing_token_address', mint });
      res.status(502).json({ error: 'me_listing_missing_token_address' });
      return;
    }

    // Only now do we need the ME key — every cheaper check already ran.
    if (!hasMeApiKey()) {
      res.status(503).json({ error: 'me_api_key_missing', message: 'ME_API_KEY env var not set on server.' });
      return;
    }

    // ── Fetch unsigned tx from ME ───────────────────────────────────────
    const url = new URL(`${ME_API_BASE}/instructions/buy_now`);
    url.searchParams.set('buyer',               buyer);
    url.searchParams.set('seller',              seller);
    url.searchParams.set('auctionHouseAddress', auctionHouse);
    url.searchParams.set('tokenMint',           mint);
    url.searchParams.set('tokenATA',            tokenAta);
    url.searchParams.set('price',               String(currentPrice));
    url.searchParams.set('buyerExpiry',         '-1');
    url.searchParams.set('prioFeeMicroLamports', String(BUY_PRIO_FEE_MICROLAMPORTS));

    let meRes: Awaited<ReturnType<typeof fetch>>;
    try {
      meRes = await fetch(url.toString(), {
        headers: { ...meAuthHeaders(), Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      rejectLog({ reason: 'me_fetch_failed', mint, message: (err as Error).message });
      res.status(502).json({ error: 'me_fetch_failed', message: (err as Error).message });
      return;
    }
    if (!meRes.ok) {
      const body = await meRes.text();
      rejectLog({ reason: 'me_upstream_error', mint, status: meRes.status });
      res.status(502).json({ error: 'me_upstream_error', status: meRes.status, body: body.slice(0, 500) });
      return;
    }

    const json = await meRes.json() as MeInstructionResponse;
    const txBytes = extractTxBytes(json);
    if (!txBytes) {
      rejectLog({ reason: 'me_response_unparseable', mint });
      res.status(502).json({ error: 'me_response_unparseable' });
      return;
    }

    // ── Post-build tx validation ────────────────────────────────────────
    const tx = deserializeTx(txBytes);
    if (!tx) {
      rejectLog({ reason: 'tx_decode_failed', mint });
      res.status(502).json({ error: 'tx_decode_failed' });
      return;
    }

    // 5. Mint binding — the account keys must reference the requested mint.
    const keys = accountKeyStrings(tx);
    if (!keys.includes(mint)) {
      rejectLog({ reason: 'tx_missing_mint', mint });
      res.status(502).json({ error: 'tx_missing_mint' });
      return;
    }

    // 6. Lamports bound — buyer's total SOL outflow via System.Transfer
    // must stay within the slippage-adjusted ceiling. We add a small pad
    // for network fee / optional AH fee instructions (Solana base fee +
    // priority + AH royalties already accounted for in the listing price).
    const LAMPORTS_PAD = 0.01 * LAMPORTS_PER_SOL; // 0.01 SOL tolerance
    const maxLamports  = Math.ceil(ceiling * LAMPORTS_PER_SOL) + LAMPORTS_PAD;
    let buyerPk: PublicKey;
    try { buyerPk = new PublicKey(buyer); }
    catch {
      rejectLog({ reason: 'buyer_pubkey_invalid', buyer: buyer.slice(0, 8) });
      res.status(400).json({ error: 'bad_request', message: 'buyer is not a valid pubkey' });
      return;
    }
    const buyerLamports = sumBuyerSolOut(tx, buyerPk.toBase58());
    if (buyerLamports > maxLamports) {
      rejectLog({
        reason: 'tx_exceeds_price_ceiling',
        mint,
        buyerLamports,
        maxLamports,
        expectedPriceSol: expectedPrice,
        currentPriceSol:  currentPrice,
      });
      res.status(502).json({ error: 'tx_exceeds_price_ceiling', buyerLamports, maxLamports });
      return;
    }

    // 7. Signer shape — only the buyer may remain unsigned.
    const unsigned = unsatisfiedSigners(tx);
    const unexpected = unsigned.filter(pk => pk !== buyerPk.toBase58());
    if (unexpected.length > 0) {
      rejectLog({ reason: 'tx_unexpected_signers', mint, unexpected });
      res.status(502).json({ error: 'tx_unexpected_signers', unexpected });
      return;
    }

    const txBase64 = txBytes.toString('base64');
    console.log(
      `[buy/me] tx_built  buyer=${buyer.slice(0, 8)}…  mint=${mint.slice(0, 8)}…  ` +
      `seller=${seller.slice(0, 8)}…  ah=${auctionHouse.slice(0, 8)}…  ` +
      `price=${currentPrice}SOL  buyerLamports=${buyerLamports}  maxLamports=${maxLamports}  ` +
      `slug=${resolvedSlug}`
    );

    res.json({
      txBase64,
      listing: {
        priceSol:     currentPrice,
        seller,
        auctionHouse,
        tokenAta,
        collectionSlug: resolvedSlug,
      },
      checks: {
        marketplace,
        collection:       resolvedSlug,
        expectedPriceSol: expectedPrice,
        currentPriceSol:  currentPrice,
        maxSlippagePct:   slippagePct,
        buyerLamports,
        maxLamports,
      },
    });
  });

  return router;
}
