/**
 * ME Sell canonical auditor — offline regression suite.
 *
 * Fixtures are SYNTHETIC-BUT-EVIDENCE-GROUNDED: every discriminator, data
 * tail, account count, and the real on-chain price come from two REAL,
 * settled, successful mainnet M2 accept-offer transactions decoded
 * read-only this session (see me-sell-auditor.ts's header for the exact
 * signatures and the lamport-for-lamport reconciliation that proved the
 * price field's location). Only the transaction ENVELOPE and the
 * unidentified filler accounts are synthetic — the real transactions are
 * natively v0+ALT-encoded (a different wire format than this tool's actual
 * legacy-`Transaction` production code ever produces), so a byte-for-byte
 * re-serialization was not attempted; instead the real instruction content
 * (program, discriminator, data, and every account this audit could
 * independently confirm — mint, auction house, metadata PDA, seller's ATA)
 * is reproduced directly as an in-memory `Transaction`/`TransactionInstruction`
 * object, which is all `auditMeSellTransaction` ever consumes.
 *
 * Run: `npm run test:me-sell-auditor`.
 */
import assert from 'assert';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { auditMeSellTransaction, type FrozenMeSellIntent } from '../me-sell-auditor';
import { deriveBuyerEscrowPda } from '../me-bid-escrow';

let passed = 0; let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}

const M2_PROGRAM_ID = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_RENT_ID = new PublicKey('SysvarRent111111111111111111111111111111111');
const AUTH_RULES_PROGRAM_ID = new PublicKey('auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg');
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

function rand(): PublicKey { return Keypair.generate().publicKey; }
function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function u64le(decimal: string): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(decimal));
  return b;
}

interface Fixture {
  seller: PublicKey; buyer: PublicKey; mint: PublicKey; auctionHouse: PublicKey;
  priceLamports: string;
  sellIx: TransactionInstruction; executeIx: TransactionInstruction;
}

/** pNFT fixture — 22-account Sell / 29-account ExecuteSaleV2, real
 *  discriminators/tail bytes, real required accounts (mint, auctionHouse,
 *  metadataPda, sellerAta, buyerEscrowPda, seller, program IDs), padded
 *  with random filler to hit the exact real-observed account counts. */
function buildPnftFixture(overrides: Partial<{ seller: PublicKey; buyer: PublicKey; mint: PublicKey; auctionHouse: PublicKey; priceLamports: string }> = {}): Fixture {
  const seller = overrides.seller ?? rand();
  const buyer = overrides.buyer ?? rand();
  const mint = overrides.mint ?? rand();
  const auctionHouse = overrides.auctionHouse ?? rand();
  const priceLamports = overrides.priceLamports ?? '9065000000';
  const metadata = metadataPda(mint);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller, false);
  const buyerEscrow = new PublicKey(deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.toBase58())!);

  const sellRequired = [seller, mint, auctionHouse, TOKEN_PROGRAM_ID, TOKEN_METADATA_PROGRAM_ID, ATA_PROGRAM_ID,
    SYSVAR_INSTRUCTIONS_ID, SYSVAR_RENT_ID, AUTH_RULES_PROGRAM_ID, metadata, sellerAta, buyer, SystemProgram.programId];
  const sellKeys = [...sellRequired, ...Array.from({ length: 22 - sellRequired.length }, rand)]
    .map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }));
  const sellIx = new TransactionInstruction({
    programId: M2_PROGRAM_ID, keys: sellKeys,
    data: Buffer.concat([Buffer.from('3a32ac6fa697165e', 'hex'), u64le(priceLamports), Buffer.from('ffffffffffffffff', 'hex')]),
  });

  const executeRequired = [seller, mint, auctionHouse, TOKEN_PROGRAM_ID, TOKEN_METADATA_PROGRAM_ID, ATA_PROGRAM_ID,
    SYSVAR_INSTRUCTIONS_ID, SYSVAR_RENT_ID, AUTH_RULES_PROGRAM_ID, metadata, buyerEscrow, buyer, SystemProgram.programId];
  const executeKeys = [...executeRequired, ...Array.from({ length: 29 - executeRequired.length }, rand)]
    .map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }));
  const executeIx = new TransactionInstruction({
    programId: M2_PROGRAM_ID, keys: executeKeys,
    data: Buffer.concat([Buffer.from('eca3ccad4790eb76', 'hex'), u64le(priceLamports), Buffer.from('0000c800', 'hex')]),
  });

  return { seller, buyer, mint, auctionHouse, priceLamports, sellIx, executeIx };
}

