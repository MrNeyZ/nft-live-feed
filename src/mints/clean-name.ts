/**
 * Display-name normaliser for mint enrichment.
 *
 * Background — what we're guarding against:
 *   On-chain Metaplex / MPL Core name fields are fixed-width, right-padded
 *   with spaces. LMNFT's homepage scraper and some DAS responses surface
 *   that raw value, so the accumulator ends up with names like
 *   "                                " (32 spaces) or "y00ts " (one
 *   trailing space). The /mints UI then renders blank cells or
 *   misaligned monospace columns.
 *
 *   Per-asset noise on launchpad drops:
 *   The first DAS hit for a freshly-minted LMNFT / cNFT / MPL Core asset
 *   typically returns a PER-NFT name ("PAGE - 2", "DASC 1/1", "Beez …
 *   #NFT #Nature #Solana"), not the collection name — collection
 *   metadata is indexed later. Without normalisation, that per-asset
 *   string lands as the collection-row title on /mints and rides there
 *   for the rest of the row's life. The strip patterns below are the
 *   shapes the audit caught most often:
 *     • " - <digits>"     ("PAGE - 2" → "PAGE")
 *     • " <n>/<n>"        ("DASC 1/1" → "DASC")
 *     • trailing #tag run ("Beez … #NFT #Solana #öko" → "Beez …")
 *   collection-confirm.ts sticky-merge prefers a later-arriving strong
 *   DAS `collectionName` / Magic Eden name over this stripped fallback,
 *   so a real collection name still wins when DAS catches up.
 *
 * Contract:
 *   - input may be string | null | undefined
 *   - returns the (trimmed + stripped) string when non-empty
 *   - returns null otherwise (callers can treat null as "leave existing
 *     value untouched" — never "wipe an existing good name")
 *
 * Caller responsibility:
 *   The "don't overwrite a good name with null" guard lives at the patch
 *   site (e.g. patchAccumulatorMeta), not in this helper. Keeping that
 *   policy at the call site lets each path mix this normaliser with its
 *   own sticky-merge rules without coupling to a single "what counts as
 *   good?" definition here.
 */

/** Trailing " - <digits>" — per-asset numbering on launches that name
 *  every NFT "<Project> - <N>" ("PAGE - 2", "PAGE - 28"). Strict spaces
 *  around the dash so a deliberate hyphenation like "Project-1" doesn't
 *  match. */
const PER_ASSET_DASH_NUM_RE = /\s+-\s+\d+\s*$/;

/** Trailing " <n>/<n>" — 1-of-1 / edition-fraction styling ("DASC 1/1",
 *  "Edition 5 / 10"). Anchored to end-of-string + requires whitespace
 *  before the digits, so a path-like or version-like fragment in the
 *  middle of a name (e.g. "Vol 1/2 Special") is left alone. */
const PER_ASSET_NN_FRAC_RE  = /\s+\d+\s*\/\s*\d+\s*$/;

/** Trailing " <digits>" without any separator — per-asset numbering on
 *  launches that name every NFT "<Project> <N>" with a bare space, no
 *  `#` and no dash ("Unknown Flork 5857", "Cryptobeezz 1342"). Requires
 *  3+ digits so legitimate names ending in a small number aren't
 *  stripped ("Vol 2", "Tesla Model 3", "PS5"). 3+ digits ⇒ serial
 *  index of a 100+ supply drop, never a real word fragment. The 2-digit
 *  case is the ambiguous one — leave it alone. */
const PER_ASSET_BARE_NUM_RE = /\s+\d{3,}\s*$/;

/** Trailing run of "#tag" tokens after non-hashtag content. cNFT /
 *  Core metadata often appends hashtag spam to the on-chain name for
 *  marketplace discovery ("Beez … #NFT #Nature #Solana #öko #BeezHip").
 *  Unicode-aware (`\p{L}\p{N}` + /u flag) so non-ASCII tags strip too.
 *  Requires a non-empty non-hashtag prefix in capture group 1, so a
 *  pure-hashtag name like "#NFT" is preserved as-is rather than wiped. */
const PER_ASSET_HASHTAG_TAIL_RE = /^(.*?\S)((?:\s*[,　]?\s*#[\p{L}\p{N}_]+)+)\s*$/u;

/** Returns true when `s` matches one of the per-asset shapes
 *  `cleanName` strips — used by `collection-confirm.ts` to widen its
 *  weak-name predicate so a later strong DAS `collectionName` can
 *  overwrite a per-asset residue without weakening sticky protection
 *  for genuinely-set names. Defense-in-depth: anything written via
 *  `patchAccumulatorMeta` / `patchAccumulatorLmnft` already passes
 *  through `cleanName`, but a future code path that bypasses
 *  cleanName would still be caught at the override-decision point. */
export function nameLooksPerAsset(s: string | null | undefined): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (PER_ASSET_DASH_NUM_RE.test(s))     return true;
  if (PER_ASSET_NN_FRAC_RE.test(s))      return true;
  if (PER_ASSET_BARE_NUM_RE.test(s))     return true;
  if (PER_ASSET_HASHTAG_TAIL_RE.test(s)) return true;
  return false;
}

/** Apply the three per-asset strips. Hashtag tail goes first because
 *  hashtags often follow numeric suffixes ("Foo 1/1 #Solana"); strip
 *  the tags then the digits, and we end up with "Foo" instead of the
 *  ambiguous "Foo 1/1". The numeric strips run twice to handle
 *  residuals like "FOO - 2 - 3" / "FOO 1/1 - 2" without needing a
 *  while-loop. Worst-case = 2 small regex passes. */
function stripPerAssetSuffixes(s: string): string {
  let out = s;
  const m = out.match(PER_ASSET_HASHTAG_TAIL_RE);
  if (m) {
    const prefix = m[1].trim();
    if (prefix.length > 0) out = prefix;
  }
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(PER_ASSET_NN_FRAC_RE, '')
      .replace(PER_ASSET_DASH_NUM_RE, '')
      .replace(PER_ASSET_BARE_NUM_RE, '');
  }
  return out.trim();
}

export function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Strip per-asset suffixes BEFORE final validation. Falls back to
  // `trimmed` if stripping somehow empties the string (shouldn't
  // happen with the prefix-required hashtag regex + anchored numeric
  // regexes, but the guard keeps us from returning null on an input
  // that did contain non-whitespace content).
  const stripped = stripPerAssetSuffixes(trimmed);
  if (stripped.length > 0) return stripped;
  return trimmed;
}
