// Candy Mint structural-auditor regression suite.
//
//   cd frontend && npx tsc src/app/tools/candy-mint/{intent,audit,audit.test}.ts \
//     --outDir /tmp/cma --module commonjs --target es2020 --esModuleInterop \
//     --strict --skipLibCheck --resolveJsonModule && node /tmp/cma/app/tools/candy-mint/audit.test.js
//
// Two clearly-separated halves:
//   A. REAL PRODUCTION BUILDER OUTPUT — the exact base64 produced by
//      src/candy-mint/build.ts against live candy machines (captured
//      read-only, no signing) — must pass auditCandyMintTx unchanged.
//   B. SYNTHETIC ADVERSARIAL transactions — the real bytes deliberately
//      mutated/reconstructed — must be rejected.

import assert from 'assert';
import {
  Transaction, PublicKey, SystemProgram, TransactionInstruction, Keypair,
} from '@solana/web3.js';
import { auditCandyMintTx, PROGRAMS } from './audit';
import {
  paymentAuthorizationMatches, guardSetMatches, canonicalGuards,
  type FrozenMintIntent, type ResolvedGuardPayment, type PaymentAuthorization,
} from './intent';
import coreFixtureRaw from './fixtures/core-mintv1.json';
import legacyFixtureRaw from './fixtures/legacy-mintv1.json';

interface Fixture {
  family: string;
  frozenIntent: {
    wallet: string; family: string; candyMachine: string; candyGuard: string;
    collection: string; collectionUpdateAuthority: string | null; group: string | null;
    enabledGuards: string[];
  };
  build: {
    transactionBase64: string; asset: string; feePayer: string;
    blockhash: string; lastValidBlockHeight: number;
    resolvedGuardPayment: ResolvedGuardPayment;
    resolvedEnabledGuards: string[];
  };
}
const coreFixture = coreFixtureRaw as unknown as Fixture;
const legacyFixture = legacyFixtureRaw as unknown as Fixture;

