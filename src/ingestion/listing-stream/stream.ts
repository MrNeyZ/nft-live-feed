/**
 * Market-wide listing stream — Helius Enhanced WebSocket `transactionSubscribe`
 * on ME M2 + Tensor TComp at `processed` commitment.
 *
 * Why this and not logsSubscribe + getTransaction: the full tx arrives in the
 * stream (billed 2 credits / 0.1 MB ≈ 0.05 credits per tx), so no per-listing
 * getTransaction (1 credit) is needed. ~10k tx/h market-wide ≈ 230–300k
 * credits/month (measured 2026-09-28).
 *
 * Every decoded list / delist / edit is handed to `onAction`; the caller
 * decides what to keep (listings-store applies it to warm collections).
 */

import WebSocket from 'ws';
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import { decodeIx, txHasSale, STREAM_PROGRAMS, type ListingAction } from './decode';

export interface StreamedListingAction extends ListingAction {
  signature: string;
  slot:      number;
  /** Wall-clock receive time (processed commitment ≈ block time). */
  ts:        number;
}

const PING_MS          = 30_000;
const STALE_MS         = 90_000;   // no message at all for this long → reconnect
const STATS_MS         = 5 * 60_000;
const BACKOFF_MS       = [1_000, 2_000, 5_000, 10_000, 30_000];

interface Stats {
  since: number; msgs: number; bytes: number; actions: Record<string, number>;
  skippedSaleTx: number; decodeErrors: number;
}
const newStats = (): Stats => ({ since: Date.now(), msgs: 0, bytes: 0, actions: {}, skippedSaleTx: 0, decodeErrors: 0 });

export function startListingStream(onAction: (a: StreamedListingAction) => void): () => void {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    console.warn('[listing-stream] HELIUS_API_KEY missing — stream disabled');
    return () => {};
  }
  const url = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let lastMsgAt = Date.now();
  let stats = newStats();
  let pingTimer: NodeJS.Timeout | null = null;

  const statsTimer = setInterval(() => {
    const mins = (Date.now() - stats.since) / 60_000;
    const credits = (stats.bytes / 100_000) * 2;
    console.log(
      `[listing-stream/stats] ${mins.toFixed(1)}m msgs=${stats.msgs} MB=${(stats.bytes / 1e6).toFixed(2)} ` +
      `credits=${credits.toFixed(0)} (~${Math.round(credits / mins * 60 * 24 * 30)}/mo) ` +
      `saleTxSkipped=${stats.skippedSaleTx} decodeErr=${stats.decodeErrors} actions=${JSON.stringify(stats.actions)}`,
    );
    stats = newStats();
  }, STATS_MS);

  const handle = (raw: WebSocket.RawData) => {
    lastMsgAt = Date.now();
    const buf = raw as Buffer;
    let m: any;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.error) { console.error('[listing-stream] rpc error', JSON.stringify(m.error)); return; }
    const r = m.params?.result;
    if (!r) return;
    stats.msgs++; stats.bytes += buf.length;
    try {
      const meta = r.transaction?.meta;
      const logs: string[] = meta?.logMessages ?? [];
      const txB64 = r.transaction?.transaction?.[0];
      if (!txB64 || meta?.err) return;
      const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
      const keys = [
        ...tx.message.staticAccountKeys.map(k => k.toBase58()),
        ...(meta.loadedAddresses?.writable ?? []),
        ...(meta.loadedAddresses?.readonly ?? []),
      ];
      const found: ListingAction[] = [];
      for (const ix of tx.message.compiledInstructions) {
        const a = decodeIx(keys[ix.programIdIndex], ix.accountKeyIndexes.map(i => keys[i]), ix.data);
        if (a) found.push(a);
      }
      for (const inner of meta.innerInstructions ?? []) {
        for (const ix of inner.instructions ?? []) {
          const a = decodeIx(keys[ix.programIdIndex], (ix.accounts ?? []).map((i: number) => keys[i]), bs58.decode(ix.data));
          if (a) found.push(a);
        }
      }
      if (found.length === 0) return;
      // A list ix inside a sale tx is consumed immediately (seller-initiated
      // bid fill / instant buy) — the sales pipeline owns that removal.
      const saleTx = txHasSale(logs);
      if (saleTx) stats.skippedSaleTx++;
      const now = Date.now();
      for (const a of found) {
        if (saleTx && a.kind !== 'delist') continue;
        stats.actions[`${a.marketplace}:${a.ix}`] = (stats.actions[`${a.marketplace}:${a.ix}`] ?? 0) + 1;
        onAction({ ...a, signature: r.signature, slot: r.slot, ts: now });
      }
    } catch (err) {
      stats.decodeErrors++;
      if (stats.decodeErrors <= 3) console.warn('[listing-stream] decode error', (err as Error).message);
    }
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.on('open', () => {
      attempt = 0;
      lastMsgAt = Date.now();
      STREAM_PROGRAMS.forEach((program, i) => ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: i + 1, method: 'transactionSubscribe',
        params: [
          { accountInclude: [program], failed: false, vote: false },
          { commitment: 'processed', encoding: 'base64', transactionDetails: 'full',
            showRewards: false, maxSupportedTransactionVersion: 1 },
        ],
      })));
      console.log(`[listing-stream] connected, subscribed ${STREAM_PROGRAMS.length} programs`);
      pingTimer = setInterval(() => {
        if (Date.now() - lastMsgAt > STALE_MS) { console.warn('[listing-stream] stale — reconnecting'); ws?.terminate(); return; }
        try { ws?.ping(); } catch { /* close handler reconnects */ }
      }, PING_MS);
    });
    ws.on('message', handle);
    ws.on('error', (e) => console.warn('[listing-stream] ws error', e.message));
    ws.on('close', (code) => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (stopped) return;
      const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      console.warn(`[listing-stream] closed code=${code}, reconnect in ${delay}ms`);
      setTimeout(connect, delay);
    });
  };
  connect();

  return () => {
    stopped = true;
    clearInterval(statsTimer);
    if (pingTimer) clearInterval(pingTimer);
    ws?.close();
  };
}
