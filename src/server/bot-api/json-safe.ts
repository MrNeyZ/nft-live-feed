/**
 * JSON-safety for the Bot API wire format.
 *
 * Plain `res.json()` / `JSON.stringify()` has two failure modes bots must
 * never see:
 *   1. A `bigint` anywhere in the payload throws ("Do not know how to
 *      serialize a BigInt") instead of producing a response at all.
 *   2. `NaN` / `Infinity` / `-Infinity` silently become JSON `null` via a
 *      normal `JSON.stringify` (no throw, no warning) — a bot reading
 *      `null` where it expected a price has no way to tell "value was
 *      genuinely absent" from "value was a broken float".
 *
 * `sanitizeForJson` walks a value tree and fixes both BEFORE
 * `JSON.stringify` ever runs, so every Bot API response is provably free
 * of both failure modes rather than hoping upstream code never produces
 * one.
 */

export function sanitizeForJson<T>(value: T): unknown {
  return sanitize(value, new Set());
}

function sanitize(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return value;

  // Cycles can't occur in this codebase's plain data shapes, but guard
  // anyway rather than stack-overflow on a future accidental cycle.
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitize(v, seen);
  }
  return out;
}

/** `res.json()` equivalent that guarantees no bigint-throw and no silent
 *  NaN/Infinity → null surprise (both are handled explicitly by
 *  `sanitizeForJson` before stringifying, not left to `JSON.stringify`'s
 *  own — different — default behavior). */
export function sendBotApiJson(res: { status(code: number): unknown; type(t: string): unknown; send(body: string): unknown }, statusCode: number, value: unknown): void {
  const safe = sanitizeForJson(value);
  res.status(statusCode);
  res.type('application/json');
  res.send(JSON.stringify(safe));
}
