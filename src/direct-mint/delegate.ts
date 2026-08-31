/**
 * MPL Core collection delegate tool — unsigned tx builder for the one-time
 * on-chain step create-v2's Core path (build.ts's header comment) assumes:
 * granting a second wallet mint rights into an existing Core collection by
 * adding it to that collection's `UpdateDelegate` plugin's
 * `additionalDelegates`. Only the collection's own `updateAuthority` can do
 * this (checked here before building anything) — once landed, the granted
 * wallet passes buildCore's `checkCollectionAuthority` gate in build.ts and
 * can mint straight into the collection without the deploy wallet again.
 *
 * No fresh keypair involved (unlike the mint builders) — the connecting
 * wallet is the only signer, so there's nothing to partial-sign server-side.
 */

import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, publicKey as umiPublicKey, signerIdentity } from '@metaplex-foundation/umi';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import {
  mplCore, safeFetchCollectionV1, addCollectionPluginV1, updateCollectionPluginV1,
  type PluginAuthority,
} from '@metaplex-foundation/mpl-core';

/** The address that actually controls a plugin: its own `Address` override
 *  if pinned, else the collection's updateAuthority. See
 *  buildAddCollectionDelegateTx's header for why this can't always be
 *  `updateAuthority` alone. */
function effectivePluginManager(pluginAuth: PluginAuthority | undefined, updateAuthority: string): string {
  return pluginAuth?.type === 'Address' && pluginAuth.address ? pluginAuth.address.toString() : updateAuthority;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export interface CollectionDelegateInfo {
  updateAuthority: string;
  additionalDelegates: string[];
  /** The address that can actually grant new delegates — usually
   *  `updateAuthority`, but a plugin-level `Address` override (see
   *  buildAddCollectionDelegateTx's comment) can pin it to something else
   *  entirely, e.g. the launchpad's own PDA. UI should compare the
   *  connecting wallet against THIS, not `updateAuthority`. */
  managingAuthority: string;
}

export type CollectionDelegateInfoResult =
  | { ok: true; info: CollectionDelegateInfo }
  | { ok: false; error: string };

/** Read-only: current updateAuthority + delegate list, for the UI to show
 *  before building anything (and to let the frontend self-check "am I the
 *  authority" without a failed build round-trip). */
export async function fetchCollectionDelegateInfo(collection: string): Promise<CollectionDelegateInfoResult> {
  const umi = createUmi(rpcUrl()).use(mplCore());
  let col;
  try {
    col = await safeFetchCollectionV1(umi, umiPublicKey(collection));
  } catch (err) {
    return { ok: false, error: `rpc_error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!col) return { ok: false, error: 'collection_not_found' };
  const updateAuthority = col.updateAuthority.toString();
  const managingAuthority = effectivePluginManager(col.updateDelegate?.authority, updateAuthority);
  return {
    ok: true,
    info: {
      updateAuthority,
      additionalDelegates: (col.updateDelegate?.additionalDelegates ?? []).map((d) => d.toString()),
      managingAuthority,
    },
  };
}

export interface BuildAddDelegateInput {
  wallet: string;
  collection: string;
  delegate: string;
}

export type BuildAddDelegateResult =
  | {
      ok: true;
      transactionBase64: string;
      blockhash: string;
      lastValidBlockHeight: number;
      feePayer: string;
      requiresSignatureFrom: string;
    }
  | { ok: false; error: string };

export async function buildAddCollectionDelegateTx(input: BuildAddDelegateInput): Promise<BuildAddDelegateResult> {
  if (input.wallet === input.delegate) return { ok: false, error: 'delegate_is_self' };

  const walletSigner = createNoopSigner(umiPublicKey(input.wallet));
  const umi = createUmi(rpcUrl()).use(mplCore()).use(signerIdentity(walletSigner));

  let col;
  try {
    col = await safeFetchCollectionV1(umi, umiPublicKey(input.collection));
  } catch (err) {
    return { ok: false, error: `rpc_error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!col) return { ok: false, error: 'collection_not_found' };

  // The right authority to check is NOT always the collection's overall
  // updateAuthority: a plugin's OWN `authority` field can be pinned to a
  // fixed `Address` independent of it, and once pinned only that address
  // can ever modify the plugin — the collection's updateAuthority has no
  // override. Confirmed live against a real LMNFT-deployed Core collection
  // (FROG, 5AZDDc…): its updateDelegate.authority was `{ type: 'Address',
  // address: <LMNFT's own PDA> }`, not `{ type: 'UpdateAuthority' }` — the
  // collection "owner" wallet building against the naive
  // `col.updateAuthority === wallet` check got a clean-looking unsigned tx
  // that reverted on-chain with `InvalidAuthority` (code 9) every time.
  // Some LMNFT collections retain plugin-level control like this even after
  // handing off the collection's nominal updateAuthority — same shape as
  // the MMM non-default-cosigner dead end elsewhere in this codebase.
  const updateAuthority = col.updateAuthority.toString();
  const manager = effectivePluginManager(col.updateDelegate?.authority, updateAuthority);
  if (manager !== input.wallet) {
    return {
      ok: false,
      error: manager === updateAuthority ? 'not_collection_authority' : `update_delegate_plugin_locked: ${manager}`,
    };
  }

  const existing = (col.updateDelegate?.additionalDelegates ?? []).map((d) => d.toString());
  if (existing.includes(input.delegate)) return { ok: false, error: 'already_a_delegate' };
  const additionalDelegates = [...existing, input.delegate].map((d) => umiPublicKey(d));

  // Plugin already present on this collection → update it (append); never
  // added before → add it fresh. Sending the wrong one of these two fails
  // on-chain ("plugin already exists" / "plugin not found"), so the branch
  // has to be exact, not a guess.
  const builder = col.updateDelegate
    ? updateCollectionPluginV1(umi, {
        collection: umiPublicKey(input.collection),
        authority: walletSigner,
        plugin: { __kind: 'UpdateDelegate', fields: [{ additionalDelegates }] },
      })
    : addCollectionPluginV1(umi, {
        collection: umiPublicKey(input.collection),
        authority: walletSigner,
        plugin: { __kind: 'UpdateDelegate', fields: [{ additionalDelegates }] },
      });

  const conn = new Connection(rpcUrl(), 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)),
  );
  tx.feePayer = new PublicKey(input.wallet);
  tx.recentBlockhash = blockhash;

  return {
    ok: true,
    transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    feePayer: input.wallet,
    requiresSignatureFrom: input.wallet,
  };
}
