/**
 * /thumb proxy — same-origin redirect to wsrv.nl for NFT thumbnails.
 *
 * Why this exists: nginx in production does not (currently) own a /thumb
 * location, so feed images requested as `/thumb?url=…&w=128&h=128…` were
 * 404-ing and the frontend silently fell back to the raw upstream URL —
 * a full-size 1–2 MB PFP from Pinit / Arweave / S3, which is the root
 * cause of the "images load slowly / flash black" bug in /feed.
 *
 * A Route Handler covers both dev and prod with one source of truth:
 * no nginx changes required, no env-conditional rewrite (the previous
 * next.config.mjs dev-only rewrite is removed).
 *
 * Behaviour: 302-redirect to wsrv.nl with the requested size + cover fit
 * + output=png. The redirect itself is heavily cacheable (immutable, 30 d)
 * so once a browser sees it, future thumb requests skip the round-trip
 * entirely and hit wsrv.nl's own CDN cache. wsrv emits long-cache headers
 * on the rendered image so the browser cache then holds the bytes too.
 *
 * Debug: set NEXT_PUBLIC_THUMB_DEBUG=1 to surface a one-line per-request
 * trace at the server console (off by default — kept quiet under load).
 */
import { NextRequest, NextResponse } from 'next/server';

const DEBUG = process.env.NEXT_PUBLIC_THUMB_DEBUG === '1';

export const runtime = 'nodejs';

// ── Smart Irys resolver ──────────────────────────────────────────────────
//
// `gateway.irys.xyz/<id>` splits into two incompatible classes and a single
// blind rewrite can only ever fix one of them:
//
//   A. Old (Bundlr-era) Irys — the txid settled to Arweave. The irys gateway
//      now 404s these, but `arweave.net/<id>` serves the byte-identical image.
//   B. New Irys (datasprite CDN) — the irys gateway 200s and redirects to
//      `*.datasprite-cdn.com`, but the txid is NOT on Arweave, so
//      `arweave.net/<id>` answers HTTP 200 with a `text/html` "not found"
//      page (NOT a 404 — so we must branch on content-type, never status).
//
// wsrv blocks the raw `gateway.irys.xyz` host by policy, so we can't just
// hand it the original URL. Instead, on a cache miss we probe (ranged GET,
// body cancelled — we only need headers + the final redirected URL):
//   1. arweave.net/<id> — if it returns image/*, that's the target (class A).
//   2. else the original irys URL, following redirects — if the FINAL host is
//      no longer gateway.irys.xyz and serves image/*, hand wsrv that final
//      (datasprite) URL (class B).
//   3. else fall back to the arweave rewrite (uncertain — short-cached).
//
// The chosen target is memoised per original URL so a collection's repeated
// thumbnails don't each pay the probe cost.

interface IrysCacheEntry {
  target: string;
  confident: boolean;
  expiresAt: number;
}
const irysCache = new Map<string, IrysCacheEntry>();
const IRYS_CACHE_MAX = 500;
const CONFIDENT_TTL_MS = 30 * 60 * 1000; // 30 min — irys/arweave content is immutable
const FALLBACK_TTL_MS = 60 * 1000;       // 60 s — let a transient miss self-heal
const PROBE_TIMEOUT_MS = 2500;
const DATASPRITE_HOST_HINT = 'datasprite-cdn.com';

function irysCacheGet(key: string): IrysCacheEntry | null {
  const e = irysCache.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    irysCache.delete(key);
    return null;
  }
  return e;
}

function irysCacheSet(key: string, target: string, confident: boolean): void {
  // Bounded — evict the oldest-inserted entry when over cap.
  if (!irysCache.has(key) && irysCache.size >= IRYS_CACHE_MAX) {
    const oldest = irysCache.keys().next().value;
    if (oldest !== undefined) irysCache.delete(oldest);
  }
  irysCache.set(key, {
    target,
    confident,
    expiresAt: Date.now() + (confident ? CONFIDENT_TTL_MS : FALLBACK_TTL_MS),
  });
}

interface ProbeResult {
  ok: boolean;
  finalUrl: string;
  contentType: string;
}

