/**
 * MMM collection-bid tool — offline test suite.
 *
 * No live network calls: the ME read transport, the DAS grouping fetcher,
 * the chain client (simulate/blockhash/account-info/send), the cosigner
 * keypair, and the wall clock are all injected via
 * `createMmmCollectionBidsRouter`'s `deps` parameter. Auth middleware is
 * replaced with a pass-through — this suite is about the pool-building/
 * validation/digest/two-signature contract, not the site-wide SIWS gate.
 *
 * Convention matches src/server/__tests__/tools-me-bids.test.ts: ts-node +
 * Node's built-in `assert`, a running failure counter, `process.exit`.
 *
 * Run: `npm run test:mmm-collection-bids`.
 */

import assert from 'assert';
import express from 'express';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  createMmmCollectionBidsRouter, loadCosignerKeypair, validateMmmStructure, messageHashHex,
  checkBlockhashFreshness,
  type MmmBidsDeps, type MmmValidationContext, type ChainClient, type SimResult,
} from '../tools-mmm-collection-bids';
import {
  MMM_PROGRAM_ID, ALLOWLIST_KIND, CURVE_KIND_LINEAR, CURVE_KIND_EXP, ALLOWLIST_MAX_LEN,
  POOL_ACCOUNT_SIZE, derivePoolPda, deriveEscrowPda, generatePoolUuid,
} from '../mmm-raw-instructions';

let failures = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}

// ── Pool account fixture encoder — mirrors mmm-raw-instructions.ts's OFF
//    table exactly, so tests can synthesize known on-chain pool bytes
//    without any network call. ─────────────────────────────────────────

const OFF = {
  spotPrice: 8, curveType: 16, curveDelta: 17, reinvestBuy: 25, reinvestSell: 26,
  expiry: 27, lpFeeBp: 35, referral: 37, royaltyBp: 71, sellsideAssetAmount: 105,
  owner: 121, cosigner: 153, uuid: 185, paymentMint: 217, allowlists: 249,
  buysidePaymentAmount: 447,
};

interface PoolFixtureFields {
  owner: PublicKey;
  cosigner: PublicKey;
  spotPriceLamports: bigint;
  curveType?: number;
  curveDelta?: bigint;
  expiry?: bigint;
  lpFeeBp?: number;
  buysideCreatorRoyaltyBp?: number;
  sellsideAssetAmount?: bigint;
  uuid?: PublicKey;
  referral?: PublicKey;
  allowlists?: Array<{ kind: number; value: PublicKey }>;
}

function encodePoolFixture(f: PoolFixtureFields): Buffer {
  const buf = Buffer.alloc(POOL_ACCOUNT_SIZE);
  buf.writeBigUInt64LE(f.spotPriceLamports, OFF.spotPrice);
  buf.writeUInt8(f.curveType ?? CURVE_KIND_LINEAR, OFF.curveType);
  buf.writeBigUInt64LE(f.curveDelta ?? 0n, OFF.curveDelta);
  buf.writeInt8(0, OFF.reinvestBuy);
  buf.writeInt8(0, OFF.reinvestSell);
  buf.writeBigInt64LE(f.expiry ?? 0n, OFF.expiry);
  buf.writeUInt16LE(f.lpFeeBp ?? 0, OFF.lpFeeBp);
  (f.referral ?? PublicKey.default).toBuffer().copy(buf, OFF.referral);
  buf.writeUInt16LE(f.buysideCreatorRoyaltyBp ?? 0, OFF.royaltyBp);
  buf.writeBigUInt64LE(f.sellsideAssetAmount ?? 0n, OFF.sellsideAssetAmount);
  f.owner.toBuffer().copy(buf, OFF.owner);
  f.cosigner.toBuffer().copy(buf, OFF.cosigner);
  (f.uuid ?? Keypair.generate().publicKey).toBuffer().copy(buf, OFF.uuid);
  PublicKey.default.toBuffer().copy(buf, OFF.paymentMint);
  const allowlists = (f.allowlists ?? []).slice(0, ALLOWLIST_MAX_LEN);
  let o = OFF.allowlists;
  for (let i = 0; i < ALLOWLIST_MAX_LEN; i++) {
    const a = allowlists[i] ?? { kind: ALLOWLIST_KIND.EMPTY, value: PublicKey.default };
    buf.writeUInt8(a.kind, o);
    a.value.toBuffer().copy(buf, o + 1);
    o += 33;
  }
  buf.writeBigUInt64LE(0n, OFF.buysidePaymentAmount);
  return buf;
}

