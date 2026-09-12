// Structural-auditor regression tests for Resize Claim (auditResizeClaimTx).
// Fixtures come from ../../../../../src/resize-claim/__tests__/capture-
// fixtures.ts — the REAL production build.ts/program.ts, run against a
// mocked Connection (no network, no signing). See __fixtures__/README below
// and that script's own header for exactly what "synthetic-real-builder"
// means here. Regenerate via `npm run capture:resize-claim-fixtures` from
// the repo root, only after a deliberate program.ts layout change.
//
// Compile + run via `npm run test:resize-claim-frontend`.

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { auditResizeClaimTx, freezeIntent, type FrozenResizeClaimIntent } from './audit';

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}

interface Fixture {
  wallet: string;
  claim: { mint: string; amountLamports: string; proof: string[] };
  resizeMints: string[];
  claimTxBase64: string;
  resizeTxBase64: string;
  alts: Record<string, string[]>;
}

const fixturePath = join(__dirname, '__fixtures__', 'resize-claim-fixtures.json');
const fx = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

const intent: FrozenResizeClaimIntent = freezeIntent(
  fx.wallet,
  [fx.claim],
  fx.resizeMints.map((mint) => ({ mint })),
);

// ── byte-mutation helpers ──────────────────────────────────────────────────
function decode(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
}
function encode(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}
/** Replace one static (non-ALT-looked-up) account key by base58 match. */
function withStaticKeySwapped(base64: string, oldKey: string, newKey: PublicKey): string {
  const tx = decode(base64);
  const idx = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === oldKey);
  if (idx === -1) throw new Error(`fixture setup error: ${oldKey} not found in staticAccountKeys`);
  tx.message.staticAccountKeys[idx] = newKey;
  return encode(tx);
}
/** Overwrite raw instruction data bytes at [ixIndex][byteOffset..]. */
function withInstructionByte(base64: string, ixIndex: number, byteOffset: number, value: number): string {
  const tx = decode(base64);
  const ix = tx.message.compiledInstructions[ixIndex];
  const data = new Uint8Array(ix.data);
  data[byteOffset] = value;
  ix.data = data;
  return encode(tx);
}
function withExtraTopLevelInstruction(base64: string, programIdIndex: number, accountKeyIndexes: number[], data: number[]): string {
  const tx = decode(base64);
  tx.message.compiledInstructions.push({ programIdIndex, accountKeyIndexes, data: new Uint8Array(data) });
  return encode(tx);
}
function withAltAddressSwapped(alts: Record<string, string[]>, realAddress: string, fakeAddress: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, addrs] of Object.entries(alts)) {
    out[k] = addrs.map((a) => (a === realAddress ? fakeAddress : a));
  }
  return out;
}

const RANDOM = () => Keypair.generate().publicKey;
const RANDOM_STR = () => RANDOM().toBase58();