let passed = 0;
function check(label: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL  ${label}\n      ${(e as Error).message}`); process.exitCode = 1; }
}



function intentOf(fx: Fixture): FrozenMintIntent {
  const fi = fx.frozenIntent;
  return {
    wallet: fi.wallet,
    family: fi.family as 'core' | 'legacy',
    candyMachine: fi.candyMachine,
    candyGuard: fi.candyGuard,
    collection: fi.collection,
    collectionUpdateAuthority: fi.collectionUpdateAuthority ?? null,
    group: fi.group,
    quantity: 1,
    // At capture time the reviewed payment == what the build resolved.
    payment: { ...fx.build.resolvedGuardPayment },
    enabledGuards: fi.enabledGuards ?? [],
  };
}

// Re-serialize a (possibly mutated) tx WITHOUT dropping the backend's
// pre-filled asset signature — mirrors how the real bytes travel.
function reserialize(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
function parse(b64: string): Transaction {
  return Transaction.from(Buffer.from(b64, 'base64'));
}

const FIX: Array<{ name: 'core' | 'legacy'; fx: Fixture }> = [
  { name: 'core', fx: coreFixture },
  { name: 'legacy', fx: legacyFixture },
];

// ── Provenance: the fixtures ARE real builder output, not synthetic ───────
console.log('fixture provenance (real production builder output)');
for (const { name, fx } of FIX) {
  const raw = name === 'core' ? (coreFixtureRaw as Record<string, unknown>) : (legacyFixtureRaw as Record<string, unknown>);
  check(`${name}: captured from a real landed reference signature`, () => {
    assert.ok(typeof raw.referenceSignature === 'string' && (raw.referenceSignature as string).length > 80);
    assert.ok(Array.isArray(raw.observedLayout) && (raw.observedLayout as unknown[]).length === 3);
  });
  check(`${name}: fixture tx is real base64 that deserializes to [CB, CB, Candy Guard]`, () => {
    const tx = parse(fx.build.transactionBase64);
    assert.strictEqual(tx.instructions.length, 3);
    assert.strictEqual(tx.instructions[0].programId.toBase58(), PROGRAMS.computeBudget);
    assert.strictEqual(tx.instructions[1].programId.toBase58(), PROGRAMS.computeBudget);
    const guardPid = tx.instructions[2].programId.toBase58();
    assert.strictEqual(guardPid, name === 'core' ? PROGRAMS.coreCandyGuard : PROGRAMS.legacyCandyGuard);
    // the asset keypair is pre-signed by the builder; only the wallet slot is open
    const assetSig = tx.signatures.find((s) => s.publicKey.toBase58() === fx.build.asset);
    assert.ok(assetSig?.signature, 'asset must be pre-signed');
  });
}

// ── A. real builder output passes unchanged ───────────────────────────────
console.log('A. real production builder output');
for (const { name, fx } of FIX) {
  check(`${name}: real ${fx.build.transactionBase64.length}-char builder tx passes the auditor`, () => {
    const r = auditCandyMintTx(fx.build.transactionBase64, intentOf(fx), { expectedAsset: fx.build.asset });
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
  });
  check(`${name}: passes with connectedWallet == frozen wallet`, () => {
    const r = auditCandyMintTx(fx.build.transactionBase64, intentOf(fx), {
      expectedAsset: fx.build.asset, connectedWallet: fx.frozenIntent.wallet,
    });
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
  });
  check(`${name}: re-serialized (unchanged) still passes — proves reserialize() is faithful`, () => {
    const r = auditCandyMintTx(reserialize(parse(fx.build.transactionBase64)), intentOf(fx), { expectedAsset: fx.build.asset });
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
  });
}

// ── B. adversarial rejections ────────────────────────────────────────────
console.log('B. adversarial transactions are rejected');
const OTHER = Keypair.generate().publicKey.toBase58();

function expectReject(label: string, name: 'core' | 'legacy', mutate: (tx: Transaction) => void, matcher?: RegExp) {
  check(`${name}: ${label}`, () => {
    const fx = FIX.find((f) => f.name === name)!.fx;
    const tx = parse(fx.build.transactionBase64);
    mutate(tx);
    const r = auditCandyMintTx(reserialize(tx), intentOf(fx), { expectedAsset: fx.build.asset });
    assert.strictEqual(r.ok, false, 'expected rejection');
    if (matcher && !r.ok) assert.ok(matcher.test(r.reason), `reason "${r.reason}" did not match ${matcher}`);
  });
}

for (const name of ['core', 'legacy'] as const) {
  const guardIx = (tx: Transaction) => tx.instructions[tx.instructions.length - 1];

  expectReject('wrong fee payer', name, (tx) => { tx.feePayer = new PublicKey(OTHER); }, /fee payer/);

  expectReject('wrong candyMachine (account #2)', name, (tx) => { guardIx(tx).keys[2].pubkey = new PublicKey(OTHER); }, /candyMachine/);
  expectReject('wrong candyGuard (account #0)', name, (tx) => { guardIx(tx).keys[0].pubkey = new PublicKey(OTHER); }, /candyGuard/);
  expectReject('wrong payer (account #4)', name, (tx) => { guardIx(tx).keys[4].pubkey = new PublicKey(OTHER); }, /payer/);
  expectReject('wrong minter (account #5)', name, (tx) => { guardIx(tx).keys[5].pubkey = new PublicKey(OTHER); }, /minter/);

  expectReject('unexpected top-level SystemProgram transfer appended', name, (tx) => {
    tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer!, toPubkey: new PublicKey(OTHER), lamports: 1_000_000 }));
  }, /after the Candy Guard|unexpected top-level program|SystemProgram value transfer/);

  expectReject('unexpected top-level SPL Token transfer appended', name, (tx) => {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.splToken),
      keys: [
        { pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true },
        { pubkey: tx.feePayer!, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]), // Transfer
    }));
  }, /after the Candy Guard|unexpected top-level program|SPL Token instruction/);

  expectReject('Approve appended', name, (tx) => {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.splToken),
      keys: [{ pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true }],
      data: Buffer.from([4, 0, 0, 0, 0, 0, 0, 0, 0]),
    }));
  }, /after the Candy Guard|unexpected top-level program|SPL Token instruction/);

  expectReject('SetAuthority appended', name, (tx) => {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.splToken),
      keys: [{ pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true }],
      data: Buffer.from([6, 0]),
    }));
  }, /after the Candy Guard|unexpected top-level program|SPL Token instruction/);

  expectReject('CloseAccount appended', name, (tx) => {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.splToken),
      keys: [{ pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true }],
      data: Buffer.from([9]),
    }));
  }, /after the Candy Guard|unexpected top-level program|SPL Token instruction/);

  expectReject('unknown program instruction appended', name, (tx) => {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(OTHER),
      keys: [],
      data: Buffer.from([0]),
    }));
  }, /unexpected top-level program|after the Candy Guard/);

  expectReject('extra ComputeBudget SetComputeUnitLimit (duplicate)', name, (tx) => {
    const cb = tx.instructions[0];
    tx.instructions.splice(1, 0, new TransactionInstruction({ programId: cb.programId, keys: [], data: Buffer.from(cb.data) }));
  }, /duplicate SetComputeUnitLimit/);

  expectReject('ComputeBudget price raised past ceiling', name, (tx) => {
    const priceIx = tx.instructions.find((ix) => ix.programId.toBase58() === PROGRAMS.computeBudget && ix.data[0] === 3)!;
    const d = Buffer.from(priceIx.data);
    d.writeBigUInt64LE(BigInt(50_000_000), 1);
    priceIx.data = d;
  }, /compute unit price/);

  expectReject('ComputeBudget limit changed', name, (tx) => {
    const limitIx = tx.instructions.find((ix) => ix.programId.toBase58() === PROGRAMS.computeBudget && ix.data[0] === 2)!;
    const d = Buffer.from(limitIx.data);
    d.writeUInt32LE(1_200_000, 1);
    limitIx.data = d;
  }, /compute unit limit/);

  expectReject('guard discriminator corrupted', name, (tx) => {
    const g = guardIx(tx);
    const d = Buffer.from(g.data);
    d[0] = d[0] ^ 0xff;
    g.data = d;
  }, /discriminator/);

  // extra account spliced into the guard instruction — the ONLY way an
  // unauthorized payment-affecting account could ride alongside the legit
  // one. Count now exceeds what the reviewed guard set allows.
  expectReject('extra account appended to the Candy Guard instruction', name, (tx) => {
    guardIx(tx).keys.push({ pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true });
  }, /accounts; the reviewed guard set/);

  expectReject('extra WRITABLE attacker destination spliced beside the real one', name, (tx) => {
    const g = guardIx(tx);
    // keep the real solPayment destination, add a second writable account
    g.keys.splice(g.keys.length, 0, { pubkey: new PublicKey(OTHER), isSigner: false, isWritable: true });
  }, /accounts; the reviewed guard set/);

  expectReject('a guard account removed from the guard instruction', name, (tx) => {
    guardIx(tx).keys.pop();
  }, /accounts; the reviewed guard set/);
}

// collection pin (family-specific indexes)
expectReject('core: wrong collection (#8)', 'core', (tx) => {
  tx.instructions[tx.instructions.length - 1].keys[8].pubkey = new PublicKey(OTHER);
}, /collection/);
expectReject('legacy: wrong collectionMint (#13)', 'legacy', (tx) => {
  tx.instructions[tx.instructions.length - 1].keys[13].pubkey = new PublicKey(OTHER);
}, /collectionMint/);

// explicit opts-based checks
console.log('B2. opts-based rejections');
for (const fx of [coreFixture, legacyFixture]) {
  check(`${fx.frozenIntent.family}: expectedAsset mismatch (asset substituted) is rejected`, () => {
    const r = auditCandyMintTx(fx.build.transactionBase64, intentOf(fx), { expectedAsset: OTHER });
    assert.strictEqual(r.ok, false);
    assert.ok(!r.ok && /(asset|nftMint)/.test(r.reason));
  });
}
check('legacy: connectedWallet != frozen wallet is rejected before Phantom', () => {
  const fx = legacyFixture;
  const r = auditCandyMintTx(fx.build.transactionBase64, intentOf(fx), { expectedAsset: fx.build.asset, connectedWallet: OTHER });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /connected wallet/.test(r.reason));
});
check('legacy: substituted solPayment destination is rejected (containment)', () => {
  const fx = legacyFixture;
  const intent = intentOf(fx);
  // reviewed config says pay X; the built tx pays X. Now claim the reviewed
  // config expected a DIFFERENT destination -> built tx no longer contains it.
  const tampered: FrozenMintIntent = { ...intent, payment: { ...intent.payment, solPaymentDestination: OTHER } };
  const r = auditCandyMintTx(fx.build.transactionBase64, tampered, { expectedAsset: fx.build.asset });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /payment destination/.test(r.reason));
});
check('core: addressGate to a different wallet is rejected', () => {
  const fx = coreFixture;
  const intent = intentOf(fx);
  const gated: FrozenMintIntent = { ...intent, payment: { ...intent.payment, addressGateAddress: OTHER } };
  const r = auditCandyMintTx(fx.build.transactionBase64, gated, { expectedAsset: fx.build.asset });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /address-gated/.test(r.reason));
});
check('core: addressGate to the connected wallet passes', () => {
  const fx = coreFixture;
  const intent = intentOf(fx);
  const gated: FrozenMintIntent = { ...intent, payment: { ...intent.payment, addressGateAddress: intent.wallet } };
  const r = auditCandyMintTx(fx.build.transactionBase64, gated, { expectedAsset: fx.build.asset });
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('not-a-transaction base64 fails closed', () => {
  const r = auditCandyMintTx(Buffer.from('not a tx').toString('base64'), intentOf(coreFixture), { expectedAsset: OTHER });
  assert.strictEqual(r.ok, false);
});

// exact-count check: real fixtures' guard-ix account count matches the table
for (const { name, fx } of FIX) {
  check(`${name}: real guard-ix account count matches the GUARD_MINT_ACCOUNTS table for its reviewed guards`, () => {
    const r = auditCandyMintTx(fx.build.transactionBase64, intentOf(fx), { expectedAsset: fx.build.asset });
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason); // passes -> count is exactly base + Σ(guard extras)
  });
}
check('core: reviewed guards claim mintLimit that the built tx does NOT include -> count mismatch REJECT', () => {
  const intent = intentOf(coreFixture);
  const widened: FrozenMintIntent = { ...intent, enabledGuards: [...intent.enabledGuards, 'mintLimit'] };
  const r = auditCandyMintTx(coreFixture.build.transactionBase64, widened, { expectedAsset: coreFixture.build.asset });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /accounts; the reviewed guard set/.test(r.reason));
});
check('legacy: reviewed guard set narrower than the built tx -> count mismatch REJECT', () => {
  const intent = intentOf(legacyFixture);
  const narrowed: FrozenMintIntent = { ...intent, enabledGuards: [] }; // claim NO guards, tx has solPayment
  const r = auditCandyMintTx(legacyFixture.build.transactionBase64, narrowed, { expectedAsset: legacyFixture.build.asset });
  assert.strictEqual(r.ok, false);
});
check('an unknown/freeze guard in the reviewed set -> exact count SKIPPED, other checks still apply', () => {
  const intent = intentOf(coreFixture);
  const withFreeze: FrozenMintIntent = { ...intent, enabledGuards: [...intent.enabledGuards, 'freezeSolPayment'] };
  // real fixture bytes still pass the rest of the auditor (freeze skips only the count check)
  const r = auditCandyMintTx(coreFixture.build.transactionBase64, withFreeze, { expectedAsset: coreFixture.build.asset });
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});

// ── D. partial-signature preservation (verification #7) ──────────────────
// NO real Phantom: a deterministic LOCAL Keypair stands in for the wallet
// signer. This proves the tx SHAPE the builder produces — asset pre-signed,
// wallet slot open — can be completed to a fully-valid 2-signature tx, and
// that a `serialize()` requiring all signatures fails closed if the asset
// signature were dropped. It does NOT claim to reproduce Phantom's exact
// internals; Phantom's signAllTransactions is a partialSign (it never clears
// existing sigs), and signAllAndSend serializes with requireAllSignatures so
// a dropped asset sig throws rather than broadcasts.
console.log('D. partial-signature preservation (local test signer)');
for (const { name, fx } of FIX) {
  check(`${name}: builder tx has asset sig FILLED, wallet slot EMPTY, no other signer`, () => {
    const tx = parse(fx.build.transactionBase64);
    const bySigner = new Map(tx.signatures.map((s) => [s.publicKey.toBase58(), s]));
    assert.ok(bySigner.get(fx.build.asset)?.signature, 'asset must be pre-signed');
    const walletSlot = bySigner.get(fx.frozenIntent.wallet);
    assert.ok(walletSlot && !walletSlot.signature, 'wallet slot must be present and empty');
    const otherUnsigned = tx.signatures.filter((s) => !s.signature && s.publicKey.toBase58() !== fx.frozenIntent.wallet);
    assert.strictEqual(otherUnsigned.length, 0, 'no third required signer');
  });

  check(`${name}: full serialize() THROWS while the wallet slot is empty (fails closed)`, () => {
    const tx = parse(fx.build.transactionBase64);
    assert.throws(() => tx.serialize(), /signature/i);
  });
}

// The web3.js Transaction partial-sign SEMANTICS that signAllAndSend relies
// on: a builder pre-signs the ephemeral asset; the wallet later adds its own
// signature; neither step clears the other. Two local keypairs (asset stand-
// in + wallet stand-in) over a minimal 2-signer legacy message.
{
  const assetKp = Keypair.generate();
  const walletKp = Keypair.generate();
  const build2SignerTx = () => {
    const t = new Transaction();
    t.add(new TransactionInstruction({
      programId: new PublicKey(PROGRAMS.system),
      keys: [
        { pubkey: walletKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: assetKp.publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.from([0]),
    }));
    t.feePayer = walletKp.publicKey;
    t.recentBlockhash = '11111111111111111111111111111111';
    return t;
  };

  check('builder partialSign(asset) — asset sig filled, wallet slot open, serialize(full) throws', () => {
    const t = build2SignerTx();
    t.partialSign(assetKp);
    const bs = new Map(t.signatures.map((s) => [s.publicKey.toBase58(), s]));
    assert.ok(bs.get(assetKp.publicKey.toBase58())?.signature);
    assert.ok(!bs.get(walletKp.publicKey.toBase58())?.signature);
    assert.throws(() => t.serialize(), /signature/i);
  });

  check('wallet partialSign() AFTER builder — preserves asset sig byte-for-byte, both verify, full serialize OK', () => {
    const t = build2SignerTx();
    t.partialSign(assetKp);
    const assetBefore = Buffer.from(t.signatures.find((s) => s.publicKey.equals(assetKp.publicKey))!.signature!);
    // Phantom-equivalent for a multi-signer legacy tx (signAllAndSend path)
    t.partialSign(walletKp);
    const assetAfter = t.signatures.find((s) => s.publicKey.equals(assetKp.publicKey))!.signature!;
    assert.strictEqual(Buffer.compare(assetBefore, assetAfter), 0, 'asset signature unchanged');
    assert.ok(t.signatures.find((s) => s.publicKey.equals(walletKp.publicKey))!.signature, 'wallet signature added');
    const wire = t.serialize(); // requireAllSignatures + verifySignatures
    const round = Transaction.from(wire);
    assert.strictEqual(round.signatures.filter((s) => !!s.signature).length, 2);
    assert.ok(round.signatures.every((s) => s.signature && round.verifySignatures()));
  });

  check('order independence: wallet-first then asset also yields a valid 2-sig tx', () => {
    const t = build2SignerTx();
    t.partialSign(walletKp);
    t.partialSign(assetKp);
    assert.doesNotThrow(() => t.serialize());
    assert.strictEqual(Transaction.from(t.serialize()).signatures.filter((s) => !!s.signature).length, 2);
  });
}

// ── C. EXACT payment-authorization check (paymentAuthorizationMatches) ────
// The FINAL /build-tx re-reads live guard state and echoes back the payment
// it resolved (`resolvedGuardPayment`). The frontend compares it to the
// FROZEN reviewed payment — EXACTLY, no tolerance. A changed mint price ->
// no signature.
console.log('C. exact payment authorization (no tolerance)');

for (const fx of [coreFixture, legacyFixture]) {
  const fam = fx.frozenIntent.family;
  check(`${fam}: REAL build's resolvedGuardPayment == frozen reviewed payment -> ok`, () => {
    const r = paymentAuthorizationMatches(intentOf(fx).payment, { ...fx.build.resolvedGuardPayment });
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
  });
}

