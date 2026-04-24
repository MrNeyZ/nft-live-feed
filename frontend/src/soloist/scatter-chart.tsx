'use client';

// Canvas-based price scatter + volume strip. Port of ScatterChart from
// collection.html — same dot/halo/grid treatment, flat terminal aesthetic.

import { useEffect, useRef, useState } from 'react';

export interface ScatterPoint {
  ts: number;
  price: number;
  type: 'buy' | 'sell';
}

interface Props {
  trades: ScatterPoint[];
  span: string;
  interval: string;
}

export function ScatterChart({ trades, span, interval }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 280 });
  const [pulseTick, setPulseTick] = useState(0);

  // Drive halo animation while any trade is under 1.8s old.
  useEffect(() => {
    const now = Date.now();
    const hasFresh = trades.some(t => now - t.ts < 1800);
    if (!hasFresh) return;
    let raf: number;
    const loop = () => {
      setPulseTick(t => t + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [trades]);

  // Observe container size to keep canvas responsive.
  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) setDims({ w: Math.floor(width), h: Math.floor(height) });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || trades.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = dims;
    const PAD = { l: 46, r: 16, t: 10, b: 52 };
    const chartW = w - PAD.l - PAD.r;
    const chartH = h - PAD.t - PAD.b - 40;
    const volH = 30;

    ctx.clearRect(0, 0, w, h);

    const prices = trades.map(t => t.price);
    const times = trades.map(t => t.ts);
    const minP = Math.min(...prices) * 0.95;
    const maxP = Math.max(...prices) * 1.05;
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const pRange = maxP - minP || 1;
    const tRange = maxT - minT || 1;

    // Y axis ticks + grid lines
    const pStep = Math.pow(10, Math.floor(Math.log10(pRange / 4)));
    const ticks: number[] = [];
    for (let v = Math.ceil(minP / pStep) * pStep; v <= maxP; v += pStep) ticks.push(v);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ticks.forEach(v => {
      const y = PAD.t + chartH - ((v - minP) / pRange) * chartH;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + chartW, y); ctx.stroke();
      ctx.fillStyle = '#5a5a78';
      ctx.font = '9px "SF Mono","Fira Code",monospace';
      const label = v.toFixed(v < 1 ? 3 : v < 10 ? 2 : 1);
      ctx.textAlign = 'right';
      ctx.fillText(label, PAD.l - 5, y + 3);
      ctx.textAlign = 'left';
      ctx.fillText(label, PAD.l + chartW + 4, y + 3);
    });

    // X axis labels
    const xLabelCount = Math.min(6, trades.length);
    ctx.fillStyle = '#5a5a78';
    ctx.font = '9px "SF Mono","Fira Code",monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= xLabelCount; i++) {
      const frac = i / xLabelCount;
      const x = PAD.l + frac * chartW;
      const tsAt = minT + frac * tRange;
      const d = new Date(tsAt);
      const label = span === '7D'
        ? `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`
        : `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      ctx.fillText(label, x, PAD.t + chartH + volH + 16);
    }

    // Axis title
    ctx.save();
    ctx.translate(10, PAD.t + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#5a5a78';
    ctx.font = '9px -apple-system,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PRICE IN SOL', 0, 0);
    ctx.restore();

    // Volume bars (bottom strip)
    const buckets = 40;
    const bucketCounts = new Array(buckets).fill(0);
    trades.forEach(t => {
      const bi = Math.min(buckets - 1, Math.floor(((t.ts - minT) / tRange) * buckets));
      bucketCounts[bi]++;
    });
    const maxBucket = Math.max(...bucketCounts, 1);
    const bw = chartW / buckets;
    bucketCounts.forEach((cnt, i) => {
      const bh = (cnt / maxBucket) * volH;
      const x = PAD.l + i * bw;
      const y = PAD.t + chartH + (volH - bh);
      ctx.fillStyle = 'rgba(168,144,232,0.55)';
      ctx.beginPath();
      ctx.rect(x + 0.5, y, bw - 1, bh);
      ctx.fill();
    });

    // Dots (flat). Newest (<1.8s) gets a fading halo ring.
    const now = Date.now();
    trades.forEach(t => {
      const x = PAD.l + ((t.ts - minT) / tRange) * chartW;
      const y = PAD.t + chartH - ((t.price - minP) / pRange) * chartH;
      const isSell = t.type === 'sell';
      const age = now - t.ts;
      const isFresh = age < 1800;
      const color = isSell ? '#f87171' : '#a890e8';

      if (isFresh) {
        const k = age / 1800;
        const haloR = 3 + k * 12;
        const haloAlpha = 0.55 * (1 - k);
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, Math.PI * 2);
        ctx.fillStyle = isSell
          ? `rgba(248,113,113,${haloAlpha})`
          : `rgba(168,144,232,${haloAlpha})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, isFresh ? 3.6 : 2.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }, [trades, dims, span, interval, pulseTick]);

  // The chart's container fills 100% × 100% of its parent (which gives it a
  // pixel height — `<div style={{ height: 220 }}>` in the collection page).
  // The previous `flex: 1, minHeight: 0` only resolved correctly when the
  // grandparent was a flex column; in any other context the wrapper
  // collapsed and the canvas — kept at its 280-px intrinsic attribute height
  // and stretched via `height: 100%` — painted past the wrapper, visually
  // bleeding into the filters/list below. `overflow: hidden` is added as a
  // belt-and-suspenders guard so a brief one-frame mismatch between
  // `dims.h` and the actual container height during ResizeObserver settle
  // can't paint outside the box.
  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        width={dims.w}
        height={dims.h}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
