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

  // 2. Else resolve the original irys URL's redirect chain (class B).
  const g = await probeImage(originalUrl);
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
