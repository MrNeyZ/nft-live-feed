/**
 * Ghost Bid — forgotten M2 (Magic Eden) + Solanart bids, ranked by profit
 * (bid - floor), on NFTs currently held by real wallets.
 *
 * Base list is a hand-built offline snapshot (see
 * forgotten-bids-2026-08-25/ on the research VPS) — this file just serves
 * it and, on demand, re-checks live escrow funding:
 *
 *   - ME rows: the bid's SOL sits in a per-(auctionHouse, buyer) M2 escrow
 *     PDA shared across ALL of that buyer's offers. `GET
 *     /v2/wallets/{buyer}/escrow_balance` (ME's own public API) returns
 *     that shared balance directly — no PDA derivation needed. If the
 *     buyer already spent the escrow on a different offer, every other
 *     row sharing that buyer effectively drops toward 0.
 *   - Solanart rows: each offer has its own self-funded escrow PDA
 *     (`offerAccount`) — one batched `getMultipleAccounts` covers all of
 *     them in a single RPC call.
 *
 * effectiveBidSol = min(originalBidSol, liveEscrowBalanceSol). Profit and
 * rank are recomputed from that; a live-checked row whose profit has gone
 * <= 0 (escrow spent down by other accepted offers, or by accepting this
 * bid) is dropped from the list entirely — the static snapshot keeps every
 * row since nothing has been re-checked yet.
 *
 * GET  /api/tools/ghostbid          — cached snapshot (last refresh, or the
 *                                     static original if never refreshed)
 * POST /api/tools/ghostbid/refresh  — re-checks live balances, drops
 *                                     now-unprofitable rows, re-ranks
 *
 * Read-only: no wallet connect, no signing, no tx building.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { deriveBuyerEscrowPda, resolveEscrowBalances } from './me-bid-escrow';

// 5 lists, ranks ~1-500 combined-and-sorted-by-profit, each its own static
// snapshot (list 1 = ranks ~1-100, list 2 = ~101-200 [after excluding
// dupes/known-dead/owner==buyer-bugged rows], etc). List 2-5 were built by
// re-running the exact same combine-and-sort methodology as list 1 against
// the wider 1-500 rank pool, then live-verifying every candidate (current
// on-chain owner matches, escrow balance covers the bid) before inclusion —
// see the research VPS session for the build script. List 5 only got 72
// valid rows; the source pool ran out (372 total valid candidates found
// across all of ranks ~101-500).
const DATA_LIST_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
type ListId = typeof DATA_LIST_IDS[number];
export function isListId(v: unknown): v is ListId {
  return typeof v === 'number' && (DATA_LIST_IDS as readonly number[]).includes(v);
}
function dataPathForList(list: ListId): string {
  const file = list === 1 ? 'ghostbid.json' : `ghostbid-list${list}.json`;
  return join(__dirname, '..', '..', 'data', file);
}
/** Shared by the Solanart escrow-account filter and the `/escrow-check`
 *  buyer param — one named check instead of two duplicated try/catches. */
export function isValidPubkey(s: string): boolean {
  try { new PublicKey(s); return true; } catch { return false; }
}
/** No response ever echoes a raw error back to the client (GB-5) — detail
 *  stays server-side in the log, the client gets a stable, generic string. */
export function toClientError(err: unknown): string {
  console.error('[ghostbid]', err);
  return 'internal_error';
}
// Every ME v2 personal-item offer in this dataset funnels through the same
// default auction house — cross-checked live: deriving the escrow PDA from
// this address for a known buyer produced byte-identical output to the
// `buyerEscrow` field ME's own `/wallets/{buyer}/escrow_balance` endpoint
// returns for that same buyer.
const ME_DEFAULT_AUCTION_HOUSE = 'E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe';
const RPC_TIMEOUT_MS = 8_000;
const RPC_CHUNK_MAX = 100;
const OWNER_ACTIVITY_CONCURRENCY = 8;
const OWNER_ACTIVITY_TIMEOUT_MS = 8_000;

