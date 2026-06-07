/**
 * Mint Tracker — cooled-collection revival unit test.
 *
 * Reproduces the audited Flork bug (collection
 *   CdGA8kAAicbx9EAY6BvMxkfBeguyn8a9YyoWqSquzhBG, sig
 *   343WCaPSqzzD6B9LHtHFcysNqL9wTbmVZahPMagjbc9heJcCBDtrG9YAwDnerZkkzqd3FMviJ8cB2hhme1YYvfjK):
 * a collection bursts → ACTIVE, idles → `cooled`, then a lone straggler mint
 * arrives. The per-mint card emits to the Live Feed, but the collection row
 * stayed `cooled` (hidden from the tracker table). The fix revives a `cooled`
 * row to WATCH (`incubating`) on fresh activity — never straight to ACTIVE on
 * one mint — gated on a usable identity.
 *
 * Deterministic via env overrides (set in the npm script BEFORE module load):
 *   MINT_BURST_V60=2  MINT_DISPLAY_THRESHOLD=50  MINT_IDLE_COOLDOWN_MS=1
 * so two quick mints promote (burst) and one sweep tick (after a >1ms spin)
 * cools the sub-threshold row. No network/DB. (`envInt` rejects 0, so the
 * cooldown is 1ms, not 0.)
 * Run: `npm run test:mint-accumulator`.
 */
import assert from 'assert';
import { recordMint, patchAccumulatorMeta, currentMintStatuses, __testHooks } from '../accumulator';
import type { MintEventWire } from '../../events/emitter';

let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}\n     ${(err as Error).message}`); }
}

let sigCounter = 0;
function mintEvent(groupingKey: string, collection: string): MintEventWire {
  sigCounter += 1;
  return {
    signature:         `sig_${groupingKey}_${sigCounter}`,
    blockTime:         new Date().toISOString(),
    programSource:     'mpl_token_metadata',
    mintAddress:       `mint_${groupingKey}_${sigCounter}`,
    collectionAddress: collection,
    groupingKey,
    groupingKind:      'collection',
    mintType:          'paid',
    priceLamports:     5_000_000,
    minter:            `minter_${sigCounter}`,
    sourceLabel:       'Metaplex Candy Machine',
  };
}

function stateOf(groupingKey: string): string | null {
  return currentMintStatuses().find(s => s.groupingKey === groupingKey)?.displayState ?? null;
}

// ── Case 1: the audited lifecycle — burst → cooled → straggler → WATCH ──────
{
  __testHooks.reset();
  const KEY = 'collection:CdGA8kAAicbx9EAY6BvMxkfBeguyn8a9YyoWqSquzhBG';
  const COLL = 'CdGA8kAAicbx9EAY6BvMxkfBeguyn8a9YyoWqSquzhBG';
  console.log('\nCase 1 — Flork: shown(burst) → cooled → straggler revives to WATCH');

  // 1. Promote to shown via burst. First mint seeds the row (incubating, no
  //    identity yet); patch the resolved collection name ("Flork"); second
  //    mint trips BURST_V60=2 with usable identity → shown.
  recordMint(mintEvent(KEY, COLL));
  patchAccumulatorMeta(KEY, { name: 'Flork' });
  recordMint(mintEvent(KEY, COLL));
  check('promoted to shown (burst)', () => assert.strictEqual(stateOf(KEY), 'shown'));

  // 2. Idle → cooled. With MINT_IDLE_COOLDOWN_MS=0 one sweep tick demotes a
  //    burst-shown sub-threshold row. Ensure >0 ms has elapsed since lastMintAt.
  const t = Date.now(); while (Date.now() - t < 3) { /* spin a few ms */ }
  __testHooks.runSweep();
  check('demoted to cooled after idle sweep', () => assert.strictEqual(stateOf(KEY), 'cooled'));

  // 3. A lone straggler mint arrives (the Flork tx case).
  recordMint(mintEvent(KEY, COLL));

  // 4. Revived to WATCH (incubating) — NOT ACTIVE (shown) on one straggler.
  check('revived to incubating (WATCH), not shown', () => assert.strictEqual(stateOf(KEY), 'incubating'));
  check('mint_status frame exposes incubating row', () => assert.ok(
    currentMintStatuses().some(s => s.groupingKey === KEY && s.displayState === 'incubating'),
  ));
}

// ── Case 2: cooled WITHOUT usable identity → stays cooled (no noise revival) ─
{
  __testHooks.reset();
  const KEY = 'collection:NoIdentityCollect1111111111111111111111';
  const COLL = 'NoIdentityCollect1111111111111111111111';
  console.log('\nCase 2 — cooled + new mint + NO identity → stays cooled/hidden');

  // Build a row, then force it `cooled` with identity stripped (this state
  // isn't naturally reachable — cooling implies a prior shown which needs
  // identity — so we construct it to exercise the identity gate directly).
  recordMint(mintEvent(KEY, COLL));
  __testHooks.setDisplayState(KEY, 'cooled');
  __testHooks.clearIdentity(KEY);
  check('precondition: cooled + no identity', () => assert.strictEqual(__testHooks.getDisplayState(KEY), 'cooled'));

  recordMint(mintEvent(KEY, COLL));
  check('stays cooled (identity-gated, not revived)', () => assert.strictEqual(__testHooks.getDisplayState(KEY), 'cooled'));
}

// ── Case 3: existing shown / incubating behavior unchanged ──────────────────
{
  __testHooks.reset();
  console.log('\nCase 3 — shown and incubating rows behave as before');

  // shown stays shown on a new mint.
  const SKEY = 'collection:ShownStays1111111111111111111111111';
  recordMint(mintEvent(SKEY, 'ShownStays1111111111111111111111111'));
  patchAccumulatorMeta(SKEY, { name: 'ShownCo' });
  recordMint(mintEvent(SKEY, 'ShownStays1111111111111111111111111'));
  check('shown precondition', () => assert.strictEqual(stateOf(SKEY), 'shown'));
  recordMint(mintEvent(SKEY, 'ShownStays1111111111111111111111111'));
  check('shown row stays shown on new mint', () => assert.strictEqual(stateOf(SKEY), 'shown'));

  // incubating-with-identity but below burst stays incubating (single mint).
  const IKEY = 'collection:IncubLowVel111111111111111111111111';
  recordMint(mintEvent(IKEY, 'IncubLowVel111111111111111111111111'));
  patchAccumulatorMeta(IKEY, { name: 'IncubCo' });
  check('low-velocity row is incubating, not shown', () => assert.strictEqual(stateOf(IKEY), 'incubating'));
}

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
