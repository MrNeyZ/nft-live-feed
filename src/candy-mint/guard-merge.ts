/**
 * Base ∪ group guard-set merge, shared by build.ts (tx construction) and
 * guard-config.ts (support/display inspection).
 *
 * Base guards (`candyGuard.guards`) are enforced by the on-chain Candy Guard
 * program on EVERY mint regardless of which group is selected — a group
 * only adds/overrides its own guards on top, it does not replace the base
 * set. Treating a group's guard set as standalone (dropping base-only
 * guards like a base `mintLimit` with no per-group override) undercounts
 * what's actually active: the remaining account a base-only guard needs is
 * then missing from `mintArgs` while the guard itself is still evaluated
 * on-chain -> `MissingRemainingAccount` -> Candy Guard bot-taxes the mint.
 * It also undercounts on the *inspection* side — an unsupported base-only
 * guard (e.g. a base `gatekeeper`) would silently mark every group
 * "supported" despite being just as doomed.
 *
 * Merge rule: the group's value wins when the group sets a guard (Some),
 * otherwise fall back to the base value (Some or None).
 */
type GuardOption = { __option: 'Some' | 'None'; value?: unknown };
type GuardSetLike = Record<string, GuardOption>;

export function mergeGuardSets<T extends GuardSetLike>(base: T, group: T): T {
  const merged: GuardSetLike = { ...base };
  for (const [name, wrapped] of Object.entries(group)) {
    if (wrapped?.__option === 'Some') merged[name] = wrapped;
  }
  return merged as T;
}
