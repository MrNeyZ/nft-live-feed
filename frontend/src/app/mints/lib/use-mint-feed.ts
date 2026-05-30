'use client';

// VictoryLabs — Live Mint Feed data hook (Stage 1 native-/multi prep).
// Self-contained: opens its OWN EventSource('/api/events/stream') and
// subscribes to ONLY the mint channels (`mint`, `mint_status`, `mint_meta`).
// This is the key efficiency win over the iframe: the native panel never
// runs the LEFT collections-table / accumulator subsystem — it keeps just
// the per-mint feed buffer + a lightweight collection-meta map (`rows`)
// for the card's name/image lookup.
//
// FOCUSED port of /mints' feed wiring: snapshot (/api/mints/recent),
// mint append (dedupe + blockTime anchoring + 60-cap), mint_status sticky-
// merge into `rows`, mint_meta name/image patch, reconnect/backoff,
// user-blacklist boundary. Intentionally omits page-only concerns
// (hover-pause buffering, localStorage persistence, the table rollups).
//
// ADDITIVE + UNWIRED: imported by nothing live yet. Standalone /mints and
// the iframe /multi are untouched; Stage 2 wires this in behind a flag.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MintEvent, MintStatus } from './types';
import { useBlacklist, MINTS_BLACKLIST_KEY } from '@/soloist/blacklist-store';
import { isMintEventBlacklisted, isMintStatusBlacklisted } from '@/soloist/blacklist-filter';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const LIVE_FEED_MAX = 150;

export interface UseMintFeed {
  /** Per-mint events, newest-first, capped at LIVE_FEED_MAX. */
  events: MintEvent[];
  /** groupingKey → collection rollup (name/image), for the card lookup. */
  rows:   Map<string, MintStatus>;
}

const evKey = (e: { signature: string; mintAddress: string | null }) => `${e.signature}:${e.mintAddress ?? ''}`;

export function useMintFeed(): UseMintFeed {
  const [events, setEvents] = useState<MintEvent[]>([]);
  const [rows, setRows]     = useState<Map<string, MintStatus>>(() => new Map());

  const { slugs } = useBlacklist(MINTS_BLACKLIST_KEY);
  const blacklistSet = useMemo(() => new Set(slugs), [slugs]);
  const blRef = useRef(blacklistSet);
  useEffect(() => { blRef.current = blacklistSet; }, [blacklistSet]);

  // Mount snapshot (DB-backed recent mints).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/mints/recent?limit=${LIVE_FEED_MAX}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { events?: Array<Omit<MintEvent, 'receivedAt'>> };
        if (cancelled || !Array.isArray(body.events)) return;
        const server: MintEvent[] = body.events
          .map(m => {
            const bt = m.blockTime ? Date.parse(m.blockTime) : NaN;
            return { ...m, receivedAt: Number.isFinite(bt) ? bt : Date.now() } as MintEvent;
          })
          .filter(ev => !isMintEventBlacklisted(ev, blRef.current));
        setEvents(prev => {
          const seen = new Set(server.map(evKey));
          const extra = prev.filter(e => !seen.has(evKey(e)));
          const merged = [...server, ...extra];
          merged.sort((a, b) => b.receivedAt - a.receivedAt);
          return merged.slice(0, LIVE_FEED_MAX);
        });
      } catch { /* offline / backend down */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live SSE (mint channels only).
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      reconnectTimer = setTimeout(connect, base + Math.random() * 1_000);
      attempt++;
    };

    const connect = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('open', () => { attempt = 0; });

      es.addEventListener('mint_status', (e: MessageEvent) => {
        try {
          const s = JSON.parse(e.data) as MintStatus;
          if (isMintStatusBlacklisted(s, blRef.current)) return;
          setRows(prev => {
            const next = new Map(prev);
            const cur  = prev.get(s.groupingKey);
            // Sticky-merge name/image so re-emitted frames don't blank a
            // previously-resolved thumbnail/name (mirrors /mints).
            const img  = (s.imageUrl && s.imageUrl.length > 0) ? s.imageUrl : (cur?.imageUrl ?? undefined);
            const nm   = (s.name && s.name.length > 0)         ? s.name     : (cur?.name ?? undefined);
            next.set(s.groupingKey, { ...s, imageUrl: img, name: nm });
            return next;
          });
        } catch { /* skip */ }
      });

      es.addEventListener('mint', (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data) as Omit<MintEvent, 'receivedAt'>;
          if (!m.signature) return;
          if (isMintEventBlacklisted(m, blRef.current)) return;
          const bt = m.blockTime ? Date.parse(m.blockTime) : NaN;
          const ev: MintEvent = { ...m, receivedAt: Number.isFinite(bt) ? bt : Date.now() };
          setEvents(prev => {
            const key = evKey(ev);
            if (prev.some(p => evKey(p) === key)) return prev;
            const merged = [ev, ...prev];
            merged.sort((a, b) => b.receivedAt - a.receivedAt);
            return merged.slice(0, LIVE_FEED_MAX);
          });
        } catch { /* skip */ }
      });

      es.addEventListener('mint_meta', (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as { signature?: string; mintAddress?: string | null; nftName?: string | null; imageUrl?: string | null };
          if (!p.signature && !p.mintAddress) return;
          setEvents(prev => {
            let changed = false;
            const next = prev.map(ev => {
              const match = (p.signature && ev.signature === p.signature)
                         || (!!p.mintAddress && ev.mintAddress === p.mintAddress);
              if (!match) return ev;
              const nextName  = (p.nftName  && p.nftName.length > 0)  ? p.nftName  : (ev.nftName     ?? null);
              const nextImage = (p.imageUrl && p.imageUrl.length > 0) ? p.imageUrl : (ev.nftImageUrl ?? null);
              if (ev.nftName === nextName && ev.nftImageUrl === nextImage) return ev;
              changed = true;
              return { ...ev, nftName: nextName, nftImageUrl: nextImage };
            });
            return changed ? next : prev;
          });
        } catch { /* skip */ }
      });

      es.addEventListener('error', () => { es?.close(); scheduleReconnect(); });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return { events, rows };
}
