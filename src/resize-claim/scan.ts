/**
 * Wallet scan for the Resize / Claim tool.
 *
 * Given a wallet, produce three buckets:
 *
 *   claimable   — legacy/pNFT held now, is a leaf in the "TM Resize" tree,
 *                 and has NO ClaimReceipt PDA yet → `DistributeToLegacyNft`.
 *   resizable   — legacy/pNFT held now, NOT in the tree, but its Metadata
 *                 account is still oversized → holder-signed `Resize`
 *                 (fallback; the vast majority of NFTs are in the tree).
 *   alreadyDone — in the tree but the ClaimReceipt PDA exists (claimed),
 *                 or not in the tree and already shrunk → nothing to do.
 *
 * Cost for a 1 000-NFT wallet: ~1 getAssetsByOwner page per 1 000 +
 * ~10 proof batches + ~10 getMultipleAccounts (ClaimReceipt existence) +
 * ~10 getMultipleAccounts (Metadata size, only for the not-in-tree tail).
 * All bounded, all cheap.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  claimReceiptPda,
  metadataPda,
  RESIZED_METADATA_MAX_SPACE,
} from './program';
import { fetchProofs, type ProofEntry } from './proof';
import type { ClaimInput, ResizeInput } from './build';

const DAS_PAGE_LIMIT = 1000;
const DAS_MAX_PAGES = 25; // 25k owned assets — covers any realistic wallet
const ACCT_BATCH = 100;

/** DAS `interface` values that are Token-Metadata NFTs eligible for resize.
 *
 *  'Custom' included deliberately: DAS falls back to it whenever a
 *  Metadata account's `token_standard` field is absent — true of the
 *  oldest pre-token_standard NFTs (Metaplex added that field after
 *  launch), which are real, legacy, holder-owned MetadataV1 accounts,
 *  not some other asset class. Verified directly on-chain against
 *  R3PSSG7eGXc9T17w6s71423g3RFHfhJgFJYTka37LVM (SolBear #3297): Metadata
 *  key byte = 4 (MetadataV1), owner = the real Token Metadata program,
 *  607-byte account, `token_standard: null` — DAS reports it as
 *  interface "Custom" and the old allowlist silently dropped it from
 *  every scan. */
const ELIGIBLE_INTERFACES = new Set(['V1_NFT', 'LEGACY_NFT', 'ProgrammableNFT', 'Custom']);

export interface ClaimableItem {
  mint: string;
  amountLamports: string;
  proof: string[];
  index: number;
}
export interface ResizableItem {
  mint: string;
  metadataSpace: number;
}
export interface ScanResult {
  wallet: string;
  scanned: number;
  eligibleHeld: number;
  claimable: ClaimableItem[];
  resizable: ResizableItem[];
  alreadyClaimed: string[];
  /** Proof lookups that failed after retries — retry the scan for these. */
  proofUnknown: string[];
}

interface DasOwnerItem {
  id?: string;
  interface?: string;
  burnt?: boolean;
  compression?: { compressed?: boolean };
  ownership?: { owner?: string };
}
interface DasOwnerResponse {
  result?: { items?: DasOwnerItem[]; total?: number };
  error?: { code: number; message: string };
}

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

async function dasCall<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(heliusRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'resize-claim', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} http ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`${method}: empty result`);
  return json.result;
}

/** All legacy/pNFT mints currently held by `wallet` (not compressed, not burnt). */
async function enumerateEligibleMints(wallet: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= DAS_MAX_PAGES; page++) {
    const r = await dasCall<DasOwnerResponse['result']>('getAssetsByOwner', {
      ownerAddress: wallet,
      page,
      limit: DAS_PAGE_LIMIT,
      displayOptions: { showCollectionMetadata: false, showUnverifiedCollections: true },
    });
    const items = r?.items ?? [];
    for (const it of items) {
      if (!it.id) continue;
      if (it.burnt) continue;
      if (it.compression?.compressed) continue;
      if (!ELIGIBLE_INTERFACES.has(it.interface ?? '')) continue;
      if (it.ownership?.owner && it.ownership.owner !== wallet) continue;
      out.push(it.id);
    }
    if (items.length < DAS_PAGE_LIMIT) break;
  }
  return [...new Set(out)];
}

