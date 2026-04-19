/**
 * Light gap-healing fallback for AMM programs only.
 *
 * Polls mmm and tamm on a long interval and a tiny page size.
 * Goal: recover the occasional sale the listener misses — NOT primary ingestion.
 *
 * me_v2 and tcomp are intentionally excluded: they have higher tx volume and
 * the listener is reliable enough there.  AMM pools emit fewer transactions
 * and a missed event is more noticeable.
 *
 * Round-robins one program per tick so a single slow getSignaturesForAddress
 * call never blocks the other target.
 */
import { ingestMeRaw } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { getLastSig, setLastSig } from '../db/poller-state';

// ─── Targets (AMM only) ───────────────────────────────────────────────────────

type IngestFn = (sig: string) => Promise<void>;

interface AmmTarget {
  name:    string;
  program: string;
  ingest:  IngestFn;
}

const TARGETS: AmmTarget[] = [
  {
    name:    'ammpoll:mmm',
    program: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc',
    ingest:  ingestMeRaw,
  },
  {
    name:    'ammpoll:tamm',
    program: 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg',
    ingest:  ingestTensorRaw,
  },
];

const INTERVAL_MS = 5 * 60_000;  // 5 min — gap-healing only, not real-time
const PAGE_SIZE   = 5;            // tiny — just enough to catch listener misses

// ─── RPC ──────────────────────────────────────────────────────────────────────

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo {
  signature:          string;
  err:                unknown;
  confirmationStatus: string | null;
}

async function fetchSignatures(program: string, until: string | null): Promise<SigInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { limit: PAGE_SIZE, commitment: 'confirmed' };
  if (until) params.until = until;

  const res = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [program, params],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
  if (json.error) throw new Error(`getSignaturesForAddress: ${json.error.message}`);
  return json.result ?? [];
}

// ─── Per-target sweep ─────────────────────────────────────────────────────────

async function sweepTarget(target: AmmTarget): Promise<void> {
  const lastSig = await getLastSig(target.name);
  const page    = await fetchSignatures(target.program, lastSig);

  if (page.length === 0) return;

  // Process oldest-first; skip on-chain failures
  const ordered = [...page].reverse();
  for (const info of ordered) {
    if (info.err !== null && info.err !== undefined) continue;
    await target.ingest(info.signature).catch((err: unknown) =>
      console.error(`[amm-poller/${target.name}] ingest error  sig=${info.signature.slice(0, 12)}...`, err)
    );
  }

  // Advance cursor to newest sig in this page
  await setLastSig(target.name, page[0].signature);
  console.log(`[amm-poller/${target.name}] swept ${page.length} sigs`);
}

// ─── Round-robin tick ─────────────────────────────────────────────────────────

let roundRobinIdx = 0;

async function tick(): Promise<void> {
  const target = TARGETS[roundRobinIdx % TARGETS.length];
  roundRobinIdx++;
  await sweepTarget(target).catch((err: unknown) =>
    console.error(`[amm-poller/${target.name}] sweep error`, err)
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startAmmPoller(): void {
  console.log(
    `[amm-poller] starting  targets=${TARGETS.map(t => t.name).join(',')}` +
    `  interval=${INTERVAL_MS / 1000}s  page=${PAGE_SIZE}`
  );
  // First tick after one full interval — listener handles the first wave.
  setInterval(() => { tick(); }, INTERVAL_MS).unref();
}
