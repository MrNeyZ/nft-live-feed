/**
 * Collection Analyzer Tool — input parser.
 *
 * Pure, network-free classification of the four supported input shapes:
 *   - a raw base58 Solana address (collection OR member mint — resolved
 *     on-chain downstream, never guessed here)
 *   - a Tensor collection URL      (tensor.trade/trade/<slug>)
 *   - a Magic Eden collection URL  (magiceden.io|us/marketplace/<slug>)
 * Anything else is `invalid` — we do not fall back to scraping or guessing.
 */

export type ParsedCollectionAnalyzerInput =
  | { kind: 'address'; address: string }
  | { kind: 'tensor_url'; slug: string }
  | { kind: 'magiceden_url'; slug: string }
  | { kind: 'invalid' };

/** Solana base58 pubkey: 32-byte → 32–44 base58 chars. Same shape used by
 *  the Holder Count tool (`tools-holders/fetch-assets.ts`). */
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Marketplace slugs are lowercase alnum + underscore/hyphen/dot, matching
 *  the shape ME/Tensor emit in their public URLs. */
const SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/;

function tryParseUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { /* fall through */ }
  try { return new URL(`https://${raw}`); } catch { return null; }
}

export function parseCollectionAnalyzerInput(raw: string): ParsedCollectionAnalyzerInput {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'invalid' };

  if (ADDR_RE.test(trimmed)) return { kind: 'address', address: trimmed };

  const url = tryParseUrl(trimmed);
  if (!url) return { kind: 'invalid' };

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'tensor.trade' && parts[0] === 'trade' && parts[1]) {
    const slug = decodeURIComponent(parts[1]);
    return SLUG_RE.test(slug) ? { kind: 'tensor_url', slug } : { kind: 'invalid' };
  }

  if ((host === 'magiceden.io' || host === 'magiceden.us') && parts[0] === 'marketplace' && parts[1]) {
    const slug = decodeURIComponent(parts[1]);
    return SLUG_RE.test(slug) ? { kind: 'magiceden_url', slug } : { kind: 'invalid' };
  }

  return { kind: 'invalid' };
}
