/**
 * Fallback polling ingestion.
 *
 * PURPOSE: recovery only.
 * This poller exists to catch events missed during webhook downtime or drops.
 * It is NOT a completeness guarantee. Coverage is limited to the program
 * addresses listed in POLL_TARGETS, which in turn is limited to what the
 * Helius enhanced parser recognises (MAGIC_EDEN, TENSOR, etc.).
 *
 * The Helius webhook is the primary ingestion path and source of truth.
 * The poller is a best-effort fallback — it heals gaps, it does not define scope.
 *
 * Cursor is persisted in poller_state, so the poller resumes from where it
 * left off after a process restart.
 */
import { parseHeliusTransaction } from './helius/parser';
import { HeliusEnhancedTransaction } from './helius/types';
import { insertSaleEvent } from '../db/insert';
import { getLastSig, setLastSig } from '../db/poller-state';
import { ingestMeRaw } from './me-raw/ingest';
import { trace } from '../trace';
import { ME_PROGRAMS } from './me-raw/programs';
import { ingestTensorRaw } from './tensor-raw/ingest';
import { TENSOR_PROGRAMS } from './tensor-raw/programs';

const HELIUS_BASE = 'https://api.helius.xyz/v0';
const POLL_INTERVAL_MS = 30_000;   // 30 seconds
const PAGE_LIMIT = 100;            // Helius max per page

interface PollTarget {
  name: string;
  programAddress: string;
  types: string[];
}

/**
 * Programs polled for fallback recovery.
 *
 * Rules:
 * - Only add addresses that have been verified against official marketplace docs.
 * - Both NFT_SALE and COMPRESSED_NFT_SALE must be listed for any program that
 *   can trade cNFTs (e.g. Magic Eden handles both standard and compressed NFTs).
 * - Do not add addresses to "expand coverage" — the webhook handles that.
 *   Add addresses only to ensure the poller can recover what the webhook delivers.
 */
const POLL_TARGETS: PollTarget[] = [
  {
    name: 'magic_eden_v2',
    programAddress: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
    // COMPRESSED_NFT_SALE included: ME v2 handles both standard and cNFT sales
    types: ['NFT_SALE', 'COMPRESSED_NFT_SALE'],
  },
  {
    name: 'magic_eden_amm',
    programAddress: 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc',
    // COMPRESSED_NFT_SALE included: ME AMM pools can hold cNFTs
    types: ['NFT_SALE', 'COMPRESSED_NFT_SALE'],
  },
  {
    // ✅ Address confirmed 2026-04-14 from ground-truth sale transactions.
    // COMPRESSED_NFT_SALE intentionally excluded — cNFT not yet a priority and
    // produces Helius 504 noise. Re-add once cNFT parsing is implemented.
    name: 'tensor_tcomp',
    programAddress: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp',
    types: ['NFT_SALE'],
  },
  {
    // ✅ Address confirmed 2026-04-14 from ground-truth TAMM pool sale transactions.
    name: 'tensor_tamm',
    programAddress: 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg',
    types: ['NFT_SALE'],
  },
];

// ─── Helius API ───────────────────────────────────────────────────────────────

/**
 * Helius returns 404 when no transactions match the filter within the current
 * search window (between the `before` cursor and the `until` cursor). This is
 * not an error — it means the search window is exhausted.
 *
 * The response body may include a `beforeSignature` hinting at where to
 * continue if a wider search is needed. We surface that here so `fetchSince`
 * can decide whether to follow it.
 */
interface SearchBoundary {
  kind: 'boundary';
  continueBefore: string | null;
}

type PageResult = HeliusEnhancedTransaction[] | SearchBoundary;

/** Base58 alphabet — Solana signatures are 87–88 chars of this set. */
const BASE58_SIG_RE = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

function parseSearchBoundary(body: string): SearchBoundary {
  let continueBefore: string | null = null;

  // Try structured JSON first (Helius may return { beforeSignature: "..." })
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const candidate =
      json['beforeSignature'] ?? json['before_signature'] ?? json['before'];
    if (typeof candidate === 'string' && BASE58_SIG_RE.test(candidate)) {
      continueBefore = candidate;
    }
  } catch {
    // Plain-text body — try to extract a signature from the message itself
    const match = BASE58_SIG_RE.exec(body);
    if (match) continueBefore = match[0];
  }

  return { kind: 'boundary', continueBefore };
}

