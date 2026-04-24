const API_URL = process.env.API_URL ?? 'http://localhost:3000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Kill the dev-only bottom-right status badge + error pill.
  // No user-facing toast UI in the product; terminal output is the source of truth.
  devIndicators: { buildActivity: false, appIsrStatus: false },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