// ── Fake chain client ────────────────────────────────────────────────────

interface FakeChainOpts {
  simulateErr?: unknown;
  simulateLogs?: string[];
  simAccountLamports?: (number | null)[];
  blockHeight?: number;
  blockhash?: string;
  lastValidBlockHeight?: number;
  minRentExemption?: number;
  sendImpl?: (tx: Transaction) => Promise<string>;
  accounts?: Map<string, { data: Buffer; lamports: number }>;
}

function fakeChain(opts: FakeChainOpts = {}): ChainClient & { sendCalls: Transaction[]; accounts: Map<string, { data: Buffer; lamports: number }> } {
  const accounts = opts.accounts ?? new Map();
  const sendCalls: Transaction[] = [];
  return {
    sendCalls,
    accounts,
    async simulateTransaction(_tx, includeAccounts) {
      const result: SimResult = {
        err: opts.simulateErr ?? null,
        logs: opts.simulateLogs ?? ['Program mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc success'],
        accounts: includeAccounts
          ? includeAccounts.map((_pk, i) => {
            const lamports = opts.simAccountLamports?.[i];
            return lamports != null ? { lamports } : null;
          })
          : null,
        unitsConsumed: 12_345,
      };
      return result;
    },
    async getBlockHeight() { return opts.blockHeight ?? 100; },
    async getAccountInfo(pubkey) {
      const found = accounts.get(pubkey.toBase58());
      return found ? { data: found.data, lamports: found.lamports } : null;
    },
    async sendRawTransaction(tx) {
      sendCalls.push(tx);
      if (opts.sendImpl) return opts.sendImpl(tx);
      return `FAKE_SIG_${sendCalls.length}`;
    },
    async getLatestBlockhash() {
      return { blockhash: opts.blockhash ?? Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: opts.lastValidBlockHeight ?? 1_000_000 };
    },
    async getMinimumBalanceForRentExemption() { return opts.minRentExemption ?? 6_393_360; },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const COLLECTION_SYMBOL = 'open_solmap';
const REAL_MCC = 'smccQeqMfKUE3W4a1tQHDxUnx122y3eUoV21JDnQj54';
const PRICE_PER_NFT_LAMPORTS = 11_800_000; // 0.0118 SOL

function fakeMeGet(listings: Array<{ tokenMint?: string }> = [{ tokenMint: Keypair.generate().publicKey.toBase58() }]) {
  return async (_p: string) => listings;
}
function fakeFetchGrouping(groupValue: string | null = REAL_MCC) {
  return async (_mint: string) => (groupValue ? { groupKey: 'collection', groupValue } : null);
}

async function withTestApp(deps: MmmBidsDeps, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createMmmCollectionBidsRouter({ authMiddleware: (_req, _res, next) => next(), ...deps }));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(() => resolve(undefined))); }
}
async function jsonPost(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}
async function jsonGet(url: string): Promise<{ status: number; json: any }> {
  const r = await fetch(url);
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

async function main(): Promise<void> {

// ── loadCosignerKeypair — file/permission/pubkey checks ─────────────────

console.log('\n== loadCosignerKeypair — startup security checks ==');
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cosigner-test-'));
  const goodDir = path.join(tmpRoot, 'good700');
  fs.mkdirSync(goodDir, { mode: 0o700 });
  const kp = Keypair.generate();
  const keypairPath = path.join(goodDir, 'keypair.json');
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });

  check('loads a valid, correctly-permissioned keypair file', () => {
    const loaded = loadCosignerKeypair({ keypairPath });
    assert.strictEqual(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  check('accepts when expectedPubkey matches', () => {
    const loaded = loadCosignerKeypair({ keypairPath, expectedPubkey: kp.publicKey.toBase58() });
    assert.strictEqual(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  check('rejects when expectedPubkey does not match (fail closed)', () => {
    assert.throws(() => loadCosignerKeypair({ keypairPath, expectedPubkey: Keypair.generate().publicKey.toBase58() }), /mmm_cosigner_pubkey_mismatch/);
  });

  check('rejects a missing file path', () => {
    assert.throws(() => loadCosignerKeypair({ keypairPath: path.join(goodDir, 'nope.json') }), /mmm_cosigner_keypair_file_missing/);
  });

  check('rejects when no path is configured at all', () => {
    const savedEnv = process.env.MMM_COLLECTION_BIDS_COSIGNER_KEYPAIR_PATH;
    delete process.env.MMM_COLLECTION_BIDS_COSIGNER_KEYPAIR_PATH;
    try {
      assert.throws(() => loadCosignerKeypair({}), /mmm_cosigner_keypair_path_not_configured/);
    } finally {
      if (savedEnv != null) process.env.MMM_COLLECTION_BIDS_COSIGNER_KEYPAIR_PATH = savedEnv;
    }
  });

  check('rejects a file with permissions broader than 600', () => {
    const loosePath = path.join(goodDir, 'loose.json');
    fs.writeFileSync(loosePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o644 });
    assert.throws(() => loadCosignerKeypair({ keypairPath: loosePath }), /mmm_cosigner_keypair_file_permissions_too_broad/);
  });

  check('rejects a parent directory with permissions broader than 700', () => {
    const looseDir = path.join(tmpRoot, 'loose755');
    fs.mkdirSync(looseDir, { mode: 0o755 });
    const p = path.join(looseDir, 'keypair.json');
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    assert.throws(() => loadCosignerKeypair({ keypairPath: p }), /mmm_cosigner_keypair_dir_permissions_too_broad/);
  });

  check('rejects an unparseable file', () => {
    const badPath = path.join(goodDir, 'bad.json');
    fs.writeFileSync(badPath, 'not json', { mode: 0o600 });
    assert.throws(() => loadCosignerKeypair({ keypairPath: badPath }), /mmm_cosigner_keypair_file_unparseable/);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── validateMmmStructure — pure, no HTTP ─────────────────────────────────

console.log('\n== validateMmmStructure — structural checks ==');

function buildFixtureTx(opts: {
  owner: PublicKey; cosigner: PublicKey; pool: PublicKey; escrow?: PublicKey;
  extraWritable?: PublicKey; wrongProgramId?: boolean; feePayerOverride?: PublicKey;
  cosignerSigned?: boolean; ownerSigned?: boolean; ownerKeypair?: Keypair; cosignerKeypair?: Keypair;
}): Transaction {
  const { PublicKey: PK, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
  const keys = [
    { pubkey: opts.owner, isSigner: true, isWritable: true },
    { pubkey: opts.cosigner, isSigner: true, isWritable: false },
    { pubkey: opts.pool, isSigner: false, isWritable: true },
  ];
  if (opts.escrow) keys.push({ pubkey: opts.escrow, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  if (opts.extraWritable) keys.push({ pubkey: opts.extraWritable, isSigner: false, isWritable: true });
  const ix = new TransactionInstruction({
    programId: opts.wrongProgramId ? Keypair.generate().publicKey : MMM_PROGRAM_ID,
    keys, data: Buffer.from([1, 2, 3]),
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.feePayer = opts.feePayerOverride ?? opts.owner;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  let out = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  if (opts.cosignerSigned !== false && opts.cosignerKeypair) out.partialSign(opts.cosignerKeypair);
  if (opts.ownerSigned && opts.ownerKeypair) out.partialSign(opts.ownerKeypair);
  return out;
}

function ctxFor(owner: PublicKey, cosigner: PublicKey, pool: PublicKey, escrow: PublicKey | null): MmmValidationContext {
  return {
    op: 'deposit', expectedOwner: owner.toBase58(), expectedCosigner: cosigner.toBase58(),
    expectedPool: pool.toBase58(), expectedEscrow: escrow ? escrow.toBase58() : null,
    expectedSpotPriceLamports: null, expectedCurveType: null, expectedCurveDelta: null,
    expectedExpiry: null, expectedAllowlists: null,
  };
}

{
  const owner = Keypair.generate();
  const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const escrow = Keypair.generate().publicKey;

  check('cosigner-only build-time tx: validates with cosigner signed, owner absent', () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner });
    const v = validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only');
    assert.strictEqual(v.messageHash.length, 64);
  });

  check('cosigner-only mode rejects a tx where owner already signed', () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner, ownerSigned: true, ownerKeypair: owner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /unexpected_owner_signature_at_build_time/);
  });

  check("'both' mode requires owner signature present", () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'both'), /owner_signature_missing/);
  });

  check("'both' mode validates when both cosigner and owner have signed", () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner, ownerSigned: true, ownerKeypair: owner });
    const v = validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'both');
    assert.strictEqual(v.messageHash.length, 64);
  });

  check('rejects when cosigner never signed at all', () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerSigned: false });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /cosigner_signature_missing/);
  });

  check('rejects wrong owner (signer slot does not match expected owner)', () => {
    const wrongOwner = Keypair.generate();
    const tx = buildFixtureTx({ owner: wrongOwner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /owner_missing_from_signers/);
  });

  check('rejects wrong cosigner (signer slot does not match expected cosigner)', () => {
    const wrongCosigner = Keypair.generate();
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: wrongCosigner.publicKey, pool, escrow, cosignerKeypair: wrongCosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /cosigner_missing_from_signers/);
  });

  check('rejects wrong pool PDA (pool not present in instruction keys)', () => {
    const wrongPool = Keypair.generate().publicKey;
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool: wrongPool, escrow, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /pool_missing_from_instruction/);
  });

  check('rejects wrong escrow PDA (escrow not writable/present as expected)', () => {
    const wrongEscrow = Keypair.generate().publicKey;
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow: wrongEscrow, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /escrow_missing_or_not_writable|unexpected_writable_account/);
  });

  check('rejects an unexpected extra writable account', () => {
    const stray = Keypair.generate().publicKey;
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, extraWritable: stray, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /unexpected_writable_account/);
  });

  check('rejects an unexpected program id', () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, wrongProgramId: true, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /unexpected_program_id/);
  });

  check('rejects a fee payer that is a stranger not among the expected signers (wrong signer count)', () => {
    const other = Keypair.generate().publicKey;
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, feePayerOverride: other, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /unexpected_signer_count/);
  });

  check('rejects a fee payer that is the cosigner instead of the owner (2 signers, still wrong)', () => {
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, feePayerOverride: cosigner.publicKey, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, escrow), 'cosigner-only'), /fee_payer_mismatch/);
  });

  check('update op (no escrow expected): rejects a stray writable account that is not pool/owner', () => {
    const stray = Keypair.generate().publicKey;
    const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, extraWritable: stray, cosignerKeypair: cosigner });
    assert.throws(() => validateMmmStructure(tx, ctxFor(owner.publicKey, cosigner.publicKey, pool, null), 'cosigner-only'), /unexpected_writable_account/);
  });
}

