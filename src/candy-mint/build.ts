/**
 * Candy Mint tool — unsigned mint-transaction builder.
 *
 * Two families, dispatched by `family` (see decode.ts's header comment for
 * the account-order verification behind both):
 *   'core'   — Core Candy Guard MintV1 -> Core Candy Machine MintAsset ->
 *              MPL Core Create.
 *   'legacy' — Token Metadata Candy Guard MintV2 -> Candy Machine MintV2 ->
 *              Token Metadata mint/master-edition. Verified against a real
 *              landed tx: instruction-data serializer produced a
 *              byte-identical discriminator to the reference tx's on-chain
 *              data (including a real `group: Some("pub")` payload), so
 *              this is not a guess at the wire format either.
 *
 * Signing model (same as tools-dotland.ts / the DotLand mint tool, and the
 * 'core' path above): the new asset/nftMint is a fresh, throwaway keypair
 * generated server-side and partial-signed here — its private key has no
 * value beyond this one transaction, exactly like every normal
 * candy-machine mint generates a fresh mint keypair client-side. The
 * connecting wallet is a noop signer; Phantom supplies the real signature
 * client-side.
 */

import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createNoopSigner, generateSigner, publicKey as umiPublicKey, signerIdentity, some, none,
} from '@metaplex-foundation/umi';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import {
  mplCandyMachine as mplCoreCandyMachine, mintV1,
  fetchCandyMachine as fetchCoreCandyMachine,
  safeFetchCandyGuard as safeFetchCoreCandyGuard,
} from '@metaplex-foundation/mpl-core-candy-machine';
import {
  mplCandyMachine as mplLegacyCandyMachine, mintV2,
  fetchCandyMachine as fetchLegacyCandyMachine,
  safeFetchCandyGuard as safeFetchLegacyCandyGuard,
} from '@metaplex-foundation/mpl-candy-machine';
import { fetchMetadata, findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';
import { inspectCandyMachine } from './guard-config';
import type { CandyMintFamily } from './decode';

// Every guard's *MintArgs type is `Omit<FullArgs, 'lamports' | 'amount' |
// 'limit'>` — i.e. always a strict subset of the guard's own on-chain
// settings (verified against the SDK's generated .d.ts for every guard in
// SUPPORTED_GUARDS: solPayment needs `destination`, mintLimit/allocation
// need `id`, solFixedFee/freeze* need `destination`, etc). The Umi builder
// never reads that on-chain state on its own to fill mintArgs — passing
// `mintArgs: {}` silently omits the guard's remaining account (wrong
// `destination`, missing counter PDA, ...), which the Candy Guard program
// then treats as a bot-mint attempt and taxes instead of failing loudly.
// So: forward each enabled guard's already-fetched on-chain value verbatim
// — a superset of what any of them individually require, all fields sourced
// from the chain itself, nothing guessed or hand-picked per guard name.
type GuardOption = { __option: 'Some' | 'None'; value?: unknown };
type GuardSetLike = Record<string, GuardOption>;
function resolveMintArgs(guards: GuardSetLike): Record<string, unknown> {
  const mintArgs: Record<string, unknown> = {};
  for (const [name, wrapped] of Object.entries(guards)) {
    if (wrapped?.__option === 'Some' && wrapped.value !== undefined) mintArgs[name] = wrapped.value;
  }
  return mintArgs;
}

function activeGuardSet<G extends { guards: GuardSetLike; groups: { label: string; guards: GuardSetLike }[] }>(
  candyGuard: G,
  group: string | null,
): GuardSetLike {
  if (group == null) return candyGuard.guards;
  return candyGuard.groups.find((g) => g.label === group)?.guards ?? candyGuard.guards;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export interface BuildCandyMintInput {
  family: CandyMintFamily;
  candyMachine: string;
  candyGuard: string;
  collection: string;
  /** Legacy only. If omitted, fetched live from the collection's Metadata PDA. */
  collectionUpdateAuthority?: string | null;
  group: string | null;
  wallet: string;
}

export type BuildCandyMintResult =
  | {
      ok: true;
      transactionBase64: string;
      blockhash: string;
      lastValidBlockHeight: number;
      feePayer: string;
      requiresSignatureFrom: string;
      asset: string;
      group: string | null;
    }
  | { ok: false; error: string };

async function buildCore(input: BuildCandyMintInput): Promise<BuildCandyMintResult> {
  const walletSigner = createNoopSigner(umiPublicKey(input.wallet));
  // Umi's default context identity is a NullSigner that throws the moment
  // anything reads it — some builder-composed sub-instructions reach for
  // `context.identity`/`context.payer` internally rather than the explicit
  // `payer`/`minter` args below (confirmed the hard way on the legacy path:
  // mintV2 pulled in a NullSigner and threw "Trying to use a NullSigner").
  // Wiring our own noop wallet signer as the context identity up front
  // makes both paths robust to that regardless of which internal helper
  // reaches for it.
  const umi = createUmi(rpcUrl()).use(mplCoreCandyMachine()).use(signerIdentity(walletSigner));
  const assetSigner = generateSigner(umi);

  const candyMachine = await fetchCoreCandyMachine(umi, umiPublicKey(input.candyMachine));
  const candyGuard = await safeFetchCoreCandyGuard(umi, umiPublicKey(input.candyGuard));
  if (!candyGuard) return { ok: false, error: 'candy_guard_not_found' };

  const builder = mintV1(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard: candyGuard.publicKey,
    collection: umiPublicKey(input.collection),
    asset: assetSigner,
    payer: walletSigner,
    minter: walletSigner,
    group: input.group ? some(input.group) : none(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- built dynamically from whatever guards are enabled on-chain; see resolveMintArgs
    mintArgs: resolveMintArgs(activeGuardSet(candyGuard, input.group)) as any,
  });

  return finalizeTx(builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)), input, assetSigner);
}

