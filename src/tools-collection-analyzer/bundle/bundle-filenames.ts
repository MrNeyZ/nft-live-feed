/**
 * Collection Analyzer - Stage 3 filename/path safety helpers.
 *
 * Mint address is the canonical filename for every per-asset file (image,
 * normalized metadata, original metadata) - mints are guaranteed unique
 * (unlike NFT `name`, which frequently collides across a collection), and
 * are validated against the same base58 shape used elsewhere in the
 * project before ever touching the filesystem.
 */

/** Same base58 pubkey shape used by tools-holders/fetch-assets.ts and
 *  tools-collection-analyzer/parse-input.ts. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validates a mint before it's used as a filename component. Returns null
 *  (caller must skip/fail the asset) for anything that doesn't match the
 *  expected shape - defense in depth against path traversal even though
 *  mints originate from our own DAS-scanned data, never client input. */
export function safeMintFilename(mint: string): string | null {
  return MINT_RE.test(mint) ? mint : null;
}

/** sharp-reported format -> safe file extension. Deliberately narrow -
 *  only the four formats Stage 3 supports; anything else is rejected
 *  upstream before this is ever consulted. */
const FORMAT_EXTENSION: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

export function extensionForFormat(format: string): string | null {
  return FORMAT_EXTENSION[format] ?? null;
}

export const SUPPORTED_IMAGE_FORMATS: ReadonlySet<string> = new Set(Object.keys(FORMAT_EXTENSION));

/** Sanitizes an arbitrary string (collection address or, in a future
 *  stage, a resolved display name) into a safe ZIP root-folder / download
 *  filename component: strips control characters and path separators,
 *  keeps only a conservative safe charset, collapses whitespace, and
 *  bounds the length. Never returns an empty string (falls back to
 *  "collection"). */
export function sanitizeCollectionName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noControl = raw.replace(/[\x00-\x1f\x7f]/g, '');
  const collapsed = noControl.trim().replace(/\s+/g, '-');
  const safe = collapsed.replace(/[^A-Za-z0-9._-]/g, '');
  // Strip leading/trailing dots/hyphens too - blocks ".."-shaped names and
  // hidden-dotfile-looking folder names.
  const trimmed = safe.replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  return trimmed.length > 0 ? trimmed : 'collection';
}
