'use client';

import { useEffect, useRef, useState } from 'react';
import { FeedEvent, LatestApiResponse, fromRow } from '@/types';

// Max events kept in memory; oldest are dropped once exceeded
const MAX_EVENTS = 100;

// ── Signal thresholds ────────────────────────────────────────────────────────
/** Show UNDER FLOOR when sale is this far below floor (fraction, e.g. 0.05 = 5%). */
const UNDER_FLOOR_THRESHOLD = 0.05;
/** Show ABOVE OFFER when top offer exceeds sale by this fraction of sale price. */
const ABOVE_OFFER_THRESHOLD = 0.05;

// ── Net price constants ───────────────────────────────────────────────────────
/** Magic Eden / Tensor marketplace fee deducted from every sale. */
const MARKETPLACE_FEE = 0.02;
// Creator royalty is fetched per-collection at runtime; fallback = 0% when unknown.

/**
 * Convert backend floorDelta (gross basis) to net basis.
 * Backend: floorDelta = (grossPrice − floor) / floor
 * Net:     netDelta   = netFactor × (1 + floorDelta) − 1
 */
function toNetFloorDelta(floorDelta: number, netFactor: number): number {
  return netFactor * (1 + floorDelta) - 1;
}

/**
 * Convert backend offerDelta (gross basis) to net basis.
 * Backend: offerDelta = grossPrice − topOffer  (SOL, absolute)
 * Net:     netDelta   = offerDelta − grossPrice × (1 − netFactor)
 */
