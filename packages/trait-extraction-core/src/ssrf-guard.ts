/**
 * Trait Extraction Core — SSRF-safe resource download.
 *
 * Moved here from the app's Stage 3/4 bundle feature (Stage 5.3) - the
 * same downloader is this package's default `ImageAcquirer` implementation
 * AND still backs the app's raw bundle export (which now imports it back
 * from `trait-extraction-core` - see bundle/image-fetch.ts,
 * bundle/metadata-fetch.ts, bundle/bundle-run.ts). Single implementation,
 * no duplication; this package has zero import in the other direction.
 *
 * Every bundle download (image or original off-chain metadata) goes through
 * `downloadToFile`. Two layers of protection, both required:
 *
 *   1. Upfront validation — before issuing a request, the destination
 *      hostname is resolved via `dns.lookup` and every returned address is
 *      checked against `isPublicAddress` (ipaddr.js `range() === 'unicast'`
 *      only — rejects private/loopback/link-local/unique-local/CGNAT/
 *      multicast/reserved/IPv4-mapped-private, for BOTH IPv4 and IPv6).
 *      Gives a clean, fast `blocked_destination` failure instead of letting
 *      a bad connection attempt happen at all.
 *   2. Connection-time pinning — the actual `http.Agent`/`https.Agent` is
 *      constructed with a custom `lookup` that re-resolves and re-validates
 *      at the exact moment Node opens the socket. This closes the
 *      DNS-rebinding gap between step 1's check and the real connection
 *      (a hostname could resolve to a public IP during validation and a
 *      private one microseconds later at connect time) — the SAME lookup
 *      function gates both, since it's the one Node actually calls to get
 *      the address it connects to.
 *
 * Redirects are followed MANUALLY (never `redirect: 'follow'`) so every hop
 * gets both layers of validation before being followed — a malicious server
 * cannot 302 the fetch into a private address after passing the initial
 * check.
 *
 * No cookies, no Authorization header, no project secrets, no
 * caller-supplied headers are ever sent — only a fixed identifying
 * User-Agent + Accept header this module controls.
 */
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as fs from 'fs';
import ipaddr from 'ipaddr.js';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Generic download defaults - callers (both the app's bundle feature and
 *  this package's own image-io) normally override timeout/redirects
 *  per-call; these are the fallback when they don't. Same values Stage 3
 *  originally shipped as DOWNLOAD_DEFAULT_MAX_REDIRECTS etc - renamed neutrally
 *  since this module no longer belongs to the bundle feature. */
const DOWNLOAD_DEFAULT_MAX_REDIRECTS = envInt('DOWNLOAD_DEFAULT_MAX_REDIRECTS', 3);
const DOWNLOAD_DEFAULT_TIMEOUT_MS = envInt('DOWNLOAD_DEFAULT_TIMEOUT_MS', 20_000);
const DOWNLOAD_DEFAULT_MAX_RETRIES = envInt('DOWNLOAD_DEFAULT_MAX_RETRIES', 3);
const DOWNLOAD_DEFAULT_RETRY_BASE_MS = envInt('DOWNLOAD_DEFAULT_RETRY_BASE_MS', 500);
const DOWNLOAD_DEFAULT_RETRY_MAX_WAIT_MS = envInt('DOWNLOAD_DEFAULT_RETRY_MAX_WAIT_MS', 8_000);

/** Machine-readable, never a raw provider/error message. Canonical
 *  definition lives here (the module that actually produces these codes);
 *  the app's bundle/bundle-types.ts re-exports this type rather than
 *  redefining it. */
export type DownloadFailureCode =
  | 'no_source_url'
  | 'invalid_url'
  | 'blocked_destination'
  | 'unsupported_protocol'
  | 'too_many_redirects'
  | 'http_error'
  | 'unsupported_content_type'
  | 'oversized'
  | 'timeout'
  | 'malformed_json'
  | 'network_error'
  | 'cancelled'
  | 'retries_exhausted';

/** Allowlist check: ONLY globally-routable unicast addresses pass. Every
 *  other ipaddr.js range (private, loopback, linkLocal, uniqueLocal,
 *  carrierGradeNat, unspecified, broadcast, multicast, reserved, and
 *  IPv4-mapped-IPv6 that unwraps to any of those) is rejected. */
export function isPublicAddress(ip: string): boolean {
  try {
    const addr = ipaddr.process(ip); // unwraps ::ffff:a.b.c.d to the IPv4 view
    return addr.range() === 'unicast';
  } catch {
    return false;
  }
}

export type AddressValidator = (ip: string) => boolean;

async function resolveAndValidate(hostname: string, validator: AddressValidator): Promise<{ ok: true } | { ok: false }> {
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return { ok: false };
    return addresses.every((a) => validator(a.address)) ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Builds a custom `lookup` for the request Agent — pins the connection to
 *  a freshly-revalidated address at the moment Node actually connects. */
function makeSsrfSafeLookup(validator: AddressValidator): typeof dns.lookup {
  return ((
    hostname: string,
    options: dns.LookupAllOptions | dns.LookupOneOptions | dns.LookupOptions | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
    callback?: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) { cb(err, '', 0); return; }
      const list = addresses as unknown as dns.LookupAddress[];
      const valid = list.filter((a) => validator(a.address));
      if (valid.length === 0) {
        cb(Object.assign(new Error('SSRF_BLOCKED_DESTINATION'), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      if ((opts as dns.LookupAllOptions).all) {
        cb(null, valid);
      } else {
        cb(null, valid[0].address, valid[0].family);
      }
    });
  }) as unknown as typeof dns.lookup;
}

// Production path: shared, connection-pooled agents using the REAL
// public-address allowlist. Every real caller (image-fetch.ts,
// metadata-fetch.ts) goes through these, unmodified.
const httpAgent = new http.Agent({ lookup: makeSsrfSafeLookup(isPublicAddress), keepAlive: false });
const httpsAgent = new https.Agent({ lookup: makeSsrfSafeLookup(isPublicAddress), keepAlive: false });

const USER_AGENT = 'VictoryLabs-CollectionBundle/1.0 (+read-only NFT metadata/image fetch)';

export interface DownloadOptions {
  destPath: string;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal: AbortSignal;
  /** TEST-ONLY. When provided, used INSTEAD of `isPublicAddress` for every
   *  destination check (initial + per-redirect-hop + connection-time
   *  pinning), and a fresh per-call Agent is built around it rather than
   *  reusing the shared pooled agents. Production code (image-fetch.ts,
   *  metadata-fetch.ts) never sets this — real traffic always goes through
   *  the real SSRF allowlist. Exists so tests can exercise the actual
   *  retry/redirect/timeout/streaming logic against a real local
   *  (loopback) test server, which the real allowlist would otherwise
   *  always reject by design. */
  isDestinationAllowedOverride?: AddressValidator;
}

export type DownloadOutcome =
  | { ok: true; statusCode: number; contentType: string | null; bytesWritten: number; finalUrl: string }
  | { ok: false; code: 'http_error'; httpStatus: number }
  | { ok: false; code: Exclude<DownloadFailureCode, 'http_error' | 'retries_exhausted'> };

async function unlinkQuiet(path: string): Promise<void> {
  try { await fs.promises.unlink(path); } catch { /* best-effort */ }
}

/** Single attempt (no retry) — one full redirect chain. Never throws. */
async function attemptDownload(url: string, opts: DownloadOptions): Promise<DownloadOutcome> {
  const maxRedirects = opts.maxRedirects ?? DOWNLOAD_DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try { parsed = new URL(currentUrl); } catch { return { ok: false, code: 'invalid_url' }; }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, code: 'unsupported_protocol' };
    }

    const validator = opts.isDestinationAllowedOverride ?? isPublicAddress;
    const validation = await resolveAndValidate(parsed.hostname, validator);
    if (!validation.ok) return { ok: false, code: 'blocked_destination' };

    const isHttps = parsed.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    // Test-only override -> build a fresh per-call agent around it (never
    // pooled/shared, tests don't care). Production (no override) reuses the
    // shared pooled agents built from the real `isPublicAddress` allowlist.
    const agent = opts.isDestinationAllowedOverride
      ? new (isHttps ? https.Agent : http.Agent)({ lookup: makeSsrfSafeLookup(opts.isDestinationAllowedOverride), keepAlive: false })
      : (isHttps ? httpsAgent : httpAgent);

    const hopResult = await new Promise<
      | { kind: 'redirect'; location: string }
      | { kind: 'response'; outcome: DownloadOutcome }
    >((resolve) => {
      let settled = false;
      const settle = (v: { kind: 'redirect'; location: string } | { kind: 'response'; outcome: DownloadOutcome }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const timeoutMs = opts.timeoutMs ?? DOWNLOAD_DEFAULT_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([timeoutSignal, opts.signal]);

      const req = requestFn(parsed, {
        agent,
        signal: combinedSignal,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      }, (res) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain, discard body
          let nextUrl: string;
          try { nextUrl = new URL(res.headers.location, parsed).toString(); }
          catch { settle({ kind: 'response', outcome: { ok: false, code: 'invalid_url' } }); return; }
          settle({ kind: 'redirect', location: nextUrl });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          settle({ kind: 'response', outcome: { ok: false, code: 'http_error', httpStatus: status } });
          return;
        }

        const contentType = res.headers['content-type'] ?? null;
        const writeStream = fs.createWriteStream(opts.destPath);
        let bytes = 0;
        let aborted = false;

        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          bytes += chunk.length;
          if (bytes > opts.maxBytes) {
            aborted = true;
            res.destroy();
            writeStream.destroy();
            void unlinkQuiet(opts.destPath);
            settle({ kind: 'response', outcome: { ok: false, code: 'oversized' } });
          }
        });
        res.on('error', () => {
          if (aborted) return;
          aborted = true;
          writeStream.destroy();
          void unlinkQuiet(opts.destPath);
          settle({ kind: 'response', outcome: { ok: false, code: 'network_error' } });
        });
        writeStream.on('error', () => {
          if (aborted) return;
          aborted = true;
          res.destroy();
          void unlinkQuiet(opts.destPath);
          settle({ kind: 'response', outcome: { ok: false, code: 'network_error' } });
        });
        writeStream.on('finish', () => {
          if (aborted) return;
          settle({ kind: 'response', outcome: { ok: true, statusCode: status, contentType, bytesWritten: bytes, finalUrl: currentUrl } });
        });
        res.pipe(writeStream);
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (opts.signal.aborted) { settle({ kind: 'response', outcome: { ok: false, code: 'cancelled' } }); return; }
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          settle({ kind: 'response', outcome: { ok: false, code: 'timeout' } });
          return;
        }
        if (err.message === 'SSRF_BLOCKED_DESTINATION' || err.code === 'ENOTFOUND') {
          settle({ kind: 'response', outcome: { ok: false, code: 'blocked_destination' } });
          return;
        }
        settle({ kind: 'response', outcome: { ok: false, code: 'network_error' } });
      });
      req.end();
    });

    if (hopResult.kind === 'response') return hopResult.outcome;
    currentUrl = hopResult.location;
    if (hop === maxRedirects) return { ok: false, code: 'too_many_redirects' };
  }
  return { ok: false, code: 'too_many_redirects' };
}

