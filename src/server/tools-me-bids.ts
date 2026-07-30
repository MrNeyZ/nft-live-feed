/**
 * Magic Eden item-level bid tool — personal use only, not a public feature.
 *
 * ME's own web UI has (as of writing) disabled placing NEW offers on
 * Solana from the frontend. Confirmed read-only against ME's public
 * "Instruction API" (api-mainnet.magiceden.dev/v2) that the backend
 * itself is not down: GET /instructions/buy, /instructions/buy_change_price
 * and /instructions/buy_cancel all return a valid unsigned instruction for
 * a real listed mint (verified against a live okay_bears listing while
 * building this route — response shape is `{ tx: { type: 'Buffer', data:
 * number[] } }`, matching `extractTxBytes` in buy-me.ts). This router lets
 * the operator build/sign/submit those three item-level bid actions
 * directly, bypassing the broken UI. MMM pool/collection-bid creation is
 * deliberately out of scope (GET /instructions/mmm/create-pool 403s at
 * Cloudflare's edge — pre-existing, unrelated to this outage).
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — same convention as tools-dotland.ts. This process never handles
 * a private key: every route here only ever returns an unsigned (or
 * ME-partially-signed) tx for the operator's own wallet to sign client-side
 * via the existing Phantom flow (`frontend/src/wallet/phantom.ts`), exactly
 * like tools-dotland.ts and buy-me.ts already do. Submission reuses the
 * existing generic broadcast proxy, POST /api/tools/mmm-pools/send-tx —
 * no new submit endpoint here.
 *
 *   GET  /api/tools/me-bids/offers?mint=<mint>        — real bids on a mint (offers_received)
 *   GET  /api/tools/me-bids/my-offers?wallet=<wallet>  — operator's own active bids (offers_made)
 *   POST /api/tools/me-bids/build/create               — { buyer, tokenMint, priceSol, expiry? }
 *   POST /api/tools/me-bids/build/change-price          — { buyer, tokenMint, newPriceSol }
 *   POST /api/tools/me-bids/build/cancel                — { buyer, tokenMint }
 *   POST /api/tools/me-bids/simulate                    — { tx: base64 } -> simulateTransaction result
 *
 * Every build/* route re-fetches live data server-side (current offer /
 * listing, current escrow balance) rather than trusting client-supplied
 * price/pda — same defense-in-depth posture as buy-me.ts — and independently
 * sanity-checks the tx ME hands back (fee payer, mint, bounded SOL-out,
 * no unexpected required signer) before ever returning it to the browser.
 */

import { Router, Request, Response } from 'express';
import {
  PublicKey, Connection, VersionedTransaction, Transaction, SystemProgram,
} from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { meAuthHeaders, hasMeApiKey, meCooldownActive, setMeCooldown } from '../me-api-cooldown';
import { deriveBuyerEscrowPda, resolveEscrowBalances, lamportsToSol } from './me-bid-escrow';

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 10_000;

// ME's shared Auction House for the v2 "M2" program — confirmed live via a
// real okay_bears listing while building this route. Used only as a last
// resort; every build route tries to read the real auctionHouse for the
// specific mint first (from an existing offer or listing) and only falls
// back to this constant when neither is available (e.g. a brand-new bid on
// a mint with zero current offers/listings).
const DEFAULT_AUCTION_HOUSE = 'E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// ── ME API client — handles the 3 documented error shapes + shared cooldown ──

class MeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseMeErrorBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { err?: unknown; message?: unknown };
    if (typeof b.err === 'string') return b.err;
    if (Array.isArray(b.err)) {
      return b.err
        .map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : JSON.stringify(e)))
        .join('; ');
    }
    if (typeof b.message === 'string') return b.message;
  }
  return 'unknown_me_error';
}

async function meGet<T>(path: string): Promise<T> {
  if (!hasMeApiKey()) throw new MeApiError(503, 'me_api_key_not_configured');
  if (meCooldownActive()) throw new MeApiError(429, 'me_api_cooldown_active');
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${ME_API_BASE}${path}`, {
      headers: { ...meAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MeApiError(504, `me_api_unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 429) {
    setMeCooldown();
    throw new MeApiError(429, 'me_api_rate_limited');
  }
  let json: unknown;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) throw new MeApiError(res.status, parseMeErrorBody(json));
  return json as T;
}

// ── Tx decode + sanity-check (mirrors buy-me.ts's checks) ──────────────────

interface MeInstructionResponse {
  tx?:       { type?: string; data?: number[] };
  txSigned?: { type?: string; data?: number[] };
}

