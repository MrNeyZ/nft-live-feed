/**
 * Background refresher for the SUPPLY column on MPL Core collections.
 *
 * Reads `CollectionV1.num_minted` (u32 at a fixed offset of the account
 * data) for collections currently visible in /mints and pushes the
 * authoritative count back into the accumulator via
 * `patchAccumulatorCoreSupply`. The accumulator already increments a
 * session-local optimistic count on every accepted mint; this worker
 * upgrades that count to the on-chain truth and re-emits one mint_status
 * frame so the SUPPLY column flips from optimistic to verified.
 *
 * Key non-goals:
 *   - Does NOT block the mint ingestion hot path. The refresher is a
 *     standalone setInterval; `recordMint` never awaits it.
 *   - Does NOT use DAS getAssetsByGroup as a primary path. RPC-level
 *     `getMultipleAccounts` is one call per ≤100 collections per tick.
 *   - Does NOT decode maxSupply / planned cap. CollectionV1 stores no
 *     cap; that's a separate launchpad-config problem.
 *
 * MPL Core CollectionV1 account binary layout (the prefix we need;
 * source: mpl-core/programs/mpl-core/src/state/collection.rs):
 *   byte 0          discriminator     u8        — 5 for CollectionV1
 *   bytes 1-32      update_authority  Pubkey    — 32 bytes
 *   bytes 33-36     name.len          u32 LE    — Borsh string prefix
 *   bytes 37..37+N  name              utf8
 *   bytes ...       uri.len           u32 LE    — Borsh string prefix
 *   bytes ...       uri               utf8
 *   bytes ...       num_minted        u32 LE    ← target field
 *   bytes ...       current_size      u32 LE
 *
 * Both `name` and `uri` are variable-length, so we step over them
 * dynamically. Defensive bounds-check every read; on any layout
 * mismatch return null and log sampled (one in `LOG_SAMPLE_DENOM`
 * decode failures) so a future Core version change doesn't flood
 * the log.
 */

import { coreCollectionSupplyTargets, patchAccumulatorCoreSupply } from './accumulator';
import { isMintTrackerEnabled } from '../runtime/mode';

const REFRESHER_TICK_MS    = 30_000;
/** Minimum gap between successful refreshes for the same collection.
 *  2026-05-29: raised 60_000 → 120_000. Cuts steady-state
 *  getMultipleAccounts traffic ~50% across the active Core tail (≈100
 *  collections at peak) with imperceptible UX impact — supplyMinted is
 *  a best-effort value and 2-min staleness is well within the
 *  human-readable refresh expectation. Hot collections still get the
 *  next tick because parser-time optimistic increments
 *  (patchAccumulatorCoreSupply) drive the eye-visible counter, not
 *  this verifier. Queue/concurrency unchanged. */
const PER_COLLECTION_TTL_MS = 120_000;
/** Tick-level batch limit — `getMultipleAccounts` accepts up to 100
 *  base58 pubkeys per JSON-RPC call. Keep one call per tick. */
const BATCH_MAX             = 100;
/** Sample one failure log per N decode failures to avoid flooding. */
const LOG_SAMPLE_DENOM      = 50;

let started = false;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let failCounter = 0;

/** CollectionV1 discriminator (the `Key::CollectionV1` enum variant in
 *  `mpl-core/src/state/key.rs`). Matches against byte 0 of the account
 *  data; account decode is skipped on a mismatch (rather than returning
 *  a confidently wrong number for e.g. AssetV1 / HashedAssetV1). */
const COLLECTION_V1_DISC = 5;

/** Decode `num_minted` (u32 LE) out of a base64-encoded CollectionV1
 *  account `data` blob. Returns `null` on any layout failure — caller
 *  treats null as "skip this collection until next tick" rather than
 *  zeroing it out (zero would clobber the optimistic local count). */
