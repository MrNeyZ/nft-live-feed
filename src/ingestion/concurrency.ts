/**
 * Async concurrency limiter with priority queues and optional stale-low drop.
 *
 * Caps the number of simultaneously-running async tasks. Callers await
 * limiter.run(fn, priority) — if the slot count is full the task is queued
 * under its priority bucket until a slot frees.
 *
 * Dispatch order: high → medium → low. Within a bucket, FIFO. Starvation of
 * low is acceptable here: low-priority callers are pages-2+ catch-up sigs
 * that are strictly optional (the primary poller covers them separately).
 *
 * Stale-low drop: when `staleLowMs > 0`, any low-priority task whose queue
 * wait exceeds that threshold is skipped at admission time — its `run()`
 * promise resolves to `null` without ever invoking `fn`. high/medium are
 * never dropped. Used to shed deep catch-up work during bursts instead of
 * spending `getTransaction` credits on sigs that no longer matter.
 *
 * Optional delayMs: after each task completes the slot is held for delayMs
 * before the next queued task is admitted (simple rate-limit smoothing).
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type Priority = 'high' | 'medium' | 'low';
const PRIORITY_ORDER: readonly Priority[] = ['high', 'medium', 'low'];

interface QueuedTask {
  fn:         () => Promise<unknown>;
  resolve:    (v: unknown) => void;
  reject:     (e: unknown) => void;
  enqueuedAt: number;
}

export class Limiter {
  private running = 0;
  private staleDropCount = 0;
  private readonly queues: Record<Priority, QueuedTask[]> = {
    high:   [],
    medium: [],
    low:    [],
  };

  /** Return the number of low-priority tasks dropped at admission since the
   *  last call, and reset the counter. Used by telemetry. */
  takeStaleDropCount(): number {
    const n = this.staleDropCount;
    this.staleDropCount = 0;
    return n;
  }

  /**
   * @param max         Maximum concurrent tasks.
   * @param delayMs     Minimum ms to hold a slot after a task finishes before
   *                    admitting the next queued task. Default 0.
   * @param staleLowMs  When >0, low-priority tasks whose queue wait exceeds
   *                    this are resolved with `null` at dispatch time instead
   *                    of running. Default 0 (no stale drop).
   */
  constructor(
    readonly max: number,
    private readonly delayMs = 0,
    private readonly staleLowMs = 0,
  ) {}

  run<T>(fn: () => Promise<T>, priority: Priority = 'medium'): Promise<T | null> {
    if (this.running < this.max) {
      return this.exec(fn);
    }
    return new Promise<T | null>((resolve, reject) => {
      this.queues[priority].push({
        fn:         fn as () => Promise<unknown>,
        resolve:    resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
    });
  }

  /** Combined queue depth across all priorities. */
  depth(): number {
    return this.queues.high.length + this.queues.medium.length + this.queues.low.length;
  }

  /** Queue depth per priority bucket (for stats/logging). */
  depthByPriority(): Record<Priority, number> {
    return {
      high:   this.queues.high.length,
      medium: this.queues.medium.length,
      low:    this.queues.low.length,
    };
  }

  private async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await fn();
    } finally {
      if (this.delayMs > 0) await sleep(this.delayMs);
      this.running--;
      this.dispatchNext();
    }
  }

  private dispatchNext(): void {
    // Shed stale low-priority tasks before picking the next runner. Resolving
    // to `null` matches the `fetchRawTx` contract for deduped/skipped sigs so
    // callers don't need a new skip branch.
    if (this.staleLowMs > 0 && this.queues.low.length > 0) {
      const cutoff = Date.now() - this.staleLowMs;
      while (this.queues.low.length > 0 && this.queues.low[0].enqueuedAt < cutoff) {
        this.queues.low.shift()!.resolve(null);
        this.staleDropCount++;
      }
    }
    for (const p of PRIORITY_ORDER) {
      const task = this.queues[p].shift();
      if (!task) continue;
      this.exec(task.fn).then(task.resolve, task.reject);
      return;
    }
  }
}
