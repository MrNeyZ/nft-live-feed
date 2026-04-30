/**
 * MPL Core + MPL Token Metadata mint ingestion.
 *
 * Single-file MVP: exports an `IngestFn`-compatible `ingestMintRaw` plus
 * the log prefilter `hasMintInstructionLog`. Reuses `fetchRawTx` from the
 * sales pipeline so RPC dedup / circuit-breakers / priority limiter all
 * apply unchanged. No new state, no new HTTP, no extra metadata fetches.
 *
 * Detection model:
 *   - MPL Core program       → look for "Instruction: CreateV1" or
 *                              "Instruction: CreateCollectionV1" log lines.
 *                              The asset is the first instruction account;
 *                              the collection is the third when present.
 *   - MPL Token Metadata     → look for the legacy/V3 mint discriminators in
 *                              the program log. Exact account layout varies
 *                              per ix; we extract the mint from the
 *                              instruction account at index 0 (Metadata PDA's
 *                              counterparty mint is at index 1 for both
 *                              CreateMetadataAccountV3 and Mint).
 *   - Bubblegum              → deferred; cNFT mints will follow once cNFT
 *                              mint coverage is needed (lower priority).
 *
 * Price extraction (free/paid/unknown):
 *   Sum of pre→post SOL delta on the payer (signer index 0) minus the
 *   tx fee. If positive (signer paid), classify as `paid`; zero ⇒ `free`;
 *   below MIN_PAID dust threshold ⇒ `unknown`. We use the same
 *   MIN_PAID_LAMPORTS as the accumulator (1 000 000 lamports).
 */

import { fetchRawTx } from '../me-raw/ingest';
import type { RawSolanaTx } from '../me-raw/types';
import type { Priority } from '../concurrency';
import { recordMint } from '../../mints/accumulator';
import { enqueueMintEnrichment } from '../../mints/enricher';
import type {
  MintEventWire,
  MintProgramSource,
  MintType,
  MintSourceLabel,
} from '../../events/emitter';

// ─── Known launchpad program IDs ─────────────────────────────────────────────
//
// Best-effort v1 detection: when a tx invokes one of these programs, the
// label takes precedence over the programSource fallback. Curated; extend
// here as more launchpad addresses are confirmed.
//
// Magic Eden Launchpad's primary mint program (CMv2 fork) and the
// Metaplex stock Candy Machine v3 are the high-confidence entries.
// LaunchMyNFT and VVV are placeholders today — the consts are exported
// so an operator can add the actual program addresses without touching
// detection logic.

const LAUNCHPAD_PROGRAM_LABELS: Readonly<Record<string, MintSourceLabel>> = {
  // Metaplex Candy Machine v3
  'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR': 'Metaplex Candy Machine',
  // Add LaunchMyNFT / VVV / Magic Eden Launchpad program IDs here when confirmed.
  // Example:
  // '<launchmynft-program-id>': 'LaunchMyNFT',
  // '<vvv-program-id>':         'VVV',
  // '<me-launchpad-program-id>':'ME',
};

function programSourceLabel(s: MintProgramSource): MintSourceLabel {
  if (s === 'mpl_core')           return 'Metaplex Core';
  if (s === 'mpl_token_metadata') return 'Metaplex';
  return 'Bubblegum';
}

function detectSourceLabel(
  programSource: MintProgramSource,
  accountKeys: string[],
): MintSourceLabel {
  // First-match-wins scan over the resolved account keys (top-level +
  // loaded addresses already merged by fetchRawTx).
  for (const k of accountKeys) {
    const hit = LAUNCHPAD_PROGRAM_LABELS[k];
    if (hit) return hit;
  }
  return programSourceLabel(programSource);
}

// ─── Program addresses ───────────────────────────────────────────────────────

export const MPL_CORE_PROGRAM       = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

// ─── Log prefilter ───────────────────────────────────────────────────────────

/** Substrings that, when present in a tx's program logs, are strong
 *  positive signals that the tx contains a mint we want to ingest.
 *  Match is case-sensitive and order-insensitive. Anything else is
 *  shed before fetchRawTx — this is the single biggest knob keeping
 *  Token Metadata's firehose under control. */
const MINT_LOG_NEEDLES: readonly string[] = [
  // MPL Core
  'Instruction: CreateV1',
  'Instruction: CreateCollectionV1',
  // MPL Token Metadata
  'Instruction: CreateMetadataAccountV3',
  'Instruction: Create',     // Token Metadata "Create" (V1.5+)
  'Instruction: Mint',       // Token Metadata "Mint" (pNFT)
];

