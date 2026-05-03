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
import {
  detectLaunchpadMint,
  getMintTrackerMode,
  LAUNCHMYNFT_PROGRAM,
} from './launchpad-detector';
import { resolveCollectionForMint } from '../../enrichment/seller-collection-count';
import { scheduleCollectionConfirmation } from '../../mints/collection-confirm';
import { getLmnftInfoByMint } from '../../enrichment/lmnft';
import { getLmnftStateForCollection } from '../../enrichment/lmnft-state';
import { patchAccumulatorLmnft } from '../../mints/accumulator';

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

/** SPL Token-2022 program ID. NFT product rules (Metaplex Core / pNFT /
 *  legacy NFT) are all served by the original SPL Token program; any
 *  mint owned by Token-2022 is treated as fungible / non-NFT for /mints
 *  purposes, even when its initial supply happens to be 1 with decimals 0
 *  (later `MintTo` calls grow supply). */
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEUNnHNEoA1YtbRuVvYr7fXMxHEy';

/** Hard reject: any mint-address extraction that lands on one of these
 *  program / canonical-account IDs is a parser misextraction (typically
 *  an inner-CPI whose account layout differs from the top-level Anchor
 *  layout). Blocking at the address level is bulletproof regardless of
 *  what shape signals follow. Includes both watched mint programs +
 *  the SPL Token / Token-2022 program addresses so a misextraction
 *  pointing at any of them is caught here, not later. */
const MINT_ADDRESS_BLACKLIST: ReadonlySet<string> = new Set([
  MPL_CORE_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  TOKEN_2022_PROGRAM,                            // SPL Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  '11111111111111111111111111111111',             // System Program
]);

// ─── Log prefilter ───────────────────────────────────────────────────────────

/** Substrings that, when present in a tx's program logs, are strong
 *  positive signals that the tx contains a mint we want to ingest.
 *  Match is case-sensitive and order-insensitive. Anything else is
 *  shed before fetchRawTx — this is the single biggest knob keeping
 *  Token Metadata's firehose under control. */
/** MPL Core needles — the program is non-fungible by design. Both the
 *  V1-suffixed and bare `CreateCollection` variants are observed in
 *  live txs (newer Core program versions emit the bare form), so we
 *  whitelist both to avoid silently dropping real Core NFTs.
 *
 *  Note: bare `Instruction: Create` is intentionally NOT included —
 *  it would substring-match `Instruction: CreateTokenAccount`,
 *  `Instruction: CreatePosition`, etc. and re-introduce the
 *  launchpad / DEX false positives the strict prefilter just fixed.
 *  Add specific Core variants here if observed in future txs.
 *
 *  Confirmed live (2026-04-28) — tx 2F5zPDSTfJqW…
 *  emitted `Program log: Instruction: CreateCollection` (no V1) for
 *  Core asset `3YSxXHVXbbR3oHEELPBGKbCXwfuFgqs8ESYjiQHg7Q6T`. */
const CORE_INSTRUCTION_NEEDLES: readonly string[] = [
  'Instruction: CreateV1',
  'Instruction: CreateV2',           // newer Core mint variant (e.g. vvv.so)
  'Instruction: CreateCollectionV1',
  'Instruction: CreateCollection',
];

/** MPL Token Metadata "create metadata account" needles. Covers both
 *  the older `Instruction: …` log format and the newer `IX: …` format
 *  emitted by Token Metadata V1.5+. These strings are TM-specific and
 *  do NOT collide with SPL Token, ATA, or launchpad logs. */
const TM_CREATE_INSTRUCTION_NEEDLES: readonly string[] = [
  // Older "Instruction: …" format
  'Instruction: CreateMetadataAccountV3',
  'Instruction: CreateMetadataAccountV2',
  'Instruction: CreateMetadataAccount',
  // Newer "IX: …" format (Token Metadata V1.5+)
  'IX: Create Metadata Accounts v3',
  'IX: Create Metadata Accounts v2',
  'IX: Create Metadata Accounts',
];