// ── positive cases ──────────────────────────────────────────────────────
console.log('positive cases (unmodified real-builder output must pass)');
check('claim: unmodified fixture passes', () => {
  const r = auditResizeClaimTx(fx.claimTxBase64, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('resize: unmodified fixture passes', () => {
  const r = auditResizeClaimTx(fx.resizeTxBase64, { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});

// ── claim: adversarial mutations (spec §9) ───────────────────────────────
console.log('claim: adversarial mutations rejected');

check('fee payer changed -> rejected', () => {
  const mutated = withStaticKeySwapped(fx.claimTxBase64, fx.wallet, RANDOM());
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('extra SystemProgram transfer appended after the claim instruction -> rejected', () => {
  // The injected instruction's exact target/data content doesn't matter to
  // this check — an extra top-level instruction of ANY shape must already
  // be caught purely by the claim path's exact-instruction-count invariant
  // (exactly 1, no ComputeBudget, nothing after). Appends a fresh
  // SystemProgram key as a new static account and points a Transfer-shaped
  // instruction at it, purely to keep the fixture realistic.
  const tx = decode(fx.claimTxBase64);
  tx.message.staticAccountKeys.push(new PublicKey('11111111111111111111111111111111'));
  const sysIdx = tx.message.staticAccountKeys.length - 1;
  const withSystemKey = encode(tx);
  const mutated = withExtraTopLevelInstruction(withSystemKey, sysIdx, [0], [2, 0, 0, 0, 0xE8, 0x03, 0, 0, 0, 0, 0, 0]);
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('wrong mint (account #5) -> rejected', () => {
  const mutated = withStaticKeySwapped(fx.claimTxBase64, fx.claim.mint, RANDOM());
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('wrong claim receipt (account #2) -> rejected', () => {
  const tx = decode(fx.claimTxBase64);
  const ix = tx.message.compiledInstructions[0];
  // account #2 in the fixed 13-account layout; find its global index positionally.
  const claimReceiptGlobalIdx = ix.accountKeyIndexes[2];
  tx.message.staticAccountKeys[claimReceiptGlobalIdx] = RANDOM();
  const r = auditResizeClaimTx(encode(tx), { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('wrong distribution account (ALT-resolved) -> rejected', () => {
  const distAddr = fx.alts[Object.keys(fx.alts)[0]][0]; // TM_RESIZE_DISTRIBUTION is listed first by capture-fixtures.ts
  const mutatedAlts = withAltAddressSwapped(fx.alts, distAddr, RANDOM_STR());
  const r = auditResizeClaimTx(fx.claimTxBase64, { kind: 'claim', mints: [fx.claim.mint] }, intent, mutatedAlts);
  assert.strictEqual(r.ok, false);
});

check('wrong recipient/owner account (recipientWsolAta, derived from a different wallet) -> rejected', () => {
  // Simulate by freezing intent against a DIFFERENT wallet than the tx was
  // actually built for — the auditor must recompute the expected ATA from
  // the frozen wallet and reject the mismatch, not trust whatever's in the tx.
  const otherIntent = freezeIntent(RANDOM_STR(), [fx.claim], fx.resizeMints.map((mint) => ({ mint })));
  const r = auditResizeClaimTx(fx.claimTxBase64, { kind: 'claim', mints: [fx.claim.mint] }, otherIntent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('wrong program ID (claim instruction points at an unrelated program) -> rejected', () => {
  const tx = decode(fx.claimTxBase64);
  const fake = RANDOM();
  tx.message.staticAccountKeys.push(fake);
  const fakeIdx = tx.message.staticAccountKeys.length - 1;
  tx.message.compiledInstructions[0].programIdIndex = fakeIdx;
  const r = auditResizeClaimTx(encode(tx), { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('wrong discriminator (byte 0 of instruction data) -> rejected', () => {
  const mutated = withInstructionByte(fx.claimTxBase64, 0, 0, 99);
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('tampered amount in instruction data -> rejected', () => {
  const mutated = withInstructionByte(fx.claimTxBase64, 0, 1, 0xFF);
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('tampered proof node (not part of the ClaimReceipt PDA seeds — must still be caught) -> rejected', () => {
  const mutated = withInstructionByte(fx.claimTxBase64, 0, 13, 0xFF);
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('extra top-level application instruction after the claim -> rejected', () => {
  const tx = decode(fx.claimTxBase64);
  const claimProgIdx = tx.message.compiledInstructions[0].programIdIndex;
  const mutated = withExtraTopLevelInstruction(fx.claimTxBase64, claimProgIdx, [], [5, 0, 0, 0, 0, 0, 0, 0, 0]);
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('unexpected writable account (payer flipped to read-only via header tampering path is structural — assert via a wrong-writable pin instead: recipientWsolAta swapped for a read-only-looking static key still fails positional pin)', () => {
  // Direct writable/signer bit flips aren't reachable without an internally
  // inconsistent message (web3.js's own header counts drive both), so this
  // exercises the reachable adjacent case: substituting the writable
  // recipientWsolAta slot with an arbitrary account fails the positional
  // pin the same way a writability mismatch would need to.
  const recipientAta = (() => {
    const tx = decode(fx.claimTxBase64);
    const ix = tx.message.compiledInstructions[0];
    return tx.message.staticAccountKeys[ix.accountKeyIndexes[3]].toBase58();
  })();
  const mutated = withStaticKeySwapped(fx.claimTxBase64, recipientAta, RANDOM());
  const r = auditResizeClaimTx(mutated, { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('claim for a mint outside the frozen/reviewed intent -> rejected', () => {
  const r = auditResizeClaimTx(fx.claimTxBase64, { kind: 'claim', mints: [RANDOM_STR()] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

// ── resize: adversarial mutations ────────────────────────────────────────
console.log('resize: adversarial mutations rejected');

check('resize target substituted (account #2 = mint, for instruction 0) -> rejected', () => {
  const tx = decode(fx.resizeTxBase64);
  const ix = tx.message.compiledInstructions[2]; // first Resize ix (after 2 ComputeBudget)
  const mintGlobalIdx = ix.accountKeyIndexes[2];
  tx.message.staticAccountKeys[mintGlobalIdx] = RANDOM();
  const r = auditResizeClaimTx(encode(tx), { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('duplicate resize target (same mint listed twice in the frozen mints list) -> rejected', () => {
  const r = auditResizeClaimTx(fx.resizeTxBase64, { kind: 'resize', mints: [fx.resizeMints[0], fx.resizeMints[0]] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('malicious ComputeBudget CU price above the allowed bound -> rejected', () => {
  const tx = decode(fx.resizeTxBase64);
  const priceIx = tx.message.compiledInstructions[1];
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice opcode
  const dv = new DataView(data.buffer);
  dv.setBigUint64(1, BigInt(10_000_000), true); // above MAX_RESIZE_COMPUTE_UNIT_PRICE_MICROLAMPORTS
  priceIx.data = data;
  const r = auditResizeClaimTx(encode(tx), { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('resize instruction wrong program ID -> rejected', () => {
  const tx = decode(fx.resizeTxBase64);
  const fake = RANDOM();
  tx.message.staticAccountKeys.push(fake);
  tx.message.compiledInstructions[2].programIdIndex = tx.message.staticAccountKeys.length - 1;
  const r = auditResizeClaimTx(encode(tx), { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('resize instruction wrong discriminator -> rejected', () => {
  const mutated = withInstructionByte(fx.resizeTxBase64, 2, 0, 5);
  const r = auditResizeClaimTx(mutated, { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('resize target outside the frozen/reviewed intent -> rejected', () => {
  const r = auditResizeClaimTx(fx.resizeTxBase64, { kind: 'resize', mints: [RANDOM_STR(), fx.resizeMints[1]] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('extra Resize instruction beyond the reviewed batch count -> rejected', () => {
  const tx = decode(fx.resizeTxBase64);
  const last = tx.message.compiledInstructions[tx.message.compiledInstructions.length - 1];
  tx.message.compiledInstructions.push({ ...last, data: new Uint8Array(last.data) });
  const r = auditResizeClaimTx(encode(tx), { kind: 'resize', mints: fx.resizeMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

check('resize batch exceeding the 8/tx pack limit -> rejected', () => {
  const nineMints = Array.from({ length: 9 }, () => RANDOM_STR());
  const r = auditResizeClaimTx(fx.resizeTxBase64, { kind: 'resize', mints: nineMints }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});

// ── cross-cutting ─────────────────────────────────────────────────────────
console.log('cross-cutting');
check('malformed base64 -> rejected, not thrown', () => {
  const r = auditResizeClaimTx('not-valid-base64!!', { kind: 'claim', mints: [fx.claim.mint] }, intent, fx.alts);
  assert.strictEqual(r.ok, false);
});
check('unknown/unresolvable ALT reference -> rejected, not thrown', () => {
  const r = auditResizeClaimTx(fx.claimTxBase64, { kind: 'claim', mints: [fx.claim.mint] }, intent, {});
  assert.strictEqual(r.ok, false);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
