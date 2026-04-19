/**
 * Simple async concurrency limiter (semaphore) with optional inter-call delay.
 *
 * Caps the number of simultaneously-running async tasks. Callers await
 * limiter.run(fn) — if the slot count is full they queue until a slot frees.
 *
 * Optional delayMs: after each task completes the slot is held for delayMs
 * before the next queued task is admitted. With max=1 this becomes a simple
 * rate-limiter: one call at a time, minimum delayMs between calls.
 *
 * Used to cap concurrent getTransaction RPC calls from the listener and
 * raw-poller so we don't exceed standard RPC rate limits.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Limiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  /**
   * @param max      Maximum concurrent tasks.
   * @param delayMs  Minimum milliseconds to hold a slot after a task finishes
   *                 before admitting the next queued task. Default 0 (no delay).
   */
  constructor(readonly max: number, private readonly delayMs = 0) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.max) {
      return this.exec(fn);
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => this.exec(fn).then(resolve, reject));
    });
  }

  private async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await fn();
    } finally {
      if (this.delayMs > 0) await sleep(this.delayMs);
      this.running--;
      this.queue.shift()?.();
    }
  }
}