export interface BaseRow {
  mint: string;
  nft: string;
  image: string | null;
  owner: string;
  buyer: string;
  offerAccount: string | null;
  marketplace: 'ME' | 'Solanart';
  bidSol: number;
  floorSol: number | null;
  royaltyBp: number;
  feeBp: number;
  /** Unix seconds of the owner wallet's most recent known signature (any
   *  tx, not scoped to this mint) — NOT a pre-computed day-count. The
   *  frontend derives "days ago" from this at render time so the number
   *  keeps ticking up with real elapsed time even between Refreshes,
   *  instead of being frozen at whatever it read when the page loaded. */
  lastActiveAt: number | null;
  sns: string | null;
  matrica: string | null;
  discord: string | null;
  twitter: string | null;
  pumpfun: string | null;
  me: string | null;
  galxe: string | null;
  /** null = normal wallet. 'LISTED_ME' / 'LISTED_TENSOR' = owner is that
   *  mint's real seller (already resolved off the marketplace's own API,
   *  not the shared escrow PDA) — still actionable. 'LISTED_SOLANART_STUCK'
   *  / 'STUCK_OTHER:<programId>' = owner is a program-owned escrow/vault
   *  (dead Solanart listing or an unrelated per-collection staking
   *  contract) that couldn't be resolved to a real wallet — not
   *  actionable, frontend should visually de-emphasize these rows. */
  listingStatus: string | null;
}

export interface GhostBidRow extends BaseRow {
  liveBidSol: number;
  profitSol: number | null;
  drained: boolean; // liveBidSol < bidSol (shared escrow spent elsewhere, or offer withdrawn)
  sharedEscrowGroup: string | null; // buyer wallet, when 2+ ME rows share it — for the frontend badge
  /** Current on-chain owner (DAS `getAssetBatch`, same call that already
   *  detects `filled`) — null until a Refresh has run for this list. Only
   *  meaningfully differs from `owner` when the NFT moved to someone other
   *  than this row's `buyer` (buyer-owned is `filled` and gets dropped
   *  entirely, never reaches here) — a sale/transfer/listing the static
   *  snapshot's `owner` never saw. */
  liveOwner: string | null;
  ownerChanged: boolean; // liveOwner != null && liveOwner != owner
  /** Unix seconds of the most recent signature touching this mint — only
   *  fetched for rows where `ownerChanged` is true (bounded cost), so it's
   *  null both when unchanged and when a changed row's activity lookup
   *  hasn't resolved yet. */
  ownerChangedAt: number | null;
}

interface BaseData {
  rows: BaseRow[];
  /** Unix ms mtime of this list's dataset file — the only signal we have
   *  for "how stale is the floor data baked into these rows" (GB-2). Not
   *  a per-row field; whole-list granularity is what the file gives us. */
  snapshotAt: number;
}
const baseRowsByList = new Map<ListId, BaseData>();
function loadBase(list: ListId): BaseData {
  const cached = baseRowsByList.get(list);
  if (cached) return cached;
  const path = dataPathForList(list);
  const rows = JSON.parse(readFileSync(path, 'utf-8')) as BaseRow[];
  const snapshotAt = statSync(path).mtimeMs;
  const data = { rows, snapshotAt };
  baseRowsByList.set(list, data);
  return data;
}

const liveStateByList = new Map<ListId, { updatedAt: number; rows: GhostBidRow[] }>();

export function computeSharedGroups(rows: BaseRow[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.marketplace !== 'ME') continue;
    counts.set(r.buyer, (counts.get(r.buyer) ?? 0) + 1);
  }
  const groups = new Map<string, string>();
  for (const [buyer, n] of counts) if (n > 1) groups.set(buyer, buyer);
  return groups;
}