// SYNTHETIC adversarial: the on-chain guard changed between review and the
// final build. Base each case on the legacy fixture's real payment
// (solPayment: 100000000 -> Fyt98…).
{
  const base: PaymentAuthorization = { ...legacyFixture.build.resolvedGuardPayment };
  const rev = (p: Partial<PaymentAuthorization>): PaymentAuthorization => ({ ...base, ...p });
  const res = (p: Partial<PaymentAuthorization>): PaymentAuthorization => ({ ...base, ...p });
  const M = (reviewed: PaymentAuthorization, resolved: PaymentAuthorization) => paymentAuthorizationMatches(reviewed, resolved);

  check('reviewed 0.005 SOL -> final 0.014 SOL -> REJECT', () => {
    const r = M(rev({ solPaymentLamports: '5000000' }), res({ solPaymentLamports: '14000000' }));
    assert.strictEqual(r.ok, false);
    assert.ok(!r.ok && /SOL mint price changed/.test(r.reason));
  });
  check('reviewed 0.01 -> final 0.019 -> REJECT', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '10000000' }), res({ solPaymentLamports: '19000000' })).ok, false));
  check('reviewed 0.1 -> final 0.109 (a "small" 9%) -> REJECT (no tolerance)', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '100000000' }), res({ solPaymentLamports: '109000000' })).ok, false));
  check('reviewed 1.0 -> final 1.09 -> REJECT', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '1000000000' }), res({ solPaymentLamports: '1090000000' })).ok, false));
  check('reviewed 1.0 -> final 1.11 -> REJECT', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '1000000000' }), res({ solPaymentLamports: '1110000000' })).ok, false));
  check('reviewed 1.0 -> final 1.000000001 (1 lamport) -> REJECT (exact)', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '1000000000' }), res({ solPaymentLamports: '1000000001' })).ok, false));
  check('reviewed 1.0 -> final EXACTLY 1.0 -> OK', () =>
    assert.strictEqual(M(rev({ solPaymentLamports: '1000000000' }), res({ solPaymentLamports: '1000000000' })).ok, true));
  check('free mint reviewed -> final has a non-zero solPayment -> REJECT', () =>
    assert.strictEqual(M(
      rev({ solPaymentLamports: null, solPaymentDestination: null }),
      res({ solPaymentLamports: '10000000', solPaymentDestination: OTHER }),
    ).ok, false));
  check('SOL destination changed (same amount) -> REJECT', () => {
    const r = M(base, res({ solPaymentDestination: OTHER }));
    assert.strictEqual(r.ok, false);
    assert.ok(!r.ok && /SOL payment destination changed/.test(r.reason));
  });
  check('token payment amount changes by 1 unit -> REJECT', () => {
    const t = { mint: 'M', amount: '1000000', destinationAta: 'D', kind: 'spl' as const };
    const r = M(rev({ tokenPayment: t }), res({ tokenPayment: { ...t, amount: '1000001' } }));
    assert.strictEqual(r.ok, false);
    assert.ok(!r.ok && /token payment amount changed/.test(r.reason));
  });
  check('token destination changes -> REJECT', () => {
    const t = { mint: 'M', amount: '1000000', destinationAta: 'D', kind: 'spl' as const };
    assert.strictEqual(M(rev({ tokenPayment: t }), res({ tokenPayment: { ...t, destinationAta: OTHER } })).ok, false);
  });
  check('token mint changes -> REJECT', () => {
    const t = { mint: 'M', amount: '1000000', destinationAta: 'D', kind: 'spl' as const };
    assert.strictEqual(M(rev({ tokenPayment: t }), res({ tokenPayment: { ...t, mint: OTHER } })).ok, false);
  });
  check('reviewed token payment, final has NONE -> REJECT', () => {
    const t = { mint: 'M', amount: '1000000', destinationAta: 'D', kind: 'spl' as const };
    assert.strictEqual(M(rev({ tokenPayment: t }), res({ tokenPayment: null })).ok, false);
  });
  check('solFixedFee amount / destination changes -> REJECT', () => {
    assert.strictEqual(M(rev({ solFixedFeeLamports: '5000' }), res({ solFixedFeeLamports: '9000' })).ok, false);
    assert.strictEqual(M(rev({ solFixedFeeDestination: 'X' }), res({ solFixedFeeDestination: OTHER })).ok, false);
  });
  check('freezeSolPayment amount / destination changes -> REJECT (freeze guards covered)', () => {
    assert.strictEqual(M(rev({ freezeSolPaymentLamports: '5000' }), res({ freezeSolPaymentLamports: '9000' })).ok, false);
    assert.strictEqual(M(rev({ freezeSolPaymentDestination: 'X' }), res({ freezeSolPaymentDestination: OTHER })).ok, false);
  });
  check('freezeTokenPayment amount changes -> REJECT', () => {
    const t = { mint: 'M', amount: '5', destinationAta: 'D', kind: 'spl' as const };
    assert.strictEqual(M(rev({ freezeTokenPayment: t }), res({ freezeTokenPayment: { ...t, amount: '6' } })).ok, false);
  });
  check('addressGate changes -> REJECT', () =>
    assert.strictEqual(M(rev({ addressGateAddress: 'A' }), res({ addressGateAddress: OTHER })).ok, false));
  check('backend WIDENS: reviewed 0.1 to X, live changed to 0.2 to Y -> REJECT before Phantom', () =>
    assert.strictEqual(M(
      rev({ solPaymentLamports: '100000000', solPaymentDestination: 'X111111111111111111111111111111111111111111' }),
      res({ solPaymentLamports: '200000000', solPaymentDestination: 'Y222222222222222222222222222222222222222222' }),
    ).ok, false));
  check('identical PaymentAuthorization on both sides -> OK', () =>
    assert.strictEqual(M(base, { ...base }).ok, true));
}

