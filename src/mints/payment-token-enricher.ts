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
import { incGetAsset } from '../helius-credit-metrics';

// Pending lookups (in-flight) — second sight of the same mint inside the
// DAS round-trip window must not double-fire the request.
const inflight = new Set<string>();

// Retry schedule for a FAILED lookup. Token metadata is available on DAS
// permanently (it's an existing token, not a just-created asset), so a
// failure here is transient — a rate-limit (429) during a mint burst, a
// timeout, or a momentary DAS hiccup. Without a retry the symbol/logo only
// gets another chance when the SAME token prices another mint, which for a
// rarely-used payment token (e.g. USDC on a Core launchpad) can be a long
// time — leaving the card showing the shortened mint address instead of
// the token name/logo. These spaced retries close that gap. Success caches
// permanently (hasPaymentTokenMeta), so a resolved token never retries.
const RETRY_DELAYS_MS = [10_000, 45_000, 180_000];

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
export function resolvePaymentToken(mint: string, attempt = 0): void {
  if (!mint) return;
  if (hasPaymentTokenMeta(mint) || inflight.has(mint)) return;
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return;
  inflight.add(mint);
  void (async () => {
    let ok = false;
    try {
      incGetAsset('payment_token_enrich');
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
      ok = true;
    } catch {
      // Quiet — handled by the retry scheduled in `finally` below.
    } finally {
      inflight.delete(mint);
      // On failure, retry a few times on a spaced schedule. Token metadata
      // is permanent on DAS, so this only ever recovers from a transient
      // failure (429 / timeout / hiccup) — a genuinely unresolvable token
      // exhausts the schedule and simply keeps its shortMint label. Nothing
      // is cached on failure, so a later organic sighting can still resolve
      // it even after the schedule is exhausted.
      if (!ok && attempt < RETRY_DELAYS_MS.length) {
        const timer = setTimeout(
          () => resolvePaymentToken(mint, attempt + 1),
          RETRY_DELAYS_MS[attempt],
        );
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  })();
}