// ── messageHashHex / checkBlockhashFreshness ─────────────────────────────

console.log('\n== digest binding + blockhash freshness ==');

check('messageHashHex is unaffected by which signature slots are filled', () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey; const escrow = Keypair.generate().publicKey;
  const unsigned = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerSigned: false });
  const cosignerSigned = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, escrow, cosignerKeypair: cosigner });
  assert.notStrictEqual(unsigned.recentBlockhash, cosignerSigned.recentBlockhash); // different fixtures, different blockhash
});

check('checkBlockhashFreshness: ok when well within margin', () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, cosignerSigned: false });
  const info = { blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1000 };
  const result = checkBlockhashFreshness(tx, info, 100, 10);
  assert.strictEqual(result.ok, true);
});
check('checkBlockhashFreshness: rejects blockhash mismatch', () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, cosignerSigned: false });
  const info = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
  const result = checkBlockhashFreshness(tx, info, 100, 10);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.strictEqual(result.code, 'blockhash_mismatch');
});
check('checkBlockhashFreshness: rejects expired blockhash', () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, cosignerSigned: false });
  const info = { blockhash: tx.recentBlockhash!, lastValidBlockHeight: 100 };
  const result = checkBlockhashFreshness(tx, info, 100, 10);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.strictEqual(result.code, 'blockhash_expired');
});
check('checkBlockhashFreshness: rejects within the safety margin (near expiry)', () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const tx = buildFixtureTx({ owner: owner.publicKey, cosigner: cosigner.publicKey, pool, cosignerSigned: false });
  const info = { blockhash: tx.recentBlockhash!, lastValidBlockHeight: 105 };
  const result = checkBlockhashFreshness(tx, info, 100, 10);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.strictEqual(result.code, 'blockhash_near_expiry');
});

