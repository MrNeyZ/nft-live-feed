/**
 * Mint Analyzer — optional live collection-authority check.
 *
 * A raw MPL Core Create/CreateV2 (no Candy Guard, no Candy Machine, no
 * wrapper program) is never actually "public": the on-chain program only
 * lets the collection's `updateAuthority`, or an address listed in its
 * `UpdateDelegate` plugin's `additionalDelegates`, create assets into it.
 * `analyze()` itself stays pure/offline (see its header comment + the
 * fixture-test requirement) — this is a separate, best-effort live read the
 * router opts into only for that one narrow case, never touching the verdict.
 */
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { mplCore, safeFetchCollectionV1 } from '@metaplex-foundation/mpl-core';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

export interface CollectionAuthorityCheck {
  updateAuthority: string;
  /** addresses granted create/update rights via the UpdateDelegate plugin */
  additionalDelegates: string[];
}

/** Returns null on any RPC failure or missing collection — best-effort only. */
export async function checkCollectionAuthority(collectionAddr: string): Promise<CollectionAuthorityCheck | null> {
  try {
    const umi = createUmi(rpcUrl()).use(mplCore());
    const collection = await safeFetchCollectionV1(umi, umiPublicKey(collectionAddr));
    if (!collection) return null;
    return {
      updateAuthority: collection.updateAuthority.toString(),
      additionalDelegates: (collection.updateDelegate?.additionalDelegates ?? []).map((d) => d.toString()),
    };
  } catch {
    return null;
  }
}
