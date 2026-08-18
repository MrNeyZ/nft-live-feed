'use client';

// VictoryLabs — Tools index.
// Plain directory of every manual, on-demand tool under /tools/<name>.
// This route used to BE the Retardio Offers scanner (moved to
// /tools/offers); this page is now just a card grid linking out — no
// data fetching, no state, matches the TOOLS dropdown in soloist/shared.tsx
// (which stays the primary nav path — this page is the browsable index).

import { useEffect } from 'react';
import { LiveDot } from '@/soloist/shared';
import { PANEL, MONO } from '@/app/tools/mmm-shared';

interface ToolCard {
  href:  string;
  title: string;
  desc:  string;
}
interface ToolCategory {
  label: string;
  color: string;
  tools: ReadonlyArray<ToolCard>;
}

// Grouped by what the tool actually DOES, not by which program it talks
// to — a user scanning this page cares "is this an accept-bid tool" or
// "is this an arb scanner", not "is this MMM vs Tensor vs Solanart".
// Color is a category accent only (left border + header dot) — never the
// dominant color of a card, same restraint as the Bid List readability
// pass on this same app.
const CATEGORIES: ReadonlyArray<ToolCategory> = [
  {
    label: 'Accept Bid / Offer',
    color: '#60a5fa',
    tools: [
      { href: '/tools/tensor-take-bid',       title: 'Tensor Take Bid',       desc: 'Accept any live Tensor collection bid on an mpl-core asset — reads live chain state, sign with Phantom.' },
      { href: '/tools/solanart-accept-offer', title: 'Solanart',              desc: 'Accept a funded 2021-2022 Solanart bid directly on-chain — the marketplace itself has been dead since ~2022.' },
      { href: '/tools/solsea-accept-bid',     title: 'SolSea',                desc: 'Accept a funded SolSea bid directly on-chain — native SOL bids only, the marketplace frontend/API is dead.' },
      { href: '/tools/mmm-pool-lookup',       title: 'MMM Pool Lookup',       desc: 'Look up a pool, connect a wallet, accept a bid directly.' },
      { href: '/tools/bid-list',              title: 'Bid List',              desc: 'Forgotten Solanart/SolSea bids sitting on NFTs held by real active wallets — marketplace escrows and locked/delegated NFTs filtered out.' },
    ],
  },
  {
    label: 'MMM Pools',
    color: '#a78bfa',
    tools: [
      { href: '/tools/mmm-pools',             title: 'MMM Dormant Scanner',   desc: 'On-chain escrow audit for a wallet’s MMM pools.' },
      { href: '/tools/mmm-collection-scanner',title: 'MMM Collection Scanner',desc: 'Triage underfunded MMM pools across a collection.' },
      { href: '/tools/mmm-collection-bids',   title: 'MMM Coll Bids',         desc: 'Create/manage collection-level MMM buy-side pools (raw on-chain, dedicated cosigner).' },
    ],
  },
  {
    label: 'Arbitrage & Spreads',
    color: '#4ade80',
    tools: [
      { href: '/tools/me-tensor-arb',         title: 'ME vs Tensor Arb',      desc: 'Find ME/MMM listings priced below Tensor’s cheapest active listing for a collection.' },
      { href: '/tools/offers',                title: 'Retardio Offers',      desc: 'Retardio-family listings against Magic Eden personal offers.' },
      { href: '/tools/offer-floor-sweep',     title: 'Offer > Floor Sweep',  desc: 'Full-market sweep for ME personal offers priced above the current listing ask.' },
      { href: '/tools/tensor-low-floor',      title: 'Tensor Low Floor',     desc: 'Full-market scan for legacy/pNFT collections under a floor threshold — Core/cNFT/SFT/Token-2022 excluded.' },
      { href: '/tools/spl20',                 title: 'SPL20',                desc: 'Resolve a ticker’s CA + unredeemed NFT inventory on-chain, spread it against an ME floor.' },
    ],
  },
  {
    label: 'Analysis & Data',
    color: '#facc15',
    tools: [
      { href: '/tools/mint-analyzer',         title: 'Mint Analyzer',        desc: 'Decode a mint transaction — primitive, wrapper, reconstruction verdict.' },
      { href: '/tools/holders',               title: 'Holders',              desc: 'Raw distinct on-chain owner count for a collection (Helius DAS).' },
      { href: '/tools/me-collection-refresh', title: 'ME Collection Refresh',desc: 'Force-resync Magic Eden’s per-NFT index (owner/name/image) for a wallet’s NFTs, optionally scoped to one collection.' },
      { href: '/tools/collection-analyzer',   title: 'Collection',           desc: 'Collection/mint/marketplace URL → asset + trait attribute preview (Helius DAS).' },
      { href: '/tools/rare-feed',             title: 'Rare Feed',            desc: 'Rarity-scored value sales feed.' },
      { href: '/tools/trending-legacy',       title: 'Trending (legacy)',    desc: 'Pre-merge Trending, preserved as-is for side-by-side comparison against /dashboard.' },
    ],
  },
  {
    label: 'Minting',
    color: '#f472b6',
    tools: [
      { href: '/tools/candy-mint',            title: 'Candy Mint',           desc: 'Reconstruct a Core Candy Guard mint from a signature and mint directly, if still alive.' },
      { href: '/tools/critters-mint-timer',   title: 'Critters Timer',       desc: 'Upcoming cheap edition mints from critters.quest, sorted by soonest start — read-only, no wallet.' },
      { href: '/tools/vvv',                   title: 'VVV Stages',           desc: 'Paste a vvv.so mint link — whitelist stages + eligible collections, structured.' },
      // Pixel Forge temporarily pulled — route still live at /tools/pixel-forge, just unlisted.
      // { href: '/tools/pixel-forge',        title: 'Pixel Forge',          desc: 'AI pixel-art trait generator, collection-aware.' },
    ],
  },
];

export default function ToolsIndexPage() {
  useEffect(() => { document.title = 'Tools | VictoryLabs'; }, []);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          TOOLS
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>manual, on-demand — pick a tool</span>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
          gap: 16,
          marginTop: 20,
          alignItems: 'start',
        }}>
          {CATEGORIES.map((cat) => (
            <div key={cat.label} style={{
              border: `1px solid ${cat.color}2e`,
              borderTop: `2px solid ${cat.color}88`,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.015)',
              padding: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: cat.color, flexShrink: 0,
                  boxShadow: `0 0 6px ${cat.color}99` }} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: cat.color, letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                  {cat.label}
                </span>
                <span style={{ fontSize: 10.5, color: '#6e6688', ...MONO }}>({cat.tools.length})</span>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(195px, 1fr))',
                gap: 10,
              }}>
                {cat.tools.map((t) => (
                  <a
                    key={t.href}
                    href={t.href}
                    style={{
                      ...PANEL,
                      marginBottom: 0,
                      padding: 12,
                      display: 'block',
                      textDecoration: 'none',
                      borderLeft: `2px solid ${cat.color}55`,
                      transition: 'border-color 0.15s, transform 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLAnchorElement).style.borderColor = `${cat.color}bb`;
                      (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(-1px)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgb(var(--vl-purple-tint) / 0.32)';
                      (e.currentTarget as HTMLAnchorElement).style.transform = 'none';
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.2px', lineHeight: 1.25 }}>{t.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginTop: 5, lineHeight: 1.4 }}>{t.desc}</div>
                    <div style={{ fontSize: 9.5, color: '#6e6688', marginTop: 8, ...MONO }}>{t.href}</div>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}