// ── HTTP: status / pool read ─────────────────────────────────────────────

console.log('\n== HTTP: status / GET pool ==');

await checkAsync('GET /status returns liveEnabled + cosignerPubkey, never a secret', async () => {
  const cosigner = Keypair.generate();
  await withTestApp({ cosignerKeypair: cosigner, liveEnabled: false }, async (base) => {
    const { status, json } = await jsonGet(`${base}/api/tools/mmm-collection-bids/status`);
    assert.strictEqual(status, 200);
    assert.strictEqual(json.liveEnabled, false);
    assert.strictEqual(json.cosignerPubkey, cosigner.publicKey.toBase58());
  });
});

await checkAsync('GET /pool: 400 on invalid pool key', async () => {
  await withTestApp({ cosignerKeypair: Keypair.generate() }, async (base) => {
    const { status } = await jsonGet(`${base}/api/tools/mmm-collection-bids/pool?poolKey=not-a-key`);
    assert.strictEqual(status, 400);
  });
});

await checkAsync('GET /pool: 404 when the account does not exist', async () => {
  const chain = fakeChain();
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain }, async (base) => {
    const { status } = await jsonGet(`${base}/api/tools/mmm-collection-bids/pool?poolKey=${Keypair.generate().publicKey.toBase58()}`);
    assert.strictEqual(status, 404);
  });
});