export function toGhostRows(
  rows: BaseRow[],
  liveBalances: Map<string, number> | null,
  ownerActivity: Map<string, number> | null,
  currentOwners: Map<string, string> | null = null,
  mintActivity: Map<string, number> | null = null,
): GhostBidRow[] {
  // Pass 1 — recompute each row's live economics against the real escrow
  // balance (when a live-checked pass supplied one).
  const priced = rows.map(r => {
    const escrowKey = r.marketplace === 'ME' ? r.buyer : r.offerAccount;
    let liveBidSol = r.bidSol;
    let drained = false;
    if (liveBalances && escrowKey) {
      const liveSol = liveBalances.get(escrowKey);
      if (typeof liveSol === 'number') {
        liveBidSol = Math.min(r.bidSol, liveSol);
        drained = liveBidSol < r.bidSol - 1e-6;
      }
    }
    // The current owner already being the bid's own buyer means the
    // previous owner already accepted this exact offer — the NFT changed
    // hands, the escrow's already spent, and the offer no longer exists.
    const liveOwner = currentOwners?.get(r.mint) ?? null;
    const filled = liveOwner === r.buyer;
    // Owner moved, but not to this row's buyer — a sale/transfer/listing
    // the static snapshot never saw. Row stays (still may be profitable),
    // but the frontend needs to know `owner` is stale.
    const ownerChanged = liveOwner != null && liveOwner !== r.owner;
    // Known formula (verified against every original row's hand-computed
    // profit, 0 mismatches): net = bid * (1 - royaltyBp/10000 - feeBp/10000),
    // profit = net - floor. Royalty + marketplace fee both come out of the
    // BID (paid by whoever fulfills it), not added on top of the floor.
    const net = liveBidSol * (1 - r.royaltyBp / 10000 - r.feeBp / 10000);
    const profitSol = r.floorSol == null ? null : Math.round((net - r.floorSol) * 1e6) / 1e6;
    return { r, liveBidSol, drained, profitSol, filled, liveOwner, ownerChanged };
  });

  // Pass 2 — drop any row that's definitively dead:
  //   - `filled`: the bid was already accepted (buyer now owns the mint) —
  //     dropped unconditionally, independent of whether an escrow-balance
  //     pass ran.
  //   - on a live-checked (escrow-balance) pass, also drop any row whose
  //     profit has gone <= 0 once the escrow is clamped to its real
  //     balance: a shared M2 escrow spent down by other accepted offers
  //     leaves the row uncollectable, and it has no business in a
  //     "profitable forgotten bids" table.
  // The static (never-refreshed) snapshot keeps every non-filled row (its
  // rows were all profitable when the list was built offline). profitSol
  // == null (no floor) is kept — undetermined, not disproven.
  const kept = priced.filter(p => {
    if (p.filled) return false;
    if (liveBalances && !(p.profitSol == null || p.profitSol > 0)) return false;
    return true;
  });

  const groups = computeSharedGroups(kept.map(p => p.r));
  return kept.map(({ r, liveBidSol, drained, profitSol, liveOwner, ownerChanged }) => ({
    ...r,
    lastActiveAt: ownerActivity?.get(r.owner) ?? r.lastActiveAt,
    liveBidSol: Math.round(liveBidSol * 1e6) / 1e6,
    profitSol,
    drained,
    sharedEscrowGroup: r.marketplace === 'ME' ? (groups.get(r.buyer) ?? null) : null,
    liveOwner,
    ownerChanged,
    ownerChangedAt: ownerChanged ? (mintActivity?.get(r.mint) ?? null) : null,
  })).sort((a, b) => (b.profitSol ?? -Infinity) - (a.profitSol ?? -Infinity));
}

// A plain GET (no Refresh click) used to serve `toGhostRows(rows, null, null)`
// forever once computed once — filled bids (buyer already accepted, NFT
// changed hands) never got dropped until someone manually hit Refresh on
// that exact list. Found live 2026-09-15: 20 rows across all 8 lists were
// already-executed bids that had sat in the static JSON for weeks. Every
// GET now re-checks current owners too (cheap: one batched `getAssetBatch`
// per list), TTL-cached so rapid repeat loads don't refetch every time.
const CURRENT_OWNERS_TTL_MS = 5 * 60_000;
const currentOwnersCacheByList = new Map<ListId, { fetchedAt: number; owners: Map<string, string> }>();

async function getCurrentOwnersCached(list: ListId, mints: readonly string[]): Promise<Map<string, string>> {
  const cached = currentOwnersCacheByList.get(list);
  if (cached && Date.now() - cached.fetchedAt < CURRENT_OWNERS_TTL_MS) return cached.owners;
  const owners = await fetchCurrentOwners(mints);
  currentOwnersCacheByList.set(list, { fetchedAt: Date.now(), owners });
  return owners;
}