// ── E. EXACT enabled-guard SET equality (guardSetMatches) ────────────────
// The account-count check cannot see: a 0-remaining-account guard added/
// removed (botTax / startDate / endDate / redeemedAmount / addressGate), or
// a same-count swap (mintLimit <-> allocation, startDate <-> endDate).
// guardSetMatches catches all of them.
console.log('E. exact enabled-guard set equality');

for (const fx of [coreFixture, legacyFixture]) {
  check(`${fx.frozenIntent.family}: REAL build's resolvedEnabledGuards == frozen reviewed set`, () => {
    const r = guardSetMatches(intentOf(fx).enabledGuards, fx.build.resolvedEnabledGuards);
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
  });
}

check('review ["solPayment","mintLimit"] / final ["solPayment","mintLimit"] -> PASS', () =>
  assert.strictEqual(guardSetMatches(['solPayment', 'mintLimit'], ['solPayment', 'mintLimit']).ok, true));
check('same set, different ORDER -> PASS (canonicalized)', () =>
  assert.strictEqual(guardSetMatches(['mintLimit', 'solPayment'], ['solPayment', 'mintLimit']).ok, true));
check('review ["startDate","solPayment"] / final ["solPayment","startDate"] -> PASS', () =>
  assert.strictEqual(guardSetMatches(['startDate', 'solPayment'], ['solPayment', 'startDate']).ok, true));
