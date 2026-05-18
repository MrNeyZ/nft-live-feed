// VictoryLabs — Mints: source-badge pill rendered next to each
// collection title in the COLLECTION column. Same palette as the
// prior right-side SOURCE column (uses `sourceBadge`); rendered
// smaller (9 px, tighter padding) so it reads as secondary metadata
// next to the title rather than competing with it. Clickable when
// `sourceHref` resolves a URL (links to the launchpad's mint page);
// plain `<span>` otherwise. flexShrink: 0 so it doesn't squeeze on
// narrow rows.
//
// Behaviour byte-identical to the prior inline IIFE in page.tsx —
// extracted only so the per-row JSX can be split later without
// inlining a small builder into the row's body.

import type { MintStatus } from '../lib/types';
import { sourceBadge, sourceHref } from '../lib/source';

export function MintsSourceBadge({ row }: { row: MintStatus }) {
  const sb = sourceBadge(row.sourceLabel);
  const href = sourceHref(row);
  const pillStyle: React.CSSProperties = {
    display: 'inline-block', padding: '1px 6px', fontSize: 9, fontWeight: 700, borderRadius: 3,
    background: sb.bg, color: sb.fg, letterSpacing: '0.4px',
    textDecoration: 'none', cursor: href ? 'pointer' : 'default',
    flexShrink: 0, lineHeight: '13px', textTransform: 'uppercase',
  };
  const plainTitle = row.sourceLabel === 'LaunchMyNFT'
    ? 'LaunchMyNFT mint page unavailable'
    : row.sourceLabel;
  // Linked-pill tooltip: VVV / GRAVE get an explicit "Open on …" hint
  // per the per-collection deep-link UX so users know clicking opens
  // the launchpad's page. Other sources keep the raw label as the
  // hover hint.
  const linkTitle = row.sourceLabel === 'VVV'
    ? 'Open on VVV'
    : row.sourceLabel === 'GRAVE'
      ? 'Open on gravemint.io'
      : row.sourceLabel;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={linkTitle}
      style={pillStyle}
      onClick={(e) => e.stopPropagation()}
    >{sb.label}</a>
  ) : (
    <span title={plainTitle} style={pillStyle}>{sb.label}</span>
  );
}