// Ranged GET that reads only the response headers + final (post-redirect)
// URL, then cancels the body. Range:bytes=0-0 keeps it to a partial response
// where honoured; where ignored (datasprite streams the full image), the body
// cancel below stops the transfer the moment headers arrive. Returns null on
// timeout / network error so the caller falls through to its next branch.
async function probeImage(url: string): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'user-agent': 'nft-live-feed-thumb/1.0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentType = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const finalUrl = res.url || url;
    const ok = res.ok;
    // We only needed headers + final URL — stop the body so a gateway that
    // ignored the Range header can't stream a multi-MB image into the worker.
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    return { ok, finalUrl, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Redirect-destination allowlist (Audit #13 SEC3 hardening) ───────────────
// gateway.irys.xyz's redirect target is untrusted — irys (or whoever
// uploaded the underlying txid) controls what a given path resolves to.
// Blindly following redirects (`redirect: 'follow'`) let a crafted response
// point this server-side fetch at an arbitrary host, including an internal
// / private address (SSRF). `probeIrysRedirectGuarded` below walks the
// redirect chain itself and only follows a hop whose destination is one of
// these explicitly-known-safe hosts; anything else is rejected and the
// caller falls back to the arweave rewrite exactly like any other probe miss.
const IRYS_REDIRECT_ALLOWED_HOSTS = new Set(['gateway.irys.xyz']);
const IRYS_REDIRECT_ALLOWED_SUFFIXES = ['.datasprite-cdn.com']; // documented class-B CDN target
const MAX_REDIRECT_HOPS = 5;

function isAllowedRedirectHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (IRYS_REDIRECT_ALLOWED_HOSTS.has(h)) return true;
  return IRYS_REDIRECT_ALLOWED_SUFFIXES.some((suf) => h === suf.slice(1) || h.endsWith(suf));
}

// Literal-address guard — blocks the common SSRF-to-internal-network shapes
// (loopback / RFC1918 / link-local) without a DNS lookup. Does NOT protect
// against DNS rebinding (an allowlisted hostname resolving to a private IP
// at fetch time); that needs socket-level enforcement and is out of scope
// for this fix.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;          // loopback / 10.0.0.0/8 / "this network"
    if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                     // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                     // link-local
    return false;
  }
  if (h === '::1' || h === '::') return true;                    // loopback / unspecified
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / unique-local
  return false;
}

function isSafeRedirectTarget(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (isBlockedHost(url.hostname)) return false;
  return isAllowedRedirectHost(url.hostname);
}