function toNetOfferDelta(offerDelta: number, grossPriceSol: number, netFactor: number): number {
  return offerDelta - grossPriceSol * (1 - netFactor);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

const MY_WALLET = 'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE';

function WalletLabel({ addr }: { addr: string }) {
  const href = `https://magiceden.io/u/${addr}`;
  if (addr === MY_WALLET) {
    return <a className="you-badge" href={href} target="_blank" rel="noopener noreferrer">YOU</a>;
  }
  return <a className="wallet-link" href={href} target="_blank" rel="noopener noreferrer">{truncate(addr)}</a>;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function resolveImage(url: string | null): string | null {
  if (!url) return null;
  const resolved = url.startsWith('ipfs://')
    ? url.replace('ipfs://', 'https://ipfs.io/ipfs/')
    : url;
  const isGif = resolved.toLowerCase().includes('.gif');
  const cdn = `https://images.weserv.nl/?url=${encodeURIComponent(resolved)}&w=320&h=320&fit=cover`;
  return isGif ? `${cdn}&output=jpg` : cdn;
}

function marketplaceBadgeClass(mp: string): string {
  return 'badge badge-' + mp.replace(/_/g, '-');
}

function marketplaceLabel(mp: string): string {
  const labels: Record<string, string> = {
    magic_eden:     'Magic Eden',
    magic_eden_amm: 'ME AMM',
    tensor:         'Tensor',
    tensor_amm:     'Tensor AMM',
    unknown:        'Unknown',
  };
  return labels[mp] ?? mp;
}

function nftTypeBadgeClass(t: string): string {
  return 'badge badge-' + t.replace(/_/g, '-');
}

function nftTypeLabel(t: string): string {
  const labels: Record<string, string> = {
    legacy:        'Legacy',
    pnft:          'pNFT',
    core:          'Core',
    metaplex_core: 'Core',
    cnft:          'cNFT',
  };
  return labels[t] ?? t;
}

// ── SaleCard ─────────────────────────────────────────────────────────────────

/**
 * Format the offer delta for display.
 *
 * Two modes:
 *  • Small/moderate gap (|delta| < salePriceSol):  "(+0.41 vs offer)" — absolute SOL
 *  • Offer >> sale   (offer ≥ 2× sale price):      "(+2050% vs sale)"  — % of sale price
 */
function formatOfferDelta(delta: number, salePriceSol: number): string {
  const absSol = Math.abs(delta);
  const sign   = delta >= 0 ? '+' : '−';

  // When the offer dwarfs the sale, switch to "vs sale" % form
  if (delta < 0 && absSol >= salePriceSol) {
    const pct = Math.round(absSol / salePriceSol * 100);
    return `(+${pct}% vs sale)`;
  }

  // Absolute SOL — vary decimals by magnitude
  let val: string;
  if (absSol < 0.01)  val = absSol.toFixed(4);
  else if (absSol < 1) val = absSol.toFixed(2);
  else                 val = absSol.toFixed(1);

  return `(${sign}${val} vs offer)`;
}

// Card border: pool / bid sells → red; normal sales and pool buys → green
function saleTypeClass(t: string): string {
  if (t === 'pool_sale' || t === 'bid_sell' || t === 'pool_sell') return 'card--sell';
  return 'card--buy';
}

function saleTypeBadgeClass(t: string): string {
  if (t === 'normal_sale') return 'badge badge-normal-sale';
  if (t === 'pool_sale')   return 'badge badge-pool-sale';
  if (t === 'bid_sell')    return 'badge badge-bid-sell';
  if (t === 'pool_sell')   return 'badge badge-pool-sell';
  if (t === 'pool_buy')    return 'badge badge-pool-buy';
  return 'badge badge-listing';
}

function saleTypeLabel(t: string): string {
  if (t === 'normal_sale') return 'NORMAL SALE';
  if (t === 'pool_sale')   return 'POOL SALE';
  if (t === 'bid_sell')    return 'BID SALE';
  if (t === 'pool_sell')   return 'POOL SELL';
  if (t === 'pool_buy')    return 'POOL BUY';
  return 'LISTING';
}

function signalBadges(e: FeedEvent, netFactor: number): Array<{ key: string; label: string; cls: string }> {
  const badges: Array<{ key: string; label: string; cls: string }> = [];
  const netFloorD = e.floorDelta != null ? toNetFloorDelta(e.floorDelta, netFactor)              : null;
  const netOfferD = e.offerDelta != null ? toNetOfferDelta(e.offerDelta, e.priceSol, netFactor)  : null;
  const netSol    = e.priceSol * netFactor;
  if (netOfferD != null && netSol > 0 && (-netOfferD / netSol) > ABOVE_OFFER_THRESHOLD)
    badges.push({ key: 'above-offer', label: 'ABOVE OFFER', cls: 'badge badge-signal-above-offer' });
  return badges;
}

function SaleCard({ event: e, netFactor }: { event: FeedEvent; netFactor: number }) {
  const [imgFailed, setImgFailed] = useState(false);
  // Reset failure flag whenever a new imageUrl arrives (e.g. after meta patch)
  useEffect(() => { setImgFailed(false); }, [e.imageUrl]);
  const imgSrc = resolveImage(e.imageUrl);

  return (
    <div className={`card ${saleTypeClass(e.saleType)}`}>
      {imgSrc && !imgFailed ? (
        <img
          className="card-img"
          src={imgSrc}
          alt={e.nftName ?? ''}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="card-img-placeholder">🖼</div>
      )}

      <div className="card-body">
        <div className="card-row1">
          <span className="card-name">{e.nftName ?? 'NFT'}</span>
          <a
            className="badge badge-magic-eden card-row1-link"
            href={e.meCollectionSlug
              ? `https://magiceden.io/marketplace/${e.meCollectionSlug}`
              : `https://magiceden.io/item-details/${e.mintAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >Magic Eden</a>
          <a
            className="badge badge-link-tensor card-row1-link"
            href={`https://www.tensor.trade/trade/${e.mintAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >Tensor</a>
          <div className="card-price-block">
            {(() => {
              const np  = e.priceSol * netFactor;
              const nfd = e.floorDelta != null ? toNetFloorDelta(e.floorDelta, netFactor)             : null;
              const nod = e.offerDelta != null ? toNetOfferDelta(e.offerDelta, e.priceSol, netFactor) : null;
              return (<>
                <span className="card-price">
                  {np.toFixed(np < 0.1 ? 4 : 3)} {e.currency}
                </span>
                <span className="card-price-gross">
                  {e.priceSol.toFixed(e.priceSol < 0.1 ? 4 : 3)} gross
                </span>
                {nfd != null && (
                  <span className="card-floor-delta">
                    ({nfd >= 0 ? '+' : ''}{Math.round(nfd * 100)}%)
                  </span>
                )}
                {nod != null && (
                  <span className="card-offer-delta">
                    {formatOfferDelta(nod, np)}
                  </span>
                )}
              </>);
            })()}
          </div>
        </div>

        {e.collectionName && (
          <div className="card-collection">{e.collectionName}</div>
        )}

        <div className="card-badges">
          {signalBadges(e, netFactor).map((s) => (
            <span key={s.key} className={s.cls}>{s.label}</span>
          ))}
          <span className={saleTypeBadgeClass(e.saleType)}>
            {saleTypeLabel(e.saleType)}
          </span>
          <span className={marketplaceBadgeClass(e.marketplace)}>
            {marketplaceLabel(e.marketplace)}
          </span>
          <span className={nftTypeBadgeClass(e.nftType)}>
            {nftTypeLabel(e.nftType)}
          </span>
        </div>

        <div className="card-addresses">
          <WalletLabel addr={e.seller} />
          {' → '}
          <WalletLabel addr={e.buyer} />
        </div>

        <div className="card-footer">
          <span className="card-time">{timeAgo(e.blockTime)}</span>
          <span className={`source-badge source-${e.source}`}>{e.source}</span>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type SseStatus = 'connecting' | 'connected' | 'disconnected';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function FeedPage() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState<SseStatus>('connecting');
  const [loading, setLoading] = useState(true);
  // Single shared tick drives timeAgo() updates for all visible cards.
  // One interval here instead of N intervals in children avoids browser timer throttling.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const seenRef    = useRef(new Set<string>());
  // mint → enriched metadata — populated when a `meta` event arrives
  const metaCache  = useRef(new Map<string, { nftName: string | null; imageUrl: string | null; collectionName: string | null; meCollectionSlug: string | null }>());

  // ── Per-collection royalty rates ────────────────────────────────────────────
  // Fetched on demand from ME API; keyed by collection slug.
  // Fallback = 0% (no entry) when royalty is unknown or collection has 0% enforced royalty.
  const royaltyFetchedRef = useRef(new Set<string>()); // guards against duplicate in-flight fetches
  const [royalties, setRoyalties] = useState<Map<string, number>>(new Map());

  function addEvent(ev: FeedEvent) {
    if (seenRef.current.has(ev.signature)) return;
    seenRef.current.add(ev.signature);
    // Apply cached metadata immediately so repeated mints never flash as "Unnamed NFT"
    const cached = metaCache.current.get(ev.mintAddress);
    const ready  = cached
      ? { ...ev,
          nftName:          cached.nftName          ?? ev.nftName,
          imageUrl:         cached.imageUrl         ?? ev.imageUrl,
          collectionName:   cached.collectionName   ?? ev.collectionName,
          meCollectionSlug: cached.meCollectionSlug ?? ev.meCollectionSlug,
        }
      : ev;
    setEvents((prev) => [ready, ...prev].slice(0, MAX_EVENTS));
  }

  function updateMeta(update: { mintAddress: string; signature: string; nftName: string | null; imageUrl: string | null; collectionName: string | null; meCollectionSlug: string | null; floorDelta: number | null; offerDelta: number | null }) {
    // Persist per-mint metadata in cache (reused when the same mint appears again)
    metaCache.current.set(update.mintAddress, {
      nftName:          update.nftName,
      imageUrl:         update.imageUrl,
      collectionName:   update.collectionName,
      meCollectionSlug: update.meCollectionSlug,
    });
    // Patch visible cards: mint-level fields by mintAddress, price-based deltas by signature
    setEvents((prev) => prev.map((e) => {
      if (e.mintAddress !== update.mintAddress) return e;
      const isExact = e.signature === update.signature;
      return {
        ...e,
        nftName:          update.nftName          ?? e.nftName,
        imageUrl:         update.imageUrl         ?? e.imageUrl,
        collectionName:   update.collectionName   ?? e.collectionName,
        meCollectionSlug: update.meCollectionSlug ?? e.meCollectionSlug,
        floorDelta:  isExact ? (update.floorDelta  ?? e.floorDelta)  : e.floorDelta,
        offerDelta:  isExact ? (update.offerDelta  ?? e.offerDelta)  : e.offerDelta,
      };
    }));
  }

  // Fetch royalty rates for collection slugs not yet resolved.
  // Runs whenever events change (new slugs arrive via meta patches).
  // One fetch per slug lifetime; 0% fallback stays when fetch fails or returns no data.
  useEffect(() => {
    for (const ev of events) {
      const slug = ev.meCollectionSlug;
      if (!slug || royaltyFetchedRef.current.has(slug)) continue;
      royaltyFetchedRef.current.add(slug);
      fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { sellerFeeBasisPoints?: number } | null) => {
          if (data?.sellerFeeBasisPoints != null) {
            setRoyalties((prev) => new Map(prev).set(slug, data.sellerFeeBasisPoints! / 10000));
          }
          // No entry → 0% fallback stays in effect
        })
        .catch(() => {}); // silent; 0% fallback stays
    }
  }, [events]);

  // Initial load
  useEffect(() => {
    fetch(`${API_BASE}/api/events/latest?limit=100`)
      .then((r) => r.json())
      .then((data: LatestApiResponse) => {
        const mapped = data.events.map(fromRow);
        mapped.forEach((e) => seenRef.current.add(e.signature));
        setEvents(mapped);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // SSE live updates + visibility-change resync
  useEffect(() => {
    let es: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      es?.close();
      setStatus('connecting');
      es = new EventSource(`${API_BASE}/api/events/stream`);

      es.addEventListener('open', () => setStatus('connected'));

      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data) as FeedEvent;
          console.log(`[timing] SSE-recv   sig=${ev.signature.slice(0,12)}  T=${Date.now()}`); // TIMING PROBE
          addEvent(ev);
        } catch {
          console.error('[sse] failed to parse sale event', e.data);
        }
      });

      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          updateMeta(JSON.parse(e.data));
        } catch {
          console.error('[sse] failed to parse meta event', e.data);
        }
      });

      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          seenRef.current.delete(signature);
          setEvents((prev) => prev.filter((ev) => ev.signature !== signature));
        } catch {
          console.error('[sse] failed to parse remove event', e.data);
        }
      });

      es.addEventListener('rawpatch', (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as {
            signature: string; seller: string; buyer: string;
            marketplace: string; nftType: string; saleType: string;
            priceSol: number;
          };
          setEvents((prev) => prev.map((ev) =>
            ev.signature !== p.signature ? ev : {
              ...ev,
              seller:      p.seller,
              buyer:       p.buyer,
              marketplace: p.marketplace,
              nftType:     p.nftType,
              saleType:    p.saleType,
              priceSol:    p.priceSol,
            }
          ));
        } catch {
          console.error('[sse] failed to parse rawpatch event', e.data);
        }
      });

      es.addEventListener('error', () => {
        setStatus('disconnected');
        es.close();
        // Only schedule a reconnect if the tab is visible; if backgrounded, the
        // visibilitychange handler will reconnect when the tab comes back.
        if (!document.hidden) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      });
    }

    // Fetch the latest 100 events and merge any the SSE stream missed.
    function catchUp() {
      fetch(`${API_BASE}/api/events/latest?limit=100`)
        .then((r) => r.json())
        .then((data: LatestApiResponse) => {
          data.events.forEach((row) => {
            if (!seenRef.current.has(row.signature)) {
              addEvent(fromRow(row));
            }
          });
        })
        .catch(console.error);
    }

    function onVisibilityChange() {
      if (document.hidden) return;
      // Tab just became visible: reconnect SSE (stream may have stalled while
      // backgrounded) then pull any missed events from the REST snapshot.
      connect();
      catchUp();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();
    return () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es?.close();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel: Record<SseStatus, string> = {
    connecting:   'Connecting…',
    connected:    'Live',
    disconnected: 'Reconnecting…',
  };

  return (
    <div className="page">
      <div className="header">
        <h1>NFT Live Feed</h1>
        <div className="header-right">
          <div className={`status-dot ${status}`} />
          <span>{statusLabel[status]}</span>
          {!loading && <span>· {events.length} events</span>}
        </div>
      </div>

      <div className="feed">
        {loading && <div className="empty">Loading…</div>}
        {!loading && events.length === 0 && (
          <div className="empty">No sales yet. Waiting for events…</div>
        )}
        {events.map((e) => {
          const royaltyRate = e.meCollectionSlug ? (royalties.get(e.meCollectionSlug) ?? 0) : 0;
          return <SaleCard key={e.signature} event={e} netFactor={1 - MARKETPLACE_FEE - royaltyRate} />;
        })}
      </div>
    </div>
  );
}