export function hasMintInstructionLog(logs: unknown): boolean {
  if (!Array.isArray(logs)) return false;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    for (const needle of MINT_LOG_NEEDLES) {
      if (line.includes(needle)) return true;
    }
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_PAID_LAMPORTS = 1_000_000;

interface ProgramHit { programSource: MintProgramSource; needle: string; }

/** Identify which mint program shows up in this tx's logs. Needle-driven:
 *  the instruction-name string in the program log is the strongest signal
 *  and uniquely identifies Core vs. Token Metadata for the unambiguous
 *  needles. Falls back to program-address sighting only for the two
 *  ambiguous needles (`Instruction: Create` / `Instruction: Mint`) which
 *  are also emitted by SPL Token (`MintTo`) and ATA (`Create`) and so
 *  need a positive TM-mention to disambiguate.
 *
 *  Why the previous `sawCore && needle === ...` requirement was wrong:
 *  for inner-CPI mints (launchpad → mpl_core CreateV1), the outer program
 *  is the launchpad and its log lines mention the launchpad's address;
 *  Core's address appears only on the inner `Program CoREENx... invoke [2]`
 *  line. That line IS in `logMessages`, so `sawCore` should be true — but
 *  any condition that gates on log-address sighting is fragile to
 *  truncation / format changes. The needle alone is enough for the two
 *  Core-unique instruction names. */
function detectProgramSource(tx: RawSolanaTx): ProgramHit | null {
  const logs = tx.meta?.logMessages;
  if (!Array.isArray(logs)) return null;
  let sawMetadata = false;
  let mintNeedle  = '';
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes(TOKEN_METADATA_PROGRAM)) sawMetadata = true;
    if (!mintNeedle) {
      for (const n of MINT_LOG_NEEDLES) {
        if (line.includes(n)) { mintNeedle = n; break; }
      }
    }
  }
  if (!mintNeedle) return null;
  // Core-unique needles → mpl_core (no other program emits these names).
  if (mintNeedle === 'Instruction: CreateV1' || mintNeedle === 'Instruction: CreateCollectionV1') {
    return { programSource: 'mpl_core', needle: mintNeedle };
  }
  // TM-unique needle → mpl_token_metadata.
  if (mintNeedle === 'Instruction: CreateMetadataAccountV3') {
    return { programSource: 'mpl_token_metadata', needle: mintNeedle };
  }
  // Ambiguous needles (`Create` / `Mint`): require TM in the log to
  // distinguish from SPL-Token / ATA noise that also matches.
  if (sawMetadata) {
    return { programSource: 'mpl_token_metadata', needle: mintNeedle };
  }
  return null;
}

/** Lamports paid by the signer (account index 0) — positive value means
 *  the signer parted with SOL. The tx fee (~5 000 lamports) is well below
 *  the 1 000 000-lamport MIN_PAID dust threshold so we don't need to
 *  subtract it explicitly for free/paid classification. */
function extractSignerLamportsPaid(tx: RawSolanaTx): number | null {
  const pre  = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length === 0) return null;
  const delta = (pre[0] as number) - (post[0] as number);
  return Number.isFinite(delta) ? delta : null;
}

function classifyMintType(priceLamports: number | null): MintType {
  if (priceLamports == null) return 'unknown';
  if (priceLamports <= 0)    return 'free';
  if (priceLamports >= MIN_PAID_LAMPORTS) return 'paid';
  return 'unknown';
}

/** First instruction whose `programIdIndex` resolves to one of our two
 *  watched programs. Top-level instructions are checked first; if the
 *  match isn't there, we descend into `tx.meta.innerInstructions[*].instructions`.
 *
 *  Why inner CPIs matter: candy-machine / launchpad mints invoke
 *  `mpl_token_metadata.create_metadata_account_v3` (or `mpl_core.create_v1`)
 *  as a CPI from the launchpad's outer instruction. The top-level
 *  program is the launchpad — only the inner CPI carries the
 *  TM/Core instruction we need to extract the asset/mint from.
 *
 *  Inner instructions use the SAME accountKeys array as the outer
 *  message (already merged with loaded addresses by fetchRawTx), so
 *  the existing `accounts[i]` → `accountKeys[a[i]]` indirection works
 *  unchanged. Returns `viaInner` so the caller can sample-log the
 *  inner-path success rate to gauge the fix's impact. */