check('duplicates canonicalize away -> PASS', () =>
  assert.strictEqual(guardSetMatches(['solPayment', 'solPayment'], ['solPayment']).ok, true));

check('final ADDS "botTax" (0 remaining accounts) -> REJECT', () => {
  const r = guardSetMatches(['solPayment'], ['solPayment', 'botTax']);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /added botTax/.test(r.reason));
});
check('final REMOVES "mintLimit" -> REJECT', () => {
  const r = guardSetMatches(['solPayment', 'mintLimit'], ['solPayment']);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /removed mintLimit/.test(r.reason));
});
check('mintLimit -> allocation SUBSTITUTION (both 1 remaining account) -> REJECT', () => {
  const r = guardSetMatches(['solPayment', 'mintLimit'], ['solPayment', 'allocation']);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && /added allocation/.test(r.reason) && /removed mintLimit/.test(r.reason));
});
check('startDate -> endDate SUBSTITUTION (both 0 remaining accounts) -> REJECT', () => {
  const r = guardSetMatches(['startDate', 'solPayment'], ['endDate', 'solPayment']);
  assert.strictEqual(r.ok, false);
});
check('addressGate silently added -> REJECT (0 remaining accounts)', () =>
  assert.strictEqual(guardSetMatches(['solPayment'], ['solPayment', 'addressGate']).ok, false));
check('empty vs empty -> PASS', () =>
  assert.strictEqual(guardSetMatches([], []).ok, true));
check('canonicalGuards is sorted + unique', () => {
  assert.deepStrictEqual(canonicalGuards(['mintLimit', 'solPayment', 'mintLimit', 'botTax']), ['botTax', 'mintLimit', 'solPayment']);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
