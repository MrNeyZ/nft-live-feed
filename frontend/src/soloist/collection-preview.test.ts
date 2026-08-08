// Standalone (no test framework — the frontend has none) verification of the
// /dashboard <-> /multi -> /collection/[slug] avatar handoff. Compile + run:
//   npx tsc src/soloist/collection-preview.ts src/soloist/collection-preview.test.ts \
//     --outDir /tmp/cp --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck && node /tmp/cp/collection-preview.test.js
//
// Covers the /multi parity fix: clicking a row in /multi's collections
// panel used to navigate straight to /collection/[slug] without stashing
// `cp-preview:<slug>`, so the header briefly showed an initials/abbr
// placeholder instead of the avatar the user just saw — unlike /dashboard.
import assert from 'assert';
import { stashCollectionPreview } from './collection-preview';

class FakeSessionStorage {
  private store = new Map<string, string>();
  setItem(k: string, v: string): void { this.store.set(k, v); }
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
}

let failures = 0;
function check(label: string, cond: boolean) {
  if (!cond) { failures++; console.log(`FAIL  ${label}`); }
  else console.log(`PASS  ${label}`);
}

let fake = new FakeSessionStorage();
(global as unknown as { sessionStorage: FakeSessionStorage }).sessionStorage = fake;

stashCollectionPreview('okay-bears', 'https://example.com/okay.png');
check('writes cp-preview:<slug> with the avatar URL', fake.getItem('cp-preview:okay-bears') === 'https://example.com/okay.png');

stashCollectionPreview('no-avatar', null);
check('null avatarUrl is a no-op (no key written)', fake.getItem('cp-preview:no-avatar') === null);

stashCollectionPreview('no-avatar-2', undefined);
check('undefined avatarUrl is a no-op (no key written)', fake.getItem('cp-preview:no-avatar-2') === null);

stashCollectionPreview('empty-string', '');
check('empty-string avatarUrl is a no-op (falsy, matches the `if (row.avatarUrl)` guard it replaced)', fake.getItem('cp-preview:empty-string') === null);

// Quota-exceeded / private-mode: setItem throws — must not propagate.
(global as unknown as { sessionStorage: unknown }).sessionStorage = {
  setItem() { throw new Error('QuotaExceededError'); },
};
let threw = false;
try { stashCollectionPreview('slug', 'url'); } catch { threw = true; }
check('sessionStorage.setItem throwing does not propagate', !threw);

assert.strictEqual(failures, 0, `${failures} collection-preview case(s) failed`);
console.log('\nAll collection-preview cases passed.');
