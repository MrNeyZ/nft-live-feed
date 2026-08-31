/**
 * CreateV2 tool — unsigned mint-transaction builder.
 *
 * Companion to Candy Mint (../candy-mint/build.ts), same signing model, but
 * for the OTHER mint shape: a direct self-authored create with no Candy
 * Machine / Candy Guard at all — the creator's own wallet signs their own
 * Create(+Mint+Verify), exactly like a solo artist minting into their own
 * collection. Candy Mint's builder assumes a candy machine account exists
 * to inspect; there's nothing to inspect here — the caller supplies the
 * NFT's own fields directly (name/uri/royalty/standard/optional collection).
 *
 * Three standards, dispatched off `standard`:
 *   'nft' / 'pnft' — Token Metadata createV1+mintV1 (`buildTokenMetadata`).
 *   'core'         — MPL Core createV2 (`buildCore`). No symbol field (Core
 *                    has none), royalty goes through a `Royalties` plugin
 *                    instead of `sellerFeeBasisPoints`, and there's no
 *                    separate verify step — collection membership IS the
 *                    Create instruction's `collection` account, checked by
 *                    the Core program itself at the same instant.
 *
 * Collection field is real-membership-or-nothing in both cases, just
 * enforced differently:
 *   Token Metadata groups strictly by the VERIFIED flag, and only the
 *   collection's own update authority can sign that (a separate
 *   `verifyCollectionV1`, chained onto the same tx here) — so this tool
 *   checks the collection's on-chain update authority against the
 *   connecting wallet FIRST and refuses (`not_collection_authority`) rather
 *   than silently minting an unverified tag that looks like membership
 *   without being it.
 *   MPL Core enforces membership on-chain at Create time: the `authority`
 *   signer must equal the collection's `updateAuthority` OR be listed in
 *   its `UpdateDelegate` plugin's `additionalDelegates` (see
 *   ../mint-analyzer/collection-authority.ts, reused here) — so a deploy
 *   wallet can approve a second wallet as delegate once, on-chain, and this
 *   tool will then let that second wallet mint straight into the
 *   collection. Same `not_collection_authority` check, just OR'd with the
 *   delegate list instead of an exact-match-only comparison.
 *
 * Signing model (same as candy-mint/build.ts): the new mint/asset is a
 * fresh, throwaway keypair generated server-side and partial-signed here;
 * the connecting wallet is a noop signer, Phantom supplies the real
 * signature client-side.
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createNoopSigner, generateSigner, publicKey as umiPublicKey, signerIdentity, percentAmount, some, none,
  type KeypairSigner,
} from '@metaplex-foundation/umi';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import {
  mplTokenMetadata, createNft, createProgrammableNft, verifyCollectionV1,
  fetchMetadata, findMetadataPda, type Collection,
} from '@metaplex-foundation/mpl-token-metadata';
import { mplCore, create as createCoreAsset } from '@metaplex-foundation/mpl-core';
import { checkCollectionAuthority } from '../mint-analyzer/collection-authority';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export type TokenStandardChoice = 'nft' | 'pnft' | 'core';

export interface BuildDirectMintInput {
  wallet: string;
  name: string;
  symbol: string;
  uri: string;
  royaltyBp: number;          // 0-10000
  standard: TokenStandardChoice;
  /** Only mintable verified — the connecting wallet must be this
   *  collection's own on-chain update authority (checked in buildDirectMintTx
   *  before anything is built). Null mints standalone, no collection. */
  collection: string | null;
}

export type BuildDirectMintResult =
  | {
      ok: true;
      transactionBase64: string;
      blockhash: string;
      lastValidBlockHeight: number;
      feePayer: string;
      requiresSignatureFrom: string;
      mint: string;
    }
  | { ok: false; error: string };

/** Shared tail: compute-budget + builder instructions, partial-signed by
 *  the fresh mint/asset keypair, base64'd for the client to co-sign. Same
 *  convention as candy-mint/build.ts's finalizeTx (priority fee — a
 *  fresh-mint tx competes for block space like any other mint attempt). */
function finalizeTx(
  web3Ixs: TransactionInstruction[],
  wallet: string,
  mintSigner: KeypairSigner,
  blockhash: string,
  lastValidBlockHeight: number,
): BuildDirectMintResult {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...web3Ixs,
  );
  tx.feePayer = new PublicKey(wallet);
  tx.recentBlockhash = blockhash;
  tx.partialSign(Keypair.fromSecretKey(mintSigner.secretKey));

  return {
    ok: true,
    transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    feePayer: wallet,
    requiresSignatureFrom: wallet,
    mint: mintSigner.publicKey.toString(),
  };
}

