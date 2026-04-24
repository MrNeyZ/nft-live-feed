/**
 * Single-instance backend lock.
 *
 * Prevents two `npm run dev` (or two `node dist/index.js`) processes from
 * running at the same time — each one would subscribe to Helius and burn
 * duplicate RPC credits. The mechanism:
 *
 *   1. On startup, read `.runtime/backend.lock` if it exists.
 *   2. If present, `process.kill(pid, 0)` probes whether that PID is still
 *      alive. Signal 0 never delivers a signal; it just asks the OS whether
 *      the pid exists (ESRCH = gone, EPERM = alive-but-not-ours, no-throw =
 *      alive-and-ours). Works identically on macOS and Linux.
 *   3. If the owner is alive, we log a clear message and exit(1).
 *   4. If the owner is gone (process crashed / machine rebooted) the stale
 *      lock is deleted and startup continues.
 *   5. On clean shutdown (SIGINT / SIGTERM / SIGHUP / normal `exit`) we
 *      delete the lock so the next boot doesn't see a false-positive.
 *
 * The lock file is tiny — just the PID as ASCII. Writing it via
 * `O_EXCL | O_CREAT` would atomically fail on race, but checking the
 * stored PID's liveness is a superset of that guarantee (it handles the
 * crashed-without-cleanup case too), so we keep the simpler write-then-check
 * path.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AcquireResult {
  /** Absolute path the lock was written to. Exposed so tests can assert. */
  lockPath: string;
  /** Release the lock immediately. Idempotent. Called automatically on
   *  process exit / signal, so most callers never need to invoke it. */
  release: () => void;
}

/**
 * Acquire the single-instance lock. If another live backend already owns
 * the lock, this function prints a diagnostic to stderr and calls
 * `process.exit(1)`. It never returns normally in that case.
 *
 * @param lockPath  Absolute path to the lock file. Parent dir is created
 *                  on demand.
 */
export function acquireSingleton(lockPath: string): AcquireResult {
  const dir = path.dirname(lockPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore — lock write will surface any real error */ }

  if (fs.existsSync(lockPath)) {
    const raw = safeRead(lockPath);
    const ownerPid = parseInt(raw.trim(), 10);
    if (Number.isFinite(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      console.error(
        `[lock] backend already running  pid=${ownerPid}  lock=${lockPath}\n` +
        `[lock] refusing to start a second instance — kill pid ${ownerPid} first ` +
        `(e.g. \`kill ${ownerPid}\`) or remove the lock file manually if you know ` +
        `the process is gone.`,
      );
      process.exit(1);
    }
    // Stale lock (crash, reboot, or the previous PID now belongs to an
    // unrelated process). Remove it and fall through to acquire.
    console.warn(`[lock] removing stale lock  was_pid=${ownerPid || 'unparseable'}  lock=${lockPath}`);
    try { fs.unlinkSync(lockPath); } catch { /* lost the race — the next write will overwrite */ }
  }

  fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8' });
  console.log(`[lock] acquired  pid=${process.pid}  lock=${lockPath}`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only unlink if we still own it — belt-and-suspenders so a second
      // instance that somehow started can't have its lock deleted by our
      // exit handler.
      const raw = safeRead(lockPath);
      const ownerPid = parseInt(raw.trim(), 10);
      if (ownerPid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* ignore — best effort */ }
  };

  // Best-effort cleanup hooks. `exit` runs synchronously on normal termination,
  // which covers `process.exit()` and the natural end of the event loop.
  // Signal handlers call `process.exit(0)` themselves so Node doesn't leave
  // us hanging on the default signal handler.
  process.on('exit',   release);
  process.on('SIGINT',  () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  process.on('SIGHUP',  () => { release(); process.exit(129); });
  // Uncaught crashes also drop the lock so restarts aren't blocked.
  process.on('uncaughtException', (err) => {
    release();
    console.error('[lock] uncaughtException — releasing lock and exiting', err);
    process.exit(1);
  });

  return { lockPath, release };
}

function safeRead(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Probe whether a PID is alive using signal 0. Portable to macOS + Linux. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means "the process exists but we don't have permission to signal
    // it" — still counts as alive for our purposes.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'EPERM') {
      return true;
    }
    return false;
  }
}