/** Which of `pdas` currently exist on chain (dataSlice 0 → cheap). */
export async function whichExist(conn: Connection, pdas: PublicKey[]): Promise<Set<string>> {
  const exist = new Set<string>();
  for (let i = 0; i < pdas.length; i += ACCT_BATCH) {
    const slice = pdas.slice(i, i + ACCT_BATCH);
    const infos = await conn.getMultipleAccountsInfo(slice, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 0 },
    });
    infos.forEach((info, j) => {
      if (info) exist.add(slice[j].toBase58());
    });
  }
  return exist;
}

/** Metadata account `space` for each mint (0 when the account is missing).
 *  Uses a raw getMultipleAccounts call — the JSON-RPC response carries
 *  `space` per account even with a zero dataSlice, which the web3.js typed
 *  helper discards. */
export async function metadataSpaces(mints: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const pdas = mints.map((m) => metadataPda(new PublicKey(m)).toBase58());
  for (let i = 0; i < pdas.length; i += ACCT_BATCH) {
    const slice = pdas.slice(i, i + ACCT_BATCH);
    const res = await dasCall<{ value?: Array<{ space?: number } | null> }>('getMultipleAccounts', [
      slice,
      { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
    ]);
    const value = res.value ?? [];
    slice.forEach((_pda, j) => {
      map.set(mints[i + j], value[j]?.space ?? 0);
    });
  }
  return map;
}

export async function scanWallet(conn: Connection, wallet: string): Promise<ScanResult> {
  new PublicKey(wallet); // validate

  const eligible = await enumerateEligibleMints(wallet);

  const { byMint: proofByMint, failedMints } = await fetchProofs(eligible);

  // In-tree mints → check ClaimReceipt PDA existence.
  const inTree: Array<{ mint: string; entry: ProofEntry }> = [];
  for (const mint of eligible) {
    const entry = proofByMint.get(mint);
    if (entry) inTree.push({ mint, entry });
  }

  const receiptPdas = inTree.map(({ mint, entry }) =>
    claimReceiptPda(new PublicKey(mint), BigInt(entry.amountLamports || '0')),
  );
  const receiptExists = await whichExist(conn, receiptPdas);

  const claimable: ClaimableItem[] = [];
  const alreadyClaimed: string[] = [];
  inTree.forEach(({ mint, entry }, idx) => {
    if (receiptExists.has(receiptPdas[idx].toBase58())) {
      alreadyClaimed.push(mint);
    } else {
      claimable.push({
        mint,
        amountLamports: entry.amountLamports,
        proof: entry.proof,
        index: entry.index,
      });
    }
  });

  // Not-in-tree tail (and not a failed lookup) → maybe still self-resizable.
  const failedSet = new Set(failedMints);
  const notInTree = eligible.filter((m) => !proofByMint.has(m) && !failedSet.has(m));
  const resizable: ResizableItem[] = [];
  if (notInTree.length) {
    const spaces = await metadataSpaces(notInTree);
    for (const mint of notInTree) {
      const space = spaces.get(mint) ?? 0;
      if (space > RESIZED_METADATA_MAX_SPACE) resizable.push({ mint, metadataSpace: space });
    }
  }

  return {
    wallet,
    scanned: eligible.length,
    eligibleHeld: eligible.length,
    claimable,
    resizable,
    alreadyClaimed,
    proofUnknown: failedMints,
  };
}

export interface RevalidateResult {
  /** claims still safe to rebuild — receipt absent AND NFT still held. */
  claimable: ClaimInput[];
  alreadyClaimed: string[];
  /** mint no longer held by this wallet (sold/transferred since scan). */
  notHeld: string[];
  /** resizes still safe to rebuild — metadata still oversized. */
  resizable: ResizeInput[];
  alreadyResized: string[];
}

/** Which of `mints` currently have a non-zero balance in `owner`'s ATA —
 *  i.e. the NFT is still actually held. Closes the "sold/transferred since
 *  scan" TOCTOU window for the claim retry path. One legacy Token Program
 *  ATA per mint (this feature never touches Token-2022 — see
 *  RESIZED_METADATA_MAX_SPACE's own header and program.ts's account
 *  builders, neither ever references TOKEN_2022_PROGRAM_ID). */
async function currentlyHeld(conn: Connection, owner: PublicKey, mints: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  const atas = mints.map((m) => getAssociatedTokenAddressSync(new PublicKey(m), owner, true));
  for (let i = 0; i < atas.length; i += ACCT_BATCH) {
    const slice = atas.slice(i, i + ACCT_BATCH);
    const infos = await conn.getMultipleAccountsInfo(slice, { commitment: 'confirmed' });
    infos.forEach((info, j) => {
      if (!info || info.data.length < AccountLayout.span) return;
      const decoded = AccountLayout.decode(info.data.subarray(0, AccountLayout.span));
      if (decoded.amount > 0n) held.add(mints[i + j]);
    });
  }
  return held;
}

/**
 * Narrow, cheap re-check for a SPECIFIC, already-scanned set of items —
 * used only before rebuilding a retry batch (never on the initial scan,
 * and never a full re-run of `scanWallet`'s wallet-wide DAS enumeration,
 * which is `wallet`-scoped, not item-scoped, and far more expensive).
 *
 * Re-reads exactly the two on-chain facts a stale item's rebuild eligibility
 * depends on: has this claim's ClaimReceipt appeared since the original
 * scan (claimed elsewhere), and is the NFT still actually held (sold/
 * transferred since the original scan)? For resizes: is the Metadata
 * account still oversized (not already resized by someone else)?
 *
 * The merkle `proof` itself is intentionally NOT re-fetched — proof.ts's
 * own documented contract is that a proof is keyed by mint only and never
 * goes stale ("stable regardless of who holds the NFT or whether it has
 * been claimed"). Re-fetching it here would add a third-party round trip
 * with no correctness benefit; the caller's original `ClaimInput.proof` is
 * reused as-is for any item this function still says is claimable.
 */
export async function revalidateItems(
  conn: Connection,
  wallet: string,
  claims: ClaimInput[],
  resizes: ResizeInput[],
): Promise<RevalidateResult> {
  const ownerPk = new PublicKey(wallet);

  const claimable: ClaimInput[] = [];
  const alreadyClaimed: string[] = [];
  const notHeld: string[] = [];

  if (claims.length > 0) {
    const receiptPdas = claims.map((c) =>
      claimReceiptPda(new PublicKey(c.mint), BigInt(c.amountLamports || '0')));
    const [receiptExists, stillHeld] = await Promise.all([
      whichExist(conn, receiptPdas),
      currentlyHeld(conn, ownerPk, claims.map((c) => c.mint)),
    ]);
    claims.forEach((c, i) => {
      if (receiptExists.has(receiptPdas[i].toBase58())) { alreadyClaimed.push(c.mint); return; }
      if (!stillHeld.has(c.mint)) { notHeld.push(c.mint); return; }
      claimable.push(c);
    });
  }

  const resizable: ResizeInput[] = [];
  const alreadyResized: string[] = [];
  if (resizes.length > 0) {
    const spaces = await metadataSpaces(resizes.map((r) => r.mint));
    for (const r of resizes) {
      if ((spaces.get(r.mint) ?? 0) > RESIZED_METADATA_MAX_SPACE) resizable.push(r);
      else alreadyResized.push(r.mint);
    }
  }

  return { claimable, alreadyClaimed, notHeld, resizable, alreadyResized };
}