async function buildTokenMetadata(input: BuildDirectMintInput): Promise<BuildDirectMintResult> {
  const walletSigner = createNoopSigner(umiPublicKey(input.wallet));
  const umi = createUmi(rpcUrl()).use(mplTokenMetadata()).use(signerIdentity(walletSigner));
  const mintSigner = generateSigner(umi);

  // Gate BEFORE building anything: the collection field only makes sense
  // (see header comment) when the connecting wallet actually holds this
  // collection's update authority — checked against the collection's own
  // live Metadata account, not trusted from the caller.
  let collectionPk: ReturnType<typeof umiPublicKey> | null = null;
  if (input.collection) {
    let collectionMeta;
    try {
      collectionMeta = await fetchMetadata(umi, findMetadataPda(umi, { mint: umiPublicKey(input.collection) }));
    } catch {
      return { ok: false, error: 'collection_metadata_not_found' };
    }
    if (collectionMeta.updateAuthority.toString() !== input.wallet) {
      return { ok: false, error: 'not_collection_authority' };
    }
    collectionPk = umiPublicKey(input.collection);
  }

  const shared = {
    mint: mintSigner,
    authority: walletSigner,
    payer: walletSigner,
    updateAuthority: walletSigner,
    tokenOwner: umiPublicKey(input.wallet),
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    uri: input.uri.trim(),
    sellerFeeBasisPoints: percentAmount(input.royaltyBp / 100, 2),
    creators: some([{ address: umiPublicKey(input.wallet), verified: true, share: 100 }]),
    // Always created unverified — verification is only ever a SEPARATE
    // on-chain instruction (verifyCollectionV1, appended below), confirmed
    // against a real landed self-mint tx (Create → Mint → Verify as three
    // distinct instructions, never a `verified: true` baked into Create).
    collection: collectionPk ? some<Collection>({ verified: false, key: collectionPk }) : none<Collection>(),
  };

  let builder = input.standard === 'pnft'
    ? createProgrammableNft(umi, shared)
    : createNft(umi, shared);

  if (collectionPk) {
    builder = builder.add(verifyCollectionV1(umi, {
      authority: walletSigner,
      metadata: findMetadataPda(umi, { mint: mintSigner.publicKey }),
      collectionMint: collectionPk,
    }));
  }

  const conn = new Connection(rpcUrl(), 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  return finalizeTx(
    builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)),
    input.wallet,
    mintSigner,
    blockhash,
    lastValidBlockHeight,
  );
}

async function buildCore(input: BuildDirectMintInput): Promise<BuildDirectMintResult> {
  const walletSigner = createNoopSigner(umiPublicKey(input.wallet));
  const umi = createUmi(rpcUrl()).use(mplCore()).use(signerIdentity(walletSigner));
  const assetSigner = generateSigner(umi);

  // Same up-front gate as the Token Metadata path, but the Core program
  // itself accepts EITHER the collection's exact updateAuthority OR an
  // address in its UpdateDelegate.additionalDelegates — see header comment.
  let collectionPk: ReturnType<typeof umiPublicKey> | null = null;
  if (input.collection) {
    const auth = await checkCollectionAuthority(input.collection);
    if (!auth) return { ok: false, error: 'collection_metadata_not_found' };
    if (auth.updateAuthority !== input.wallet && !auth.additionalDelegates.includes(input.wallet)) {
      return { ok: false, error: 'not_collection_authority' };
    }
    collectionPk = umiPublicKey(input.collection);
  }

  // Core assets have no symbol field and no separate verify instruction —
  // collection membership is the `collection` account on this single Create,
  // checked on-chain by the program at the same instant it lands.
  const builder = createCoreAsset(umi, {
    asset: assetSigner,
    name: input.name.trim(),
    uri: input.uri.trim(),
    payer: walletSigner,
    authority: walletSigner,
    owner: umiPublicKey(input.wallet),
    updateAuthority: umiPublicKey(input.wallet),
    collection: collectionPk ? { publicKey: collectionPk, oracles: [], lifecycleHooks: [] } : undefined,
    plugins: input.royaltyBp > 0
      ? [{
          type: 'Royalties',
          basisPoints: input.royaltyBp,
          creators: [{ address: umiPublicKey(input.wallet), percentage: 100 }],
          ruleSet: { type: 'None' },
        }]
      : undefined,
  });

  const conn = new Connection(rpcUrl(), 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  return finalizeTx(
    builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)),
    input.wallet,
    assetSigner,
    blockhash,
    lastValidBlockHeight,
  );
}

export async function buildDirectMintTx(input: BuildDirectMintInput): Promise<BuildDirectMintResult> {
  if (!input.name.trim()) return { ok: false, error: 'missing_name' };
  if (!input.uri.trim()) return { ok: false, error: 'missing_uri' };
  if (!Number.isFinite(input.royaltyBp) || input.royaltyBp < 0 || input.royaltyBp > 10000) {
    return { ok: false, error: 'invalid_royaltyBp' };
  }

  return input.standard === 'core' ? buildCore(input) : buildTokenMetadata(input);
}