/** MPL Core fixture — 12-account Sell / 22-account ExecuteSaleV2. Core has
 *  no metadata PDA / ATA (the asset account IS the identity), so those are
 *  correctly absent from the required set — matches the auditor's own
 *  standard branch. */
function buildCoreFixture(overrides: Partial<{ seller: PublicKey; buyer: PublicKey; mint: PublicKey; auctionHouse: PublicKey; priceLamports: string }> = {}): Fixture {
  const seller = overrides.seller ?? rand();
  const buyer = overrides.buyer ?? rand();
  const mint = overrides.mint ?? rand(); // the Core asset address
  const auctionHouse = overrides.auctionHouse ?? rand();
  const priceLamports = overrides.priceLamports ?? '4980000000';
  const buyerEscrow = new PublicKey(deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.toBase58())!);

  const sellRequired = [seller, mint, auctionHouse, TOKEN_PROGRAM_ID, MPL_CORE_PROGRAM_ID, buyer, SystemProgram.programId];
  const sellKeys = [...sellRequired, ...Array.from({ length: 12 - sellRequired.length }, rand)]
    .map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }));
  const sellIx = new TransactionInstruction({
    programId: M2_PROGRAM_ID, keys: sellKeys,
    data: Buffer.concat([Buffer.from('1ff3f73b8653a5da', 'hex'), u64le(priceLamports), Buffer.from('ffffffffffffffff00', 'hex')]),
  });

  const executeRequired = [seller, mint, auctionHouse, TOKEN_PROGRAM_ID, MPL_CORE_PROGRAM_ID, buyerEscrow, buyer, SystemProgram.programId];
  const executeKeys = [...executeRequired, ...Array.from({ length: 22 - executeRequired.length }, rand)]
    .map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }));
  const executeIx = new TransactionInstruction({
    programId: M2_PROGRAM_ID, keys: executeKeys,
    data: Buffer.concat([Buffer.from('d562c518f2359a23', 'hex'), u64le(priceLamports), Buffer.from('0000c80000', 'hex')]),
  });

  return { seller, buyer, mint, auctionHouse, priceLamports, sellIx, executeIx };
}

