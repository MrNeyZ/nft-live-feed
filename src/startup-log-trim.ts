/**
 * Minimal startup log-file trimmer.
 *
 * When the app is launched with stdout/stderr captured to a file (e.g.
 * `npm run dev >> /tmp/backend.log 2>&1`) the target path grows unbounded
 * across restarts. This utility runs once at startup: if `LOG_FILE` is set
 * and the file exceeds `MAX_LINES`, it is rewritten to its last `MAX_LINES`
 * lines. No rotation, no secondary files, no changes to logging calls.
 *
 * No-op when `LOG_FILE` is unset or the file does not exist.
 */
import fs from 'fs';

const MAX_LINES = 5000;

export function trimStartupLog(): void {
  const path = process.env.LOG_FILE;
  if (!path) return;
  try {
    if (!fs.existsSync(path)) return;
    const content = fs.readFileSync(path, 'utf8');
    const lines = content.split('\n');
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(path, lines.slice(-MAX_LINES).join('\n'));
    console.log(`[startup] trimmed ${path}: ${lines.length} → ${MAX_LINES} lines`);
  } catch (err) {
    console.warn(`[startup] log trim failed for ${path}:`, (err as Error).message ?? err);
  }
}