function extractTxBytes(json: MeInstructionResponse): Buffer | null {
  const src = json.txSigned ?? json.tx;
  if (!src?.data || !Array.isArray(src.data)) return null;
  return Buffer.from(src.data);
}

function deserializeTx(bytes: Buffer): VersionedTransaction | Transaction | null {
  try { return VersionedTransaction.deserialize(bytes); } catch { /* try legacy */ }
  try { return Transaction.from(bytes); } catch { /* give up */ }
  return null;
}

function accountKeyStrings(tx: VersionedTransaction | Transaction): string[] {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((k) => k.toBase58());
  }
  return tx.instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]);
}

function feePayerOf(tx: VersionedTransaction | Transaction): string | null {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  }
  return tx.feePayer?.toBase58() ?? tx.signatures[0]?.publicKey.toBase58() ?? null;
}

function unsatisfiedSigners(tx: VersionedTransaction | Transaction): string[] {
  if (tx instanceof VersionedTransaction) {
    const required = tx.message.staticAccountKeys
      .slice(0, tx.message.header.numRequiredSignatures)
      .map((k) => k.toBase58());
    return required.filter((_pk, i) => {
      const sig = tx.signatures[i];
      return !sig || sig.every((b) => b === 0);
    });
  }
  return tx.signatures.filter((s) => !s.signature).map((s) => s.publicKey.toBase58());
}

/** Sum of SystemProgram::Transfer lamports flowing out of `owner`. */
function sumSystemTransferOut(tx: VersionedTransaction | Transaction, owner: string): number {
  const systemProgramId = SystemProgram.programId.toBase58();
  let lamportsOut = 0;

  if (tx instanceof VersionedTransaction) {
    const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      if (staticKeys[ix.programIdIndex] !== systemProgramId) continue;
      const data = ix.data as Uint8Array;
      if (data.length < 12) continue;
      const variant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
      if (variant !== 2) continue;
      const fromIdx = ix.accountKeyIndexes[0];
      if (fromIdx == null || staticKeys[fromIdx] !== owner) continue;
      lamportsOut += Number(Buffer.from(data.buffer, data.byteOffset + 4, 8).readBigUInt64LE(0));
    }
    return lamportsOut;
  }

  for (const ix of tx.instructions) {
    if (ix.programId.toBase58() !== systemProgramId) continue;
    const data = ix.data;
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;
    if (ix.keys[0]?.pubkey.toBase58() !== owner) continue;
    lamportsOut += Number(data.readBigUInt64LE(4));
  }
  return lamportsOut;
}

interface SanityCheckResult {
  tx: VersionedTransaction | Transaction;
  txType: 'versioned' | 'legacy';
  accountKeys: string[];
  feePayer: string | null;
  buyerLamportsOut: number;
}

/** Throws a descriptive error on any mismatch — callers 502 with the message
 *  rather than ever returning a tx that failed a check. */
function sanityCheckTx(
  bytes: Buffer,
  opts: { expectedBuyer: string; expectedMint: string; maxLamportsOut: number | null },
): SanityCheckResult {
  const tx = deserializeTx(bytes);
  if (!tx) throw new Error('tx_undecodable');
  const txType = tx instanceof VersionedTransaction ? 'versioned' : 'legacy';
  const accountKeys = accountKeyStrings(tx);
  const feePayer = feePayerOf(tx);

  if (feePayer !== opts.expectedBuyer) {
    throw new Error(`fee_payer_mismatch: expected ${opts.expectedBuyer}, got ${feePayer}`);
  }
  if (!accountKeys.includes(opts.expectedMint)) {
    throw new Error('mint_mismatch: expected mint not found in tx account keys');
  }
  const badSigners = unsatisfiedSigners(tx).filter((pk) => pk !== opts.expectedBuyer);
  if (badSigners.length > 0) {
    throw new Error(`unexpected_signer: tx requires a signature we can't provide (${badSigners.join(', ')})`);
  }
  const buyerLamportsOut = sumSystemTransferOut(tx, opts.expectedBuyer);
  if (opts.maxLamportsOut != null && buyerLamportsOut > opts.maxLamportsOut) {
    throw new Error(
      `price_exceeds_expected: tx would move ${buyerLamportsOut} lamports from buyer, expected at most ${opts.maxLamportsOut}`,
    );
  }
  return { tx, txType, accountKeys, feePayer, buyerLamportsOut };
}

function serializeForClient(tx: VersionedTransaction | Transaction): string {
  if (tx instanceof VersionedTransaction) return Buffer.from(tx.serialize()).toString('base64');
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

// ── Input validation helpers ────────────────────────────────────────────

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}