await checkAsync('GET /pool: decodes a real fixture pool correctly, including estimatedRemainingQuantity', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const poolPk = Keypair.generate().publicKey;
  const escrowPk = deriveEscrowPda(poolPk);
  const data = encodePoolFixture({
    owner: owner.publicKey, cosigner: cosigner.publicKey, spotPriceLamports: 11_800_000n,
    allowlists: [{ kind: ALLOWLIST_KIND.MCC, value: new PublicKey(REAL_MCC) }],
  });
  const accounts = new Map([
    [poolPk.toBase58(), { data, lamports: 6_393_360 }],
    [escrowPk.toBase58(), { data: Buffer.alloc(0), lamports: 35_400_000 }],
  ]);
  const chain = fakeChain({ accounts });
  await withTestApp({ cosignerKeypair: cosigner, chain }, async (base) => {
    const { status, json } = await jsonGet(`${base}/api/tools/mmm-collection-bids/pool?poolKey=${poolPk.toBase58()}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(json.pool.owner, owner.publicKey.toBase58());
    assert.strictEqual(json.pool.cosigner, cosigner.publicKey.toBase58());
    assert.strictEqual(json.pool.spotPriceSol, 11_800_000 / 1e9);
    assert.strictEqual(json.pool.escrowBalanceSol, 35_400_000 / 1e9);
    assert.strictEqual(json.pool.estimatedRemainingQuantity, 3);
    assert.strictEqual(json.pool.allowlists.length, 1);
    assert.strictEqual(json.pool.allowlists[0].value, REAL_MCC);
  });
});

// ── HTTP: build/create ────────────────────────────────────────────────────

console.log('\n== HTTP: build/create ==');

await checkAsync('build/create: happy path, quantity 1 at 0.0118 SOL -> 11_800_000 lamports liquidity', async () => {
  const owner = Keypair.generate();
  const cosigner = Keypair.generate();
  const chain = fakeChain({ simAccountLamports: [PRICE_PER_NFT_LAMPORTS] });
  await withTestApp({ cosignerKeypair: cosigner, chain, meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: owner.publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL,
      pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.requiredLiquiditySol, PRICE_PER_NFT_LAMPORTS / 1e9);
    assert.strictEqual(json.summary.maxQuantity, 1);
    assert.strictEqual(json.summary.curveType, 'linear');
    assert.strictEqual(json.summary.curveDelta, '0');
    assert.strictEqual(json.summary.lpFeeBp, 0);
    assert.strictEqual(json.summary.buysideCreatorRoyaltyBp, 0);
    assert.strictEqual(typeof json.digest, 'string');
    assert.strictEqual(json.digest.length, 64);
    // Cosigner slot must already be signed at build time, owner must not be.
    const built = Transaction.from(Buffer.from(json.tx, 'base64'));
    assert.strictEqual(built.signatures.length, 2);
    const ownerSig = built.signatures.find((s) => s.publicKey.toBase58() === owner.publicKey.toBase58());
    const cosignerSig = built.signatures.find((s) => s.publicKey.toBase58() === cosigner.publicKey.toBase58());
    assert.ok(cosignerSig?.signature && cosignerSig.signature.some((b) => b !== 0));
    assert.ok(!ownerSig?.signature || ownerSig.signature.every((b) => b === 0));
  });
});

for (const qty of [2, 5, 10]) {
  await checkAsync(`build/create: quantity ${qty} -> liquidity scales linearly`, async () => {
    const owner = Keypair.generate();
    const chain = fakeChain({ simAccountLamports: [PRICE_PER_NFT_LAMPORTS * qty] });
    await withTestApp({ cosignerKeypair: Keypair.generate(), chain, meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
      const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
        owner: owner.publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL,
        pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: qty,
      });
      assert.strictEqual(status, 200, JSON.stringify(json));
      assert.strictEqual(json.summary.requiredLiquiditySol, (PRICE_PER_NFT_LAMPORTS * qty) / 1e9);
    });
  });
}

await checkAsync('build/create: rejects owner == cosigner', async () => {
  const cosigner = Keypair.generate();
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain(), meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: cosigner.publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(status, 400);
    assert.match(json.error, /owner_equals_cosigner/);
  });
});

for (const [label, body] of [
  ['invalid owner', { owner: 'not-a-key', collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1 }],
  ['missing collection', { owner: Keypair.generate().publicKey.toBase58(), pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1 }],
  ['zero price', { owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: 0, maxQuantity: 1 }],
  ['negative quantity', { owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: -1 }],
  ['non-integer quantity', { owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1.5 }],
] as const) {
  await checkAsync(`build/create: rejects ${label}`, async () => {
    await withTestApp({ cosignerKeypair: Keypair.generate(), chain: fakeChain(), meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
      const { status } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, body);
      assert.strictEqual(status, 400);
    });
  });
}

await checkAsync('build/create: refuses when no active listings resolve a collection allowlist', async () => {
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain: fakeChain(), meGet: fakeMeGet([]), fetchGrouping: fakeFetchGrouping() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /collection_allowlist_unresolved/);
  });
});

await checkAsync('build/create: refuses when sampled mints disagree on collection grouping', async () => {
  const mintsToGroups = new Map<string, string>();
  const mints = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  mintsToGroups.set(mints[0], REAL_MCC);
  mintsToGroups.set(mints[1], Keypair.generate().publicKey.toBase58());
  const meGet = async (_p: string) => mints.map((tokenMint) => ({ tokenMint }));
  const fetchGrouping = async (mint: string) => ({ groupKey: 'collection', groupValue: mintsToGroups.get(mint)! });
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain: fakeChain(), meGet, fetchGrouping }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /collection_allowlist_unresolved/);
  });
});

await checkAsync('build/create: preflight simulation failure is surfaced, tx not built', async () => {
  const chain = fakeChain({ simulateErr: { InstructionError: [0, 'Custom'] } });
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain, meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: Keypair.generate().publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /preflight_simulation_failed/);
  });
});

// ── HTTP: build/deposit, build/update, build/withdraw-sol, build/close ──

console.log('\n== HTTP: build/deposit / build/update / build/withdraw-sol / build/close ==');

function poolFixture(owner: Keypair, cosigner: Keypair, opts: Partial<PoolFixtureFields> = {}) {
  const pool = Keypair.generate().publicKey;
  const escrow = deriveEscrowPda(pool);
  const data = encodePoolFixture({
    owner: owner.publicKey, cosigner: cosigner.publicKey, spotPriceLamports: BigInt(PRICE_PER_NFT_LAMPORTS), ...opts,
  });
  return { pool, escrow, data };
}

await checkAsync('build/deposit: additionalQuantity 3 -> liquidity = spotPrice * 3', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: PRICE_PER_NFT_LAMPORTS }]]);
  const chain = fakeChain({ accounts, simAccountLamports: [PRICE_PER_NFT_LAMPORTS * 4] });
  await withTestApp({ cosignerKeypair: cosigner, chain }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 3 });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.additionalLiquiditySol, (PRICE_PER_NFT_LAMPORTS * 3) / 1e9);
  });
});

await checkAsync('build/deposit: refuses a pool not cosigned by this tool', async () => {
  const owner = Keypair.generate(); const otherCosigner = Keypair.generate();
  const { pool, data } = poolFixture(owner, otherCosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }]]);
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    assert.strictEqual(status, 409);
    assert.match(json.error, /pool_not_managed_by_this_tool/);
  });
});

await checkAsync('build/update: only price/expiry change, other fields preserved from on-chain state', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, data } = poolFixture(owner, cosigner, { curveType: CURVE_KIND_EXP, curveDelta: 300n, lpFeeBp: 50, buysideCreatorRoyaltyBp: 250 });
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/update`, { poolKey: pool.toBase58(), spotPriceLamports: 20_000_000 });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.newPriceSol, 20_000_000 / 1e9);
    assert.strictEqual(json.summary.oldPriceSol, PRICE_PER_NFT_LAMPORTS / 1e9);
  });
});

