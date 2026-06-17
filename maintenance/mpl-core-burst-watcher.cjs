#!/usr/bin/env node
/**
 * Passive, READ-ONLY watcher for the next high-volume mpl_core mint burst.
 *
 * Detects a burst and writes a NEXT BURST REPORT — no app/ingestion/parser/
 * frontend changes, no DB writes. Reads: backend.out.log, mint_events (SELECT),
 * Helius DAS (getAssetsByGroup / getSignaturesForAddress, read-only).
 *
 * Trigger (either):
 *   A) a NON-cold-start [mints/poller] sweep with atCap=true AND pages>1 in the
 *      last 30 min, OR
 *   B) a collection with >=100 captured mints in mint_events in the last 30 min.
 *
 * Cold-start exclusion: a sweep within COLD_START_MS of the backend process
 * start (pm2 uptime) is ignored for triggering / P0 (the empty-cursor first
 * sweep always paginates to MAX_PAGES by construction).
 *
 * One-shot: on first trigger, writes the report + prints it + exits(0). Re-arm
 * by relaunching. Self-exits after MAX_RUNTIME_MS if no burst.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');
require('dotenv').config({ path: '/root/nft-live-feed/.env' });

const LOG = '/home/nftfeed/logs/backend.out.log';
const OUT_DIR = '/root/nft-live-feed/data/backfills';
const POLL_MS = 60_000;
const WINDOW_MIN = 30;
const COLD_START_MS = 120_000;
const MAX_RUNTIME_MS = 24 * 3600_000;
const MPL_CORE_POLL_LIMIT = parseInt(process.env.MINT_MPL_CORE_POLL_LIMIT ?? '25', 10) || 25;
const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const startedAt = Date.now();

async function rpc(method, params) {
  const r = await fetch(HELIUS, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}
function backendStartMs() {
  try {
    const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8' }));
    const p = j.find((x) => x.name === 'nft-backend');
    return p ? p.pm2_env.pm_uptime : 0;
  } catch { return 0; }
}
function tail(file, n) {
  try { return execSync(`tail -n ${n} ${file}`, { encoding: 'utf8' }).split('\n'); } catch { return []; }
}
// Parse [mints/poller] sweep lines newer than sinceMs into {ts,sigs,pages,atCap,safetyCapHit,coldStart}
function parseSweeps(lines, sinceMs, bootMs) {
  const out = [];
  for (const l of lines) {
    if (!l.includes('sweep target=mpl_core') || !l.includes('pages=')) continue;
    const tsm = l.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/);
    if (!tsm) continue;
    const ts = Date.parse(tsm[1] + 'Z');
    if (!ts || ts < sinceMs) continue;
    const g = (re) => { const m = l.match(re); return m ? m[1] : null; };
    out.push({
      ts, line: l.trim(),
      sigs: +(g(/sigs=(\d+)/) || 0),
      pages: +(g(/pages=(\d+)/) || 1),
      atCap: g(/atCap=(true|false)/) === 'true',
      safetyCapHit: g(/safetyCapHit=(true|false)/) === 'true',
      coldStart: bootMs > 0 && Math.abs(ts - bootMs) < COLD_START_MS,
    });
  }
  return out;
}
async function dasNewestMintTimes(coll, sampleN) {
  // newest assets by created → per-asset oldest sig = mint time
  const r = await rpc('getAssetsByGroup', { groupKey: 'collection', groupValue: coll, page: 1, limit: sampleN, sortBy: { sortBy: 'created', sortDirection: 'desc' } });
  const items = (r && r.items) || [];
  const out = [];
  for (const it of items) {
    const s = await rpc('getSignaturesForAddress', [it.id, { limit: 1000 }]);
    if (s && s.length) out.push({ mint: it.id, t: s[s.length - 1].blockTime });
  }
  return out;
}
async function dasTotal(coll) {
  let page = 1, total = 0;
  while (page <= 6) { const r = await rpc('getAssetsByGroup', { groupKey: 'collection', groupValue: coll, page, limit: 1000 }); const it = (r && r.items) || []; if (!it.length) break; total += it.length; page++; }
  return total;
}

async function buildReport(trigger, pool, bootMs) {
  const nowMs = Date.now();
  const sinceMs = nowMs - WINDOW_MIN * 60_000;
  const sweeps = parseSweeps(tail(LOG, 8000), sinceMs, bootMs);
  const atCapMulti = sweeps.filter((s) => s.atCap && s.pages > 1);
  const realSafety = sweeps.filter((s) => s.safetyCapHit && !s.coldStart);
  const maxPages = sweeps.reduce((m, s) => Math.max(m, s.pages), 0);

  // top collections by captured count in window
  const top = (await pool.query(
    `select collection_address, count(*) c, max(nft_name) nm, min(block_time) f, max(block_time) l
       from mint_events where block_time > now() - interval '${WINDOW_MIN} minutes'
       group by 1 order by 2 desc limit 3`)).rows;

  const lines = [];
  lines.push('NEXT BURST REPORT');
  lines.push('=================');
  lines.push(`generated: ${new Date(nowMs).toISOString()}`);
  lines.push(`trigger reason: ${trigger}`);
  lines.push(`burst window: ${new Date(sinceMs).toISOString()} .. ${new Date(nowMs).toISOString()} (${WINDOW_MIN}m)`);
  lines.push('');
  lines.push('POLLER STATS (window):');
  lines.push(`  total sweeps     : ${sweeps.length}`);
  lines.push(`  atCap sweeps     : ${sweeps.filter((s) => s.atCap).length}`);
  lines.push(`  multi-page sweeps: ${sweeps.filter((s) => s.pages > 1).length}`);
  lines.push(`  max pages        : ${maxPages}`);
  lines.push(`  safetyCapHit (total / non-cold-start): ${sweeps.filter((s) => s.safetyCapHit).length} / ${realSafety.length}`);
  if (sweeps.filter((s) => s.safetyCapHit).length) { lines.push('  safetyCapHit lines:'); sweeps.filter((s) => s.safetyCapHit).forEach((s) => lines.push(`    ${s.coldStart ? '[cold-start]' : '[REAL]'} ${s.line}`)); }
  lines.push('');

  // retention for top collections (window-scoped via per-asset mint time)
  lines.push('TOP COLLECTIONS:');
  let worstRetention = 100;
  for (const c of top) {
    const captured = +c.c;
    let minted = null, retention = null;
    try {
      const times = await dasNewestMintTimes(c.collection_address, 200);
      const inWindow = times.filter((x) => x.t * 1000 >= sinceMs).length;
      const total = await dasTotal(c.collection_address);
      minted = inWindow >= 200 ? `>=${inWindow} (sample cap; total DAS=${total})` : inWindow;
      const denom = typeof minted === 'number' ? minted : inWindow;
      retention = denom > 0 ? (100 * captured / denom) : null;
      if (retention !== null && retention < worstRetention) worstRetention = retention;
    } catch (e) { minted = 'das_error:' + e.message; }
    lines.push(`  - ${c.collection_address}  ${JSON.stringify(c.nm)}`);
    lines.push(`      captured(window)=${captured}  first=${c.f.toISOString().slice(11,19)} last=${c.l.toISOString().slice(11,19)}`);
    lines.push(`      minted(window, DAS sample)=${minted}  retention≈${retention === null ? 'n/a' : retention.toFixed(1) + '%'}`);
  }
  lines.push('');

  // conclusion
  lines.push('CONCLUSION:');
  if (realSafety.length > 0) {
    const maxRealSigs = Math.max(...sweeps.filter((s)=>!s.coldStart).map((s)=>s.sigs), 0);
    const needPages = Math.ceil(maxRealSigs / MPL_CORE_POLL_LIMIT) + 1;
    lines.push(`  [P0] safetyCapHit=true OUTSIDE cold-start (${realSafety.length}x) — pagination cap reached on a real burst.`);
    lines.push(`       Largest real sweep enumerated ${maxRealSigs} sigs at limit=${MPL_CORE_POLL_LIMIT}.`);
    lines.push(`       RECOMMEND raising MINT_MPL_CORE_POLL_MAX_PAGES to >= ${needPages} (env only; DO NOT auto-change).`);
  } else if (worstRetention < 90) {
    lines.push(`  [INVESTIGATE] retention ${worstRetention.toFixed(1)}% < 90% while safetyCapHit=false (non-cold-start).`);
    lines.push(`       Pagination is NOT the bottleneck here — STOP and trace the next stage before any fix.`);
    lines.push(`       Suspects to check (with this burst's data): WS seen=0 gaps, fetch nullTx rate, cold-start cursor gap, dedupe.`);
  } else {
    lines.push(`  [OK] retention >=90% and no real safetyCapHit — pagination fix holding under this burst.`);
  }
  lines.push('');
  lines.push('RECOMMENDED NEXT ACTION:');
  if (realSafety.length > 0) lines.push(`  Raise MINT_MPL_CORE_POLL_MAX_PAGES (env) then restart backend — await approval.`);
  else if (worstRetention < 90) lines.push(`  Open a bottleneck investigation on this burst window — await approval before any fix.`);
  else lines.push(`  None. Re-arm watcher for the following burst if desired.`);

  return lines.join('\n');
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`[burst-watcher] armed ${new Date(startedAt).toISOString()} window=${WINDOW_MIN}m poll=${POLL_MS/1000}s`);
  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    try {
      const bootMs = backendStartMs();
      const sinceMs = Date.now() - WINDOW_MIN * 60_000;
      const sweeps = parseSweeps(tail(LOG, 8000), sinceMs, bootMs);
      // Only sweeps AFTER the watcher started count for waking — never fire on
      // stale data already in the trailing window. And require a GENUINE
      // overflow (>=3 pages → >2×limit sigs) or a real safetyCapHit; a minor
      // pages=2 blip (1-4 over cap, fully recovered) is not a launch.
      const heavyOverflow = sweeps.filter((s) => s.atCap && !s.coldStart && s.ts > startedAt && (s.pages >= 3 || s.safetyCapHit));
      const bigColl = (await pool.query(
        `select collection_address, count(*) c from mint_events
           where block_time > now() - interval '${WINDOW_MIN} minutes'
           group by 1 having count(*) >= 100 order by 2 desc limit 1`)).rows[0];
      let trigger = null;
      if (bigColl) trigger = `collection ${bigColl.collection_address.slice(0,8)} reached ${bigColl.c} captured mints in ${WINDOW_MIN}m`;
      else if (heavyOverflow.length > 0) { const s = heavyOverflow[heavyOverflow.length - 1]; trigger = `heavy mpl_core overflow sweep (post-arm): sigs=${s.sigs} pages=${s.pages} safetyCapHit=${s.safetyCapHit}`; }
      if (trigger) {
        const report = await buildReport(trigger, pool, bootMs);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = `${OUT_DIR}/burst-report-${stamp}.txt`;
        fs.writeFileSync(path, report);
        console.log(`\n[burst-watcher] TRIGGERED → ${path}\n`);
        console.log(report);
        await pool.end();
        process.exit(0);
      }
    } catch (e) { console.error('[burst-watcher] poll error:', e.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log('[burst-watcher] max runtime reached, no burst detected — exiting');
  await pool.end();
  process.exit(0);
})();
