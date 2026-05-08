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
 * Contract:
 *   - input may be string | null | undefined
 *   - returns the trimmed string when it has any non-whitespace content
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
export function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
