'use client';

// Shared primitives for the MMM tool pages (mmm-pool-lookup, mmm-collection-scanner,
// mmm-pools) — extracted from byte-identical copies previously duplicated across
// those three files. See research_backlog.md, Architecture Simplification #1,
// Finding AS12. Behavior preserved exactly for every existing call site.

import { useState } from 'react';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
export const ADDR_RE   = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const MONO: React.CSSProperties = { fontFamily: "'SF Mono','Fira Code',monospace" };

export const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg,#1a1530 0%,#1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06),0 16px 50px rgba(0,0,0,0.6),0 0 0 1px rgba(0,0,0,0.4),0 0 28px rgba(128,104,216,0.10)',
  overflow: 'hidden',
  marginBottom: 16,
};

export function fmtSol(lam: number): string { return (lam / 1e9).toFixed(4); }
export function short(s: string): string { return s.length > 10 ? `${s.slice(0,5)}…${s.slice(-5)}` : s; }

export function CopyKey({ value, label, color }: { value: string; label?: string; color?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span onClick={copy} title={value}
      style={{ cursor: 'pointer', color: copied ? '#43b984' : (color ?? '#a890e8'), fontSize: 11, ...MONO, userSelect: 'none' }}>
      {copied ? 'copied!' : (label ?? short(value))}
    </span>
  );
}