function findMintInstruction(
  tx: RawSolanaTx,
  programSource: MintProgramSource,
): { ix: { accounts: number[] }; accountKeys: string[]; viaInner: boolean } | null {
  const message = tx.transaction?.message;
  if (!message) return null;
  // accountKeys after fetchRawTx's merge are objects with .pubkey.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (message as any).accountKeys as Array<string | { pubkey: string }> | undefined;
  if (!Array.isArray(rawKeys)) return null;
  const accountKeys = rawKeys.map(k => typeof k === 'string' ? k : k?.pubkey ?? '');
  const target = programSource === 'mpl_core' ? MPL_CORE_PROGRAM : TOKEN_METADATA_PROGRAM;

  // 1. Top-level instructions — original path, unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ixs = (message as any).instructions as Array<{ programIdIndex: number; accounts: number[] }> | undefined;
  if (Array.isArray(ixs)) {
    for (const ix of ixs) {
      const programId = accountKeys[ix.programIdIndex];
      if (programId === target) return { ix, accountKeys, viaInner: false };
    }
  }

  // 2. Inner-instruction CPIs — required to catch launchpad / candy-
  //    machine wrappers where the outer program isn't TM/Core. Each
  //    `RawInnerInstructionGroup` belongs to one outer instruction
  //    (`grp.index`); its `instructions` list contains the CPI calls
  //    that outer instruction made. We only care about the programId,
  //    not which outer ix triggered it.
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const grp of inner) {
      if (!Array.isArray(grp.instructions)) continue;
      for (const ix of grp.instructions) {
        const programId = accountKeys[ix.programIdIndex];
        if (programId === target) return { ix, accountKeys, viaInner: true };
      }
    }
  }
  return null;
}

// ─── Ingestion entry point ───────────────────────────────────────────────────

/** Listener-compatible IngestFn. Fetches the tx, parses it for a
 *  mint, and forwards into the in-memory accumulator. No DB write
 *  in this MVP — the accumulator is the source of truth.
 *
 *  Priority pinned to 'low' regardless of caller: mint ingestion must
 *  never starve the sales path at the shared `rpcLimiter`. Under a
 *  hot Token Metadata launch this lets sale fetches stay snappy even
 *  if mint fetches queue up or get stale-dropped. */