/** Combined list — used as a fast pre-screen by both `hasMintInstructionLog`
 *  and `detectProgramSource`. Note the previous loose `Instruction: Create`
 *  and `Instruction: Mint` needles were removed: they matched
 *  `Instruction: CreateTokenAccount` / `Instruction: CreatePosition` /
 *  `Instruction: MintTo` and let SPL fungible / launchpad / DEX txs through
 *  the prefilter, costing RPC fetches and occasionally polluting /mints. */
const MINT_LOG_NEEDLES: readonly string[] = [
  ...CORE_INSTRUCTION_NEEDLES,
  ...TM_CREATE_INSTRUCTION_NEEDLES,
];

/** Strict word-boundary regex for the MPL Token Metadata `Mint`
 *  instruction (pNFT mint path). Anchored end-of-token so the SPL
 *  Token `Instruction: MintTo` log line can't substring-match. */
const TM_MINT_INSTRUCTION_REGEX = /Instruction: Mint(?:\s|$)/;

/** Strict prefilter — requires BOTH:
 *    1. At least one log line contains the TM or Core program ID
 *       (anchors the tx to an actual NFT-creating program), AND
 *    2. At least one log line matches a strict NFT instruction needle
 *       (or the anchored TM-Mint regex for the pNFT path).
 *
 *  Rationale: previously the prefilter only checked needles, so SPL
 *  fungible / launchpad / DEX txs with logs like `Instruction: MintTo`
 *  or `Instruction: CreateTokenAccount` slipped through and burned
 *  `getTransaction` credits (and occasionally polluted the accumulator
 *  before downstream filters caught up). */