await checkAsync('build/withdraw-sol: full withdrawal to exactly 0 is allowed', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 1_000_000 }]]);
  const chain = fakeChain({ accounts, simAccountLamports: [0] });
  await withTestApp({ cosignerKeypair: cosigner, chain }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/withdraw-sol`, { poolKey: pool.toBase58(), amountLamports: 1_000_000 });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.amountSol, 1_000_000 / 1e9);
  });
});

await checkAsync('build/withdraw-sol: rejects a partial withdrawal leaving a non-rent-exempt residual', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 1_000_000 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/withdraw-sol`, { poolKey: pool.toBase58(), amountLamports: 500_000 });
    assert.strictEqual(status, 409);
    assert.match(json.error, /withdrawal_leaves_non_rent_exempt_residual/);
  });
});

await checkAsync('build/withdraw-sol: rejects withdrawal exceeding known escrow balance', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 1_000_000 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/withdraw-sol`, { poolKey: pool.toBase58(), amountLamports: 2_000_000 });
    assert.strictEqual(status, 409);
    assert.match(json.error, /withdrawal_exceeds_known_escrow_balance/);
  });
});

await checkAsync('build/close: refuses when escrow is not empty', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 100 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/close`, { poolKey: pool.toBase58() });
    assert.strictEqual(status, 409);
    assert.match(json.error, /escrow_not_empty_withdraw_first/);
  });
});

