/** Trimmed name, or null when blank. Some launchpads (LMNFT Core mints)
 *  write a whitespace-only placeholder on-chain name (e.g. 32 spaces) — a
 *  truthy string that used to win every `??` / `||` fallback chain, so the
 *  real per-item name from Tensor / ME never got a chance. */
export function nonBlankName(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
