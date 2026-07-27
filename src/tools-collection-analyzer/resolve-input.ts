/**
 * Collection Analyzer — shared input resolution.
 *
 * Extracted from Stage 1's route handler (behavior-preserving — same status
 * codes / error strings / warning text) so Stage 2's full-scan route can
 * reuse the identical address/mint/marketplace-URL resolution logic instead
 * of duplicating it (CLAUDE.md "one source of truth per concept").
 */
import { parseCollectionAnalyzerInput } from './parse-input';
import { isValidCollectionAddress } from '../tools-holders/fetch-assets';
import { resolveSlugToCollection, resolveMintToCollectionAddress } from '../tools-holders/resolve-slug';
import type { CollectionAnalyzerInputKind } from './types';

export type ResolveInputResult =
  | { ok: true; inputKind: CollectionAnalyzerInputKind; collectionAddress: string; extraWarnings: string[] }
  | { ok: false; status: number; error: string };

export async function resolveInputToCollectionAddress(input: string): Promise<ResolveInputResult> {
  const parsed = parseCollectionAnalyzerInput(input);
  if (parsed.kind === 'invalid') {
    return { ok: false, status: 400, error: 'invalid_input' };
  }

  const extraWarnings: string[] = [];

  if (parsed.kind === 'address') {
    if (!isValidCollectionAddress(parsed.address)) {
      return { ok: false, status: 400, error: 'invalid_address' };
    }
    // Address-shaped input could be an individual NFT mint instead of the
    // collection's own address — resolve via DAS first. Falls back to
    // treating it as the collection address itself when DAS finds no
    // distinct parent collection (same contract as the Holder Count tool).
    let mintCollection: string | null = null;
    try {
      mintCollection = await resolveMintToCollectionAddress(parsed.address);
    } catch (err) {
      console.error('[tools/collection-analyzer] mint resolve error', err);
    }
    if (mintCollection) {
      extraWarnings.push(`Address ${parsed.address} is an individual NFT — resolved to its collection ${mintCollection}.`);
      return { ok: true, inputKind: 'mint', collectionAddress: mintCollection, extraWarnings };
    }
    return { ok: true, inputKind: 'collection', collectionAddress: parsed.address, extraWarnings };
  }

  // tensor_url | magiceden_url — both resolve through the same
  // marketplace-agnostic slug sampler.
  let resolution;
  try {
    resolution = await resolveSlugToCollection(parsed.slug);
  } catch (err) {
    console.error('[tools/collection-analyzer] slug resolve error', err);
    return { ok: false, status: 502, error: 'rpc_error' };
  }
  if (!resolution.collectionAddress) {
    return { ok: false, status: 404, error: `slug_unresolved:${resolution.error ?? 'unknown'}` };
  }
  extraWarnings.push(`Slug "${parsed.slug}" resolved to collection ${resolution.collectionAddress} via a sample Magic Eden listing — verify the address if it looks wrong.`);
  return { ok: true, inputKind: parsed.kind, collectionAddress: resolution.collectionAddress, extraWarnings };
}
