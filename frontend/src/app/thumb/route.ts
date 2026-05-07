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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp  = req.nextUrl.searchParams;
  const url = sp.get('url');
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    return new NextResponse('bad url', { status: 400 });
  }

  // Bypass — wsrv refuses irys.xyz hosts ("Domain or TLD blocked"); the
  // raw upstream renders better than a broken proxy response. compressImage()
  // already short-circuits on irys, but defend in depth at the route too.
  if (url.includes('irys.xyz')) {
    const res = NextResponse.redirect(url, 302);
    res.headers.set('Cache-Control', 'public, max-age=86400');
    return res;
  }

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
      `[image/thumb] source=${url.slice(0, 80)} size=${w}x${h} status=302->wsrv`,
    );
  }

  const res = NextResponse.redirect(target.toString(), 302);
  // Long-lived cache: thumbnail bytes for a given (url, w, h, output) are
  // immutable for the upstream lifetime. 30 d browser + edge cache so a
  // returning user / scrolling client never re-hits this handler.
  res.headers.set(
    'Cache-Control',
    'public, max-age=2592000, s-maxage=2592000, immutable',
  );
  return res;
}