function parsePriceSol(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

interface MeOffer {
  pdaAddress?: string;
  tokenMint?: string;
  auctionHouse?: string;
  buyer?: string;
  price?: number;
  expiry?: number;
}

async function findOwnOffer(mint: string, buyer: string): Promise<MeOffer | null> {
  const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
  if (!Array.isArray(offers)) return null;
  return offers.find((o) => o.buyer === buyer) ?? null;
}

async function resolveAuctionHouse(mint: string): Promise<{ address: string; source: 'offer' | 'listing' | 'default' }> {
  try {
    const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
    const withAh = Array.isArray(offers) ? offers.find((o) => o.auctionHouse) : null;
    if (withAh?.auctionHouse) return { address: withAh.auctionHouse, source: 'offer' };
  } catch { /* fall through */ }
  try {
    const listings = await meGet<Array<{ auctionHouse?: string }>>(`/tokens/${encodeURIComponent(mint)}/listings`);
    const withAh = Array.isArray(listings) ? listings.find((l) => l.auctionHouse) : null;
    if (withAh?.auctionHouse) return { address: withAh.auctionHouse, source: 'listing' };
  } catch { /* fall through */ }
  return { address: DEFAULT_AUCTION_HOUSE, source: 'default' };
}

async function currentEscrowSol(auctionHouse: string, buyer: string): Promise<number | null> {
  const pda = deriveBuyerEscrowPda(auctionHouse, buyer);
  if (!pda) return null;
  const { balances } = await resolveEscrowBalances([pda]);
  return lamportsToSol(balances.get(pda) ?? null);
}

export function createMeBidsRouter(): Router {
  const router = Router();
  const readLimit  = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-bids/read' });
  const buildLimit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-bids/build' });
  const simLimit   = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-bids/simulate' });
  const conn = new Connection(rpcUrl(), 'confirmed');

  router.get('/tools/me-bids/offers', readLimit, requireAuth, async (req: Request, res: Response) => {
    const mint = String(req.query.mint ?? '').trim();
    if (!parsePubkey(mint)) return res.status(400).json({ ok: false, error: 'invalid_mint' });
    try {
      const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
      return res.json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
    } catch (err) {
      const e = err as MeApiError;
      return res.status(e.status ?? 502).json({ ok: false, error: e.message });
    }
  });

  router.get('/tools/me-bids/my-offers', readLimit, requireAuth, async (req: Request, res: Response) => {
    const wallet = String(req.query.wallet ?? '').trim();
    if (!parsePubkey(wallet)) return res.status(400).json({ ok: false, error: 'invalid_wallet' });
    try {
      const offers = await meGet<MeOffer[]>(`/wallets/${encodeURIComponent(wallet)}/offers_made?limit=100`);
      return res.json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
    } catch (err) {
      const e = err as MeApiError;
      return res.status(e.status ?? 502).json({ ok: false, error: e.message });
    }
  });

  router.post('/tools/me-bids/build/create', buildLimit, requireAuth, async (req: Request, res: Response) => {
    const { buyer, tokenMint, priceSol, expiry } = req.body as {
      buyer?: string; tokenMint?: string; priceSol?: number; expiry?: number;
    };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    const price = parsePriceSol(priceSol);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });
    if (price == null) return res.status(400).json({ ok: false, error: 'invalid_price_sol' });
    const expiryVal = expiry != null && Number.isFinite(Number(expiry)) ? Number(expiry) : undefined;

    try {
      const { address: auctionHouseAddress, source: auctionHouseSource } = await resolveAuctionHouse(mintPk.toBase58());
      let path = `/instructions/buy?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${price}&auctionHouseAddress=${auctionHouseAddress}`;
      if (expiryVal !== undefined) path += `&expiry=${expiryVal}`;

      const json = await meGet<MeInstructionResponse>(path);
      const bytes = extractTxBytes(json);
      if (!bytes) return res.status(502).json({ ok: false, error: 'me_response_missing_tx' });

      const priceLamports = Math.round(price * 1e9);
      // Small buffer for network/priority fee + a fresh deposit possibly
      // being bundled into the same tx; not a loose bound, just not exact.
      const maxLamportsOut = priceLamports + 50_000;
      const check = sanityCheckTx(bytes, {
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        maxLamportsOut,
      });

      const escrowSol = await currentEscrowSol(auctionHouseAddress, buyerPk.toBase58()).catch(() => null);

      return res.json({
        ok: true,
        tx: serializeForClient(check.tx),
        txType: check.txType,
        summary: {
          action: 'create',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          priceSol: price,
          expiry: expiryVal ?? null,
          auctionHouseAddress,
          auctionHouseSource,
          feePayer: check.feePayer,
          buyerLamportsOut: check.buyerLamportsOut,
          currentEscrowSol: escrowSol,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/create error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/me-bids/build/change-price', buildLimit, requireAuth, async (req: Request, res: Response) => {
    const { buyer, tokenMint, newPriceSol } = req.body as {
      buyer?: string; tokenMint?: string; newPriceSol?: number;
    };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    const newPrice = parsePriceSol(newPriceSol);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });
    if (newPrice == null) return res.status(400).json({ ok: false, error: 'invalid_new_price_sol' });

    try {
      // Re-fetch the real existing offer server-side — never trust a
      // client-supplied old price / pda / auction house for this.
      const existing = await findOwnOffer(mintPk.toBase58(), buyerPk.toBase58());
      if (!existing || existing.price == null || !existing.auctionHouse) {
        return res.status(404).json({ ok: false, error: 'offer_not_found' });
      }

      const path = `/instructions/buy_change_price?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${existing.price}&newPrice=${newPrice}&auctionHouseAddress=${existing.auctionHouse}`;
      const json = await meGet<MeInstructionResponse>(path);
      const bytes = extractTxBytes(json);
      if (!bytes) return res.status(502).json({ ok: false, error: 'me_response_missing_tx' });

      const newPriceLamports = Math.round(newPrice * 1e9);
      const oldPriceLamports = Math.round(existing.price * 1e9);
      // Raising a bid requires an extra deposit ~= (new - old); lowering
      // requires none. Bound generously above the raise amount only.
      const maxLamportsOut = Math.max(0, newPriceLamports - oldPriceLamports) + 50_000;
      const check = sanityCheckTx(bytes, {
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        maxLamportsOut,
      });

      return res.json({
        ok: true,
        tx: serializeForClient(check.tx),
        txType: check.txType,
        summary: {
          action: 'change-price',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          oldPriceSol: existing.price,
          newPriceSol: newPrice,
          auctionHouseAddress: existing.auctionHouse,
          pdaAddress: existing.pdaAddress ?? null,
          feePayer: check.feePayer,
          buyerLamportsOut: check.buyerLamportsOut,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/change-price error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/me-bids/build/cancel', buildLimit, requireAuth, async (req: Request, res: Response) => {
    const { buyer, tokenMint } = req.body as { buyer?: string; tokenMint?: string };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });

    try {
      const existing = await findOwnOffer(mintPk.toBase58(), buyerPk.toBase58());
      if (!existing || existing.price == null || !existing.auctionHouse) {
        return res.status(404).json({ ok: false, error: 'offer_not_found' });
      }

      const path = `/instructions/buy_cancel?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${existing.price}&auctionHouseAddress=${existing.auctionHouse}`;
      const json = await meGet<MeInstructionResponse>(path);
      const bytes = extractTxBytes(json);
      if (!bytes) return res.status(502).json({ ok: false, error: 'me_response_missing_tx' });

      // Cancel refunds SOL to the buyer — no upper bound on outflow, just
      // the structural checks (fee payer / mint / signer shape).
      const check = sanityCheckTx(bytes, {
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        maxLamportsOut: null,
      });

      return res.json({
        ok: true,
        tx: serializeForClient(check.tx),
        txType: check.txType,
        summary: {
          action: 'cancel',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          priceSol: existing.price,
          auctionHouseAddress: existing.auctionHouse,
          pdaAddress: existing.pdaAddress ?? null,
          feePayer: check.feePayer,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/cancel error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  // Simulation is mandatory in the frontend flow before any real signature
  // is requested from the wallet (see app/tools/me-bids/page.tsx).
  router.post('/tools/me-bids/simulate', simLimit, requireAuth, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') return res.status(400).json({ ok: false, error: 'missing_tx' });
    let bytes: Buffer;
    try { bytes = Buffer.from(tx, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'invalid_tx_encoding' }); }
    const decoded = deserializeTx(bytes);
    if (!decoded) return res.status(400).json({ ok: false, error: 'tx_undecodable' });

    try {
      if (decoded instanceof VersionedTransaction) {
        const sim = await conn.simulateTransaction(decoded, { sigVerify: false, replaceRecentBlockhash: true });
        return res.json({
          ok: true,
          err: sim.value.err,
          logs: sim.value.logs ?? [],
          unitsConsumed: sim.value.unitsConsumed ?? null,
        });
      }
      const sim = await conn.simulateTransaction(decoded);
      return res.json({
        ok: true,
        err: sim.value.err,
        logs: sim.value.logs ?? [],
        unitsConsumed: sim.value.unitsConsumed ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/me-bids] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