async function getSnapshot(list: ListId): Promise<{ updatedAt: number; rows: GhostBidRow[] }> {
  const cached = liveStateByList.get(list);
  // A real Refresh (updatedAt > 0) already did the full live check
  // (escrow balances, owner activity, current owners) — trust it as-is,
  // don't re-derive anything here.
  if (cached && cached.updatedAt > 0) return cached;

  const rows = loadBase(list).rows;
  const currentOwners = await getCurrentOwnersCached(list, rows.map(r => r.mint));
  const ghostRows = toGhostRows(rows, null, null, currentOwners);
  const snapshot = { updatedAt: 0, rows: ghostRows }; // updatedAt=0 means "never fully refreshed"
  liveStateByList.set(list, snapshot);
  return snapshot;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Derives each buyer's M2 escrow PDA (deterministic, no network call) and
 *  reads their lamport balances in one batched `getMultipleAccounts` — the
 *  same approach already used for Solanart below, and what ME's own
 *  `/wallets/{buyer}/escrow_balance` does internally anyway. Replaces an
 *  earlier version that hit that public REST endpoint once per buyer,
 *  sequentially: measured 34% failure rate (15/44 unresolved) on a live
 *  run, plus ~250ms/buyer of pure rate-limit-avoidance sleep. One RPC call
 *  against our own Helius endpoint has neither problem. */
async function fetchMeEscrowBalances(buyers: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pdaToBuyer = new Map<string, string>();
  for (const buyer of buyers) {
    const pda = deriveBuyerEscrowPda(ME_DEFAULT_AUCTION_HOUSE, buyer);
    if (pda) pdaToBuyer.set(pda, buyer);
  }
  const { balances } = await resolveEscrowBalances([...pdaToBuyer.keys()]);
  for (const [pda, lamports] of balances) {
    const buyer = pdaToBuyer.get(pda);
    if (buyer) out.set(buyer, lamports / 1e9);
  }
  return out;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

interface MultipleAccountsResp {
  result?: { value?: Array<{ lamports?: number } | null> };
}

/** Batched getMultipleAccounts for Solanart offer-escrow PDAs — self-funded
 *  per offer, so one call covers every Solanart row in the list. */
async function fetchSolanartEscrowBalances(offerAccounts: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = offerAccounts.filter(isValidPubkey);
  for (let i = 0; i < valid.length; i += RPC_CHUNK_MAX) {
    const chunk = valid.slice(i, i + RPC_CHUNK_MAX);
    try {
      const r = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
          params: [chunk, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const data = await r.json() as MultipleAccountsResp;
      const values = data.result?.value;
      if (!Array.isArray(values)) continue;
      for (let j = 0; j < chunk.length && j < values.length; j++) {
        const lamports = values[j]?.lamports;
        out.set(chunk[j], (typeof lamports === 'number' ? lamports : 0) / 1e9);
      }
    } catch {
      // this chunk's accounts stay unresolved
    }
  }
  return out;
}

interface GetAssetBatchResp {
  result?: Array<{ id?: string; ownership?: { owner?: string } } | null>;
}

const GET_ASSET_BATCH_MAX = 1000;

/** Batched Helius DAS `getAssetBatch` — resolves each mint's CURRENT
 *  on-chain owner in as few calls as the list allows (Helius caps at 1000
 *  ids/call, well above any list's row count). This is how a FILLED bid is
 *  detected: if the mint's current owner equals the row's `buyer`, the
 *  previous owner already accepted this exact offer and the NFT changed
 *  hands — the offer no longer exists (escrow already spent), so the row
 *  must be dropped, not just re-ranked. Works uniformly across legacy/pNFT/
 *  MPL Core/cNFT since DAS classifies ownership the same way for all of
 *  them. */
async function fetchCurrentOwners(mints: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(mints)].filter(isValidPubkey);
  for (let i = 0; i < valid.length; i += GET_ASSET_BATCH_MAX) {
    const chunk = valid.slice(i, i + GET_ASSET_BATCH_MAX);
    try {
      const r = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getAssetBatch',
          params: { ids: chunk },
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const data = await r.json() as GetAssetBatchResp;
      const values = data.result;
      if (!Array.isArray(values)) continue;
      for (const asset of values) {
        const id = asset?.id;
        const owner = asset?.ownership?.owner;
        if (id && typeof owner === 'string' && owner.length > 0) out.set(id, owner);
      }
    } catch {
      // this chunk's mints stay unresolved — treated as "owner unknown", not filled
    }
  }
  return out;
}

interface SignaturesForAddressResp {
  result?: Array<{ signature: string; blockTime?: number | null }>;
}

interface TransactionResp {
  result?: {
    transaction?: {
      message?: {
        accountKeys?: string[];
        header?: { numRequiredSignatures?: number };
      };
    };
  };
}

const OWNER_ACTIVITY_SIG_WINDOW = 8;

/** `getSignaturesForAddress` returns any tx the owner appears in as ANY
 *  account key — including ones where it's a passive participant (dust/spam
 *  token airdrops, or an M2 sale filled by a buyer against a listing the
 *  owner delegated ages ago and never touched again). That produced real
 *  false "active 1 day ago" rows while the owner's true last SIGNED tx was
 *  months old (confirmed against forgotten-bids-2026-08-25's holder-outreach
 *  scan — see project memory on the "no-signer" bug). Signers are always
 *  the first `header.numRequiredSignatures` entries of `accountKeys`,
 *  regardless of tx version or address-lookup-tables (those only ever add
 *  non-signer keys), so checking that slice is reliable even for v0 txs. */
async function findLastSignedActivity(owner: string): Promise<number | null> {
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [owner, { limit: OWNER_ACTIVITY_SIG_WINDOW }],
    }),
    signal: AbortSignal.timeout(OWNER_ACTIVITY_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const data = await r.json() as SignaturesForAddressResp;
  const sigs = data.result;
  if (!Array.isArray(sigs)) return null;

  for (const { signature, blockTime } of sigs) {
    if (typeof blockTime !== 'number') continue;
    try {
      const tr = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getTransaction',
          params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
        }),
        signal: AbortSignal.timeout(OWNER_ACTIVITY_TIMEOUT_MS),
      });
      if (!tr.ok) continue;
      const txData = await tr.json() as TransactionResp;
      const msg = txData.result?.transaction?.message;
      const keys = msg?.accountKeys;
      const numSigners = msg?.header?.numRequiredSignatures ?? 0;
      if (Array.isArray(keys) && keys.slice(0, numSigners).includes(owner)) return blockTime;
    } catch {
      // this signature unresolved — try the next one back
    }
  }
  return null; // no real signed tx in the checked window — leave unresolved, base snapshot's value is kept
}

