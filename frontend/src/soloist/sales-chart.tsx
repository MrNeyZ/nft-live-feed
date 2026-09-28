'use client';

// Interactive sales scatter for the Collection page. Canvas-drawn (a few k
// points stays cheap), with an HTML tooltip overlay on top.
//
//   wheel / pinch     zoom time axis around the cursor
//   drag              pan time axis
//   double-click      reset zoom
//   hover             nearest sale → crosshair + tooltip
//   click a sale      pin tooltip (links become clickable); click empty / Esc unpins
//
// Y auto-fits to the sales inside the visible window. With `showOutliers`
// off, the fit uses a robust range (Q1 − 3·IQR … Q3 + 3·IQR) and sales
// outside it are drawn as edge markers instead of stretching the axis.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VL, VLText, alpha, rgb } from '@/lib/palette';
import { formatSol, shortWallet, timeAgo } from '@/soloist/mock-data';

export interface SalePoint {
  ts:     number;            // epoch ms
  price:  number;            // SOL (gross)
  side:   'buy' | 'sell';    // buy = listing bought, sell = bid / pool accepted
  sig:    string;
  mint:   string;
  name:   string;            // display name ("Collection #123")
  image:  string | null;     // already proxied/compressed
  mp:     string;
  buyer:  string;
  seller: string;
  rank:   number | null;
  supply: number | null;
}

interface Props {
  points:       SalePoint[];
  /** Full window the span selector asked for, in ms. */
  spanMs:       number;
  floor:        number | null;
  showOutliers: boolean;
}

const PAD = { l: 50, r: 12, t: 28, b: 22 };
const VOL_H = 34;
const VOL_GAP = 8;
const HIT_R = 14;
const MIN_RANGE_MS = 2 * 60_000;
const FRESH_MS = 2_500;
const FONT = '10px "SF Mono","Fira Code",ui-monospace,monospace';

const C = {
  buy:     rgb(VL.greenStrong),
  sell:    rgb(VL.redStrong),
  median:  alpha(VL.purpleTint, 0.75),
  floor:   alpha([240, 238, 248], 0.55),
  rare:    rgb(VL.goldBright),
  grid:    'rgba(255,255,255,0.06)',
  axis:    VLText.muted,
  cross:   'rgba(255,255,255,0.28)',
  volBuy:  alpha(VL.greenStrong, 0.35),
  volSell: alpha(VL.redStrong, 0.35),
  labelBg: '#241F3B',
};

const TIME_STEPS = [
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  86_400_000, 2 * 86_400_000, 7 * 86_400_000,
];

const pad2 = (n: number) => n.toString().padStart(2, '0');
const fmtHM = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtMD = (d: Date) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtFull = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${fmtHM(d)}:${pad2(d.getSeconds())}`;
};
function fmtPrice(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10)  return v.toFixed(1);
  if (v >= 1)   return v.toFixed(2);
  if (v >= 0.1) return v.toFixed(3);
  return v.toFixed(4);
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function isRare(p: SalePoint): boolean {
  return p.rank != null && p.supply != null && p.supply > 0 && p.rank / p.supply <= 0.01;
}

function marketplaceLabel(mp: string): string {
  const m = mp.toLowerCase();
  if (m.includes('tensor')) return 'Tensor';
  if (m.includes('magic') || m === 'me' || m.includes('mmm')) return 'Magic Eden';
  return mp;
}

function itemUrl(p: SalePoint): string {
  return p.mp.toLowerCase().includes('tensor')
    ? `https://www.tensor.trade/item/${p.mint}`
    : `https://magiceden.io/item-details/${p.mint}`;
}

interface View { t0: number; t1: number }

interface Layout {
  w: number; h: number;
  plotW: number; plotH: number;
  t0: number; t1: number;
  y0: number; y1: number;
  x(ts: number): number;
  y(price: number): number;
}

