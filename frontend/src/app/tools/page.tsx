'use client';

// VictoryLabs — Tools index.
// Plain directory of every manual, on-demand tool under /tools/<name>.
// This route used to BE the Retardio Offers scanner (moved to
// /tools/retardio); this page is now just a card grid linking out — no
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

const TOOLS: ReadonlyArray<ToolCard> = [
  { href: '/tools/me-tensor-arb',         title: 'ME vs Tensor Arb',       desc: 'Find ME/MMM listings priced below Tensor’s cheapest active listing for a collection.' },
  { href: '/tools/retardio',              title: 'Retardio Offers',       desc: 'Retardio-family listings against Magic Eden personal offers.' },
  { href: '/tools/rare-feed',             title: 'Rare Feed',             desc: 'Rarity-scored value sales feed.' },
  { href: '/tools/mint-analyzer',         title: 'Mint Analyzer',         desc: 'Decode a mint transaction — primitive, wrapper, reconstruction verdict.' },
  { href: '/tools/holders',               title: 'Holders',               desc: 'Raw distinct on-chain owner count for a collection (Helius DAS).' },
  { href: '/tools/trending',              title: 'Trending',              desc: 'Trending collections by volume / sales.' },
  { href: '/tools/mmm-pools',             title: 'MMM Dormant Scanner',   desc: 'On-chain escrow audit for a wallet’s MMM pools.' },
  { href: '/tools/mmm-pool-lookup',       title: 'MMM Pool Lookup',       desc: 'Look up a pool, connect a wallet, accept a bid directly.' },
  { href: '/tools/mmm-collection-scanner',title: 'MMM Collection Scanner',desc: 'Triage underfunded MMM pools across a collection.' },
  { href: '/tools/dotland',               title: 'DotLand',               desc: 'Direct-mint tool (personal use).' },
  { href: '/tools/me-bids',               title: 'ME Bids',               desc: 'Create/change/cancel item-level Magic Eden offers directly (bypasses disabled web UI).' },
  { href: '/tools/mmm-collection-bids',   title: 'MMM Collection Bids',   desc: 'Create/manage collection-level MMM buy-side pools (raw on-chain, dedicated cosigner).' },
  { href: '/tools/dexbull-airdrop',       title: 'DEXBULL Airdrop',       desc: 'DotLand × DEXBULL airdrop eligibility estimate — strict vs relaxed.' },
  { href: '/tools/pixel-forge',           title: 'Pixel Forge',           desc: 'AI pixel-art trait generator, collection-aware.' },
];

export default function ToolsIndexPage() {
  useEffect(() => { document.title = 'Tools | VictoryLabs'; }, []);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
          TOOLS
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>manual, on-demand — pick a tool</span>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
          marginTop: 16,
        }}>
          {TOOLS.map((t) => (
            <a
              key={t.href}
              href={t.href}
              style={{
                ...PANEL,
                marginBottom: 0,
                padding: 14,
                display: 'block',
                textDecoration: 'none',
                transition: 'border-color 0.15s, transform 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(168,144,232,0.65)';
                (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(168,144,232,0.32)';
                (e.currentTarget as HTMLAnchorElement).style.transform = 'none';
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px' }}>{t.title}</div>
              <div style={{ fontSize: 11.5, color: '#9a9ab4', marginTop: 6, lineHeight: 1.45 }}>{t.desc}</div>
              <div style={{ fontSize: 10, color: '#6e6688', marginTop: 10, ...MONO }}>{t.href}</div>
            </a>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}