/** Unix seconds of the owner wallet's most recent SIGNED tx (any tx, not
 *  scoped to this mint) — same "is this wallet still alive" signal the
 *  original offline scan used, just re-derived live on Refresh so a wallet
 *  that's moved since the snapshot was built shows up immediately instead
 *  of waiting for the next full rebuild. The day-count itself is computed
 *  on the frontend from this timestamp, not here, so it keeps ticking up
 *  with real time between refreshes instead of freezing. */
async function fetchOwnerLastActiveAt(owners: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const queue = [...owners];

  async function worker(): Promise<void> {
    for (;;) {
      const owner = queue.shift();
      if (!owner) return;
      try {
        const blockTime = await findLastSignedActivity(owner);
        if (typeof blockTime === 'number') out.set(owner, blockTime);
      } catch {
        // leave unresolved — the base snapshot's `lastActiveAt` is kept for this owner
      }
    }
  }

  const workerCount = Math.min(OWNER_ACTIVITY_CONCURRENCY, owners.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return out;
}

/** Unix seconds of the most recent signature touching a mint — unlike
 *  `findLastSignedActivity` (owner wallets), no signer filter is needed
 *  here: any tx naming the mint account (transfer, listing, sale) is real
 *  activity on that specific NFT, and `getSignaturesForAddress`'s first
 *  result is already the most recent one, so this is one RPC call per
 *  mint, no follow-up `getTransaction`. Only called for rows already known
 *  to be `ownerChanged` (a handful per list, not the whole table), so the
 *  concurrency-8 fan-out stays cheap. */
async function findMintLastActivity(mint: string): Promise<number | null> {
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [mint, { limit: 1 }],
    }),
    signal: AbortSignal.timeout(OWNER_ACTIVITY_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const data = await r.json() as SignaturesForAddressResp;
  const blockTime = data.result?.[0]?.blockTime;
  return typeof blockTime === 'number' ? blockTime : null;
}

