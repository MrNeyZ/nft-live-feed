// Standalone (no test framework — the frontend has none) verification of
// range persistence used by /dashboard (vl.dashboard.range) and /multi
// (vl.multi.range). Compile + run:
//   npx tsc src/soloist/range-storage.ts src/soloist/range-storage.test.ts \
//     --outDir /tmp/rs --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck && node /tmp/rs/range-storage.test.js
//
// Covers the /multi parity fix: range used to be page-local state with no
// persistence at all, resetting to the default on every reload unlike
// /dashboard's already-persisted range.
import assert from 'assert';
import { loadStoredRange, saveStoredRange } from './range-storage';

// Minimal in-memory localStorage stand-in — Node has no `window`.
class FakeStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { this.store.set(k, v); }
  removeItem(k: string): void { this.store.delete(k); }
}

const VALID = new Set(['5m', '10m', '1h'] as const);
type R = '5m' | '10m' | '1h';

let failures = 0;
function check(label: string, cond: boolean) {
  if (!cond) { failures++; console.log(`FAIL  ${label}`); }
  else console.log(`PASS  ${label}`);
}

(global as unknown as { window: { localStorage: FakeStorage } }).window = { localStorage: new FakeStorage() };

check('missing key falls back to default', loadStoredRange<R>('vl.multi.range', VALID, '1h') === '1h');

saveStoredRange('vl.multi.range', '10m');
check('saved value round-trips', loadStoredRange<R>('vl.multi.range', VALID, '1h') === '10m');

saveStoredRange('vl.multi.range', 'not-a-range');
check('invalid stored value falls back to default, not the garbage string',
  loadStoredRange<R>('vl.multi.range', VALID, '1h') === '1h');

// Two independent keys (dashboard vs multi) never collide.
saveStoredRange('vl.dashboard.range', '5m');
saveStoredRange('vl.multi.range', '10m');
check('vl.dashboard.range and vl.multi.range persist independently',
  loadStoredRange<R>('vl.dashboard.range', VALID, '1h') === '5m'
  && loadStoredRange<R>('vl.multi.range', VALID, '1h') === '10m');

// Private-mode / storage-throws path: getItem throws, must not crash and
// must fall back to default.
(global as unknown as { window: { localStorage: unknown } }).window = {
  localStorage: {
    getItem() { throw new Error('SecurityError: private mode'); },
    setItem() { throw new Error('SecurityError: private mode'); },
  },
};
check('storage exception on read falls back to default', loadStoredRange<R>('vl.multi.range', VALID, '1h') === '1h');
saveStoredRange('vl.multi.range', '5m'); // must not throw
check('storage exception on write does not throw', true);

// SSR path: no `window` at all.
delete (global as unknown as { window?: unknown }).window;
check('no window (SSR) falls back to default', loadStoredRange<R>('vl.multi.range', VALID, '1h') === '1h');

assert.strictEqual(failures, 0, `${failures} range-storage case(s) failed`);
console.log('\nAll range-storage cases passed.');
