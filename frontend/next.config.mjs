const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const IS_PROD = process.env.NODE_ENV === 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
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