export async function ingestMintRaw(
  sig: string,
  _heliusTx?: unknown,                // unused; we always fetch raw
  _priority: Priority = 'medium',     // intentionally ignored — see above
): Promise<void> {
  const tx = await fetchRawTx(sig, false, 'low');
  if (!tx) {
    noteParseStep('fetch_null', null, sig);
    return;
  }
  const hit = detectProgramSource(tx);
  if (!hit) {
    noteParseStep('program_source_null', null, sig);
    return;
  }

  const found = findMintInstruction(tx, hit.programSource);
  if (!found) {
    // Both the top-level scan AND the inner-CPI scan came up empty.
    // Possible causes (in rough order of likelihood):
    //   - prefilter let in a non-mint tx whose log substrings collide
    //     (e.g. SPL `MintTo` or ATA `Create`)
    //   - account-key merge missed an ALT-loaded program (rare; logs
    //     would still show the program address but accountKeys[i]
    //     wouldn't resolve to it)
    noteParseStep('ix_not_found_anywhere', hit.programSource, sig);
    return;
  }
  if (found.viaInner) {
    // First inner-CPI hit per (step, source) + every 25th. Lets us
    // confirm in production logs that the inner-instruction extension
    // is firing and how often vs. the top-level path.
    noteParseStep('inner_ix_found', hit.programSource, sig);
  }
  const { ix, accountKeys } = found;

  // Conservative account extraction. Both Core CreateV1 and Token
  // Metadata CreateMetadataAccountV3/Mint place the asset/mint at a
  // low instruction-account index; we read defensively and fall back
  // to null when the layout isn't what we expect.
  //
  //   Core.CreateV1:               accounts[0] = asset
  //                                accounts[2] = collection (optional)
  //                                accounts[3] = authority/update_authority
  //                                accounts[5] = payer/minter (signer)
  //   TM.CreateMetadataAccountV3:  accounts[0] = metadata PDA
  //                                accounts[1] = mint
  //                                accounts[2] = mint authority
  //                                accounts[4] = payer (signer)
  const a = ix.accounts;
  let mintAddress:       string | null = null;
  let collectionAddress: string | null = null;
  let updateAuthority:   string | null = null;
  let minter:            string | null = null;

  if (hit.programSource === 'mpl_core') {
    mintAddress       = accountKeys[a[0]] ?? null;
    collectionAddress = a.length > 2 ? (accountKeys[a[2]] ?? null) : null;
    updateAuthority   = a.length > 3 ? (accountKeys[a[3]] ?? null) : null;
    minter            = a.length > 5 ? (accountKeys[a[5]] ?? null) : null;
  } else {
    // Token Metadata: mint is index 1 across the relevant ixs.
    mintAddress     = a.length > 1 ? (accountKeys[a[1]] ?? null) : null;
    updateAuthority = a.length > 2 ? (accountKeys[a[2]] ?? null) : null;
    minter          = a.length > 4 ? (accountKeys[a[4]] ?? null) : null;
    // Collection address isn't directly in the instruction accounts
    // for Token Metadata Create — it lives in the data payload. Left
    // null in this MVP; falls back to update authority for grouping.
  }

  // Dedup: ignore the "create collection" call itself — that's the
  // collection NFT, not a mint into a collection. We still want to
  // count it as a single mint event though, since for Core the
  // collection asset IS the first NFT-like row in many drops.
  if (hit.needle === 'Instruction: CreateCollectionV1') {
    collectionAddress = mintAddress; // self-collection
  }

  // ── NFT-only filter ──────────────────────────────────────────────
  // MPL Core assets are inherently non-fungible by program design,
  // so we always accept them. For Token Metadata we additionally
  // verify the mint is NFT-shaped (decimals=0, post-balance amount
  // not >1) by inspecting the tx's post-token-balance entry for the
  // mint we identified above. This rejects fungible / SPL-token
  // metadata creations (decimals > 0) and FT-with-metadata edge
  // cases, leaving only legacy NFT, pNFT, and Core asset mints.
  if (hit.programSource !== 'mpl_core') {
    const verdict = checkTokenMetadataNftShape(tx, mintAddress);
    if (!verdict.ok) {
      noteFilterReject(verdict.reason, sig, mintAddress);
      return;
    }
    noteFilterAccept(verdict.kind, sig, mintAddress);
  } else {
    noteFilterAccept('core', sig, mintAddress);
  }

  const priceLamports = extractSignerLamportsPaid(tx);
  const mintType      = classifyMintType(priceLamports);

  const groupingKey: string =
    collectionAddress ? `collection:${collectionAddress}` :
    updateAuthority   ? `authority:${updateAuthority}` :
    `program:${hit.programSource}`;
  const groupingKind: MintEventWire['groupingKind'] =
    collectionAddress ? 'collection' :
    updateAuthority   ? 'updateAuthority' :
    'programSource';

  const blockTime = tx.blockTime
    ? new Date((tx.blockTime as number) * 1000).toISOString()
    : new Date().toISOString();

  const sourceLabel = detectSourceLabel(hit.programSource, accountKeys);

  recordMint({
    signature:         sig,
    blockTime,
    programSource:     hit.programSource,
    mintAddress,
    collectionAddress,
    groupingKey,
    groupingKind,
    mintType,
    priceLamports,
    minter,
    sourceLabel,
  });
  // Async, non-blocking metadata fetch — fired once per groupingKey
  // ever (enricher dedups internally). Never awaited; ingestion
  // continues regardless.
  if (mintAddress) {
    enqueueMintEnrichment(groupingKey, mintAddress);
  }
  // Sampled debug: 1-in-25 to show recordMint() is firing without
  // flooding during a hot Token Metadata launch.
  noteMintRecorded(hit.programSource);
  // Sampled source-label debug: first event per sourceLabel + every
  // 25th. Lets the operator confirm whether the launchpad allowlist
  // ever fires or everything falls back to Metaplex / Unknown.
  noteSourceLabel(sourceLabel, hit.programSource, groupingKey);
}

const mintRecordCount = new Map<string, number>();
function noteMintRecorded(programSource: string): void {
  const n = (mintRecordCount.get(programSource) ?? 0) + 1;
  mintRecordCount.set(programSource, n);
  if (n === 1 || n % 25 === 0) {
    console.log(`[mints/record] source=${programSource} count=${n}`);
  }
}

/** Per-step counters for the parse pipeline. Emits one line on the first
 *  occurrence of each (step, source) pair and then every 25th. Lets the
 *  operator see at a glance which step is shedding the most txs without
 *  flooding the log under a hot launch. */
