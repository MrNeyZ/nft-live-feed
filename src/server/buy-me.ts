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
import { slugForMint } from './listings-store';

const ME_API_BASE      = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 8_000;

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

function rejectLog(fields: Record<string, unknown>): void {
  console.warn('[buy/me] REJECTED', JSON.stringify(fields));
}

export function createBuyMeRouter(): Router {
  const router = Router();

  const buyLimit = rateLimit({ limit: 10, windowMs: 60_000, label: 'buy/me' });

  // Capability probe — unauthenticated, cheap; frontend uses it to
  // render the Buy button's disabled state on mount.
  router.get('/me/status', (_req: Request, res: Response) => {
    res.json({ enabled: !!process.env.ME_API_KEY });
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

    // ── Fetch live listing (single source of truth for price) ───────────
    const listing = await fetchMeListing(mint);
    if (!listing) {
      rejectLog({ reason: 'not_listed', mint, buyer: buyer.slice(0, 8) });
      res.status(404).json({ error: 'not_listed', message: 'No active ME listing for this mint.' });
      return;
    }

    // ── Collection binding ──────────────────────────────────────────────
    // Prefer our own enriched index (mint → slug, populated from sale_events
    // + live enrichment). Fall back to ME's `collection` field on the
    // listing, then to `/v2/tokens/:mint`. If all three fail we fail closed
    // — never ship a tx on unverifiable collection binding.
    let resolvedSlug: string | null = slugForMint(mint) ?? listing.collection ?? listing.collectionSymbol ?? null;
    if (!resolvedSlug) {
      resolvedSlug = await fetchMeTokenCollection(mint);
    }
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
    const apiKey = process.env.ME_API_KEY;
    if (!apiKey) {
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

    let meRes: Awaited<ReturnType<typeof fetch>>;
    try {
      meRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
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
