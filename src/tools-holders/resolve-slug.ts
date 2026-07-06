/**
 * Holder Count Tool — slug → on-chain collection address resolver.
 *
 * Marketplace slugs (Magic Eden / Tensor "symbol") are NOT on-chain collection
 * addresses, so DAS getAssetsByGroup can't take them directly. We resolve a
 * slug to a SAMPLE mint via Magic Eden's public listings/activities endpoints,
 * then read that mint's verified collection group from Helius DAS getAsset.
 *
 * Important: the marketplace is used ONLY to map slug → a representative mint.
 * The holder COUNT still comes exclusively from on-chain DAS ownership — no
 * marketplace holder stat is ever trusted.
 */
import { getAsset } from '../enrichment/helius-das';

/** ME collection symbols are lowercase alnum + underscore/hyphen. Keep the
 *  validator permissive but reject paths/spaces that could break the URL. */
const SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/;

export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug.trim());
}

const ME_BASE = 'https://api-mainnet.magiceden.dev/v2/collections';

/** Pull one representative mint for a slug from ME (public, no key). Tries an
 *  active listing first, then a recent buyNow activity. Returns null when the
 *  slug is unknown / has no on-chain activity to sample. Never throws. */
async function sampleMintForSlug(slug: string): Promise<string | null> {
  const s = encodeURIComponent(slug);
  const urls = [
    `${ME_BASE}/${s}/listings?offset=0&limit=1`,
    `${ME_BASE}/${s}/activities?type=buyNow&offset=0&limit=1`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const json = await res.json() as Array<{ tokenMint?: string }>;
      const mint = Array.isArray(json) ? json[0]?.tokenMint : undefined;
      if (typeof mint === 'string' && mint.length > 0) return mint;
    } catch { /* try next source */ }
  }
  return null;
}

export interface SlugResolution {
  /** Resolved on-chain collection address, or null when unresolvable. */
  collectionAddress: string | null;
  /** The mint we sampled to resolve the group (diagnostic / warning context). */
  sampleMint:        string | null;
  /** Machine-readable failure reason when collectionAddress is null. */
  error:             'slug_not_found' | 'no_onchain_collection' | 'resolver_error' | null;
}

/**
 * slug → on-chain collection address. Never throws.
 *   - slug_not_found        : ME returned no listing/activity to sample.
 *   - no_onchain_collection : sampled mint has no verified DAS collection group
 *                             (e.g. a collection grouped only by creator/UA —
 *                             can't be scanned by getAssetsByGroup).
 *   - resolver_error        : DAS getAsset transport error.
 */
export async function resolveSlugToCollection(slug: string): Promise<SlugResolution> {
  const sampleMint = await sampleMintForSlug(slug);
  if (!sampleMint) return { collectionAddress: null, sampleMint: null, error: 'slug_not_found' };

  let collectionAddress: string | null = null;
  try {
    const meta = await getAsset(sampleMint);
    collectionAddress = meta.collectionAddress;
  } catch {
    return { collectionAddress: null, sampleMint, error: 'resolver_error' };
  }
  if (!collectionAddress) return { collectionAddress: null, sampleMint, error: 'no_onchain_collection' };
  return { collectionAddress, sampleMint, error: null };
}

/**
 * Address-shaped input can be EITHER a collection's own on-chain address
 * (the common case — used directly by getAssetsByGroup) OR an individual
 * NFT mint belonging to that collection (a user pasting one item instead of
 * the collection). Distinguish by asking DAS what the address itself groups
 * under: a real collection root has no `collection` grouping (it IS the
 * group value), while a member NFT's grouping points at a DIFFERENT
 * address. Returns null when the input should be treated as-is (either it's
 * genuinely the collection address, or DAS doesn't recognize it as an asset
 * at all — same fallback `resolveSlugToCollection`'s sample-mint step
 * already relies on). Never throws.
 */
export async function resolveMintToCollectionAddress(address: string): Promise<string | null> {
  try {
    const meta = await getAsset(address);
    if (meta.collectionAddress && meta.collectionAddress !== address) {
      return meta.collectionAddress;
    }
    return null;
  } catch {
    return null;
  }
}
