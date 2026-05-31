'use client';

// VictoryLabs — shared SSE multiplexer for native /multi.
// ONE EventSource('/api/events/stream') fanning every named event out to
// any number of subscribers (the sales + mint panels), so /multi opens a
// single connection instead of one per panel. Centralizes reconnect/backoff.
//
// Scoped to /multi only: the standalone /feed and /mints pages have their own
// inline SSE; the native hooks (useSalesFeed/useMintFeed) only consume this
// when a `subscribe` fn is injected (via SaleStreamContext), and fall back to
// their own EventSource otherwise.

import { createContext, useContext, useEffect, useRef } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Register a handler for an SSE event type; returns an unsubscribe fn. */
export type StreamSubscribe = (type: string, handler: (e: MessageEvent) => void) => () => void;

export const SaleStreamContext = createContext<StreamSubscribe | null>(null);
/** Null outside a <SaleStreamProvider> → hooks fall back to own EventSource. */
export function useSaleStream(): StreamSubscribe | null {
  return useContext(SaleStreamContext);
}

export function SaleStreamProvider({ children }: { children: React.ReactNode }) {
  // type → set of handlers. Source of truth; re-attached to each new ES.
  const handlersRef = useRef<Map<string, Set<(e: MessageEvent) => void>>>(new Map());
  const esRef = useRef<EventSource | null>(null);

  // Stable subscribe identity (so consuming effects don't re-run): registers
  // the handler and attaches it to the live ES if one is open.
  const subscribeRef = useRef<StreamSubscribe>((type, handler) => {
    let set = handlersRef.current.get(type);
    if (!set) { set = new Set(); handlersRef.current.set(type, set); }
    set.add(handler);
    esRef.current?.addEventListener(type, handler as EventListener);
    return () => {
      handlersRef.current.get(type)?.delete(handler);
      esRef.current?.removeEventListener(type, handler as EventListener);
    };
  });

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const attachAll = (es: EventSource) => {
      for (const [type, set] of handlersRef.current) {
        for (const h of set) es.addEventListener(type, h as EventListener);
      }
    };
    const scheduleReconnect = () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      reconnectTimer = setTimeout(connect, base + Math.random() * 1_000);
      attempt++;
    };
    const connect = () => {
      if (cancelled) return;
      esRef.current?.close();
      const es = new EventSource(`${API_BASE}/api/events/stream`);
      esRef.current = es;
      es.addEventListener('open', () => { attempt = 0; });
      attachAll(es);   // re-attach every registered handler to the new ES
      es.addEventListener('error', () => { es.close(); scheduleReconnect(); });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return (
    <SaleStreamContext.Provider value={subscribeRef.current}>
      {children}
    </SaleStreamContext.Provider>
  );
}
