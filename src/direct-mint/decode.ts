/**
 * CreateV2 tool — reference-signature decoder.
 *
 * Mirrors candy-mint/decode.ts's job for the OTHER mint shape: given a
 * landed mint tx signature with no Candy Machine/Guard involved (a bare
 * self-mint), resolve the minted asset's own on-chain fields so the
 * frontend can render the same launchpad-hero read Candy Mint gets from
 * inspecting a live machine — paste a signature, not five hand-typed
 * fields.
 *
 * Two detection paths, tried in order:
 *   Token Metadata (nft/pnft) — a fresh 1-of-1 SPL token shows up as a
 *     postTokenBalances entry with amount "1"/decimals 0.
 *   MPL Core (core) — no token account exists at all (Core assets aren't
 *     SPL mints), so instead we scan the tx's own instructions for an
 *     MPL Core CreateV1/CreateV2 (program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R
 *     94rH4PZNhX7d, discriminator byte 0 or 20) and read its first account
 *     (`asset`) — same account-order fact already relied on in
 *     mint-analyzer/analyze.ts's `inferMintPrimitive`.
 */

import bs58 from 'bs58';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? 'rpc_error');
  return json.result as T;
}

const MPL_CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

interface RawTokenBalance {
  mint: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}
interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}
interface RawTx {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
      instructions?: RawInstruction[];
    };
  };
  meta?: {
    postTokenBalances?: RawTokenBalance[];
    err?: unknown;
    innerInstructions?: Array<{ index: number; instructions: RawInstruction[] }>;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

/** Finds a raw MPL Core CreateV1/CreateV2's `asset` account (index 0 in
 *  both) by scanning outer + inner instructions — an asset created via a
 *  wrapper (e.g. a thin custom program) still shows up in innerInstructions. */
function findCoreAssetMint(tx: RawTx): string | null {
  const msg = tx.transaction?.message;
  if (!msg?.accountKeys || !msg.instructions) return null;
  const keys = [
    ...msg.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const all: RawInstruction[] = [
    ...msg.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== MPL_CORE_PROGRAM_ID) continue;
    let data: Buffer;
    try { data = Buffer.from(bs58.decode(ix.data ?? '')); } catch { continue; }
    if (data[0] !== 0 && data[0] !== 20) continue; // CreateV1 / CreateV2
    const assetIdx = ix.accounts[0];
    if (assetIdx == null) continue;
    const asset = keys[assetIdx];
    if (asset) return asset;
  }
  return null;
}

export interface DecodedDirectMint {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  royaltyBp: number;
  standard: 'nft' | 'pnft' | 'core';
  collection: string | null;
}

export type DecodeDirectMintResult =
  | { ok: true; decoded: DecodedDirectMint }
  | { ok: false; error: string };

interface DasAsset {
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string; description?: string; token_standard?: string };
    links?: { image?: string };
  };
  royalty?: { basis_points?: number };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
}

export async function decodeDirectMintSignature(sig: string): Promise<DecodeDirectMintResult> {
  let tx: RawTx;
  try {
    tx = await rpc<RawTx>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  } catch (err) {
    return { ok: false, error: `signature_lookup_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!tx) return { ok: false, error: 'signature_not_found' };
  if (tx.meta?.err) return { ok: false, error: 'reference_tx_failed_onchain' };

  // A fresh Token Metadata NFT mint's own token account shows up as a
  // postTokenBalances entry with amount "1" / decimals 0 — the one balance a
  // plain SOL/SPL payment leg never produces. First match wins (a bare
  // create+mint has exactly one such entry; see build.ts's header for the
  // shape this targets — no candy machine, no batch). MPL Core assets have
  // no token account at all, so fall back to scanning for a raw Core Create.
  const post = tx.meta?.postTokenBalances ?? [];
  const nftBalance = post.find((b) => b.uiTokenAmount?.decimals === 0 && b.uiTokenAmount?.amount === '1');
  const coreAssetMint = nftBalance ? null : findCoreAssetMint(tx);
  const mint = nftBalance?.mint ?? coreAssetMint;
  if (!mint) return { ok: false, error: 'no_nft_mint_found_in_transaction' };

  let asset: DasAsset;
  try {
    asset = await rpc<DasAsset>('getAsset', { id: mint });
  } catch (err) {
    return { ok: false, error: `asset_lookup_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const uri = asset.content?.json_uri ?? '';
  if (!uri) return { ok: false, error: 'asset_has_no_metadata_uri' };

  const collectionGroup = asset.grouping?.find((g) => g.group_key === 'collection');

  // DAS's own indexed metadata already carries name/symbol/description from
  // the off-chain JSON for a synced asset — fetching the URI ourselves too
  // would just duplicate that round trip for a value we already have.
  return {
    ok: true,
    decoded: {
      mint,
      name: asset.content?.metadata?.name ?? 'Untitled',
      symbol: asset.content?.metadata?.symbol ?? '',
      uri,
      image: asset.content?.links?.image ?? null,
      description: asset.content?.metadata?.description ?? null,
      royaltyBp: asset.royalty?.basis_points ?? 0,
      standard: coreAssetMint
        ? 'core'
        : asset.content?.metadata?.token_standard === 'ProgrammableNonFungible' ? 'pnft' : 'nft',
      collection: collectionGroup?.group_value ?? null,
    },
  };
}