export function decodeCollectionV1NumMinted(dataB64: string): number | null {
  let buf: Buffer;
  try { buf = Buffer.from(dataB64, 'base64'); } catch { return null; }
  if (buf.length < 1) return null;
  if (buf[0] !== COLLECTION_V1_DISC) return null;

  let off = 1;
  // update_authority (Pubkey, 32 bytes)
  if (off + 32 > buf.length) return null;
  off += 32;
  // name (Borsh string: u32 LE length + utf8)
  if (off + 4 > buf.length) return null;
  const nameLen = buf.readUInt32LE(off); off += 4;
  if (nameLen > 256 || off + nameLen > buf.length) return null;
  off += nameLen;
  // uri (Borsh string)
  if (off + 4 > buf.length) return null;
  const uriLen = buf.readUInt32LE(off); off += 4;
  if (uriLen > 2048 || off + uriLen > buf.length) return null;
  off += uriLen;
  // num_minted (u32 LE)
  if (off + 4 > buf.length) return null;
  const numMinted = buf.readUInt32LE(off);
  if (!Number.isFinite(numMinted) || numMinted < 0) return null;
  return numMinted;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

interface GmaResult {
  context: { slot: number };
  value: Array<{
    lamports: number;
    owner: string;
    data: [string, 'base64'];
    executable: boolean;
    rentEpoch: number | bigint;
  } | null>;
}

/** Picks up to BATCH_MAX collections that are due for a refresh.
 *  Priority:
 *    1. Never-verified collections come first (lastVerifiedAt undefined).
 *    2. Then collections whose lastVerifiedAt is older than the TTL,
 *       most-recently-active first (their counts move fastest).
 *  Collections inside the TTL window are skipped entirely this tick.
 *  Returns a de-duplicated list keyed on collectionAddress — multiple
 *  groupingKeys mapping to the same collection (a defensive guard;
 *  shouldn't happen in practice) get fanned out via the address→keys
 *  side-map for the patch step. */
function selectBatch(now: number): {
  addresses: string[];
  addrToKeys: Map<string, string[]>;
} {
  const targets = coreCollectionSupplyTargets();
  const eligible = targets.filter(t => {
    if (!t.lastVerifiedAt) return true;
    return (now - t.lastVerifiedAt) >= PER_COLLECTION_TTL_MS;
  });
  // Sort: undefined verifiedAt first, then oldest verified first (so
  // the staleness backlog drains evenly). Among equal staleness,
  // most-recently-active wins (those are the ones operators are
  // watching).
  eligible.sort((a, b) => {
    const ax = a.lastVerifiedAt ?? -Infinity;
    const bx = b.lastVerifiedAt ?? -Infinity;
    if (ax !== bx) return ax - bx;
    return b.lastMintAt - a.lastMintAt;
  });

  const addrToKeys = new Map<string, string[]>();
  const orderedAddresses: string[] = [];
  for (const t of eligible) {
    const existing = addrToKeys.get(t.collectionAddress);
    if (existing) {
      existing.push(t.groupingKey);
    } else {
      addrToKeys.set(t.collectionAddress, [t.groupingKey]);
      orderedAddresses.push(t.collectionAddress);
      if (orderedAddresses.length >= BATCH_MAX) break;
    }
  }
  return { addresses: orderedAddresses, addrToKeys };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  // Mint tracker disabled → no Core supply RPC (getMultipleAccounts). The timer
  // keeps ticking cheaply and auto-resumes when the tracker is re-enabled.
  if (!isMintTrackerEnabled()) return;
  inFlight = true;
  const now = Date.now();
  try {
    const { addresses, addrToKeys } = selectBatch(now);
    if (addresses.length === 0) return;

    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
      params: [addresses, { encoding: 'base64', commitment: 'confirmed' }],
    });

    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timerId);
      logFailure('fetch', err);
      return;
    }
    clearTimeout(timerId);

    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('application/json')) {
      logFailure('http', `status=${res.status} ct=${ct}`);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as { result?: GmaResult; error?: { message: string } };
    if (json.error) {
      logFailure('rpc', json.error.message);
      return;
    }
    const values = json.result?.value ?? [];

    let refreshed = 0, changed = 0, failed = 0;
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      const acc = values[i];
      if (!acc || !acc.data) {
        failed++;
        if (failCounter++ % LOG_SAMPLE_DENOM === 0) {
          console.warn(`[mints/supply] failed collection=${addr} reason=account_missing`);
        }
        continue;
      }
      const [dataB64, enc] = acc.data;
      if (enc !== 'base64') {
        failed++;
        continue;
      }
      const numMinted = decodeCollectionV1NumMinted(dataB64);
      if (numMinted == null) {
        failed++;
        if (failCounter++ % LOG_SAMPLE_DENOM === 0) {
          console.warn(`[mints/supply] failed collection=${addr} reason=decode_failed`);
        }
        continue;
      }
      refreshed++;
      const keys = addrToKeys.get(addr) ?? [];
      for (const groupingKey of keys) {
        // Patch helper internally re-emits a mint_status frame only when
        // the value actually moves. `changed` here counts attempts, not
        // emits — but the cost of an emit is a single bus dispatch so
        // double-counting via N groupingKeys per collection is harmless.
        patchAccumulatorCoreSupply(groupingKey, numMinted);
      }
      changed++;
    }

    console.log(
      `[mints/supply] refreshed=${refreshed} changed=${changed} ` +
      `failed=${failed} batch=${addresses.length}`,
    );
  } finally {
    inFlight = false;
  }
}

function logFailure(kind: string, detail: unknown): void {
  // Periodic failures (e.g. RPC outages) are interesting; spamming
  // the log on every tick is not. Sample by the same counter the
  // per-collection decode failures use so the operator gets at least
  // one line per outage window.
  if (failCounter++ % LOG_SAMPLE_DENOM !== 0) return;
  const msg = detail instanceof Error ? detail.message : String(detail);
  console.warn(`[mints/supply] failed kind=${kind} detail=${msg}`);
}

/** Public: start the refresher. Safe to call multiple times; second
 *  and later calls are no-ops. The refresher is independent of the
 *  ingestion runtime mode — it has no effect when /mints is empty
 *  (the snapshot is empty so the batch selector returns nothing). */
export function startCoreSupplyRefresher(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    void tick().catch(err => {
      console.warn(`[mints/supply] tick threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, REFRESHER_TICK_MS);
  // Don't keep the process alive just for the refresher.
  if (timer && typeof timer.unref === 'function') timer.unref();
  // Run one tick immediately at startup so the first batch of
  // collections that the listener has already accumulated gets
  // visited before the 30 s initial delay.
  void tick().catch(err => {
    console.warn(`[mints/supply] initial tick threw: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`[mints/supply] refresher started tick=${REFRESHER_TICK_MS}ms ttl=${PER_COLLECTION_TTL_MS}ms batch=${BATCH_MAX}`);
}

/** Test-only: stop the timer and reset state. Not used in prod. */
export function _stopCoreSupplyRefresherForTests(): void {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
  inFlight = false;
  failCounter = 0;
}
