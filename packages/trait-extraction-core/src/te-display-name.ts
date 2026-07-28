/**
 * Trait Extraction Core - best-effort collection display name.
 *
 * Same logic as the app's bundle/bundle-display-name.ts (Stage 4), copied
 * here as its own tiny, dependency-free copy so the orchestrator doesn't
 * reach back into the app's bundle feature. Fallback order (never
 * blocks/fails extraction - wrapped so any unexpected input just falls
 * through to the address):
 *   1. a trusted collection name already resolved elsewhere (accepted as a
 *      parameter for forward-compat).
 *   2. a common name PREFIX shared across a reliable majority of the
 *      collection's own per-asset `name` fields (e.g. "Frogana #335" ->
 *      "Frogana") - derived entirely from already-fetched asset data.
 *   3. the collection address itself.
 * Sanitized for filesystem use either way.
 */
import type { NormalizedAsset } from './asset-types';

const SAMPLE_SIZE = 200;
const CONSISTENCY_THRESHOLD = 0.6;

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

/** Same sanitization contract as the app's bundle-filenames.ts
 *  sanitizeCollectionName - strips control chars/path separators, keeps a
 *  conservative safe charset, collapses whitespace, bounds length. */
function sanitizeCollectionName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noControl = raw.replace(/[\x00-\x1f\x7f]/g, '');
  const collapsed = noControl.trim().replace(/\s+/g, '-');
  const safe = collapsed.replace(/[^A-Za-z0-9._-]/g, '');
  const trimmed = safe.replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  return trimmed.length > 0 ? trimmed : 'collection';
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