async function fetchMintLastActivityAt(mints: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const queue = [...mints];

  async function worker(): Promise<void> {
    for (;;) {
      const mint = queue.shift();
      if (!mint) return;
      try {
        const blockTime = await findMintLastActivity(mint);
        if (typeof blockTime === 'number') out.set(mint, blockTime);
      } catch {
        // leave unresolved — ownerChangedAt stays null for this row
      }
    }
  }

  const workerCount = Math.min(OWNER_ACTIVITY_CONCURRENCY, mints.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return out;
}

export function createGhostBidRouter(): Router {
  const router = Router();
  const readLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/ghostbid' });
  const refreshLimit = rateLimit({ limit: 4, windowMs: 60_000, label: 'tools/ghostbid/refresh' });

  function parseList(req: Request): ListId | null {
    if (req.query.list === undefined) return 1;
    const n = Number(req.query.list);
    return isListId(n) ? n : null;
  }

  router.get('/tools/ghostbid', readLimit, requireAuth, async (req: Request, res: Response) => {
    const list = parseList(req);
    if (list === null) { res.status(400).json({ ok: false, error: 'invalid_list' }); return; }
    try {
      const { updatedAt, rows } = await getSnapshot(list);
      const { snapshotAt } = loadBase(list);
      res.json({ ok: true, list, updatedAt, snapshotAt, count: rows.length, rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: toClientError(err) });
    }
  });

  router.post('/tools/ghostbid/refresh', refreshLimit, requireAuth, async (req: Request, res: Response) => {
    const list = parseList(req);
    if (list === null) { res.status(400).json({ ok: false, error: 'invalid_list' }); return; }
    try {
      const { rows, snapshotAt } = loadBase(list);
      const meBuyers = [...new Set(rows.filter(r => r.marketplace === 'ME').map(r => r.buyer))];
      const solanartAccounts = [...new Set(
        rows.filter(r => r.marketplace === 'Solanart' && r.offerAccount).map(r => r.offerAccount as string)
      )];
      // Stuck rows' `owner` is a program-owned escrow/vault, not a real
      // wallet (LISTED_ME/LISTED_TENSOR rows already carry the resolved
      // real seller in `owner`, so those stay in the refresh set) —
      // re-checking a stuck escrow's signature history just reproduces the
      // shared-escrow false-"recently active" bug this field exists to
      // avoid. Skip them; `lastActiveAt` stays null from the base snapshot.
      const isStuck = (r: BaseRow) => !!r.listingStatus && r.listingStatus !== 'LISTED_ME' && r.listingStatus !== 'LISTED_TENSOR';
      const owners = [...new Set(rows.filter(r => !isStuck(r)).map(r => r.owner))];
      const mints = [...new Set(rows.map(r => r.mint))];

      const [meBalances, solanartBalances, ownerActivity, currentOwners] = await Promise.all([
        fetchMeEscrowBalances(meBuyers),
        fetchSolanartEscrowBalances(solanartAccounts),
        fetchOwnerLastActiveAt(owners),
        fetchCurrentOwners(mints),
      ]);
      const merged = new Map<string, number>([...meBalances, ...solanartBalances]);
      const filledCount = rows.filter(r => currentOwners.get(r.mint) === r.buyer).length;

      // Bounded second pass: only fetch mint-activity time for rows whose
      // live owner differs from both the snapshot's `owner` AND this row's
      // `buyer` (that combination is exactly `ownerChanged`, computed the
      // same way `toGhostRows` will compute it) — a handful of rows per
      // list, not the whole table.
      const ownerChangedMints = [...new Set(
        rows
          .filter(r => {
            const live = currentOwners.get(r.mint);
            return live != null && live !== r.owner && live !== r.buyer;
          })
          .map(r => r.mint)
      )];
      const mintActivity = await fetchMintLastActivityAt(ownerChangedMints);

      const updated = toGhostRows(rows, merged, ownerActivity, currentOwners, mintActivity);
      const updatedAt = Date.now();
      liveStateByList.set(list, { updatedAt, rows: updated });
      res.json({
        ok: true,
        list,
        updatedAt,
        snapshotAt,
        count: updated.length,
        checked: {
          meBuyers: meBuyers.length, meResolved: meBalances.size,
          solanartAccounts: solanartAccounts.length, solanartResolved: solanartBalances.size,
          owners: owners.length, ownerActivityResolved: ownerActivity.size,
          mints: mints.length, mintOwnersResolved: currentOwners.size, filled: filledCount,
          ownerChanged: ownerChangedMints.length, ownerChangedActivityResolved: mintActivity.size,
        },
        rows: updated,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: toClientError(err) });
    }
  });

  // On-demand single-buyer escrow check for the shared-escrow-group hover
  // tooltip — one ME `escrow_balance` call, not a full-table refresh, so
  // hovering a dot is cheap even if the operator hovers several in a row.
  const escrowCheckLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/ghostbid/escrow-check' });
  router.get('/tools/ghostbid/escrow-check', escrowCheckLimit, requireAuth, async (req: Request, res: Response) => {
    const buyer = typeof req.query.buyer === 'string' ? req.query.buyer : '';
    if (!isValidPubkey(buyer)) {
      res.status(400).json({ ok: false, error: 'invalid_buyer' });
      return;
    }
    try {
      const balances = await fetchMeEscrowBalances([buyer]);
      const balanceSol = balances.get(buyer);
      if (balanceSol == null) {
        res.status(502).json({ ok: false, error: 'unresolved' });
        return;
      }
      res.json({ ok: true, buyer, balanceSol });
    } catch (err) {
      res.status(500).json({ ok: false, error: toClientError(err) });
    }
  });

  return router;
}