// Manual-redirect variant of probeImage, used ONLY for the untrusted
// gateway.irys.xyz origin. Walks the redirect chain itself (`redirect:
// 'manual'`) instead of letting fetch auto-follow, rejecting the first hop
// whose destination isn't an allowlisted host / is a private-address literal
// / isn't http(s). One shared AbortController covers the whole chain so the
// total time budget matches the original single-fetch-with-follow behaviour
// (PROBE_TIMEOUT_MS overall, not per hop). On any rejection this returns
// null — identical to a network-failure probe miss — so resolveIrysTarget's
// existing fallback-to-arweave-rewrite path handles it with no new failure
// mode.
async function probeIrysRedirectGuarded(startUrl: string): Promise<ProbeResult | null> {
  let current: URL;
  try { current = new URL(startUrl); } catch { return null; }
  if (!isSafeRedirectTarget(current)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      let res: Response;
      try {
        res = await fetch(current.toString(), {
          method: 'GET',
          headers: { Range: 'bytes=0-0', 'user-agent': 'nft-live-feed-thumb/1.0' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        return null;
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        try { await res.body?.cancel(); } catch { /* best-effort */ }
        if (!location) return null;
        let next: URL;
        try { next = new URL(location, current); } catch { return null; }
        if (!isSafeRedirectTarget(next)) {
          // Host only — never log the full URL (may carry long paths/query).
          console.warn(`[image/thumb] blocked redirect host=${next.hostname}`);
          return null;
        }
        current = next;
        continue;
      }

      const contentType = (res.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const ok = res.ok;
      // Same body-cancel guard as probeImage — stop a non-Range-respecting
      // server from streaming a full image into the worker.
      try { await res.body?.cancel(); } catch { /* best-effort */ }
      return { ok, finalUrl: current.toString(), contentType };
    }
    return null; // too many redirect hops — treat like any other probe failure
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve a gateway.irys.xyz URL to the best wsrv-renderable target.
// `pathname` is `/<txid>` (the leading slash is kept by URL.pathname), and the
// arweave gateway wants the bare txid with no query, so dropping `?ext=…` is
// exactly `arweave.net${pathname}`.
async function resolveIrysTarget(
  originalUrl: string,
  pathname: string,
): Promise<{ target: string; confident: boolean }> {
  const arweaveUrl = `https://arweave.net${pathname}`;

  // 1. Prefer Arweave when it actually serves the image (class A).
  const a = await probeImage(arweaveUrl);
  if (a && a.ok && a.contentType.startsWith('image/')) {
    return { target: arweaveUrl, confident: true };
  }

  // 2. Else resolve the original irys URL's redirect chain (class B),
  //    guarded against redirecting to a non-allowlisted host (SEC3).
  const g = await probeIrysRedirectGuarded(originalUrl);
  if (g && g.ok && g.contentType.startsWith('image/')) {
    try {
      const finalHost = new URL(g.finalUrl).hostname.toLowerCase();
      if (finalHost !== 'gateway.irys.xyz' && finalHost.endsWith('.irys.xyz') === false) {
        // A non-irys CDN host (datasprite, or any other) that wsrv can fetch.
        // datasprite is the common one; we don't hard-require it so a future
        // CDN host still works, but log when it's the expected one.
        return { target: g.finalUrl, confident: true };
      }
    } catch { /* unparseable final URL — fall through to fallback */ }
  }

  // 3. Neither path proved an image — fall back to the old arweave rewrite,
  //    marked uncertain so it's only short-cached and re-probed soon.
  return { target: arweaveUrl, confident: false };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp  = req.nextUrl.searchParams;
  let   url = sp.get('url');
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    return new NextResponse('bad url', { status: 400 });
  }

  // Default: long-lived immutable cache for confidently-resolved targets.
  let cacheControl = 'public, max-age=2592000, s-maxage=2592000, immutable';
  let irysClass: 'A-arweave' | 'B-datasprite' | 'fallback' | null = null;

  // ── gateway.irys.xyz → smart resolve (class A arweave / class B datasprite)
  // ── *.mypinata.cloud/ipfs/<CID> → ipfs.io/ipfs/<CID> (dead-dedicated-gateway
  //    rewrite; CID is content-addressable so ipfs.io serves identical bytes).
  //    Scoped to `.mypinata.cloud` subdomains so the public gateway.pinata.cloud
  //    and the pinata.cloud apex pass through unchanged.
  try {
    const u = new URL(url);
    if (u.hostname === 'gateway.irys.xyz') {
      const cached = irysCacheGet(url);
      let target: string;
      let confident: boolean;
      if (cached) {
        ({ target, confident } = cached);
      } else {
        ({ target, confident } = await resolveIrysTarget(url, u.pathname));
        irysCacheSet(url, target, confident);
      }
      url = target;
      if (confident) {
        irysClass = target.includes(DATASPRITE_HOST_HINT) ? 'B-datasprite' : 'A-arweave';
      } else {
        irysClass = 'fallback';
        cacheControl = 'public, max-age=60';
      }
    } else if (u.hostname.endsWith('.mypinata.cloud')
               && u.pathname.startsWith('/ipfs/')) {
      u.hostname = 'ipfs.io';
      u.search   = '';            // dedicated-gateway query params are unauthenticated noise on ipfs.io
      url = u.toString();
    }
  } catch { /* malformed URL — drop through to the existing bad-url guard above */ }

  const w      = sp.get('w')      ?? '128';
  const h      = sp.get('h')      ?? '128';
  const fit    = sp.get('fit')    ?? 'cover';
  const output = sp.get('output') ?? 'png';

  const target = new URL('https://wsrv.nl/');
  target.searchParams.set('url',    url);
  target.searchParams.set('w',      w);
  target.searchParams.set('h',      h);
  target.searchParams.set('fit',    fit);
  target.searchParams.set('output', output);
  // we = "without enlargement" — wsrv won't upscale a tiny upstream into
  // a fuzzy 128 px thumbnail; it returns the original size instead.
  target.searchParams.set('we', '');

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log(
      `[image/thumb] source=${url.slice(0, 80)} size=${w}x${h}` +
      `${irysClass ? ` irys=${irysClass}` : ''} status=302->wsrv`,
    );
  }

  const res = NextResponse.redirect(target.toString(), 302);
  // Long-lived cache for confident targets; short cache for the uncertain
  // irys fallback so a transient miss isn't pinned in the browser for 30 d.
  res.headers.set('Cache-Control', cacheControl);
  return res;
}
