/**
 * Minimal in-memory TTL cache.
 * No external dependencies. Entries expire lazily on read; opt-in active
 * sweep can also evict expired keys on a fixed interval so a cache that
 * holds entries for keys never re-read doesn't grow unboundedly.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();

  /**
   * @param ttlMs            entry lifetime
   * @param sweepIntervalMs  if > 0, run a periodic sweep that deletes
   *                         expired keys. Default off — preserves the
   *                         lazy-only behavior every existing caller
   *                         already relies on.
   */
  constructor(
    private readonly ttlMs: number,
    sweepIntervalMs?: number,
  ) {
    if (sweepIntervalMs && sweepIntervalMs > 0) {
      const timer = setInterval(() => this.sweep(), sweepIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  // Iterates the map once and deletes any keys past `expiresAt`. Uses
  // `forEach` so iteration creates no per-element tuple allocation.
  // Map mutation while iterating is safe — the spec guarantees keys
  // visited at most once each.
  private sweep(): void {
    const now = Date.now();
    this.map.forEach((entry, key) => {
      if (now > entry.expiresAt) this.map.delete(key);
    });
  }
}