function backoffWaitMs(attempt: number): number {
  const base = DOWNLOAD_DEFAULT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * DOWNLOAD_DEFAULT_RETRY_BASE_MS;
  return Math.min(DOWNLOAD_DEFAULT_RETRY_MAX_WAIT_MS, Math.round(base + jitter));
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-eligible ONLY for: HTTP 429, transient 5xx (500/502/503/504), or a
 *  generic transport-level network error (connection reset etc. — those
 *  are transient by nature). Every other code — blocked destination, bad
 *  URL, oversized, unsupported content, timeout, malformed JSON,
 *  cancellation, and permanent 4xx (404/403/...) — is NOT retried. */
function isRetryable(outcome: DownloadOutcome & { ok: false }): boolean {
  if (outcome.code === 'http_error') {
    return outcome.httpStatus === 429 || (outcome.httpStatus >= 500 && outcome.httpStatus < 600);
  }
  return outcome.code === 'network_error';
}

export interface DownloadWithRetryResult {
  outcome: DownloadOutcome | { ok: false; code: 'retries_exhausted' };
  retryCount: number;
}

/** Downloads `url` to `opts.destPath`, retrying up to DOWNLOAD_DEFAULT_MAX_RETRIES
 *  times (exponential backoff) on transient failures only. Never throws —
 *  every path resolves to a typed outcome. Streams directly to disk; never
 *  buffers the full response in memory. */
export async function downloadToFile(url: string, opts: DownloadOptions): Promise<DownloadWithRetryResult> {
  for (let attempt = 1; attempt <= DOWNLOAD_DEFAULT_MAX_RETRIES + 1; attempt++) {
    if (opts.signal.aborted) return { outcome: { ok: false, code: 'cancelled' }, retryCount: attempt - 1 };
    const outcome = await attemptDownload(url, opts);
    if (outcome.ok) return { outcome, retryCount: attempt - 1 };
    if (!isRetryable(outcome)) return { outcome, retryCount: attempt - 1 };
    if (attempt > DOWNLOAD_DEFAULT_MAX_RETRIES) {
      return { outcome: { ok: false, code: 'retries_exhausted' }, retryCount: attempt - 1 };
    }
    await interruptibleSleep(backoffWaitMs(attempt), opts.signal);
  }
  // Unreachable — the loop always returns by DOWNLOAD_DEFAULT_MAX_RETRIES + 1.
  return { outcome: { ok: false, code: 'retries_exhausted' }, retryCount: DOWNLOAD_DEFAULT_MAX_RETRIES };
}