const parseStepCount = new Map<string, number>();
function noteParseStep(step: string, programSource: MintProgramSource | null, sig: string): void {
  const key = `${step}:${programSource ?? '—'}`;
  const n   = (parseStepCount.get(key) ?? 0) + 1;
  parseStepCount.set(key, n);
  if (n === 1 || n % 25 === 0) {
    console.log(
      `[mints/parse] step=${step} source=${programSource ?? '—'} ` +
      `count=${n} sig=${sig.slice(0, 12)}…`,
    );
  }
}

// ── NFT-only filter helpers ─────────────────────────────────────────
//
// /mints aggregates per collection of NFT mints and is intentionally
// blind to fungible-token creation events. The Token Metadata program
// is used by both NFTs (legacy / pNFT, decimals=0) and fungibles
// (decimals>0); we filter post-parse so only true NFT mints reach
// `recordMint`.
//
// MPL Core: assets are non-fungible by program design — always
// accepted (no extra check needed).
//
// Token Metadata: we inspect the tx's post-token-balance entry for
// the mint we identified. If decimals > 0, it's a fungible mint and
// we reject. If decimals === 0 and the supply state looks NFT-like
// (post amount is "0" pre-mint-to, or "1" if the same tx mints to a
// holder), we accept and label legacy / pnft based on the matched
// instruction name.

interface NftCheckOk   { ok: true;  kind: 'core' | 'pnft' | 'legacy'; }
interface NftCheckBad  { ok: false; reason: string; }
type NftCheck = NftCheckOk | NftCheckBad;

function checkTokenMetadataNftShape(tx: RawSolanaTx, mintAddress: string | null): NftCheck {
  if (!mintAddress) return { ok: false, reason: 'no_mint_address' };
  const post = tx.meta?.postTokenBalances ?? [];
  const entries = post.filter(b => b.mint === mintAddress);
  if (entries.length === 0) {
    // Some flows (lazy mint / metadata-only Create with no MintTo) leave
    // postTokenBalances empty for the freshly-created mint. Reject so
    // we don't surface unverifiable rows. False negatives here are
    // sparse drop-only metadata-creation flows we don't care about.
    return { ok: false, reason: 'no_post_balance' };
  }
  for (const e of entries) {
    if (e.uiTokenAmount.decimals !== 0) {
      return { ok: false, reason: `decimals=${e.uiTokenAmount.decimals}` };
    }
    // amount can be "0" (created but not yet minted-to) or "1" (mint
    // landed in this tx). Anything > 1 is a fungible-style supply.
    const amt = e.uiTokenAmount.amount;
    if (amt !== '0' && amt !== '1') {
      return { ok: false, reason: `amount=${amt}` };
    }
  }
  // Kind discrimination by matched instruction needle. mip1 = pNFT;
  // CreateMetadataAccountV3 = legacy. The generic `Instruction: Create`
  // can be either — fall back to 'legacy' as the most common case.
  const logs = tx.meta?.logMessages ?? [];
  const sawMip1 = logs.some(l => typeof l === 'string' && l.includes('mip1'));
  const kind: NftCheckOk['kind'] = sawMip1 ? 'pnft' : 'legacy';
  return { ok: true, kind };
}

const filterAcceptCount = new Map<string, number>();
function noteFilterAccept(kind: string, sig: string, mint: string | null): void {
  const n = (filterAcceptCount.get(kind) ?? 0) + 1;
  filterAcceptCount.set(kind, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/filter] accept_nft type=${kind} count=${n} ` +
      `sig=${sig.slice(0, 12)}… mint=${mint ? mint.slice(0, 8) + '…' : '—'}`,
    );
  }
}
const filterRejectCount = new Map<string, number>();
function noteFilterReject(reason: string, sig: string, mint: string | null): void {
  const n = (filterRejectCount.get(reason) ?? 0) + 1;
  filterRejectCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/filter] reject_non_nft reason=${reason} count=${n} ` +
      `sig=${sig.slice(0, 12)}… mint=${mint ? mint.slice(0, 8) + '…' : '—'}`,
    );
  }
}

const sourceLabelCount = new Map<string, number>();
function noteSourceLabel(
  sourceLabel: MintSourceLabel,
  programSource: MintProgramSource,
  groupingKey: string,
): void {
  const n = (sourceLabelCount.get(sourceLabel) ?? 0) + 1;
  sourceLabelCount.set(sourceLabel, n);
  if (n === 1 || n % 25 === 0) {
    console.log(
      `[mints/source] sourceLabel=${sourceLabel} programSource=${programSource}` +
      ` groupingKey=${groupingKey} count=${n}`,
    );
  }
}
