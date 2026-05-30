'use client';

// VictoryLabs — Sales (Live Feed) data hook (Stage 1 native-/multi prep).
// Self-contained: opens its OWN EventSource('/api/events/stream'), drives
// the shared feedReducer, and exposes ordered events + ME-health for the
// native <SalesFeedPanel>. This is a FOCUSED port of /feed's stream wiring
// — it keeps the parts a /multi panel needs (snapshot, sale/meta/remove/
// resize_status/status, reconnect/backoff, blacklist boundary + backstop)
// and intentionally omits page-only concerns (seller-count persistence,
// deep-discount sound, floorBySlug fallback, hover-pause, filters UI).
//
// ADDITIVE + UNWIRED: imported by nothing live yet. The iframe /multi and
// the standalone /feed page are untouched; Stage 2 wires this in behind a
// flag/route and the seller-count/floor extras are revisited then.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type ResizeStatusPatch,
} from '@/soloist/feed-store';
import { fromBackend, fromRow } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { useBlacklist, FEED_BLACKLIST_KEY } from '@/soloist/blacklist-store';
import { isFeedEventBlacklisted } from '@/soloist/blacklist-filter';
import type { FeedEvent } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS = 200;
const SNAPSHOT_LIMIT = 100;

export interface UseSalesFeed {
  events:  FeedEvent[];
  /** Magic Eden source health (from the `status` SSE frame). */
  meStale: boolean;
}

export function useSalesFeed(): UseSalesFeed {
  const [state, dispatch] = useReducer(feedReducer, MAX_EVENTS, initFeedState);
  const [sourceState, setSourceState] = useState<{ magiceden: 'ok' | 'stale'; tensor: 'ok' | 'stale' }>(
    { magiceden: 'ok', tensor: 'ok' },
  );

  const { slugs } = useBlacklist(FEED_BLACKLIST_KEY);
  const blacklistSet = useMemo(() => new Set(slugs), [slugs]);
  const blRef = useRef(blacklistSet);
  useEffect(() => { blRef.current = blacklistSet; }, [blacklistSet]);

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
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const ev = fromBackend(JSON.parse(e.data) as BackendEvent);
          if (isFeedEventBlacklisted(ev, blRef.current)) return;
          dispatch({ type: 'live', event: ev });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          dispatch({ type: 'meta', patch: JSON.parse(e.data) as MetaPatch, blacklist: blRef.current });
        } catch { /* skip */ }
      });
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (signature) dispatch({ type: 'remove', signature });
        } catch { /* skip */ }
      });
      es.addEventListener('resize_status', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as ResizeStatusPatch;
          if (patch.signature && patch.resizeStatus) dispatch({ type: 'resize_status', patch });
        } catch { /* skip */ }
      });
      es.addEventListener('status', (e: MessageEvent) => {
        try {
          const { source, state: st } = JSON.parse(e.data) as { source: 'magiceden' | 'tensor'; state: 'ok' | 'stale' };
          setSourceState(prev => ({ ...prev, [source]: st }));
        } catch { /* skip */ }
      });
      es.addEventListener('error', () => { es?.close(); scheduleReconnect(); });
    };

    fetch(`${API_BASE}/api/events/latest?limit=${SNAPSHOT_LIMIT}`)
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const events = data.events
          .map(r => fromBackend(fromRow(r)))
          .filter(ev => !isFeedEventBlacklisted(ev, blRef.current));
        dispatch({ type: 'snapshot', events });
      })
      .catch(() => { /* snapshot failed — live stream still connects */ })
      .finally(() => { if (!cancelled) connect(); });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  const ordered = useMemo(() => orderedEvents(state), [state]);
  // Render backstop — drops rows whose blacklisted identity only became
  // known via a late `meta` patch (mirrors /feed's render-time filter).
  const events = useMemo(
    () => ordered.filter(e => !isFeedEventBlacklisted(e, blacklistSet)),
    [ordered, blacklistSet],
  );

  return { events, meStale: sourceState.magiceden === 'stale' };
}
