/**
 * "Duplicate existing NFT" tool — resolves the off-chain metadata JSON for
 * NFT #n of a collection whose asset URIs follow a predictable numbered
 * pattern (`.../1447.json`, one file per mint index — the shape a
 * generative drop's own asset folder always is). Given one real example
 * URI (copied from any already-minted NFT in the collection, e.g. via the
 * existing signature-decode path) and a target number, this derives that
 * number's own URI, fetches its JSON, and returns the same
 * name/uri/image/description/royalty fields build.ts's mint builders need
 * — feeding straight into the SAME Core create path as everything else in
 * this tool. There's no new mint-building logic here; this only replaces
 * "load metadata from a landed tx" with "load metadata from a number".
 */

const MAX_METADATA_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 8_000;

/** Swaps the trailing number in a URI for `n`, unpadded (e.g.
 *  `.../1447.json` + 1 → `.../1.json`) — matches the plain sequential
 *  naming every real example so far has used. Returns null if the example
 *  URI has no trailing number to swap. */
export function deriveUriForNumber(exampleUri: string, n: number): string | null {
  const m = exampleUri.match(/^(.*?)(\d+)(\.\w+)?$/);
  if (!m) return null;
  const [, prefix, , ext = ''] = m;
  return `${prefix}${n}${ext}`;
}

/** Minimal SSRF guard: this endpoint fetches a URL an authenticated
 *  operator supplies, but only http(s) to a public-looking host — no
 *  internal metadata services, loopback, or link-local. */
function isSafeMetadataUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

export interface ResolvedDuplicateMetadata {
  n: number;
  uri: string;
  name: string;
  image: string | null;
  description: string | null;
  royaltyBp: number;
}

export type ResolveDuplicateResult =
  | { ok: true; resolved: ResolvedDuplicateMetadata }
  | { ok: false; error: string };

interface MetadataJson {
  name?: string;
  image?: string;
  description?: string;
  seller_fee_basis_points?: number;
}

export async function resolveDuplicateMetadata(exampleUri: string, n: number): Promise<ResolveDuplicateResult> {
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'invalid_number' };
  const uri = deriveUriForNumber(exampleUri, n);
  if (!uri) return { ok: false, error: 'example_uri_has_no_number' };
  if (!isSafeMetadataUrl(uri)) return { ok: false, error: 'unsafe_metadata_url' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(uri, { signal: controller.signal });
  } catch (err) {
    return { ok: false, error: `metadata_fetch_failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return { ok: false, error: `metadata_not_found: HTTP ${res.status}` };

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_METADATA_BYTES) {
    return { ok: false, error: 'metadata_too_large' };
  }

  let json: MetadataJson;
  try {
    json = await res.json() as MetadataJson;
  } catch {
    return { ok: false, error: 'metadata_not_valid_json' };
  }
  if (typeof json.name !== 'string' || !json.name.trim()) {
    return { ok: false, error: 'metadata_missing_name' };
  }

  return {
    ok: true,
    resolved: {
      n,
      uri,
      name: json.name.trim(),
      image: typeof json.image === 'string' ? json.image : null,
      description: typeof json.description === 'string' ? json.description : null,
      royaltyBp: typeof json.seller_fee_basis_points === 'number' ? json.seller_fee_basis_points : 0,
    },
  };
}
