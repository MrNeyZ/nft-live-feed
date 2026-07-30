/**
 * Candy Mint tool — reconstructs the account set for a Candy Guard mint
 * call from a real, already-landed mint signature. Read-only; shares the
 * mint-analyzer's tx fetch + program registry (single source of truth —
 * see CLAUDE.md "existing pattern first").
 *
 * Two supported families, both dispatched off which Candy Guard program
 * invoked the instruction:
 *
 *   'core'   — MPL Core Candy Guard `MintV1` (CMAGAKJ67e9h…). Account
 *              order verified against `@metaplex-foundation/
 *              mpl-core-candy-machine`'s generated `MintV1InstructionAccounts`
 *              AND a real landed tx — both match byte-for-byte:
 *                0 candyGuard · 1 candyMachineProgram · 2 candyMachine ·
 *                3 candyMachineAuthorityPda · 4 payer · 5 minter · 6 owner ·
 *                7 asset · 8 collection · 9 mplCoreProgram · 10 systemProgram ·
 *                11 sysvarInstructions · 12 recentSlothashes · [13+ guard extras]
 *
 *   'legacy' — Token Metadata Candy Guard `MintV2` (Guard1Jw…). Account
 *              order verified the same way against `@metaplex-foundation/
 *              mpl-candy-machine`'s generated `MintV2InstructionAccounts`
 *              AND a real landed tx (discriminator + all 25 fixed accounts
 *              matched exactly):
 *                0 candyGuard · 1 candyMachineProgram · 2 candyMachine ·
 *                3 candyMachineAuthorityPda · 4 payer · 5 minter · 6 nftMint ·
 *                7 nftMintAuthority · 8 nftMetadata · 9 nftMasterEdition ·
 *                10 token · 11 tokenRecord · 12 collectionDelegateRecord ·
 *                13 collectionMint · 14 collectionMetadata ·
 *                15 collectionMasterEdition · 16 collectionUpdateAuthority ·
 *                17 tokenMetadataProgram · 18 splTokenProgram ·
 *                19 splAtaProgram · 20 systemProgram · 21 sysvarInstructions ·
 *                22 recentSlothashes · 23 authorizationRulesProgram ·
 *                24 authorizationRules · [25+ guard extras]
 *              We only need positions 0/1/2/3/13/16 — the rest the build
 *              step re-derives (defaults or fresh fetches), same as core.
 */

import { fetchTransaction, isValidSignature } from '../mint-analyzer/fetch-tx';
import { CORE_CANDY_GUARD_PROGRAM } from '../mint-analyzer/programs';
import { CANDY_GUARD_PROGRAM } from '../ingestion/mint-raw/launchpad-detector';
import bs58 from 'bs58';

export type CandyMintFamily = 'core' | 'legacy';

export interface DecodedCandyMint {
  signature: string;
  family: CandyMintFamily;
  candyGuard: string;
  candyMachineProgram: string;
  candyMachine: string;
  candyMachineAuthorityPda: string;
  collection: string;
  /** Legacy-only: required, non-derivable input to MintV2. Null for 'core'. */
  collectionUpdateAuthority: string | null;
  /** Group label the reference tx minted under, or null for root guards. */
  group: string | null;
}

export type DecodeResult =
  | { ok: true; decoded: DecodedCandyMint }
  | { ok: false; error: string };

/** Reads Anchor's `Option<T>` tag (1 byte: 0=None, 1=Some) + payload. */
function readOptionalString(data: Buffer, offset: number): { value: string | null; next: number } {
  if (offset >= data.length) return { value: null, next: offset };
  const tag = data.readUInt8(offset);
  if (tag !== 1) return { value: null, next: offset + 1 };
  const len = data.readUInt32LE(offset + 1);
  const start = offset + 5;
  const value = data.subarray(start, start + len).toString('utf8');
  return { value, next: start + len };
}

/** MintV1/MintV2 instruction data: discriminator(8) + mintArgs Vec<u8>(4+N) + group Option<String>. Identical shape in both families — verified against a real 'group: Some("pub")' legacy tx. */
function decodeGroup(dataB58: string): string | null {
  const data = Buffer.from(bs58.decode(dataB58));
  if (data.length < 12) return null;
  const mintArgsLen = data.readUInt32LE(8);
  const groupOffset = 12 + mintArgsLen;
  return readOptionalString(data, groupOffset).value;
}

