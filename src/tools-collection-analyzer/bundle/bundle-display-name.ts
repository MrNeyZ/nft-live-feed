/**
 * Collection Analyzer - Stage 4 best-effort collection display name.
 *
 * Fallback order (never blocks/fails bundle creation - wrapped so any
 * unexpected input just falls through to the address):
 *   1. a trusted collection name already resolved elsewhere in scan state
 *      (accepted as a parameter for forward-compat; Stage 1/2 do not
 *      currently populate one, so this is normally absent today).
 *   2. a common name PREFIX shared across a reliable majority of the
 *      scan's own per-asset `name` fields (e.g. "Frogana #335" ->
 *      "Frogana") - derived entirely from already-fetched scan data, no
 *      new network call, no marketplace HTML scraping.
 *   3. the collection address itself.
 * Sanitized for filesystem use via the existing `sanitizeCollectionName`
 * (bounds length, strips unsafe characters) either way.
 */
import { sanitizeCollectionName } from './bundle-filenames';
import type { NormalizedAsset } from '../types';

/** Assets sampled for the common-prefix check - bounded so a huge
 *  collection doesn't cost more than a cheap array scan. */
const SAMPLE_SIZE = 200;
/** Fraction of sampled non-null names that must share the same stripped
 *  prefix before we trust it as the collection's real name. */
const CONSISTENCY_THRESHOLD = 0.6;

/** Strips a trailing "#123", "#0123", or bare number token (with any
 *  separating whitespace/punctuation) from an NFT name, e.g.
 *  "Frogana #335" -> "Frogana", "Okay Bear 4821" -> "Okay Bear". */
function stripTrailingSerial(name: string): string {
  return name.replace(/[\s#_-]*\d+\s*$/, '').trim();
}

function commonNamePrefix(assets: NormalizedAsset[]): string | null {
  const sample = assets.slice(0, SAMPLE_SIZE).map((a) => a.name).filter((n): n is string => !!n && n.trim().length > 0);
  if (sample.length === 0) return null;

  const counts = new Map<string, number>();
  for (const raw of sample) {
    const stripped = stripTrailingSerial(raw);
    if (stripped.length < 2) continue;
    counts.set(stripped, (counts.get(stripped) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) { best = name; bestCount = count; }
  }
  if (!best || bestCount / sample.length < CONSISTENCY_THRESHOLD) return null;
  return best;
}

export function deriveCollectionDisplayName(
  collectionAddress: string,
  assets: NormalizedAsset[],
  trustedCollectionName?: string | null,
): string {
  try {
    if (trustedCollectionName && trustedCollectionName.trim().length > 0) {
      return sanitizeCollectionName(trustedCollectionName);
    }
    const common = commonNamePrefix(assets);
    if (common) return sanitizeCollectionName(common);
    return sanitizeCollectionName(collectionAddress);
  } catch {
    return sanitizeCollectionName(collectionAddress);
  }
}
