/**
 * Fallback ingestion via standard RPC getSignaturesForAddress.
 *
 * Polls each program address every 30 seconds for new signatures, then passes
 * each confirmed signature to the appropriate raw ingest function.
 *
 * Uses STANDARD RPC — not Helius enhanced transactions endpoint.
 * No Helius compute-unit cost beyond the getTransaction calls inside ingest.
 *
 * Cursor keys are prefixed "rawpoll:" to avoid conflicting with the existing
 * Helius-enhanced poller's cursor entries in poller_state.
 *
 * This is a recovery/gap-filling path. The listener (logsSubscribe) is the
 * primary real-time trigger. Together they provide coverage without the
 * Helius enhanced API.
 */
import { ingestMeRaw } from './me-raw/ingest';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { getLastSig, setLastSig } from '../db/poller-state';
import { Limiter } from './concurrency';

// ─── Targets ─────────────────────────────────────────────────────────────────

type IngestFn = (sig: string) => Promise<void>;

interface Target {
  name:    string;
  program: string;
  ingest:  IngestFn;
}

const TARGETS: Target[] = [
  {
    name:    'me_v2',
    program: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
    ingest:  ingestMeRaw,
  },
  {
    name:    'mmm',
    program: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc',
    ingest:  ingestMeRaw,
  },
  {
    name:    'tcomp',
    program: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp',
    ingest:  ingestTensorRaw,
  },
  {
    name:    'tamm',
    program: 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg',
    ingest:  ingestTensorRaw,
  },
];

const POLL_INTERVAL_MS      = 120_000; // 2 min — safety-net poller, not primary path
const PAGE_LIMIT            = 10;      // steady-state: 10 sigs per page
const FIRST_RUN_PAGE_LIMIT  = 5;       // first sweep: 5 sigs max per program
const FIRST_RUN_CONCURRENCY = 1;       // first sweep: strictly sequential

// Shared limiter for steady-state sweeps.
// concurrency=1 + 150ms delay → sequential with a small gap between calls.
const limiter = new Limiter(1, 150);

// ─── Stats ────────────────────────────────────────────────────────────────────

interface Stats {
  seen:     number; // signatures returned by getSignaturesForAddress
  fired:    number; // ingest() called (err=null)
  filtered: number; // on-chain failed txs skipped
  errors:   number; // ingest() threw
}

function newStats(): Stats {
  return { seen: 0, fired: 0, filtered: 0, errors: 0 };
}

// ─── RPC ──────────────────────────────────────────────────────────────────────

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

interface SigInfo {
  signature:          string;
  slot:               number;
  err:                unknown;    // null = success, object = on-chain error
  blockTime:          number | null;
  confirmationStatus: string | null;
}

/**
 * Fetch up to `limit` signatures for `address` that are newer than `until`.
 * Standard RPC — getSignaturesForAddress — not the Helius enhanced endpoint.
 * Returns newest-first (Solana default order).
 */
async function fetchSignatures(
  address: string,
  until:   string | null,
  limit:   number,
): Promise<SigInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [address, { limit, commitment: 'confirmed' }];
  if (until) params[1].until = until;

  const res = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'getSignaturesForAddress',
      params,
    }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
  if (json.error) throw new Error(`getSignaturesForAddress: ${json.error.message}`);
  return json.result ?? [];
}

// ─── Per-target poll ─────────────────────────────────────────────────────────

async function pollTarget(target: Target, pageLimit = PAGE_LIMIT, activeLimiter = limiter): Promise<void> {
  const cursorKey = `rawpoll:${target.program}`;
  const lastSig   = await getLastSig(cursorKey);

  // Paginate oldest-to-newest: keep fetching pages (newest-first) until
  // we hit the cursor, then reverse the whole batch for processing order.
  const allSigs: SigInfo[] = [];
  let before: string | null = null;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = { limit: pageLimit, commitment: 'confirmed' };
    if (lastSig) params.until = lastSig;
    if (before)  params.before = before;

    const res = await fetch(rpcUrl(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'getSignaturesForAddress',
        params:  [target.program, params],
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as { result?: SigInfo[]; error?: { message: string } };
    if (json.error) throw new Error(`getSignaturesForAddress: ${json.error.message}`);

    const page = json.result ?? [];
    if (page.length === 0) break;

    allSigs.push(...page);

    if (page.length < pageLimit) break; // last page

    before = page[page.length - 1].signature;

    // Safety cap on first run (no cursor)
    if (!lastSig && allSigs.length >= pageLimit * 10) {
      console.warn(`[raw-poller/${target.name}] first-run cap hit — remaining caught next poll`);
      break;
    }
  }

  if (allSigs.length === 0) return;

  // Reverse to process oldest-first
  const ordered = [...allSigs].reverse();

  const stats = newStats();
  stats.seen = ordered.length;

  // Fire ingest calls concurrently (rate-limited by caller-supplied limiter)
  const tasks = ordered.map((info) => {
    if (info.err !== null && info.err !== undefined) {
      stats.filtered++;
      return Promise.resolve();
    }
    stats.fired++;
    return activeLimiter
      .run(() => target.ingest(info.signature))
      .catch((err: unknown) => {
        stats.errors++;
        console.error(
          `[raw-poller/${target.name}] ingest error  sig=${info.signature.slice(0, 12)}...`,
          err,
        );
      });
  });

  await Promise.allSettled(tasks);

  // Advance cursor to the newest signature (first item before reversal)
  const newestSig = allSigs[0].signature;
  await setLastSig(cursorKey, newestSig);

  console.log(
    `[raw-poller/${target.name}] seen=${stats.seen}` +
    ` fired=${stats.fired} filtered=${stats.filtered} errors=${stats.errors}`,
  );
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollAll(pageLimit = PAGE_LIMIT, activeLimiter = limiter): Promise<void> {
  for (const target of TARGETS) {
    await pollTarget(target, pageLimit, activeLimiter).catch((err: unknown) =>
      console.error(`[raw-poller/${target.name}] poll error`, err),
    );
  }
}

/**
 * Start the raw poller and return a Promise that resolves once the first
 * sweep finishes. Callers (index.ts) await this before starting the listener
 * so the listener doesn't pile onto an already-busy first-run ingest burst.
 *
 * First sweep: pageLimit=10, concurrency=1 — minimal RPC pressure at startup.
 * Subsequent sweeps: normal PAGE_LIMIT and limiter concurrency.
 */
export async function startRawPoller(): Promise<void> {
  console.log(
    `[raw-poller] starting  targets=${TARGETS.length}` +
    `  interval=${POLL_INTERVAL_MS / 1000}s`,
  );

  // First sweep: its own limiter — sequential with a 200ms gap between calls.
  const firstRunLimiter = new Limiter(FIRST_RUN_CONCURRENCY, 200);
  console.log(
    `[raw-poller] first sweep  pageLimit=${FIRST_RUN_PAGE_LIMIT}` +
    `  concurrency=${FIRST_RUN_CONCURRENCY}`,
  );
  await pollAll(FIRST_RUN_PAGE_LIMIT, firstRunLimiter).catch((err: unknown) =>
    console.error('[raw-poller] first sweep error', err),
  );
  console.log(`[raw-poller] first sweep done — listener will now start`);

  // Schedule subsequent sweeps at normal settings.
  setInterval(
    () => pollAll().catch((err: unknown) => console.error('[raw-poller] poll error', err)),
    POLL_INTERVAL_MS,
  );
}