export function hasMintInstructionLog(logs: unknown): boolean {
  if (!Array.isArray(logs)) return false;
  // Targeted-mode shortcut: LaunchMyNFT's outer ix logs `Instruction:
  // MintCore` and the LMNFT program ID — admit those even when the
  // strict TM/Core pre-screen below would reject (the inner CPI to
  // Core is still present, but the Core program string sometimes only
  // appears on the inner-program-invoke log line that we trust the
  // tx-fetch path to surface). vvv.so reuses Core's `CreateV2`
  // log + program ID directly, so it's already covered by the
  // existing Core path below — no extra prefilter rule needed.
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes(LAUNCHMYNFT_PROGRAM) && line.includes('Instruction: MintCore')) {
      return true;
    }
    if (line.includes(LAUNCHMYNFT_PROGRAM)) {
      // LMNFT outer program present but MintCore needle on a different
      // line — still admit; the per-tx detector resolves accept/reject.
      return true;
    }
  }
  let hasNftProgram = false;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes(TOKEN_METADATA_PROGRAM) || line.includes(MPL_CORE_PROGRAM)) {
      hasNftProgram = true;
      break;
    }
  }
  if (!hasNftProgram) return false;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    for (const needle of MINT_LOG_NEEDLES) {
      if (line.includes(needle)) return true;
    }
    if (TM_MINT_INSTRUCTION_REGEX.test(line)) return true;
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
  let sawTokenMetadata = false;
  let sawMplCore       = false;
  let coreNeedle       = '';
  let tmCreateNeedle   = '';
  let sawTmMintLine    = false;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes(TOKEN_METADATA_PROGRAM)) sawTokenMetadata = true;
    if (line.includes(MPL_CORE_PROGRAM))       sawMplCore       = true;
    if (!coreNeedle) {
      for (const n of CORE_INSTRUCTION_NEEDLES) {
        if (line.includes(n)) { coreNeedle = n; break; }
      }
    }
    if (!tmCreateNeedle) {
      for (const n of TM_CREATE_INSTRUCTION_NEEDLES) {
        if (line.includes(n)) { tmCreateNeedle = n; break; }
      }
    }
    if (!sawTmMintLine && TM_MINT_INSTRUCTION_REGEX.test(line)) {
      sawTmMintLine = true;
    }
  }
  // Strict gate: NFT program ID must appear AND a strict instruction
  // needle of the matching family must be present. Reject everything
  // else as `not_metadata_mint` (logged at the call site).
  if (sawMplCore && coreNeedle) {
    return { programSource: 'mpl_core', needle: coreNeedle };
  }
  if (sawTokenMetadata && tmCreateNeedle) {
    return { programSource: 'mpl_token_metadata', needle: tmCreateNeedle };
  }
  // pNFT path: `Instruction: Mint` exact (anchored to exclude MintTo)
  // is only a valid signal when Token Metadata is also in the logs.
  if (sawTokenMetadata && sawTmMintLine) {
    return { programSource: 'mpl_token_metadata', needle: 'Instruction: Mint' };
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

  // Targeted mode (default): run the narrow launchpad detector and
  // skip the broader TM/Core classifier entirely. Anything that
  // doesn't match LMNFT or vvv.so is rejected with `unknown_launchpad`.
  // Set MINT_TRACKER_MODE=legacy to fall back to the original
  // classifier (kept for diagnostic / one-off backfills).
  if (getMintTrackerMode() === 'targeted') {
    const lp = detectLaunchpadMint(tx);
    if (!lp) {
      logLaunchpadReject('unknown_launchpad', sig, null);
      return;
    }
    // cNFT path: no on-chain mint, the Merkle tree (already in
    // `lp.collectionAddress`) is the collection-equivalent group.
    // No DAS resolve needed and no standalone-asset gate (the tree
    // itself proves the row belongs to a collection-like grouping).
    if (lp.standard === 'cnft') {
      if (!lp.collectionAddress) {
        logLaunchpadReject('no_mint', sig, null);
        return;
      }
      const priceLamports = extractSignerLamportsPaid(tx);
      const mintType      = classifyMintType(priceLamports);
      const groupingKey   = `collection:${lp.collectionAddress}`;
      const groupingKind: MintEventWire['groupingKind'] = 'collection';
      const blockTime = tx.blockTime
        ? new Date((tx.blockTime as number) * 1000).toISOString()
        : new Date().toISOString();
      console.log(
        `[mints/launchpad] accept source=${lp.source} type=cNFT ix=${lp.matchedNeedle ?? '—'} ` +
        `tree=${lp.collectionAddress} sig=${sig.slice(0,12)}…`,
      );
      recordMint({
        signature:         sig,
        blockTime,
        programSource:     'bubblegum',
        // cNFTs have no on-chain mint account — emit null so the
        // frontend renders the row without a Solscan token link.
        mintAddress:       null,
        collectionAddress: lp.collectionAddress,
        groupingKey,
        groupingKind,
        mintType,
        priceLamports,
        minter:            lp.minter,
        sourceLabel:       lp.source,
      });
      // No `enqueueMintEnrichment` — DAS verification is keyed off a
      // mintAddress; cNFTs would no-op anyway.
      return;
    }
    // Core path: accept on parser-extracted collection optimistically,
    // then verify asynchronously via DAS with a 30 s / 120 s / 300 s
    // retry queue (`scheduleCollectionConfirmation`). DAS lags
    // freshly-minted assets by seconds-to-minutes, so a synchronous
    // gate would drop every real LMNFT mint during that index window
    // (confirmed against fixture
    //   xtJv8g4TjtFPrcXkayEzzA4fVbgBkd8fo5qj2uYasZxxvMdMumZSTUengVwe7viKJjneaneyHG2es4nmF3g2Uke
    // ). When DAS later returns a real collection grouping → row
    // stays. When all 3 retries return null (test / standalone case)
    // → `evictMintGroup` drops the row and a `mint_status` frame
    // pushes the eviction to every connected client. When the parser
    // extracts no collection AT ALL we still try one cached DAS
    // fallback synchronously (fast in steady-state; null on first
    // sight of a fresh mint) — only if both come back null is the
    // row rejected outright.
    if (!lp.mintAddress) {
      logLaunchpadReject('no_mint', sig, null);
      return;
    }
    const parserCollection: string | null = lp.collectionAddress;
    let collectionAddress: string | null = parserCollection;
    let confirmedBy: 'parser_pending' | 'das' = 'parser_pending';
    if (!collectionAddress) {
      collectionAddress = await resolveCollectionForMint(lp.mintAddress);
      confirmedBy       = 'das';
    }
    if (!collectionAddress) {
      console.log(
        `[mints/launchpad] reject reason=no_confirmed_collection sig=${sig.slice(0,12)}… ` +
        `mint=${lp.mintAddress} source=${lp.source}`,
      );
      console.log(
        `[mints/launchpad-debug] sig=${sig.slice(0,12)}… ix=MintCore ` +
        `parserCollection=${parserCollection ?? 'null'} dasCollection=null decision=reject_no_collection`,
      );
      return;
    }
    const priceLamports = extractSignerLamportsPaid(tx);
    const mintType      = classifyMintType(priceLamports);
    const groupingKey   = `collection:${collectionAddress}`;
    const groupingKind: MintEventWire['groupingKind'] = 'collection';
    const blockTime = tx.blockTime
      ? new Date((tx.blockTime as number) * 1000).toISOString()
      : new Date().toISOString();
    console.log(
      `[mints/launchpad] accept source=${lp.source} type=Core mint=${lp.mintAddress} ` +
      `collection=${collectionAddress} confirmedBy=${confirmedBy} sig=${sig}`,
    );
    console.log(
      `[mints/launchpad-debug] sig=${sig.slice(0,12)}… ix=MintCore ` +
      `parserCollection=${parserCollection ?? 'null'} ` +
      `dasCollection=${confirmedBy === 'das' ? collectionAddress : 'pending'} ` +
      `decision=accept (confirmedBy=${confirmedBy})`,
    );
    recordMint({
      signature:         sig,
      blockTime,
      programSource:     'mpl_core',
      mintAddress:       lp.mintAddress,
      collectionAddress,
      groupingKey,
      groupingKind,
      mintType,
      priceLamports,
      minter:            lp.minter,
      sourceLabel:       lp.source,
    });
    enqueueMintEnrichment(groupingKey, lp.mintAddress);
    // LMNFT featured-set lookup. Synchronous cache read — hits surface
    // owner/collectionId on the wire immediately so the source pill
    // becomes clickable on the very first row, not after the 15 s DAS
    // retry. Parser-pending rows also get rechecked from
    // collection-confirm.ts in case the cache was empty here.
    if (lp.source === 'LaunchMyNFT') {
      // Path A — featured-set scraper. Hits cache; supplies owner +
      // collectionId + maxSupply for collections LMNFT promotes on
      // their homepage.
      const lmntf = getLmnftInfoByMint(collectionAddress);
      if (lmntf) {
        patchAccumulatorLmnft(groupingKey, {
          owner:        lmntf.owner,
          collectionId: lmntf.collectionId,
          maxSupply:    lmntf.maxSupply,
          name:         lmntf.collectionName,
        });
      }
      // Path B — on-chain decoder. Walks the tx's account universe,
      // finds the LMNFT-program-owned config account, decodes
      // {owner, maxSupply, collectionMint} at confirmed offsets.
      // Surfaces owner + maxSupply for ALL LMNFT mints (not just
      // featured ones). collectionId stays null until the scraper
      // fills it — sourceHref builds the URL only when both halves
      // are present, so a non-featured LMNFT row gets SUPPLY but
      // keeps the plain pill until promoted.
      void (async () => {
        const candidateAddrs = collectAccountUniverse(tx);
        const state = await getLmnftStateForCollection(collectionAddress, candidateAddrs);
        if (state && state.owner) {
          console.log(
            `[mints/lmnft-config] collection=${collectionAddress} owner=${state.owner} ` +
            `collectionId=onchain_unavailable maxSupply=${state.maxSupply ?? 'null'}`,
          );
          patchAccumulatorLmnft(groupingKey, {
            owner:     state.owner,
            maxSupply: state.maxSupply,
          });
        }
      })();
    }
    // Async DAS confirmation only when the accept relied on the
    // parser-extracted collection (the DAS path is already verified).
    if (confirmedBy === 'parser_pending') {
      scheduleCollectionConfirmation(groupingKey, lp.mintAddress, collectionAddress, sig);
    }
    return;
  }

  const hit = detectProgramSource(tx);
  if (!hit) {
    // Strict prefilter caught a tx with an NFT-shaped log line but
    // either no NFT program ID alongside it, or a non-TM/Core
    // matching needle. Logged separately so SPL-fungible / launchpad /
    // DEX false-positives are visible without diluting the
    // `program_source_null` parse-step counter.
    noteParseStep('program_source_null', null, sig);
    noteFilterReject('not_metadata_mint', sig, null);
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
  // Tier 0a: hard reject if no mintAddress was extracted. The strict
  // instruction filter above keeps this rare (TM CreateMetadataAccountV3
  // and Core CreateV1 always have the mint at a fixed account index),
  // but a malformed inner-CPI from a launchpad could leave it null.
  if (!mintAddress) {
    noteFilterReject('no_mint_address', sig, null);
    logRejectMintLevel('no_mint_address', sig, null);
    logRejectNonNft('no_mint_address', null);
    return;
  }

  // Tier 0b: hard reject if the extracted "mint" landed on a known
  // program/canonical address (parser misextraction from inner-CPI
  // account layouts). This is the bulletproof guard against rows
  // like `metaqbxx…` (the Token Metadata program) showing up.
  if (MINT_ADDRESS_BLACKLIST.has(mintAddress)) {
    noteFilterReject('program_account', sig, mintAddress);
    logRejectMintLevel('program_account', sig, mintAddress);
    logRejectNonNft('program_account', mintAddress);
    return;
  }

  // Tier 0c: NFT program presence in accountKeys. `detectProgramSource`
  // already gates on this via log scanning, but a tx whose logs mention
  // the program ID without the program actually being in accountKeys
  // would slip through there. Defense-in-depth — keeps pool / authority
  // / system-account txs from ever reaching the accumulator.
  const txHasNftProgram = accountKeys.some(
    k => k === TOKEN_METADATA_PROGRAM || k === MPL_CORE_PROGRAM,
  );
  if (!txHasNftProgram) {
    noteFilterReject('not_metadata_mint', sig, mintAddress);
    logRejectMintLevel('not_metadata_mint', sig, mintAddress);
    logRejectNonNft('not_metadata_mint', mintAddress);
    return;
  }

  // Tier 1: shape verification.
  //
  // Two distinct NFT families need to be allowed here, both legitimate:
  //   • Token Metadata path (legacy NFT + pNFT) — mint owner is the
  //     SPL Token program (`TokenkegQ…`), confirmed via the
  //     post-token-balance entry: `programId === TokenkegQ…`,
  //     `decimals === 0`, `amount === '1'`. Token-2022
  //     (`TokenzQ…`) is the ONLY token program rejected — original
  //     SPL Token ownership is REQUIRED for legacy/pNFT and remains
  //     fully accepted. Master Edition / Update / Verify metadata
  //     ops downstream don't change this verdict.
  //   • MPL Core path — assets aren't SPL tokens, so they have no
  //     post-token-balance. Validated separately below by the
  //     freshly-created-account check.
  //
  // The /mints rule is "Core / pNFT / legacy NFT only" — DO NOT
  // require Core ownership; Token Program ownership is valid and
  // expected for legacy/pNFT. Rejects fungibles (decimals > 0),
  // metadata-only / lazy-mint flows (amount === '0'), and any
  // post-balance ≥ 2 (fungible-style supply). The DAS verifier in
  // src/mints/enricher.ts catches anything that sneaks past this
  // with NFT-shape but actually-fungible later (interface or
  // tokenStandard from DAS resolves the ambiguity).
  if (hit.programSource !== 'mpl_core') {
    const verdict = checkTokenMetadataNftShape(tx, mintAddress);
    if (!verdict.ok) {
      noteFilterReject(verdict.reason, sig, mintAddress);
      logRejectNonNft(verdict.reason, mintAddress);
      // `no_post_balance` from the shape check means the address has
      // no SPL token account in this tx → it's not a mint at all
      // (likely an authority / pool / wallet that the parser picked
      // up by accident). Surface with the user-spec'd reason.
      if (verdict.reason === 'no_post_balance') {
        logRejectMintLevel('not_mint_account', sig, mintAddress);
      }
      return;
    }
    noteFilterAccept(verdict.kind, sig, mintAddress);
    logAcceptNft(verdict.kind, mintAddress);
  } else {
    // Tier 1 (Core path): assets aren't SPL tokens, so post-token-
    // balance can't validate them. Instead require the address to be
    // freshly created in this tx — Core `CreateV1` allocates the
    // asset account via SystemProgram, so its lamport delta moves
    // pre=0 → post>0. Pre-existing addresses (pool authorities,
    // wallets, program accounts) have pre>0 and fail this check.
    if (!isFreshlyCreatedAccount(tx, accountKeys, mintAddress)) {
      noteFilterReject('not_mint_account', sig, mintAddress);
      logRejectMintLevel('not_mint_account', sig, mintAddress);
      logRejectNonNft('not_mint_account', mintAddress);
      return;
    }
    noteFilterAccept('core', sig, mintAddress);
    logAcceptNft('core', mintAddress);
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

/** Per-spec [mints/reject] log line for the new mint-level guards.
 *  Sampled (1st + every 50th) per reason so a bursty source doesn't
 *  flood. Distinct from `noteFilterReject` so the operator can grep
 *  for `[mints/reject]` to see the strict mint-presence verdicts
 *  separately from the broader filter chain. */
const _rejectMintLevelCount = new Map<string, number>();
function logRejectMintLevel(reason: string, sig: string, mint: string | null): void {
  const n = (_rejectMintLevelCount.get(reason) ?? 0) + 1;
  _rejectMintLevelCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/reject] reason=${reason} count=${n} sig=${sig.slice(0, 12)}… ` +
      `mint=${mint ? mint.slice(0, 8) + '…' : '—'}`,
    );
  }
}

/** Verify the extracted address was freshly created in this tx —
 *  i.e. the account didn't exist before and was allocated by some
 *  inner instruction (typically a SystemProgram CPI from the Core
 *  CreateV1 path). Pre-balance 0 + post-balance > 0 is the
 *  cheapest signal in the existing tx data; no extra RPC call. */
function isFreshlyCreatedAccount(
  tx: RawSolanaTx,
  accountKeys: string[],
  address: string,
): boolean {
  const idx = accountKeys.indexOf(address);
  if (idx < 0) return false;
  const pre  = tx.meta?.preBalances?.[idx];
  const post = tx.meta?.postBalances?.[idx];
  if (typeof pre !== 'number' || typeof post !== 'number') return false;
  return pre === 0 && post > 0;
}

/** Operator-facing accept log per the /mints filter spec.
 *  Format: `[mints/accept-nft] kind=core|pnft|legacy mint=…`.
 *  Sampled (1st + every 50th per kind) so a hot launch doesn't
 *  flood the console. Distinct from `noteFilterAccept` so the
 *  operator can grep for `[mints/accept-nft]` to see only the
 *  parse-time positive verdicts. */
const _acceptNftCount = new Map<string, number>();
function logAcceptNft(kind: string, mint: string): void {
  const n = (_acceptNftCount.get(kind) ?? 0) + 1;
  _acceptNftCount.set(kind, n);
  if (n === 1 || n % 50 === 0) {
    console.log(`[mints/accept-nft] kind=${kind} count=${n} mint=${mint.slice(0, 8)}…`);
  }
}

/** Operator-facing reject log per the /mints filter spec.
 *  Format: `[mints/reject-non-nft] reason=… mint=…`. Same
 *  sampling pattern as `logAcceptNft`. */
const _rejectNonNftCount = new Map<string, number>();
function logRejectNonNft(reason: string, mint: string | null): void {
  const n = (_rejectNonNftCount.get(reason) ?? 0) + 1;
  _rejectNonNftCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/reject-non-nft] reason=${reason} count=${n} ` +
      `mint=${mint ? mint.slice(0, 8) + '…' : '—'}`,
    );
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
  // Strict shape: decimals === 0 AND amount === '1' on EVERY post
  // entry for this mint. Rejects:
  //   • decimals > 0     → fungible (e.g. SPL token with metadata)
  //   • amount  === '0'  → metadata exists but no supply minted yet;
  //                        we can't prove NFT-ness without supply, and
  //                        this is the gap fungibles slip through
  //                        (later MintTo creates 10^9 supply offline).
  //   • amount  > '1'    → fungible-style supply.
  //   • programId === Token-2022 → out of scope for the /mints rule
  //                        (Core / pNFT / legacy all run on the original
  //                        SPL Token program). Token-2022 mints with an
  //                        initial 1-unit MintTo would otherwise pass
  //                        the decimals/amount check and slip through
  //                        before the async DAS verifier evicts them.
  for (const e of entries) {
    // Primary hard reject: any positive decimals → fungible by
    // definition (SPL tokens with metadata, multi-decimal coin-like
    // assets). Explicit `> 0` is the main rule the /mints product
    // depends on; the `!== 0` fallback below fails closed on the
    // rare undefined / NaN / negative-decimals cases.
    if (e.uiTokenAmount.decimals > 0) {
      return { ok: false, reason: `decimals=${e.uiTokenAmount.decimals}` };
    }
    if (e.uiTokenAmount.decimals !== 0) {
      return { ok: false, reason: `decimals=${e.uiTokenAmount.decimals}` };
    }
    if (e.uiTokenAmount.amount !== '1') {
      return { ok: false, reason: `supply=${e.uiTokenAmount.amount}` };
    }
    // Defensive numeric supply guard — catches amount strings that
    // pass the literal `!== '1'` test but parse as > 1 (e.g. '1.0',
    // ' 1', '01'). Decimals=0 fungibles whose first MintTo creates
    // exactly 1 unit still pass parse-time (their later MintTo grows
    // supply offline); the async DAS verifier in mints/enricher.ts
    // is the deeper safety net for that edge case.
    const amtNum = Number(e.uiTokenAmount.amount);
    if (Number.isFinite(amtNum) && amtNum > 1) {
      return { ok: false, reason: `supply_num=${e.uiTokenAmount.amount}` };
    }
    if (e.programId && e.programId === TOKEN_2022_PROGRAM) {
      return { ok: false, reason: 'token_2022' };
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
  // TEMPORARY hard diagnostic: every reject in ingestMintRaw fires this
  // unsampled line. Pairs with `[mints/INSERT]` in accumulator.recordMint
  // so the operator can spot the path that lets Pump.fun / Meteora
  // authority rows reach /mints. Remove once the bypass is identified.
  console.log(
    `[mints/REJECT] reason=${reason} sig=${sig.slice(0, 20)}… ` +
    `mint=${mint ?? '—'}`,
  );
}

// Targeted-mode launchpad log helpers — unsampled accept lines (rare,
// signal-rich), sampled reject lines (1st + every 100th per reason)
// so a quiet day doesn't bury the accepts but a busy day doesn't
// drown out the actual launchpad mints. Operator can grep for
// `[mints/launchpad]` to see only this path's verdicts.
const _launchpadRejectCount = new Map<string, number>();
function logLaunchpadReject(reason: 'unknown_launchpad' | 'no_mint', sig: string, mint: string | null): void {
  const n = (_launchpadRejectCount.get(reason) ?? 0) + 1;
  _launchpadRejectCount.set(reason, n);
  if (n === 1 || n % 100 === 0) {
    console.log(
      `[mints/launchpad] reject reason=${reason} count=${n} ` +
      `sig=${sig.slice(0, 12)}… mint=${mint ?? '—'}`,
    );
  }
}

/** All accounts the tx touched — static keys + ALT-loaded writable +
 *  readonly. Used by the LMNFT on-chain decoder to enumerate
 *  candidates for the launchpad's collection-state PDA. */
function collectAccountUniverse(tx: RawSolanaTx): string[] {
  const message = tx.transaction?.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (message as any)?.accountKeys as Array<string | { pubkey: string }> | undefined;
  if (!Array.isArray(rawKeys)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string): void => {
    if (typeof k !== 'string' || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const k of rawKeys) push(typeof k === 'string' ? k : k?.pubkey ?? '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = (tx.meta as any)?.loadedAddresses as { writable?: string[]; readonly?: string[] } | undefined;
  if (loaded?.writable) for (const k of loaded.writable) push(k);
  if (loaded?.readonly) for (const k of loaded.readonly) push(k);
  return out;
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
