'use client';

// VictoryLabs — Multi-tab.
// Composite layout that hosts the existing /dashboard and /feed pages in
// embed mode (?embed=1) via iframes, sharing localStorage/cookies via
// same-origin. No body refactor — each iframe runs its own page exactly
// as before, just with TopNav and bottom status hidden.
//
// Layout (rough):
//   ┌─────────────┬──────────────┐
//   │ DASHBOARD   │              │
//   │ (top-left)  │   LIVE FEED  │
//   ├─────────────┤  (full right)│
//   │ (reserved)  │              │
//   │ (bottom-left)              │
//   └─────────────┴──────────────┘

import { useEffect } from 'react';
import { TopNav } from '@/soloist/shared';

const IFRAME_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  background: 'transparent',
  display: 'block',
};

export default function MultiTabPage() {
  useEffect(() => { document.title = 'VictoryLabs — Multi-tab'; }, []);

  return (
    // Override .feed-root's right padding to 0 so the feed iframe can
    // sit flush with the viewport edge. Left padding stays so the
    // dashboard pane doesn't hug the screen edge. `data-no-scale` opts
    // this page out of the PC-mode +15% zoom — multi-tab is sized
    // exactly and shouldn't be scaled with the rest of the app shell.
    <div className="feed-root" data-no-scale="1" style={{ paddingRight: 0 }}>
      <TopNav active="multi" />

      <div style={{
        flex: 1,
        display: 'grid',
        // Dashboard column wider than the feed; feed pushed to right edge.
        gridTemplateColumns: '1.55fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        padding: '12px 0',
        minHeight: 0,
      }}>
        {/* Top-left: Dashboard (embedded) */}
        <div style={{
          gridColumn: '1 / 2',
          gridRow: '1 / 2',
          minWidth: 0, minHeight: 0,
          border: '1px solid rgba(168,144,232,0.18)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
        }}>
          <iframe
            src="/dashboard?embed=1"
            title="Dashboard"
            style={IFRAME_STYLE}
            // Same-origin so localStorage/cookies are shared; no sandbox
            // restrictions needed.
          />
        </div>

        {/* Right column: Live Feed (embedded), spans both rows */}
        <div style={{
          gridColumn: '2 / 3',
          gridRow: '1 / 3',
          minWidth: 0, minHeight: 0,
          border: '1px solid rgba(168,144,232,0.18)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
        }}>
          <iframe
            src="/feed?embed=1"
            title="Live Feed"
            style={IFRAME_STYLE}
          />
        </div>

        {/* Bottom-left: reserved placeholder for a future tool */}
        <div style={{
          gridColumn: '1 / 2',
          gridRow: '2 / 3',
          minWidth: 0, minHeight: 0,
          border: '1px dashed rgba(168,144,232,0.22)',
          borderRadius: 10,
          background: 'rgba(20,14,34,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#55556e', fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase',
        }}>
          reserved · future tool
        </div>
      </div>
    </div>
  );
}
