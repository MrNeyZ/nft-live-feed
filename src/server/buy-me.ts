/**
 * Magic Eden buy-now transaction builder (server-side).
 *
 *   Flow per request:
 *     1. Re-fetch the live ME listing for the mint (single source of truth).
 *     2. Verify the buyer's quoted price still matches (fail with 409 + the
 *        current price so the UI can re-prompt).
 *     3. Derive the seller's associated token account (ME's `tokenATA` param).
 *     4. Call ME `/v2/instructions/buy_now` with `Authorization: Bearer
 *        <ME_API_KEY>` to get the partially-signed transaction.
 *     5. Return it as base64 plus the listing snapshot used to validate.
 *
 * The buyer signs and submits in the browser — no key material here. Without
 * an `ME_API_KEY` the route returns 503 so the UI can render a clear
 * "buying disabled" message instead of a misleading failure.
 *
 * Tolerance: prices can be quoted in SOL with float precision. We allow a
 * 0.0005 SOL absolute tolerance (≈ network fee noise) to avoid spurious 409s
 * when the listing didn't actually change.
 */

import { Router, Request, Response } from 'express';

const ME_API_BASE        = 'https://api-mainnet.magiceden.dev/v2';
const PRICE_TOLERANCE_SOL = 0.0005;
const FETCH_TIMEOUT_MS    = 8_000;

interface MeListing {
  price?:        number;
  seller?:       string;
  auctionHouse?: string;
  tokenAddress?: string;   // seller's ATA holding the NFT (ME provides this)
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

interface MeInstructionResponse {
  // Older shape: { tx: { type:'Buffer', data:[…] }, txSigned: { …same… } }
  tx?:       { type?: string; data?: number[] };
  txSigned?: { type?: string; data?: number[] };
}

/** Pull the base64 transaction out of either shape ME returns. */
function extractTxBase64(json: MeInstructionResponse): string | null {
  // Prefer txSigned (already partially signed by ME's authority + seller).
  const src = json.txSigned ?? json.tx;
  if (!src?.data || !Array.isArray(src.data)) return null;
  return Buffer.from(src.data).toString('base64');
}

export function createBuyMeRouter(): Router {
  const router = Router();

  // Capability probe — frontend calls this on mount so the Buy button can
  // render as "Buy unavailable (server)" *before* the user ever clicks.
  // Returns whether the server is configured to fetch ME tx instructions.
  router.get('/me/status', (_req: Request, res: Response) => {
    res.json({ enabled: !!process.env.ME_API_KEY });
  });

  router.get('/me', async (req: Request, res: Response) => {
    const apiKey = process.env.ME_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'me_api_key_missing', message: 'ME_API_KEY env var not set on server.' });
      return;
    }

    const mint            = String(req.query.mint    ?? '').trim();
    const buyer           = String(req.query.buyer   ?? '').trim();
    const expectedPrice   = Number(req.query.price);
    if (!mint || !buyer || !Number.isFinite(expectedPrice) || expectedPrice <= 0) {
      res.status(400).json({ error: 'bad_request', message: 'mint, buyer, and price are required.' });
      return;
    }

    // ── 1. Re-validate listing on the server ─────────────────────────────
    const listing = await fetchMeListing(mint);
    if (!listing) {
      res.status(404).json({ error: 'not_listed', message: 'No active ME listing for this mint.' });
      return;
    }
    if (Math.abs((listing.price ?? 0) - expectedPrice) > PRICE_TOLERANCE_SOL) {
      res.status(409).json({
        error: 'price_changed',
        expectedPriceSol: expectedPrice,
        currentPriceSol:  listing.price,
        currentSeller:    listing.seller,
      });
      return;
    }

    const seller       = listing.seller!;
    const auctionHouse = listing.auctionHouse!;
    // Use ME's `tokenAddress` directly — for escrowed listings this is the AH
    // escrow PDA, not `getAssociatedTokenAddressSync(mint, seller)`. Deriving
    // would be wrong for any non-Hyperdrive listing. (Verified live:
    // listing.tokenAddress=7V5GH… vs derived ATA=Gg1sUSj… for the same pair.)
    const tokenAta = listing.tokenAddress;
    if (!tokenAta) {
      res.status(502).json({ error: 'me_listing_missing_token_address' });
      return;
    }

    // ── 2. Fetch instruction from ME ────────────────────────────────────
    const url = new URL(`${ME_API_BASE}/instructions/buy_now`);
    url.searchParams.set('buyer',               buyer);
    url.searchParams.set('seller',              seller);
    url.searchParams.set('auctionHouseAddress', auctionHouse);
    url.searchParams.set('tokenMint',           mint);
    url.searchParams.set('tokenATA',            tokenAta);
    url.searchParams.set('price',               String(listing.price));
    url.searchParams.set('buyerExpiry',         '-1');

    let meRes: Awaited<ReturnType<typeof fetch>>;
    try {
      meRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      res.status(502).json({ error: 'me_fetch_failed', message: (err as Error).message });
      return;
    }
    if (!meRes.ok) {
      const body = await meRes.text();
      res.status(502).json({ error: 'me_upstream_error', status: meRes.status, body: body.slice(0, 500) });
      return;
    }

    const json = await meRes.json() as MeInstructionResponse;
    const txBase64 = extractTxBase64(json);
    if (!txBase64) {
      res.status(502).json({ error: 'me_response_unparseable' });
      return;
    }

    // Lightweight pre-buy log so the first real test leaves a trail in the
    // server log even if the client never confirms. Mint+seller+ah+price are
    // the four fields needed to reproduce the call.
    console.log(
      `[buy/me] tx_built  buyer=${buyer.slice(0, 8)}…  mint=${mint.slice(0, 8)}…  ` +
      `seller=${seller.slice(0, 8)}…  ah=${auctionHouse.slice(0, 8)}…  ` +
      `price=${listing.price} SOL  tokenAta=${tokenAta.slice(0, 8)}…`
    );

    res.json({
      txBase64,
      listing: {
        priceSol:     listing.price,
        seller,
        auctionHouse,
        tokenAta,
      },
    });
  });

  return router;
}
