const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const IS_PROD = process.env.NODE_ENV === 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build-and-swap support: build into an ISOLATED dist dir (NEXT_DIST_DIR set
  // by the deploy script) so the live `next start` keeps serving the existing
  // `.next` for the whole build, then the script atomically swaps it in. At
  // `next start` the env is unset → distDir defaults to `.next`. This closes
  // the window where a live `rm -rf .next`/rebuild made every /_next/*.js 404
  // as text/html and poisoned Cloudflare's cache (the /mints black screen).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Kill the dev-only bottom-right status badge + error pill.
  // No user-facing toast UI in the product; terminal output is the source of truth.
  devIndicators: { buildActivity: false, appIsrStatus: false },
  async rewrites() {
    // Production deploys put nginx in front of Next; nginx routes `/api/*`
    // to the Express backend before requests ever reach Next, so no rewrite
    // is needed in prod. In dev the `next dev` server has no nginx, hence
    // the dev-only `/api/:path*` rewrite below.
    //
    // `/thumb` is a Next.js Route Handler now (see src/app/thumb/route.ts),
    // so it works in both dev and prod with one source of truth — the
    // previous dev-only `/thumb → wsrv.nl` rewrite has been removed.
    // (A rewrite would have intercepted before the route handler could run.)
    if (IS_PROD) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