export async function decodeCandyMintSignature(signature: string): Promise<DecodeResult> {
  if (!isValidSignature(signature)) return { ok: false, error: 'invalid_signature' };

  let tx;
  try {
    tx = await fetchTransaction(signature);
  } catch (err) {
    return { ok: false, error: `rpc_error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!tx) return { ok: false, error: 'signature_not_found' };
  if (tx.meta?.err) return { ok: false, error: 'reference_tx_failed_onchain' };

  // Versioned (v0) txs resolve address-lookup-table entries into
  // `meta.loadedAddresses` rather than inlining them into
  // `message.accountKeys` — on-chain account indices number the static
  // keys first, then ALT writable, then ALT readonly, in that order.
  // Concatenating all three lines up `outer.accounts[i]` with the right
  // pubkey regardless of legacy vs v0. (First surfaced by a real recent
  // mint using a lookup table — the naive `accountKeys`-only lookup
  // silently resolved to `undefined` past the static-key boundary.)
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];

  const outerCore = tx.transaction.message.instructions.find(
    (ix) => keys[ix.programIdIndex] === CORE_CANDY_GUARD_PROGRAM,
  );
  const outerLegacy = outerCore ? undefined : tx.transaction.message.instructions.find(
    (ix) => keys[ix.programIdIndex] === CANDY_GUARD_PROGRAM,
  );
  const family: CandyMintFamily | null = outerCore ? 'core' : outerLegacy ? 'legacy' : null;
  const outer = outerCore ?? outerLegacy;
  if (!family || !outer) return { ok: false, error: 'no_candy_guard_instruction_found' };

  const minAccounts = family === 'core' ? 13 : 25;
  if (outer.accounts.length < minAccounts) return { ok: false, error: 'unexpected_account_count' };

  const acct = (i: number) => keys[outer.accounts[i]];
  const decoded: DecodedCandyMint = family === 'core'
    ? {
        signature,
        family,
        candyGuard: acct(0),
        candyMachineProgram: acct(1),
        candyMachine: acct(2),
        candyMachineAuthorityPda: acct(3),
        collection: acct(8),
        collectionUpdateAuthority: null,
        group: decodeGroup(outer.data),
      }
    : {
        signature,
        family,
        candyGuard: acct(0),
        candyMachineProgram: acct(1),
        candyMachine: acct(2),
        candyMachineAuthorityPda: acct(3),
        collection: acct(13),
        collectionUpdateAuthority: acct(16),
        group: decodeGroup(outer.data),
      };

  const requiredFields: (keyof DecodedCandyMint)[] = family === 'core'
    ? ['candyGuard', 'candyMachineProgram', 'candyMachine', 'candyMachineAuthorityPda', 'collection']
    : ['candyGuard', 'candyMachineProgram', 'candyMachine', 'candyMachineAuthorityPda', 'collection', 'collectionUpdateAuthority'];
  if (requiredFields.some((f) => !decoded[f])) return { ok: false, error: 'account_resolution_failed' };
  return { ok: true, decoded };
}

/**
 * For the raw-address entry path (no reference signature): resolve family
 * from which program OWNS the candyGuard account on-chain. Both guard
 * programs allocate their CandyGuard accounts as owned PDAs of themselves,
 * so `owner` is authoritative — cheaper and more direct than instruction
 * sniffing a transaction we don't have.
 */
export async function detectFamilyFromGuardAddress(candyGuardAddr: string): Promise<CandyMintFamily | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  const url = apiKey ? `https://beta.helius-rpc.com/?api-key=${apiKey}` : 'https://api.mainnet-beta.solana.com';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [candyGuardAddr, { encoding: 'base64' }],
    }),
  });
  if (!res.ok) return null;
  const body = await res.json() as { result?: { value?: { owner?: string } | null } };
  const owner = body.result?.value?.owner;
  if (owner === CORE_CANDY_GUARD_PROGRAM) return 'core';
  if (owner === CANDY_GUARD_PROGRAM) return 'legacy';
  return null;
}