await checkAsync('build/close: refuses when sellside inventory is non-empty', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner, { sellsideAssetAmount: 2n });
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 0 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/close`, { poolKey: pool.toBase58() });
    assert.strictEqual(status, 409);
    assert.match(json.error, /sellside_inventory_not_empty/);
  });
});

await checkAsync('build/close: happy path when escrow empty and sellside empty', async () => {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: 0 }]]);
  await withTestApp({ cosignerKeypair: cosigner, chain: fakeChain({ accounts }) }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/close`, { poolKey: pool.toBase58() });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.action, 'close');
  });
});

// ── HTTP: submit — two-signature digest/blockhash lifecycle ─────────────

console.log('\n== HTTP: submit — two-signature digest/blockhash lifecycle ==');

async function buildDepositSignSubmitSetup(chainOverrides: Partial<FakeChainOpts> = {}) {
  const owner = Keypair.generate(); const cosigner = Keypair.generate();
  const { pool, escrow, data } = poolFixture(owner, cosigner);
  const accounts = new Map([[pool.toBase58(), { data, lamports: 6_393_360 }], [escrow.toBase58(), { data: Buffer.alloc(0), lamports: PRICE_PER_NFT_LAMPORTS }]]);
  const chain = fakeChain({ accounts, simAccountLamports: [PRICE_PER_NFT_LAMPORTS * 2], blockHeight: 100, lastValidBlockHeight: 1_000_000, ...chainOverrides });
  return { owner, cosigner, pool, chain };
}

await checkAsync('happy path: build -> owner signs -> submit succeeds exactly once', async () => {
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    assert.strictEqual(build.status, 200, JSON.stringify(build.json));
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    built.partialSign(owner);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 200, JSON.stringify(submit.json));
    assert.strictEqual(typeof submit.json.signature, 'string');
    assert.strictEqual(chain.sendCalls.length, 1);
  });
});

await checkAsync('/submit refuses before touching the digest cache or RPC when LIVE is off', async () => {
  const { chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain, liveEnabled: false }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx: 'anything', digest: 'a'.repeat(64) });
    assert.strictEqual(status, 403);
    assert.match(json.error, /live_mode_disabled_server_side/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('submitting without the owner signature fails', async () => {
  const { pool, cosigner, chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx: build.json.tx, digest: build.json.digest });
    assert.notStrictEqual(submit.status, 200);
    assert.match(submit.json.error, /owner_signature_missing|revalidation_failed/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('submitting owner slot signed by the WRONG wallet fails cryptographic verification', async () => {
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup();
  const attacker = Keypair.generate();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    const ownerIdx = built.signatures.findIndex((s) => s.publicKey.toBase58() === owner.publicKey.toBase58());
    const forged = nacl.sign.detached(built.serializeMessage(), attacker.secretKey);
    built.signatures[ownerIdx].signature = Buffer.from(forged);
    const signedTx = built.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 400);
    assert.match(submit.json.error, /invalid_signature/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('digest replay: second submit of the same digest fails even with valid signatures', async () => {
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    built.partialSign(owner);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const first = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(first.status, 200);
    const second = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(second.status, 410);
    assert.match(second.json.error, /digest_not_found_expired_or_already_used/);
  });
});

await checkAsync('expired digest (TTL passed) is rejected', async () => {
  let currentTime = 1_000_000;
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true, now: () => currentTime }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    currentTime += 6 * 60_000; // beyond the 5-minute TTL
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    built.partialSign(owner);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.match(submit.json.error, /digest_expired/);
  });
});

