/**
 * Lazy DAS resolver for custom-token mint payments.
 *
 * When a mint event arrives with `paymentMint` set (the user paid in an
 * SPL/Token-2022 token, not SOL), we look up the token's symbol / name /
 * image / decimals via Helius DAS getAsset exactly ONCE per unique mint
 * — token metadata is immutable for the life of a mint, so a single
 * resolved entry is permanent. Results fan out on the bus as
 * `payment_token_meta` and are replayed to new SSE clients on connect.
 *
 * Hot-path discipline: never awaited. The DAS call is fire-and-forget;
 * the live mint event is emitted with paymentMint/Amount/Decimals only,
 * and the symbol/logo arrive later via the bus.
 */
import {
  saleEventBus,
  hasPaymentTokenMeta,
  type PaymentTokenMeta,
} from '../events/emitter';

// Pending lookups (in-flight) — second sight of the same mint inside the
// DAS round-trip window must not double-fire the request.
const inflight = new Set<string>();

interface RawDasContent {
  metadata?: { name?: string; symbol?: string };
  links?:    { image?: string };
  files?:    Array<{ uri?: string; cdn_uri?: string }>;
}
interface RawDasAsset {
  content?:    RawDasContent;
  token_info?: { decimals?: number };
}
interface RawDasResponse {
  result?: RawDasAsset;
  error?:  { code: number; message: string };
}

/** Fire-and-forget resolver. Safe to call on every mint event — already-
 *  resolved or in-flight mints short-circuit without doing work. */
export function resolvePaymentToken(mint: string): void {
  if (!mint) return;
  if (hasPaymentTokenMeta(mint) || inflight.has(mint)) return;
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return;
  inflight.add(mint);
  void (async () => {
    try {
      const res = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'payment-token',
            method: 'getAsset',
            params: { id: mint },
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return;
      const json = (await res.json()) as RawDasResponse;
      if (json.error || !json.result) return;
      const a = json.result;
      const image = a.content?.links?.image
        ?? (a.content?.files ?? []).map(f => f.cdn_uri || f.uri).find(Boolean)
        ?? null;
      const out: PaymentTokenMeta = {
        mint,
        symbol:   a.content?.metadata?.symbol ?? null,
        name:     a.content?.metadata?.name   ?? null,
        image:    image ?? null,
        decimals: a.token_info?.decimals      ?? null,
      };
      saleEventBus.emitPaymentTokenMeta(out);
    } catch {
      // Quiet — next sighting retries because `inflight` clears in finally
      // and the entry isn't yet in the permanent cache.
    } finally {
      inflight.delete(mint);
    }
  })();
}
