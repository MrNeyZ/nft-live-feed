// Lazy SNS (.sol) domain resolver for live-feed wallet links.
//
// Resolution is on-demand only: a wallet is resolved the first time it appears
// in a rendered (visible) feed card — never for buffered/off-screen events.
// Results are cached at module scope for the session (positive AND negative)
// so the same wallet across many cards resolves at most once; concurrent
// first-time lookups for the same wallet share one in-flight request. The
// backend adds a 24h cache on top (GET /api/tools/sns/resolve).
//
// Returned value:
//   string  → "name.sol"
//   null    → resolved, no domain (or not yet resolved)

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type Resolved = string | null;

// `cache` holds confirmed results (string or null). A wallet absent from the
// map has not been resolved yet. Transient failures are NOT stored so they
// retry on the next appearance.
const cache    = new Map<string, Resolved>();
const inFlight = new Map<string, Promise<Resolved>>();

async function resolveWallet(wallet: string): Promise<Resolved> {
  const cached = cache.get(wallet);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(wallet);
  if (pending) return pending;

  const task = (async (): Promise<Resolved> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/tools/sns/resolve?wallet=${encodeURIComponent(wallet)}`,
        { headers: { ...authHeaders() } },
      );
      if (!res.ok) return null;   // don't cache failures
      const body = await res.json() as { ok?: boolean; domain?: string | null; stale?: boolean };
      const domain = body?.ok && typeof body.domain === 'string' ? body.domain : null;
      // `stale` marks an upstream lookup failure surfaced as null — don't cache
      // it so a later appearance retries. Cache every definitive result.
      if (!body?.stale) cache.set(wallet, domain);
      return domain;
    } catch {
      return null;
    } finally {
      inFlight.delete(wallet);
    }
  })();

  inFlight.set(wallet, task);
  return task;
}

/** Resolve a wallet's .sol domain lazily on mount. Returns the domain string
 *  once known, or null (no domain / not yet resolved). Safe to call with null. */
export function useSnsDomain(wallet: string | null): Resolved {
  const [domain, setDomain] = useState<Resolved>(
    () => (wallet ? cache.get(wallet) ?? null : null),
  );

  useEffect(() => {
    if (!wallet) { setDomain(null); return; }
    const cached = cache.get(wallet);
    if (cached !== undefined) { setDomain(cached); return; }
    let alive = true;
    void resolveWallet(wallet).then(d => { if (alive) setDomain(d); });
    return () => { alive = false; };
  }, [wallet]);

  return domain;
}