async function buildLegacy(input: BuildCandyMintInput): Promise<BuildCandyMintResult> {
  const walletSigner = createNoopSigner(umiPublicKey(input.wallet));
  const umi = createUmi(rpcUrl()).use(mplLegacyCandyMachine()).use(signerIdentity(walletSigner));
  const assetSigner = generateSigner(umi);

  const candyMachine = await fetchLegacyCandyMachine(umi, umiPublicKey(input.candyMachine));
  const candyGuard = await safeFetchLegacyCandyGuard(umi, umiPublicKey(input.candyGuard));
  if (!candyGuard) return { ok: false, error: 'candy_guard_not_found' };

  // collectionUpdateAuthority is a required MintV2 account with no on-chain
  // default the SDK can derive for us — pull it from the reference tx when
  // we have it, otherwise read it live off the collection's own Metadata
  // account (the field the mint instruction itself needs is exactly this).
  let collectionUpdateAuthority = input.collectionUpdateAuthority ?? null;
  if (!collectionUpdateAuthority) {
    try {
      const collectionMeta = await fetchMetadata(umi, findMetadataPda(umi, { mint: umiPublicKey(input.collection) }));
      collectionUpdateAuthority = collectionMeta.updateAuthority.toString();
    } catch {
      return { ok: false, error: 'collection_update_authority_unresolved' };
    }
  }

  const builder = mintV2(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard: candyGuard.publicKey,
    nftMint: assetSigner,
    collectionMint: umiPublicKey(input.collection),
    collectionUpdateAuthority: umiPublicKey(collectionUpdateAuthority),
    payer: walletSigner,
    minter: walletSigner,
    group: input.group ? some(input.group) : none(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- built dynamically from whatever guards are enabled on-chain; see resolveMintArgs
    mintArgs: resolveMintArgs(activeGuardSet(candyGuard, input.group)) as any,
  });

  return finalizeTx(builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)), input, assetSigner);
}

async function finalizeTx(
  web3Ixs: ReturnType<typeof toWeb3JsInstruction>[],
  input: BuildCandyMintInput,
  assetSigner: ReturnType<typeof generateSigner>,
): Promise<BuildCandyMintResult> {
  const conn = new Connection(rpcUrl(), 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  const walletPk = new PublicKey(input.wallet);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...web3Ixs,
  );
  tx.feePayer = walletPk;
  tx.recentBlockhash = blockhash;
  tx.partialSign(Keypair.fromSecretKey(assetSigner.secretKey));

  const transactionBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  return {
    ok: true,
    transactionBase64,
    blockhash,
    lastValidBlockHeight,
    feePayer: input.wallet,
    requiresSignatureFrom: input.wallet,
    asset: assetSigner.publicKey.toString(),
    group: input.group,
  };
}

export async function buildCandyMintTx(input: BuildCandyMintInput): Promise<BuildCandyMintResult> {
  const inspection = await inspectCandyMachine(input.family, input.candyMachine, input.candyGuard);
  if (!inspection.alive) return { ok: false, error: 'candy_machine_closed' };
  const groupSummary = inspection.groups.find((g) => g.label === input.group);
  if (!groupSummary) return { ok: false, error: 'group_not_found' };
  if (!groupSummary.supported) {
    return { ok: false, error: `unsupported_guards: ${groupSummary.unsupportedGuards.join(', ')}` };
  }

  return input.family === 'core' ? buildCore(input) : buildLegacy(input);
}
