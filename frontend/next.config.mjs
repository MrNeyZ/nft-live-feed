const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const IS_PROD = process.env.NODE_ENV === 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Kill the dev-only bottom-right status badge + error pill.
  // No user-facing toast UI in the product; terminal output is the source of truth.
  devIndicators: { buildActivity: false, appIsrStatus: false },
  async rewrites() {
    // Production deploys put nginx in front of Next, and nginx already
    // routes `/api/*` to the Express backend and `/thumb` to wsrv.nl
    // before requests ever reach Next. Returning an empty array in prod
    // makes the routing topology explicit: a single source of truth
    // (nginx), no silent overlap with a Next-side rewrite that might
    // disagree. Dev still needs both rewrites because `next dev` runs
    // without nginx.
    if (IS_PROD) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/:path*`,
      },
      // Dev-only thumbnail proxy. In production nginx serves `/thumb`
      // directly (proxy_pass to wsrv.nl + proxy_cache + Cloudflare edge
      // cache). In `next dev` there is no nginx, so without this every
      // NFT thumbnail would 404. Query string is preserved by Next's
      // rewriter.
      {
        source: '/thumb',
        destination: 'https://wsrv.nl/',
      },
    ];
  },
};

export default nextConfig;