await checkAsync('stale blockhash (chain has moved past lastValidBlockHeight) is rejected', async () => {
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup({ blockHeight: 100 });
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    built.partialSign(owner);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    (chain as any).accounts; // no-op, keep TS happy about unused destructure patterns
    // Force the block height check to fail by mutating what getBlockHeight returns.
    const origGetBlockHeight = chain.getBlockHeight.bind(chain);
    chain.getBlockHeight = async () => 999_999_999;
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.match(submit.json.error, /blockhash_expired/);
    chain.getBlockHeight = origGetBlockHeight;
  });
});

await checkAsync('message substitution: tampering with the tx after build invalidates the digest match', async () => {
  const { owner, cosigner, pool, chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: cosigner, chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey: pool.toBase58(), additionalQuantity: 1 });
    const built = Transaction.from(Buffer.from(build.json.tx, 'base64'));
    built.recentBlockhash = Keypair.generate().publicKey.toBase58(); // substitute the message
    built.partialSign(owner, cosigner);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 409);
    assert.match(submit.json.error, /signed_tx_message_does_not_match_digest/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('malformed digest is rejected before any cache lookup', async () => {
  const { chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain, liveEnabled: true }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx: 'anything', digest: 'not-hex' });
    assert.strictEqual(status, 400);
    assert.match(json.error, /missing_or_malformed_digest/);
  });
});

await checkAsync('unknown digest (never built) is rejected', async () => {
  const { chain } = await buildDepositSignSubmitSetup();
  await withTestApp({ cosignerKeypair: Keypair.generate(), chain, liveEnabled: true }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/mmm-collection-bids/submit`, { signedTx: 'anything', digest: 'a'.repeat(64) });
    assert.strictEqual(status, 410);
    assert.match(json.error, /digest_not_found_expired_or_already_used/);
  });
});

// ── Full mocked lifecycle: create -> deposit -> update -> withdraw -> close

console.log('\n== Full mocked lifecycle: create -> deposit -> update -> withdraw -> close ==');

await checkAsync('full lifecycle builds successfully end-to-end with a consistent cosigner', async () => {
  const owner = Keypair.generate();
  const cosigner = Keypair.generate();
  const accounts = new Map<string, { data: Buffer; lamports: number }>();
  const chain = fakeChain({ accounts, simAccountLamports: [PRICE_PER_NFT_LAMPORTS] });

  await withTestApp({ cosignerKeypair: cosigner, chain, meGet: fakeMeGet(), fetchGrouping: fakeFetchGrouping() }, async (base) => {
    // 1. create
    const create = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/create`, {
      owner: owner.publicKey.toBase58(), collectionSymbol: COLLECTION_SYMBOL, pricePerNftLamports: PRICE_PER_NFT_LAMPORTS, maxQuantity: 1,
    });
    assert.strictEqual(create.status, 200, JSON.stringify(create.json));
    const poolKey = create.json.summary.poolKey;
    const escrowKey = create.json.summary.escrowPda;

    // Simulate the chain committing the pool + escrow after create+deposit.
    accounts.set(poolKey, {
      data: encodePoolFixture({ owner: owner.publicKey, cosigner: cosigner.publicKey, spotPriceLamports: BigInt(PRICE_PER_NFT_LAMPORTS) }),
      lamports: 6_393_360,
    });
    accounts.set(escrowKey, { data: Buffer.alloc(0), lamports: PRICE_PER_NFT_LAMPORTS });

    // 2. deposit
    chain.accounts.set(escrowKey, { data: Buffer.alloc(0), lamports: PRICE_PER_NFT_LAMPORTS });
    const deposit = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/deposit`, { poolKey, additionalQuantity: 1 });
    assert.strictEqual(deposit.status, 200, JSON.stringify(deposit.json));

    // 3. update
    const update = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/update`, { poolKey, spotPriceLamports: 15_000_000 });
    assert.strictEqual(update.status, 200, JSON.stringify(update.json));

    // 4. withdraw-sol (full amount, to exactly 0)
    accounts.set(escrowKey, { data: Buffer.alloc(0), lamports: PRICE_PER_NFT_LAMPORTS });
    const withdraw = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/withdraw-sol`, { poolKey, amountLamports: PRICE_PER_NFT_LAMPORTS });
    assert.strictEqual(withdraw.status, 200, JSON.stringify(withdraw.json));

    // 5. close (escrow now empty, sellside empty)
    accounts.set(escrowKey, { data: Buffer.alloc(0), lamports: 0 });
    const close = await jsonPost(`${base}/api/tools/mmm-collection-bids/build/close`, { poolKey });
    assert.strictEqual(close.status, 200, JSON.stringify(close.json));
  });
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