function buildTx(fx: Fixture, opts: { sellerSigned?: boolean; extraIxs?: TransactionInstruction[] } = {}): Transaction {
  const tx = new Transaction({ feePayer: fx.seller, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  for (const ix of opts.extraIxs ?? []) tx.add(ix);
  tx.add(fx.sellIx, fx.executeIx);
  // 2 signature slots: seller + cosigner. Cosigner's slot always carries a
  // real signature (that's ME's job, unrelated to this test) — represented
  // here with 64 zero bytes (auditor never calls verifySignatures itself).
  const cosigner = Keypair.generate();
  tx.signatures = [
    { publicKey: fx.seller, signature: opts.sellerSigned ? Buffer.alloc(64, 1) : null },
    { publicKey: cosigner.publicKey, signature: Buffer.alloc(64, 2) },
  ];
  return tx;
}

function intentFor(fx: Fixture, standard: 'pnft' | 'mplCore'): FrozenMeSellIntent {
  return { seller: fx.seller.toBase58(), mint: fx.mint.toBase58(), buyer: fx.buyer.toBase58(), auctionHouse: fx.auctionHouse.toBase58(), priceLamports: fx.priceLamports, standard };
}

// ── positive cases ──────────────────────────────────────────────────────
console.log('positive cases (real discriminators/accounts/price)');
check('pNFT: correct fixture, unsigned (build-time) -> ok', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('pNFT: correct fixture, signed (submit-time) -> ok', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx, { sellerSigned: true }), intentFor(fx, 'pnft'), 'present');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('MPL Core: correct fixture -> ok', () => {
  const fx = buildCoreFixture();
  const r = auditMeSellTransaction(buildTx(fx), intentFor(fx, 'mplCore'), 'absent');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});

// ── MS-2: exact price ─────────────────────────────────────────────────────
console.log('exact price authorization (MS-2)');
check('price -1 lamport -> rejected', () => {
  const fx = buildPnftFixture();
  const bad = buildPnftFixture({ ...fx, priceLamports: (BigInt(fx.priceLamports) - 1n).toString() });
  const r = auditMeSellTransaction(buildTx({ ...fx, sellIx: bad.sellIx, executeIx: bad.executeIx }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('price +1 lamport -> rejected', () => {
  const fx = buildPnftFixture();
  const bad = buildPnftFixture({ ...fx, priceLamports: (BigInt(fx.priceLamports) + 1n).toString() });
  const r = auditMeSellTransaction(buildTx({ ...fx, sellIx: bad.sellIx, executeIx: bad.executeIx }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('zero price -> rejected', () => {
  const fx = buildPnftFixture();
  const bad = buildPnftFixture({ ...fx, priceLamports: '0' });
  const r = auditMeSellTransaction(buildTx({ ...fx, sellIx: bad.sellIx, executeIx: bad.executeIx }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('price mismatched BETWEEN sell and execute_sale instructions -> rejected', () => {
  const fx = buildPnftFixture();
  const other = buildPnftFixture({ ...fx, priceLamports: '1' });
  const r = auditMeSellTransaction(buildTx({ ...fx, executeIx: other.executeIx }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});

// ── instruction identity ───────────────────────────────────────────────
console.log('instruction identity');
check('wrong Sell discriminator -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.instructions[0].data = Buffer.concat([Buffer.from('0000000000000000', 'hex'), tx.instructions[0].data.subarray(8)]);
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('unknown ExecuteSaleV2 discriminator (swapped for something else) -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.instructions[1].data = Buffer.concat([Buffer.from('1111111111111111', 'hex'), tx.instructions[1].data.subarray(8)]);
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('Sell/ExecuteSaleV2 discriminators from DIFFERENT variants (pnft Sell + core ExecuteSaleV2) -> rejected', () => {
  const pnft = buildPnftFixture();
  const core = buildCoreFixture();
  const tx = buildTx({ ...pnft, executeIx: core.executeIx });
  const r = auditMeSellTransaction(tx, intentFor(pnft, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('extra M2 instruction -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.add(fx.sellIx);
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});

// ── account identity ────────────────────────────────────────────────────
console.log('account identity');
check('wrong mint -> rejected', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), { ...intentFor(fx, 'pnft'), mint: rand().toBase58() }, 'absent');
  assert.strictEqual(r.ok, false);
});
check('wrong buyer -> rejected', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), { ...intentFor(fx, 'pnft'), buyer: rand().toBase58() }, 'absent');
  assert.strictEqual(r.ok, false);
});
check('wrong seller -> rejected', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), { ...intentFor(fx, 'pnft'), seller: rand().toBase58() }, 'absent');
  assert.strictEqual(r.ok, false);
});
check('wrong auction house -> rejected', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), { ...intentFor(fx, 'pnft'), auctionHouse: rand().toBase58() }, 'absent');
  assert.strictEqual(r.ok, false);
});
check('missing seller ATA (mint present but seller never held any ATA for it) -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  // remove the seller ATA key specifically, replace with a random filler
  const ata = getAssociatedTokenAddressSync(fx.mint, fx.seller, false).toBase58();
  const idx = tx.instructions[0].keys.findIndex((k) => k.pubkey.toBase58() === ata);
  tx.instructions[0].keys[idx] = { pubkey: rand(), isSigner: false, isWritable: true };
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('missing metadata PDA -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  const md = metadataPda(fx.mint).toBase58();
  const idx = tx.instructions[0].keys.findIndex((k) => k.pubkey.toBase58() === md);
  tx.instructions[0].keys[idx] = { pubkey: rand(), isSigner: false, isWritable: true };
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('missing buyer escrow PDA in execute_sale -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  const escrow = deriveBuyerEscrowPda(fx.auctionHouse.toBase58(), fx.buyer.toBase58())!;
  const idx = tx.instructions[1].keys.findIndex((k) => k.pubkey.toBase58() === escrow);
  tx.instructions[1].keys[idx] = { pubkey: rand(), isSigner: false, isWritable: true };
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('wrong account count (one extra account appended) -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.instructions[0].keys.push({ pubkey: rand(), isSigner: false, isWritable: true });
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});

// ── envelope ────────────────────────────────────────────────────────────
console.log('envelope');
check('wrong fee payer -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.feePayer = rand();
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('wrong signer count (3 signatures) -> rejected', () => {
  const fx = buildPnftFixture();
  const tx = buildTx(fx);
  tx.signatures.push({ publicKey: rand(), signature: Buffer.alloc(64, 3) });
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('unknown signer (cosigner replaced by an unrelated pubkey — still just structurally 2 signers, not itself rejected by identity, but seller must still be found)', () => {
  // Structural check: as long as seller is present and exactly 2 sigs exist, this alone is not rejected here —
  // cryptographic legitimacy of "who" the cosigner is stays verifySignatures(true)'s job (unchanged, untouched).
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('SystemProgram transfer appended as a top-level instruction -> rejected', () => {
  const fx = buildPnftFixture();
  const transfer = SystemProgram.transfer({ fromPubkey: fx.seller, toPubkey: rand(), lamports: 1_000_000 });
  const tx = buildTx(fx, { extraIxs: [transfer] });
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('extra application instruction (unknown program) -> rejected', () => {
  const fx = buildPnftFixture();
  const bogus = new TransactionInstruction({ programId: rand(), keys: [], data: Buffer.from([1, 2, 3]) });
  const tx = buildTx(fx, { extraIxs: [bogus] });
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});

// ── ComputeBudget containment ───────────────────────────────────────────
console.log('ComputeBudget containment');
check('no ComputeBudget instructions -> still accepted (0 is a valid observed count)', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('real observed 2-instruction ComputeBudget shape (limit+price) -> accepted', () => {
  const fx = buildPnftFixture();
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const cb1 = ComputeBudgetProgram.setComputeUnitLimit({ units: 695_289 });
  const cb2 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 73_613 });
  const r = auditMeSellTransaction(buildTx(fx, { extraIxs: [cb1, cb2] }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
});
check('arbitrary/absurd CU price -> rejected', () => {
  const fx = buildPnftFixture();
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const cb1 = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const cb2 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }); // way above the 0.01 SOL worst-case ceiling at this CU limit
  const r = auditMeSellTransaction(buildTx(fx, { extraIxs: [cb1, cb2] }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('unknown ComputeBudget opcode -> rejected', () => {
  const fx = buildPnftFixture();
  const weird = new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from([99, 0, 0, 0, 0]) });
  const r = auditMeSellTransaction(buildTx(fx, { extraIxs: [weird] }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('duplicate ComputeBudget opcode -> rejected', () => {
  const fx = buildPnftFixture();
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const cb1 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  const cb2 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 });
  const r = auditMeSellTransaction(buildTx(fx, { extraIxs: [cb1, cb2] }), intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('ComputeBudget instruction placed AFTER the M2 instructions -> rejected', () => {
  const fx = buildPnftFixture();
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const tx = new Transaction({ feePayer: fx.seller, recentBlockhash: rand().toBase58() });
  tx.add(fx.sellIx, fx.executeIx, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.signatures = [{ publicKey: fx.seller, signature: null }, { publicKey: rand(), signature: Buffer.alloc(64, 2) }];
  const r = auditMeSellTransaction(tx, intentFor(fx, 'pnft'), 'absent');
  assert.strictEqual(r.ok, false);
});

// ── standard gate ────────────────────────────────────────────────────────
console.log('standard gate (MS-6)');
check('pnft fixture with intent.standard=mplCore -> rejected (standard mismatch)', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), intentFor(fx, 'mplCore'), 'absent');
  assert.strictEqual(r.ok, false);
});
check('unsupported standard string in frozen intent -> rejected before any structural check', () => {
  const fx = buildPnftFixture();
  const r = auditMeSellTransaction(buildTx(fx), { ...intentFor(fx, 'pnft'), standard: 'legacy' as unknown as 'pnft' }, 'absent');
  assert.strictEqual(r.ok, false);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
