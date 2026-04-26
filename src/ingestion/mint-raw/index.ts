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

/** Identify which mint program shows up in this tx's logs. First match wins. */
function detectProgramSource(tx: RawSolanaTx): ProgramHit | null {
  const logs = tx.meta?.logMessages;
  if (!Array.isArray(logs)) return null;
  let sawCore     = false;
  let sawMetadata = false;
  let mintNeedle  = '';
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes(MPL_CORE_PROGRAM))       sawCore     = true;
    if (line.includes(TOKEN_METADATA_PROGRAM)) sawMetadata = true;
    if (!mintNeedle) {
      for (const n of MINT_LOG_NEEDLES) {
        if (line.includes(n)) { mintNeedle = n; break; }
      }
    }
  }
  if (sawCore     && (mintNeedle === 'Instruction: CreateV1' || mintNeedle === 'Instruction: CreateCollectionV1')) {
    return { programSource: 'mpl_core', needle: mintNeedle };
  }
  if (sawMetadata && mintNeedle.length > 0) {
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

/** First top-level instruction whose `programIdIndex` resolves to one of
 *  our two watched programs. Returns the instruction + its resolved
 *  account-key strings for downstream account-index lookups. */
function findMintInstruction(
  tx: RawSolanaTx,
  programSource: MintProgramSource,
): { ix: { accounts: number[] }; accountKeys: string[] } | null {
  const message = tx.transaction?.message;
  if (!message) return null;
  // accountKeys after fetchRawTx's merge are objects with .pubkey.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (message as any).accountKeys as Array<string | { pubkey: string }> | undefined;
  if (!Array.isArray(rawKeys)) return null;
  const accountKeys = rawKeys.map(k => typeof k === 'string' ? k : k?.pubkey ?? '');
  const target = programSource === 'mpl_core' ? MPL_CORE_PROGRAM : TOKEN_METADATA_PROGRAM;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ixs = (message as any).instructions as Array<{ programIdIndex: number; accounts: number[] }> | undefined;
  if (!Array.isArray(ixs)) return null;
  for (const ix of ixs) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId === target) return { ix, accountKeys };
  }
  return null;
}

// ─── Ingestion entry point ───────────────────────────────────────────────────

/** Listener-compatible IngestFn. Fetches the tx, parses it for a
 *  mint, and forwards into the in-memory accumulator. No DB write
 *  in this MVP — the accumulator is the source of truth. */
export async function ingestMintRaw(
  sig: string,
  _heliusTx?: unknown,                // unused; we always fetch raw
  priority: Priority = 'medium',
): Promise<void> {
  const tx = await fetchRawTx(sig, false, priority);
  if (!tx) return;
  const hit = detectProgramSource(tx);
  if (!hit) return;

  const found = findMintInstruction(tx, hit.programSource);
  if (!found) return;
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
