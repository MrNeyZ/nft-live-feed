/**
 * Daily Helius usage ledger — runs 24/7 inside each process that installs it.
 *
 * Fed by rpc-method-counter (every outgoing *.helius-rpc.com request, by
 * JSON-RPC method) and by the self-reporting call-site counters
 * (helius-credit-metrics sources, sigList sources). Buckets are per UTC day,
 * converted to estimated credits, persisted to data/rpc-usage-daily.<proc>.json
 * (survives restarts), and summarised once per day in the log as
 * `[rpc/daily]`. /api/tools/rpc-usage merges every process's file.
 *
 * Credit weights follow Helius billing: DAS methods and getProgramAccounts
 * cost 10 credits per call, every other RPC method 1.
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR    = path.join(__dirname, '../../data');
const KEEP_DAYS   = 60;
const SAVE_MS     = 30_000;   // a restart loses at most this much counting

const TEN_CREDIT_METHODS = new Set([
  'getProgramAccounts',
  'getAsset', 'getAssetBatch', 'getAssetProof', 'getAssetProofBatch',
  'getAssetsByOwner', 'getAssetsByGroup', 'getAssetsByCreator', 'getAssetsByAuthority',
  'searchAssets', 'getSignaturesForAsset', 'getTokenAccounts', 'getNftEditions',
]);
export function creditsForMethod(method: string): number {
  return TEN_CREDIT_METHODS.has(method) ? 10 : 1;
}

export interface DayUsage {
  date:     string;                     // YYYY-MM-DD (UTC)
  requests: number;
  credits:  number;
  methods:  Record<string, number>;     // method → requests
  sources:  Record<string, number>;     // call-site source → requests
}

let proc = 'unknown';
let file = '';
const days = new Map<string, DayUsage>();
let installed = false;
let dirty = false;

const today = (): string => new Date().toISOString().slice(0, 10);
function bucket(): DayUsage {
  const d = today();
  let b = days.get(d);
  if (!b) {
    b = { date: d, requests: 0, credits: 0, methods: {}, sources: {} };
    days.set(d, b);
    for (const k of Array.from(days.keys()).sort().slice(0, Math.max(0, days.size - KEEP_DAYS))) days.delete(k);
  }
  return b;
}

/** One Helius JSON-RPC call (batch bodies call this once per inner call). */
export function noteRpcMethod(method: string): void {
  if (!installed) return;
  const b = bucket();
  b.requests++;
  b.credits += creditsForMethod(method);
  b.methods[method] = (b.methods[method] ?? 0) + 1;
  dirty = true;
}

/** Attribution only (who made the call) — no credits, those come from the method. */
export function noteRpcSource(source: string, n = 1): void {
  if (!installed || n <= 0) return;
  const b = bucket();
  b.sources[source] = (b.sources[source] ?? 0) + n;
  dirty = true;
}

function save(): void {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(file, JSON.stringify(Array.from(days.values())), 'utf8');
  } catch { /* non-fatal */ }
}

function top(rec: Record<string, number>, n: number, weight?: (k: string) => number): string {
  return Object.entries(rec)
    .map(([k, v]) => [k, v * (weight ? weight(k) : 1)] as const)
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}=${v}`).join(' ');
}

function logDay(d: DayUsage): void {
  console.log(
    `[rpc/daily] proc=${proc} date=${d.date} requests=${d.requests} credits_est=${d.credits}` +
    ` | credits_by_method: ${top(d.methods, 8, creditsForMethod)} | top_sources: ${top(d.sources, 8)}`,
  );
}

export function installRpcUsageDaily(processName: string): void {
  if (installed) return;
  installed = true;
  proc = processName;
  file = path.join(DATA_DIR, `rpc-usage-daily.${processName}.json`);
  try {
    for (const d of JSON.parse(fs.readFileSync(file, 'utf8')) as DayUsage[]) days.set(d.date, d);
  } catch { /* first run */ }
  let lastDay = today();
  setInterval(() => {
    const now = today();
    if (now !== lastDay) {
      const done = days.get(lastDay);
      if (done) logDay(done);
      lastDay = now;
    }
    save();
  }, SAVE_MS).unref();
  // No SIGINT/SIGTERM hooks on purpose: a listener there stops Node from
  // exiting on the signal and pm2 would have to SIGKILL us.
}

/** Every process's ledger, merged per day (newest first). */
export function readAllRpcUsage(): Array<DayUsage & { byProcess: Record<string, { requests: number; credits: number }> }> {
  const merged = new Map<string, DayUsage & { byProcess: Record<string, { requests: number; credits: number }> }>();
  let files: string[] = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => /^rpc-usage-daily\..+\.json$/.test(f)); } catch { /* none */ }
  for (const f of files) {
    const name = f.slice('rpc-usage-daily.'.length, -'.json'.length);
    // This process's freshest numbers are in memory, not yet on disk.
    let rows: DayUsage[];
    if (name === proc && installed) rows = Array.from(days.values());
    else {
      try { rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) as DayUsage[]; } catch { continue; }
    }
    for (const d of rows) {
      let m = merged.get(d.date);
      if (!m) { m = { date: d.date, requests: 0, credits: 0, methods: {}, sources: {}, byProcess: {} }; merged.set(d.date, m); }
      m.requests += d.requests;
      m.credits  += d.credits;
      for (const [k, v] of Object.entries(d.methods)) m.methods[k] = (m.methods[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.sources)) m.sources[`${name}:${k}`] = (m.sources[`${name}:${k}`] ?? 0) + v;
      m.byProcess[name] = { requests: d.requests, credits: d.credits };
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.date.localeCompare(a.date));
}