async function fetchPage(
  programAddress: string,
  txType: string,
  until: string | null,
  before: string | null
): Promise<PageResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');

  const url = new URL(`${HELIUS_BASE}/addresses/${programAddress}/transactions`);
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('type', txType);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (until) url.searchParams.set('until', until);
  if (before) url.searchParams.set('before', before);

  const res = await fetch(url.toString());

  if (res.status === 404) {
    const body = await res.text();
    if (body.includes('Failed to find events within the search period')) {
      return parseSearchBoundary(body);
    }
    // Unexpected 404 (wrong address, auth issue, etc.) — still a real error
    throw new Error(`Helius API 404: ${body}`);
  }

  if (!res.ok) {
    throw new Error(`Helius API ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<HeliusEnhancedTransaction[]>;
}

/**
 * Fetch all transactions newer than `lastSig` for a given program+type,
 * paginating forward until the cursor is reached or the response is empty.
 * Returns transactions in ascending (oldest-first) order, ready to process.
 */
async function fetchSince(
  programAddress: string,
  txType: string,
  lastSig: string | null
): Promise<HeliusEnhancedTransaction[]> {
  const pages: HeliusEnhancedTransaction[][] = [];
  let before: string | null = null;

  while (true) {
    const result = await fetchPage(programAddress, txType, lastSig, before);

    if (!Array.isArray(result)) {
      // Search-boundary 404: Helius found no matching events in this window.
      if (result.continueBefore) {
        // Helius provided a continuation hint — jump to it and keep paginating.
        before = result.continueBefore;
        continue;
      }
      // No continuation hint — search window is fully exhausted, stop cleanly.
      break;
    }

    const page = result;
    if (page.length === 0) break;

    pages.push(page);

    if (page.length < PAGE_LIMIT) break; // last page

    // There may be more — paginate using the oldest sig on this page
    before = page[page.length - 1].signature;

    // Safety: if no lastSig (first ever run) and pages are huge, stop after
    // 10 pages to avoid an unbounded catch-up. Subsequent polls will continue.
    if (!lastSig && pages.length >= 10) {
      console.warn(
        `[poller] first-run page cap hit for ${programAddress}:${txType}. ` +
        'Remaining history will be caught on next poll.'
      );
      break;
    }
  }

  // Each page is newest-first; flatten and reverse to get oldest-first overall
  return pages.flatMap((p) => p).reverse();
}

// ─── Per-target poll ──────────────────────────────────────────────────────────

async function pollTarget(target: PollTarget, txType: string): Promise<void> {
  const cursorKey = `${target.programAddress}:${txType}`;
  const lastSig = await getLastSig(cursorKey);

  let txs: HeliusEnhancedTransaction[];
  try {
    txs = await fetchSince(target.programAddress, txType, lastSig);
  } catch (err) {
    console.error(`[poller] fetch error ${target.name}:${txType}`, err);
    return;
  }

  if (txs.length === 0) return;

  const isMeTarget     = ME_PROGRAMS.has(target.programAddress);
  const isTensorTarget = TENSOR_PROGRAMS.has(target.programAddress);

  for (const tx of txs) trace(tx.signature, 'poll:fetched', `target=${target.name}:${txType}`);

  // Fire ME raw parser for ME program targets in parallel.
  const rawIngests = isMeTarget
    ? txs.map((tx) => {
        trace(tx.signature, 'poll:ingest', `target=${target.name}:${txType}`);
        return ingestMeRaw(tx.signature).catch((err) =>
          console.error('[me_raw] unhandled error', err)
        );
      })
    : [];

  // Fire Tensor raw parser for Tensor program targets in parallel.
  const tensorRawIngests = isTensorTarget
    ? txs.map((tx) => {
        trace(tx.signature, 'poll:ingest', `target=${target.name}:${txType}`);
        return ingestTensorRaw(tx.signature).catch((err) =>
          console.error('[tensor_raw] unhandled error', err)
        );
      })
    : [];

  let inserted = 0;
  let skipped = 0;

  for (const tx of txs) {
    const result = parseHeliusTransaction(tx);
    if (!result.ok) { skipped++; continue; }

    try {
      const id = await insertSaleEvent(result.event);
      id ? inserted++ : skipped++;
    } catch (err) {
      console.error('[poller] insert error', err);
    }
  }

  await Promise.allSettled([...rawIngests, ...tensorRawIngests]);

  // Cursor advances to the newest signature fetched (last item after reversal = originally first)
  const newestSig = txs[txs.length - 1].signature;
  await setLastSig(cursorKey, newestSig);

  if (inserted > 0) {
    console.log(
      `[poller] ${target.name}:${txType} +${inserted} inserted, ${skipped} skipped`
    );
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollAll(): Promise<void> {
  for (const target of POLL_TARGETS) {
    for (const txType of target.types) {
      // Run targets sequentially to avoid hammering the API
      await pollTarget(target, txType).catch((err) =>
        console.error(`[poller] unhandled error ${target.name}:${txType}`, err)
      );
    }
  }
}

export function startPoller(): void {
  console.log(
    `[poller] starting, interval=${POLL_INTERVAL_MS / 1000}s, ` +
    `targets=${POLL_TARGETS.length}`
  );

  // Run immediately on start (catch-up from last cursor), then on interval
  pollAll().catch((err) => console.error('[poller] initial poll error', err));

  setInterval(() => {
    pollAll().catch((err) => console.error('[poller] poll error', err));
  }, POLL_INTERVAL_MS);
}