export function SalesChart({ points, spanMs, floor, showOutliers }: Props) {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);   // null = full span
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [animTick, setAnimTick] = useState(0);
  const layoutRef = useRef<Layout | null>(null);

  // Sorted by time; indices into this array are the hover/pin identity.
  const sorted = useMemo(() => [...points].sort((a, b) => a.ts - b.ts), [points]);

  // Pin/hover indices are positional — drop them when the set changes shape.
  const pinnedSig = pinned != null ? sorted[pinned]?.sig : undefined;
  useEffect(() => {
    if (pinnedSig == null) return;
    const i = sorted.findIndex(p => p.sig === pinnedSig);
    setPinned(i >= 0 ? i : null);
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted]);

  // Reset zoom when the span changes (new data window).
  useEffect(() => { setView(null); setPinned(null); setHover(null); }, [spanMs]);

  // Keep "now" moving so the right edge of the default view tracks live time.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setNow(Date.now()); }, [points]);

  // Halo animation for sales that just landed.
  useEffect(() => {
    const newest = sorted.length ? sorted[sorted.length - 1].ts : 0;
    if (Date.now() - newest > FRESH_MS) return;
    let raf = 0;
    const loop = () => {
      setAnimTick(t => t + 1);
      if (Date.now() - newest < FRESH_MS) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sorted]);

  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) setDims({ w: Math.floor(width), h: Math.floor(height) });
      }
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Full extent: the requested span ending now, widened if data sits outside.
  const extent = useMemo(() => {
    let t0 = now - spanMs, t1 = now;
    if (sorted.length) {
      t0 = Math.min(t0, sorted[0].ts);
      t1 = Math.max(t1, sorted[sorted.length - 1].ts);
    }
    return { t0, t1 };
  }, [now, spanMs, sorted]);

  const t0 = view ? view.t0 : extent.t0;
  const t1 = view ? view.t1 : extent.t1;

  // Visible slice [lo, hi) via binary search.
  const [lo, hi] = useMemo(() => {
    const bs = (t: number) => {
      let a = 0, b = sorted.length;
      while (a < b) { const m = (a + b) >> 1; if (sorted[m].ts < t) a = m + 1; else b = m; }
      return a;
    };
    return [bs(t0), bs(t1 + 1)];
  }, [sorted, t0, t1]);

  const yRange = useMemo(() => {
    const prices = sorted.slice(lo, hi).map(p => p.price).sort((a, b) => a - b);
    if (prices.length === 0) {
      const f = floor ?? 1;
      return { y0: f * 0.8, y1: f * 1.2, hidden: 0 };
    }
    let a = prices[0], b = prices[prices.length - 1];
    let hidden = 0;
    if (!showOutliers && prices.length >= 8) {
      const q1 = quantile(prices, 0.25), q3 = quantile(prices, 0.75);
      const iqr = Math.max(q3 - q1, q3 * 0.02);
      const ra = Math.max(prices[0], q1 - 3 * iqr), rb = Math.min(b, q3 + 3 * iqr);
      hidden = prices.filter(p => p < ra || p > rb).length;
      a = ra; b = rb;
    }
    if (floor != null && floor > 0 && floor >= a * 0.7 && floor <= b * 1.3) {
      a = Math.min(a, floor); b = Math.max(b, floor);
    }
    const span = b - a || Math.max(b * 0.1, 0.01);
    return { y0: Math.max(0, a - span * 0.08), y1: b + span * 0.1, hidden };
  }, [sorted, lo, hi, showOutliers, floor]);

  // Rolling median over the whole span (window scales with density), so
  // zooming doesn't restart the line at the left edge.
  const medianAll = useMemo(() => {
    const n = sorted.length;
    if (n < 12) return [] as { ts: number; v: number }[];
    const k = Math.max(5, Math.min(60, Math.round(n / 25)));
    const out: { ts: number; v: number }[] = [];
    for (let i = 4; i < n; i++) {
      const s = sorted.slice(Math.max(0, i - k + 1), i + 1).map(p => p.price).sort((x, y) => x - y);
      out.push({ ts: sorted[i].ts, v: quantile(s, 0.5) });
    }
    return out;
  }, [sorted]);
  const medianLine = useMemo(() => {
    let a = 0, b = medianAll.length;
    while (a < medianAll.length && medianAll[a].ts < t0) a++;
    while (b > a && medianAll[b - 1].ts > t1) b--;
    return medianAll.slice(Math.max(0, a - 1), Math.min(medianAll.length, b + 1));
  }, [medianAll, t0, t1]);

  // ── Draw ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== dims.w * dpr || canvas.height !== dims.h * dpr) {
      canvas.width = dims.w * dpr;
      canvas.height = dims.h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const plotW = dims.w - PAD.l - PAD.r;
    const plotH = dims.h - PAD.t - PAD.b - VOL_H - VOL_GAP;
    if (plotW < 40 || plotH < 40) return;
    const { y0, y1 } = yRange;
    const x = (ts: number) => PAD.l + ((ts - t0) / (t1 - t0 || 1)) * plotW;
    const y = (p: number) => PAD.t + plotH - ((p - y0) / (y1 - y0 || 1)) * plotH;
    layoutRef.current = { w: dims.w, h: dims.h, plotW, plotH, t0, t1, y0, y1, x, y };

    ctx.font = FONT;

    // Y grid + labels
    const yStep = niceStep(y1 - y0, Math.max(3, Math.floor(plotH / 44)));
    ctx.lineWidth = 1;
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(PAD.l + plotW, yy); ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'right';
      ctx.fillText(fmtPrice(v), PAD.l - 6, yy + 3);
    }

    // X ticks
    const range = t1 - t0;
    const maxTicks = Math.max(2, Math.floor(plotW / 84));
    const tStep = TIME_STEPS.find(s => range / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const tzOff = new Date().getTimezoneOffset() * 60_000;
    const first = Math.ceil((t0 - tzOff) / tStep) * tStep + tzOff;
    const axisY = PAD.t + plotH + VOL_GAP + VOL_H;
    ctx.textAlign = 'center';
    for (let t = first; t <= t1; t += tStep) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, PAD.t + plotH); ctx.stroke();
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = tStep >= 86_400_000 || midnight ? fmtMD(d) : fmtHM(d);
      ctx.fillStyle = C.axis;
      ctx.fillText(label, xx, axisY + 14);
    }

    // Volume strip (buy/sell stacked)
    const buckets = Math.max(10, Math.min(120, Math.floor(plotW / 7)));
    const bBuy = new Array(buckets).fill(0), bSell = new Array(buckets).fill(0);
    for (let i = lo; i < hi; i++) {
      const bi = Math.min(buckets - 1, Math.floor(((sorted[i].ts - t0) / range) * buckets));
      if (bi < 0) continue;
      if (sorted[i].side === 'sell') bSell[bi]++; else bBuy[bi]++;
    }
    let maxB = 1;
    for (let i = 0; i < buckets; i++) maxB = Math.max(maxB, bBuy[i] + bSell[i]);
    const bw = plotW / buckets;
    const volTop = PAD.t + plotH + VOL_GAP;
    for (let i = 0; i < buckets; i++) {
      const hb = (bBuy[i] / maxB) * VOL_H, hs = (bSell[i] / maxB) * VOL_H;
      const bx = PAD.l + i * bw + 0.5, bwid = Math.max(1, bw - 1);
      if (hb > 0) { ctx.fillStyle = C.volBuy;  ctx.fillRect(bx, volTop + VOL_H - hb, bwid, hb); }
      if (hs > 0) { ctx.fillStyle = C.volSell; ctx.fillRect(bx, volTop + VOL_H - hb - hs, bwid, hs); }
    }

    // Clip plot area for lines + dots
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t, plotW, plotH); ctx.clip();

    // Floor line
    if (floor != null && floor > 0 && floor >= y0 && floor <= y1) {
      const fy = Math.round(y(floor)) + 0.5;
      ctx.strokeStyle = C.floor;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(PAD.l, fy); ctx.lineTo(PAD.l + plotW, fy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Median line
    if (medianLine.length > 1) {
      ctx.strokeStyle = C.median;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      medianLine.forEach((m, i) => (i ? ctx.lineTo(x(m.ts), y(m.v)) : ctx.moveTo(x(m.ts), y(m.v))));
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Dots
    const n = hi - lo;
    const r = n > 1500 ? 2.2 : n > 400 ? 2.8 : 3.4;
    const nowMs = Date.now();
    for (let i = lo; i < hi; i++) {
      const p = sorted[i];
      const px = x(p.ts);
      const clippedHi = p.price > y1, clippedLo = p.price < y0;
      const col = p.side === 'sell' ? C.sell : C.buy;
      if (clippedHi || clippedLo) {
        // Out-of-range sale: small triangle on the edge.
        const ey = clippedHi ? PAD.t + 4 : PAD.t + plotH - 4;
        const dir = clippedHi ? -1 : 1;
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(px, ey + dir * 4); ctx.lineTo(px - 3.5, ey - dir * 2); ctx.lineTo(px + 3.5, ey - dir * 2);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }
      const py = y(p.price);
      const age = nowMs - p.ts;
      if (age >= 0 && age < FRESH_MS) {
        const k = age / FRESH_MS;
        ctx.beginPath();
        ctx.arc(px, py, r + 2 + k * 12, 0, Math.PI * 2);
        ctx.fillStyle = p.side === 'sell' ? alpha(VL.redStrong, 0.5 * (1 - k)) : alpha(VL.greenStrong, 0.5 * (1 - k));
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isRare(p)) {
        ctx.strokeStyle = C.rare;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Active (hover / pinned) highlight + crosshair
    const active = pinned ?? hover;
    const ap = active != null ? sorted[active] : undefined;
    if (ap && ap.ts >= t0 && ap.ts <= t1 && ap.price >= y0 && ap.price <= y1) {
      const ax = x(ap.ts), ay = y(ap.price);
      ctx.strokeStyle = C.cross;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, ay); ctx.lineTo(PAD.l + plotW, ay);
      ctx.moveTo(ax, PAD.t); ctx.lineTo(ax, PAD.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(ax, ay, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = VLText.primary;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.restore();

    // Axis labels for floor + active point (drawn outside clip, over axis)
    const tag = (text: string, yy: number, bg: string, fg: string) => {
      const tw = ctx.measureText(text).width + 8;
      ctx.fillStyle = bg;
      ctx.fillRect(PAD.l - tw - 2, yy - 7, tw, 14);
      ctx.fillStyle = fg;
      ctx.textAlign = 'right';
      ctx.fillText(text, PAD.l - 6, yy + 3);
    };
    if (floor != null && floor > 0 && floor >= y0 && floor <= y1) {
      tag(fmtPrice(floor), y(floor), '#3a3552', VLText.primary);
    }
    if (ap && ap.ts >= t0 && ap.ts <= t1 && ap.price >= y0 && ap.price <= y1) {
      tag(fmtPrice(ap.price), y(ap.price), ap.side === 'sell' ? C.sell : C.buy, '#0a0714');
      const tl = fmtHM(new Date(ap.ts)) + (range > 86_400_000 ? ` ${fmtMD(new Date(ap.ts))}` : '');
      const tw = ctx.measureText(tl).width + 8;
      const tx = Math.min(Math.max(x(ap.ts), PAD.l + tw / 2), PAD.l + plotW - tw / 2);
      ctx.fillStyle = C.labelBg;
      ctx.fillRect(tx - tw / 2, axisY + 4, tw, 14);
      ctx.fillStyle = VLText.primary;
      ctx.textAlign = 'center';
      ctx.fillText(tl, tx, axisY + 14);
    }
  }, [dims, sorted, lo, hi, t0, t1, yRange, floor, medianLine, hover, pinned, animTick]);

  // ── Interaction ──────────────────────────────────────────────────────
  const clampView = useCallback((a: number, b: number): View | null => {
    const full = extent.t1 - extent.t0;
    const w = Math.max(MIN_RANGE_MS, b - a);
    if (w >= full) return null;
    if (a < extent.t0) { a = extent.t0; b = a + w; }
    if (b > extent.t1) { b = extent.t1; a = b - w; }
    return { t0: a, t1: b };
  }, [extent]);

  const zoomAt = useCallback((clientX: number, factor: number) => {
    const L = layoutRef.current, el = canvasRef.current;
    if (!L || !el) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left - PAD.l) / L.plotW));
    const anchor = L.t0 + frac * (L.t1 - L.t0);
    const w = (L.t1 - L.t0) * factor;
    setView(clampView(anchor - frac * w, anchor + (1 - frac) * w));
  }, [clampView]);

  // Native (non-passive) wheel listener so the page doesn't scroll while zooming.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX, Math.exp(dy * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const hitTest = useCallback((clientX: number, clientY: number): number | null => {
    const L = layoutRef.current, el = canvasRef.current;
    if (!L || !el) return null;
    const rect = el.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    if (mx < PAD.l || mx > PAD.l + L.plotW || my < PAD.t - 6 || my > PAD.t + L.plotH + 6) return null;
    let best: number | null = null, bestD = HIT_R * HIT_R;
    for (let i = lo; i < hi; i++) {
      const p = sorted[i];
      const py = p.price > L.y1 ? PAD.t + 4 : p.price < L.y0 ? PAD.t + L.plotH - 4 : L.y(p.price);
      const dx = L.x(p.ts) - mx, dy = py - my;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }, [sorted, lo, hi]);

  // Pointer state: pan with one pointer, pinch-zoom with two.
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; view: View; midX: number } | null>(null);

  const currentView = (): View => ({ t0, t1 });

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 1) {
      drag.current = { startX: e.clientX, startY: e.clientY, view: currentView(), moved: false };
    } else if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { dist: Math.abs(a.x - b.x) || 1, view: currentView(), midX: (a.x + b.x) / 2 };
      drag.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const L = layoutRef.current;
    if (pinch.current && ptrs.current.size === 2 && L) {
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.abs(a.x - b.x) || 1;
      const pv = pinch.current.view;
      const rect = canvasRef.current!.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (pinch.current.midX - rect.left - PAD.l) / L.plotW));
      const anchor = pv.t0 + frac * (pv.t1 - pv.t0);
      const w = (pv.t1 - pv.t0) * (pinch.current.dist / dist);
      setView(clampView(anchor - frac * w, anchor + (1 - frac) * w));
      return;
    }
    const d = drag.current;
    if (d && L) {
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) + Math.abs(e.clientY - d.startY) > 4) d.moved = true;
      if (d.moved) {
        const shift = (dx / L.plotW) * (d.view.t1 - d.view.t0);
        setView(clampView(d.view.t0 - shift, d.view.t1 - shift));
        setHover(null);
        return;
      }
    }
    if (e.pointerType === 'mouse' && !d) setHover(hitTest(e.clientX, e.clientY));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const hit = hitTest(e.clientX, e.clientY);
      setPinned(hit != null && hit !== pinned ? hit : null);
    }
  };

  useEffect(() => {
    if (pinned == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  // ── Tooltip ──────────────────────────────────────────────────────────
  const active = pinned ?? hover;
  const ap = active != null ? sorted[active] : undefined;
  const L = layoutRef.current;
  let tip: React.ReactNode = null;
  if (ap && L && ap.ts >= t0 && ap.ts <= t1) {
    const ax = L.x(ap.ts);
    const ay = ap.price > L.y1 ? PAD.t : ap.price < L.y0 ? PAD.t + L.plotH : L.y(ap.price);
    const TW = 236;
    const left = ax + 14 + TW > dims.w - 4 ? Math.max(4, ax - 14 - TW) : ax + 14;
    const top = Math.min(Math.max(4, ay - 50), Math.max(4, dims.h - 150));
    // Sales stacked on (nearly) the same pixel — sweeps, bundles.
    let stacked = 0;
    for (let i = lo; i < hi; i++) {
      if (i === active) continue;
      const p = sorted[i];
      if (Math.abs(L.x(p.ts) - ax) < 3 && Math.abs(L.y(p.price) - L.y(ap.price)) < 3) stacked++;
    }
    const vsFloor = floor ? (ap.price / floor - 1) * 100 : null;
    const isPinned = pinned != null;
    const link = (href: string, text: string) => (
      <a href={href} target="_blank" rel="noopener noreferrer"
        style={{ color: 'var(--vl-purple-tint)', textDecoration: 'none' }}>{text}</a>
    );
    tip = (
      <div
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'absolute', left, top, width: TW, zIndex: 3,
          background: 'rgba(19,16,42,0.97)', border: `1px solid ${isPinned ? 'var(--vl-purple-tint)' : 'var(--vl-border-primary)'}`,
          borderRadius: 8, padding: 8, fontSize: 11, color: VLText.muted,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          pointerEvents: isPinned ? 'auto' : 'none',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {ap.image
            ? <img src={ap.image} alt="" width={44} height={44} style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#0a0714' }} />
            : <div style={{ width: 44, height: 44, borderRadius: 6, background: '#241F3B', flexShrink: 0 }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: VLText.primary, fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ap.name}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: ap.side === 'sell' ? C.sell : C.buy }}>{formatSol(ap.price)}</span>
              {vsFloor != null && (
                <span style={{ color: vsFloor < 0 ? C.buy : VLText.muted }}>
                  {vsFloor >= 0 ? '+' : ''}{vsFloor.toFixed(1)}% vs floor
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 2 }}>
          <span>Type</span>
          <span style={{ color: VLText.primary }}>{ap.side === 'sell' ? 'Sold into bid / pool' : 'Listing bought'} · {marketplaceLabel(ap.mp)}</span>
          {ap.rank != null && <>
            <span>Rarity</span>
            <span style={{ color: isRare(ap) ? C.rare : VLText.primary }}>
              #{ap.rank}{ap.supply ? ` / ${ap.supply} (top ${Math.max(0.1, (ap.rank / ap.supply) * 100).toFixed(1)}%)` : ''}
            </span>
          </>}
          <span>Time</span>
          <span style={{ color: VLText.primary }}>{fmtFull(ap.ts)} · {timeAgo(ap.ts)}</span>
          <span>Buyer</span>
          <span style={{ color: VLText.primary }}>{isPinned ? link(`https://solscan.io/account/${ap.buyer}`, shortWallet(ap.buyer)) : shortWallet(ap.buyer)}</span>
          <span>Seller</span>
          <span style={{ color: VLText.primary }}>{isPinned ? link(`https://solscan.io/account/${ap.seller}`, shortWallet(ap.seller)) : shortWallet(ap.seller)}</span>
        </div>
        {stacked > 0 && <div style={{ color: VLText.faint }}>+{stacked} more sale{stacked > 1 ? 's' : ''} at this spot</div>}
        {isPinned
          ? <div style={{ display: 'flex', gap: 12, borderTop: '1px solid var(--vl-border-subtle)', paddingTop: 6 }}>
              {link(`https://solscan.io/tx/${ap.sig}`, 'Tx ↗')}
              {link(itemUrl(ap), 'Item ↗')}
              <span style={{ marginLeft: 'auto', color: VLText.faint }}>Esc to close</span>
            </div>
          : <div style={{ color: VLText.faint }}>Click to pin</div>}
      </div>
    );
  }

  const zoomed = view != null;
  const btn: React.CSSProperties = {
    padding: '2px 7px', fontSize: 10, fontWeight: 600, borderRadius: 4,
    border: '1px solid var(--vl-border-primary)', background: 'rgba(19,16,42,0.9)',
    color: VLText.muted, cursor: 'pointer',
  };

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: '100%', display: 'block', touchAction: 'none',
          cursor: drag.current?.moved ? 'grabbing' : hover != null ? 'pointer' : 'crosshair',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null); }}
        onDoubleClick={() => { setView(null); setPinned(null); }}
      />
      {/* Legend + zoom controls */}
      <div style={{
        position: 'absolute', top: 6, left: PAD.l + 6, right: PAD.r + 6,
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: VLText.muted,
        pointerEvents: 'none', flexWrap: 'wrap',
      }}>
        <span><span style={{ color: C.buy }}>●</span> Listing buy</span>
        <span><span style={{ color: C.sell }}>●</span> Bid sell</span>
        <span><span style={{ color: C.median }}>━</span> Median</span>
        {floor != null && floor > 0 && <span><span style={{ color: C.floor }}>┄</span> Floor</span>}
        <span><span style={{ color: C.rare }}>◯</span> Top 1%</span>
        {yRange.hidden > 0 && <span style={{ color: VLText.faint }}>{yRange.hidden} outlier{yRange.hidden > 1 ? 's' : ''} at edge</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, pointerEvents: 'auto' }}>
          <button style={btn} onClick={() => zoomAt((canvasRef.current?.getBoundingClientRect().left ?? 0) + PAD.l + (layoutRef.current?.plotW ?? 0) / 2, 0.6)} title="Zoom in (or scroll)">+</button>
          <button style={btn} onClick={() => zoomAt((canvasRef.current?.getBoundingClientRect().left ?? 0) + PAD.l + (layoutRef.current?.plotW ?? 0) / 2, 1 / 0.6)} title="Zoom out">−</button>
          {zoomed && <button style={btn} onClick={() => setView(null)} title="Reset zoom (double-click)">Reset</button>}
        </span>
      </div>
      {tip}
      {sorted.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: VLText.muted, fontSize: 11, pointerEvents: 'none' }}>
          No sales in this span.
        </div>
      )}
    </div>
  );
}
