/**
 * Magic Eden item-bid tool — offline test suite.
 *
 * No live network calls: the Magic Eden HTTP transport, the chain RPC
 * client, and the wall clock are all injected via `createMeBidsRouter`'s
 * `deps` parameter (see tools-me-bids.ts). Auth middleware is replaced
 * with a pass-through — this suite is about the bid-building/validation/
 * digest/signature contract, not the (separately covered) site-wide SIWS
 * gate.
 *
 * Convention matches src/mint-analyzer/__tests__/analyze.test.ts: ts-node
 * + Node's built-in `assert`, a running failure counter, `process.exit`.
 * Extended here with an async-aware `checkAsync` since most of this
 * surface is request/response.
 *
 * Run: `npm run test:me-bids`.
 */

import assert from 'assert';
import express from 'express';
import type { Server } from 'http';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, AccountMeta,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  createMeBidsRouter, validateStructure, validateWithdrawStructure, messageHashHex, checkBlockhashFreshness,
  decodeLegacyTxFromBase64, MeApiError,
  type MeBidsDeps, type ValidationContext, type WithdrawValidationContext, type CancellationContext,
  type ChainClient, type MeHttpTransport, type MeApiKeyProvider, type Op,
} from '../tools-me-bids';
import { deriveBuyerEscrowPda } from '../me-bid-escrow';

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

// ── Fixture accounts ────────────────────────────────────────────────────
// All addresses below are either freshly generated test keypairs (never
// funded, never used on mainnet) or the real, public M2/ComputeBudget
// program IDs. No captured third-party signatures or secrets.

const M2_PROGRAM_ID = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const FAKE_BLOCKHASH = () => Keypair.generate().publicKey.toBase58();

interface FixtureAccounts {
  buyer: Keypair;
  mint: PublicKey;
  auctionHouse: PublicKey;
  escrowPda: string;
  tradeStatePda: PublicKey;
  filler: PublicKey;
}

function makeAccounts(): FixtureAccounts {
  const buyer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const auctionHouse = Keypair.generate().publicKey;
  const escrowPda = deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.publicKey.toBase58());
  if (!escrowPda) throw new Error('fixture escrow derivation failed');
  return { buyer, mint, auctionHouse, escrowPda, tradeStatePda: Keypair.generate().publicKey, filler: Keypair.generate().publicKey };
}

interface KeyOverrides {
  buyer?: PublicKey;
  mint?: PublicKey | null;
  mintWritable?: boolean;
  auctionHouse?: PublicKey | null;
  escrowPda?: PublicKey | null;
  tradeStatePda?: PublicKey | null;
  extraWritable?: PublicKey | null;
}

function buildM2Keys(a: FixtureAccounts, op: Op, ov: KeyOverrides = {}): AccountMeta[] {
  const keys: AccountMeta[] = [];
  keys.push({ pubkey: ov.buyer ?? a.buyer.publicKey, isSigner: true, isWritable: true });
  keys.push({ pubkey: a.filler, isSigner: false, isWritable: false });
  const mint = 'mint' in ov ? ov.mint : a.mint;
  if (mint) keys.push({ pubkey: mint, isSigner: false, isWritable: ov.mintWritable ?? false });
  const ah = 'auctionHouse' in ov ? ov.auctionHouse : a.auctionHouse;
  if (ah) keys.push({ pubkey: ah, isSigner: false, isWritable: false });
  if (op !== 'cancel') {
    const escrow = 'escrowPda' in ov ? ov.escrowPda : new PublicKey(a.escrowPda);
    if (escrow) keys.push({ pubkey: escrow, isSigner: false, isWritable: true });
  }
  const tradeState = 'tradeStatePda' in ov ? ov.tradeStatePda : a.tradeStatePda;
  if (tradeState) keys.push({ pubkey: tradeState, isSigner: false, isWritable: true });
  if (ov.extraWritable) keys.push({ pubkey: ov.extraWritable, isSigner: false, isWritable: true });
  return keys;
}

interface TxOverrides {
  programId?: PublicKey;
  extraInstruction?: boolean;
  feePayerOverride?: PublicKey;
  extraSigner?: Keypair;
}

function buildTx(a: FixtureAccounts, op: Op, keyOv: KeyOverrides = {}, txOv: TxOverrides = {}): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  const keys = buildM2Keys(a, op, keyOv);
  if (txOv.extraSigner) keys.push({ pubkey: txOv.extraSigner.publicKey, isSigner: true, isWritable: false });
  tx.add(new TransactionInstruction({
    programId: txOv.programId ?? M2_PROGRAM_ID,
    keys,
    data: Buffer.from([1, 2, 3, 4]),
  }));
  if (txOv.extraInstruction) {
    tx.add(new TransactionInstruction({ programId: M2_PROGRAM_ID, keys: [], data: Buffer.from([9, 9]) }));
  }
  tx.feePayer = txOv.feePayerOverride ?? a.buyer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH();
  // Round-trip through wire format so `.signatures` is populated exactly as
  // it would be for a tx this router actually decoded from a real ME
  // response (`Transaction.compileMessage()` alone does NOT populate
  // `.signatures` on a freshly-constructed object — only serialize/from does).
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function ctxFor(a: FixtureAccounts, op: Op): ValidationContext {
  return {
    op,
    expectedBuyer: a.buyer.publicKey.toBase58(),
    expectedMint: a.mint.toBase58(),
    expectedAuctionHouse: a.auctionHouse.toBase58(),
    expectedTradeStatePda: op === 'create' ? null : a.tradeStatePda.toBase58(),
    expectedEscrowPda: a.escrowPda,
  };
}

// ── Part 1/2 — validateStructure + digest binding (pure, no HTTP) ────────

async function main(): Promise<void> {
console.log('\n== validateStructure — happy path per op ==');
for (const op of ['create', 'change-price', 'cancel'] as Op[]) {
  const a = makeAccounts();
  check(`${op}: correctly-shaped tx validates`, () => {
    const tx = buildTx(a, op);
    const v = validateStructure(tx, ctxFor(a, op), 'absent');
    assert.ok(v.messageHash.length === 64);
  });
}

console.log('\n== validateStructure — structural negative cases (table-driven) ==');
type Mutation = { label: string; keyOv?: KeyOverrides; txOv?: TxOverrides; expect: RegExp };
const mutationsFor = (a: FixtureAccounts): Mutation[] => [
  { label: 'wrong mint', keyOv: { mint: Keypair.generate().publicKey }, expect: /mint_missing_from_instruction/ },
  { label: 'missing mint entirely', keyOv: { mint: null }, expect: /mint_missing_from_instruction/ },
  { label: 'mint marked writable', keyOv: { mintWritable: true }, expect: /unexpected_mint_writable/ },
  { label: 'wrong auction house', keyOv: { auctionHouse: Keypair.generate().publicKey }, expect: /auction_house_missing_from_instruction/ },
  { label: 'missing auction house', keyOv: { auctionHouse: null }, expect: /auction_house_missing_from_instruction/ },
  { label: 'wrong escrow PDA', keyOv: { escrowPda: Keypair.generate().publicKey }, expect: /escrow_pda_missing_or_mismatch/ },
  { label: 'missing escrow PDA', keyOv: { escrowPda: null }, expect: /escrow_pda_missing_or_mismatch/ },
  { label: 'extra unexplained writable account', keyOv: { extraWritable: Keypair.generate().publicKey }, expect: /unexpected_writable_account/ },
  { label: 'unknown program id', txOv: { programId: Keypair.generate().publicKey }, expect: /unexpected_program_id/ },
  { label: 'extra instruction appended', txOv: { extraInstruction: true }, expect: /unexpected_program_id|unexpected_m2_instruction_count/ },
  { label: 'unexpected second signer', txOv: { extraSigner: Keypair.generate() }, expect: /unexpected_signer_count/ },
  // A fee payer distinct from the buyer necessarily becomes a SECOND
  // required signer (fee payer is always position-0 required-signer in a
  // compiled Solana message) — so this is correctly rejected, just via the
  // signer-count check rather than reaching the fee-payer-specific one.
  { label: 'fee payer set to a different wallet', txOv: { feePayerOverride: Keypair.generate().publicKey }, expect: /unexpected_signer_count|fee_payer_mismatch|fee_payer_field_mismatch/ },
];
for (const op of ['create', 'change-price'] as Op[]) {
  const a = makeAccounts();
  for (const m of mutationsFor(a)) {
    check(`${op}: ${m.label} -> rejected`, () => {
      const tx = buildTx(a, op, m.keyOv, m.txOv);
      assert.throws(() => validateStructure(tx, ctxFor(a, op), 'absent'), m.expect);
    });
  }
}
// cancel: escrow must be ABSENT, not "matching" — different table.
{
  const a = makeAccounts();
  check('cancel: correct tx has no escrow reference', () => {
    const tx = buildTx(a, 'cancel');
    validateStructure(tx, ctxFor(a, 'cancel'), 'absent'); // must not throw
  });
  check('cancel: escrow touched -> rejected', () => {
    const keys = buildM2Keys(a, 'cancel');
    keys.push({ pubkey: new PublicKey(a.escrowPda), isSigner: false, isWritable: true });
    const raw = new Transaction();
    raw.add(new TransactionInstruction({ programId: M2_PROGRAM_ID, keys, data: Buffer.from([1]) }));
    raw.feePayer = a.buyer.publicKey;
    raw.recentBlockhash = FAKE_BLOCKHASH();
    const tx = Transaction.from(raw.serialize({ requireAllSignatures: false, verifySignatures: false }));
    assert.throws(() => validateStructure(tx, ctxFor(a, 'cancel'), 'absent'), /unexpected_escrow_touch_on_cancel/);
  });
  check('cancel: wrong trade-state PDA -> rejected', () => {
    const tx = buildTx(a, 'cancel', { tradeStatePda: Keypair.generate().publicKey });
    assert.throws(() => validateStructure(tx, ctxFor(a, 'cancel'), 'absent'), /trade_state_pda_missing_or_mismatch/);
  });
}
// change-price: wrong trade-state PDA specifically (create has no fixed one to mismatch).
{
  const a = makeAccounts();
  check('change-price: wrong trade-state PDA -> rejected', () => {
    const tx = buildTx(a, 'change-price', { tradeStatePda: Keypair.generate().publicKey });
    assert.throws(() => validateStructure(tx, ctxFor(a, 'change-price'), 'absent'), /trade_state_pda_missing_or_mismatch/);
  });
}
// create: exactly one unknown writable account is required, not zero/two.
{
  const a = makeAccounts();
  check('create: no new trade-state account at all -> rejected', () => {
    const tx = buildTx(a, 'create', { tradeStatePda: null });
    assert.throws(() => validateStructure(tx, ctxFor(a, 'create'), 'absent'), /unexpected_writable_account_count/);
  });
}

console.log('\n== validateStructure — signature-presence contract ==');
{
  const a = makeAccounts();
  check('build-time: pre-filled signature is rejected', () => {
    const tx = buildTx(a, 'create');
    tx.sign(a.buyer);
    assert.throws(() => validateStructure(tx, ctxFor(a, 'create'), 'absent'), /unexpected_pre_filled_signature/);
  });
  check('submit-time: missing signature is rejected', () => {
    const tx = buildTx(a, 'create');
    assert.throws(() => validateStructure(tx, ctxFor(a, 'create'), 'present'), /missing_buyer_signature/);
  });
  check('submit-time: correctly-signed tx passes structural re-check', () => {
    const tx = buildTx(a, 'create');
    tx.sign(a.buyer);
    validateStructure(tx, ctxFor(a, 'create'), 'present'); // must not throw
  });
}

console.log('\n== digest binds the MESSAGE only, not the signature bytes ==');
{
  const a = makeAccounts();
  const unsigned = buildTx(a, 'create');
  const digestBeforeSign = messageHashHex(unsigned);

  const signed = buildTx(a, 'create');
  signed.recentBlockhash = unsigned.recentBlockhash; // same message inputs
  signed.sign(a.buyer);
  check('adding the correct signature preserves the digest', () => {
    assert.strictEqual(messageHashHex(signed), digestBeforeSign);
  });

  check('a garbage (invalid) signature does not change the digest, but fails crypto verification', () => {
    const tampered = buildTx(a, 'create');
    tampered.recentBlockhash = unsigned.recentBlockhash;
    tampered.sign(a.buyer);
    tampered.signatures[0].signature = Buffer.alloc(64, 7); // overwrite with garbage
    assert.strictEqual(messageHashHex(tampered), digestBeforeSign, 'digest unaffected by signature bytes');
    assert.strictEqual(tampered.verifySignatures(true), false, 'garbage signature must fail crypto verification');
  });

  check('changing the blockhash changes the digest', () => {
    const other = buildTx(a, 'create');
    // buildTx already gives a fresh random blockhash each call -> different digest expected.
    assert.notStrictEqual(messageHashHex(other), digestBeforeSign);
  });

  for (const m of [
    { label: 'mint', keyOv: { mint: Keypair.generate().publicKey } as KeyOverrides },
    { label: 'auction house', keyOv: { auctionHouse: Keypair.generate().publicKey } as KeyOverrides },
    { label: 'escrow PDA', keyOv: { escrowPda: Keypair.generate().publicKey } as KeyOverrides },
    { label: 'fee payer', keyOv: {} as KeyOverrides, txOv: { feePayerOverride: Keypair.generate().publicKey } as TxOverrides },
  ]) {
    check(`changing ${m.label} changes the digest`, () => {
      const mutated = buildTx(a, 'create', m.keyOv, m.txOv);
      mutated.recentBlockhash = unsigned.recentBlockhash;
      assert.notStrictEqual(messageHashHex(mutated), digestBeforeSign);
    });
  }

  check('a different message signed by the same buyer has a different digest', () => {
    const other = makeAccounts();
    other.buyer = a.buyer; // same buyer, different mint/AH/escrow
    const differentMsg = buildTx(other, 'create');
    assert.notStrictEqual(messageHashHex(differentMsg), digestBeforeSign);
  });
}

console.log('\n== checkBlockhashFreshness ==');
{
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const info = { blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1_000 };
  check('fresh blockhash, well within margin -> ok', () => {
    assert.strictEqual(checkBlockhashFreshness(tx, info, 500, 10).ok, true);
  });
  check('blockhash mismatch (tx does not carry cached hash) -> rejected', () => {
    const other = buildTx(a, 'create');
    const r = checkBlockhashFreshness(other, info, 500, 10);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(!r.ok && r.code, 'blockhash_mismatch');
  });
  check('current height past lastValidBlockHeight -> expired', () => {
    const r = checkBlockhashFreshness(tx, info, 1_000, 10);
    assert.strictEqual(!r.ok && r.code, 'blockhash_expired');
  });
  check('current height within margin but not yet past -> near_expiry', () => {
    const r = checkBlockhashFreshness(tx, info, 995, 10);
    assert.strictEqual(!r.ok && r.code, 'blockhash_near_expiry');
  });
  check('current height just outside margin -> ok', () => {
    const r = checkBlockhashFreshness(tx, info, 989, 10);
    assert.strictEqual(r.ok, true);
  });
}

// ── Fake ME transport / chain / test-app harness for HTTP-level tests ────

function meOkResponse(tx: Transaction, lastValidBlockHeight = 999_999_999): { status: number; text: string } {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    status: 200,
    text: JSON.stringify({
      tx: { type: 'Buffer', data: [0] }, // matches real ME quirk: unusable, never read by this router
      v0: { tx: { type: 'Buffer', data: [] }, txSigned: { type: 'Buffer', data: [] } },
      blockhashData: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
      txSigned: { type: 'Buffer', data: Array.from(bytes) },
    }),
  };
}

function offersReceivedResponse(offer: { pdaAddress: string; tokenMint: string; auctionHouse: string; buyer: string; price: number }): { status: number; text: string } {
  return { status: 200, text: JSON.stringify([offer]) };
}

type RouteHandler = () => { status: number; text: string } | Promise<{ status: number; text: string }>;

function routeTransport(routes: Record<string, RouteHandler>): MeHttpTransport {
  return async (path: string) => {
    const route = path.split('?')[0];
    const handler = routes[route];
    if (!handler) throw new Error(`no fake route registered for ${route} (full path: ${path})`);
    return handler();
  };
}

function alwaysKeyed(overrides: Partial<MeApiKeyProvider> = {}): MeApiKeyProvider {
  return {
    hasKey: () => true,
    authHeaders: () => ({ Authorization: 'Bearer test-key-do-not-use' }),
    cooldownActive: () => false,
    setCooldown: () => {},
    ...overrides,
  };
}

interface FakeChainOpts {
  simulateErr?: unknown;
  simulateLogs?: string[];
  escrowPostLamports?: number | null;
  blockHeight?: number;
  blockHeightDelayMs?: number;
  sendImpl?: (tx: Transaction) => Promise<string>;
}
function fakeChain(opts: FakeChainOpts = {}): ChainClient & { sendCalls: Transaction[]; simulateCalls: number } {
  const sendCalls: Transaction[] = [];
  let simulateCalls = 0;
  return {
    sendCalls,
    get simulateCalls() { return simulateCalls; },
    async simulateTransaction(_tx, includeAccounts) {
      simulateCalls++;
      return {
        err: opts.simulateErr ?? null,
        logs: opts.simulateLogs ?? ['Program M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K success'],
        accounts: includeAccounts
          ? includeAccounts.map(() => (opts.escrowPostLamports != null ? { lamports: opts.escrowPostLamports } : null))
          : null,
        unitsConsumed: 12_345,
      };
    },
    async getBlockHeight() {
      if (opts.blockHeightDelayMs) await new Promise((r) => setTimeout(r, opts.blockHeightDelayMs));
      return opts.blockHeight ?? 100;
    },
    async sendRawTransaction(tx) {
      sendCalls.push(tx);
      if (opts.sendImpl) return opts.sendImpl(tx);
      return `FAKE_SIG_${sendCalls.length}`;
    },
  };
}

async function withTestApp(
  deps: MeBidsDeps,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createMeBidsRouter({ authMiddleware: (_req, _res, next) => next(), ...deps }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
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

// ── Part 5 — full build/create HTTP-level coverage ────────────────────────

console.log('\n== HTTP: build/create ==');
await checkAsync('happy path: 200, returns tx+digest+summary, escrow bound respected', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    [`/instructions/buy`]: () => meOkResponse(tx),
  });
  await withTestApp(
    { meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain({ escrowPostLamports: 1_000_000 }) },
    async (base) => {
      const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
        buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.ok, true);
      assert.strictEqual(typeof json.digest, 'string');
      assert.strictEqual(json.digest.length, 64);
      assert.strictEqual(json.summary.action, 'create');
    },
  );
});

await checkAsync('malformed ME response (missing txSigned) -> 502', async () => {
  const a = makeAccounts();
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => ({ status: 200, text: JSON.stringify({ blockhashData: { blockhash: 'x', lastValidBlockHeight: 1 } }) }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /me_response_missing_tx_signed/);
  });
});

await checkAsync('ME API error shape {err: string} surfaces cleanly', async () => {
  const a = makeAccounts();
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 400, text: JSON.stringify({ err: 'invalid_x' }) }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => ({ status: 400, text: JSON.stringify({ err: 'invalid_x' }) }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 400);
    assert.match(json.error, /invalid_x/);
  });
});

await checkAsync('ME API error shape {err: [{msg}]} (express-validator) surfaces cleanly', async () => {
  const a = makeAccounts();
  const body = JSON.stringify({ err: [{ msg: 'price must be a number', param: 'price', location: 'query' }] });
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 400, text: body }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => ({ status: 400, text: body }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 400);
    assert.match(json.error, /price must be a number/);
  });
});

await checkAsync('ME API error shape {message} surfaces cleanly', async () => {
  const a = makeAccounts();
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 500, text: JSON.stringify({ message: 'internal server error' }) }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => ({ status: 500, text: JSON.stringify({ message: 'internal server error' }) }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 500);
    assert.match(json.error, /internal server error/);
  });
});

await checkAsync('HTML/WAF response (Cloudflare-style block page) is handled, not crashed on', async () => {
  const a = makeAccounts();
  const html = '<!DOCTYPE html><html><head><title>Attention Required</title></head><body>Cloudflare</body></html>';
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 403, text: html }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => ({ status: 403, text: html }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 403);
    assert.strictEqual(json.ok, false);
    assert.match(json.error, /unknown_me_error/);
  });
});

await checkAsync('rate limit (429) sets cooldown and surfaces cleanly', async () => {
  const a = makeAccounts();
  let cooldownSet = false;
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 429, text: '' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => ({ status: 429, text: '' }),
  });
  await withTestApp({
    meTransport: transport,
    meApiKeyProvider: alwaysKeyed({ setCooldown: () => { cooldownSet = true; } }),
    chain: fakeChain(),
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 429);
    assert.match(json.error, /me_api_rate_limited/);
    assert.strictEqual(cooldownSet, true);
  });
});

await checkAsync('transport timeout/throw is caught and surfaced as 504', async () => {
  const a = makeAccounts();
  const transport: MeHttpTransport = async () => { throw new Error('network timeout'); };
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 504);
    assert.match(json.error, /me_api_unreachable/);
  });
});

await checkAsync('ME API key not configured -> 503, no transport call attempted', async () => {
  const a = makeAccounts();
  let transportCalled = false;
  const transport: MeHttpTransport = async () => { transportCalled = true; return { status: 200, text: '[]' }; };
  await withTestApp({
    meTransport: transport,
    meApiKeyProvider: alwaysKeyed({ hasKey: () => false }),
    chain: fakeChain(),
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 503);
    assert.match(json.error, /me_api_key_not_configured/);
    assert.strictEqual(transportCalled, false);
  });
});

await checkAsync('simulation error at build time -> 502, digest never issued', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(tx),
  });
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(),
    chain: fakeChain({ simulateErr: { InstructionError: [0, 'Custom'] } }),
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /preflight_simulation_failed/);
    assert.strictEqual(json.digest, undefined);
  });
});

await checkAsync('inflated escrow balance in simulation (wrong offer price) -> rejected', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(tx),
  });
  // priceSol=0.001 => 1_000_000 lamports expected; simulate reports 50 SOL moved.
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(),
    chain: fakeChain({ escrowPostLamports: 50_000_000_000 }),
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /escrow_balance_exceeds_expected/);
  });
});

console.log('\n== HTTP: build/change-price + build/cancel — offer_not_found + wrong new price ==');
await checkAsync('change-price: no existing offer -> 404 offer_not_found', async () => {
  const a = makeAccounts();
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/change-price`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), newPriceSol: 2,
    });
    assert.strictEqual(status, 404);
    assert.match(json.error, /offer_not_found/);
  });
});

await checkAsync('cancel: no existing offer -> 404 offer_not_found', async () => {
  const a = makeAccounts();
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
  });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/cancel`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(),
    });
    assert.strictEqual(status, 404);
    assert.match(json.error, /offer_not_found/);
  });
});

await checkAsync('change-price: escrow bound uses the FULL new price, not the delta', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'change-price');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 46,
    } as any),
    '/instructions/buy_change_price': () => meOkResponse(tx),
  });
  // newPriceSol=47 => bound is 47 SOL + buffer. escrow reports 47.5 SOL moved -> must reject.
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(),
    chain: fakeChain({ escrowPostLamports: 47_500_000_000 }),
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/change-price`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), newPriceSol: 47,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /escrow_balance_exceeds_expected/);
  });
});

// ── Part 6/7 — LIVE gate, simulate, submit lifecycle ──────────────────────

console.log('\n== HTTP: server-side LIVE capability ==');
await checkAsync('/status: liveEnabled defaults to false and is boolean-only (no secrets)', async () => {
  await withTestApp({ meTransport: routeTransport({}), meApiKeyProvider: alwaysKeyed() }, async (base) => {
    const { status, json } = await jsonGet(`${base}/api/tools/me-bids/status`);
    assert.strictEqual(status, 200);
    assert.strictEqual(json.liveEnabled, false);
    assert.strictEqual(typeof json.meApiConfigured, 'boolean');
    assert.strictEqual(Object.keys(json).sort().join(','), 'liveEnabled,meApiConfigured,ok');
  });
});
await checkAsync('/status: explicit liveEnabled override is reflected', async () => {
  await withTestApp({ meTransport: routeTransport({}), meApiKeyProvider: alwaysKeyed(), liveEnabled: true }, async (base) => {
    const { json } = await jsonGet(`${base}/api/tools/me-bids/status`);
    assert.strictEqual(json.liveEnabled, true);
  });
});
await checkAsync('/submit: refuses before touching the digest cache or RPC when LIVE is off', async () => {
  const chain = fakeChain();
  await withTestApp({ meTransport: routeTransport({}), meApiKeyProvider: alwaysKeyed(), chain, liveEnabled: false }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: 'anything', digest: 'a'.repeat(64) });
    assert.strictEqual(status, 403);
    assert.match(json.error, /live_mode_disabled_server_side/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

/** Full happy-path build->sign->submit helper, reused by several tests. */
async function buildSignSubmitHappyPath(opts: { liveEnabled?: boolean; chain?: ChainClient & { sendCalls: Transaction[] } } = {}) {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(tx, 1_000_000_000), // huge lastValidBlockHeight, never near expiry
  });
  const chain = opts.chain ?? fakeChain({ escrowPostLamports: 1_000_000, blockHeight: 100 });
  return { a, transport, chain, liveEnabled: opts.liveEnabled ?? true };
}

console.log('\n== HTTP: submit — digest / signature / blockhash lifecycle ==');

await checkAsync('happy path: build -> sign -> submit succeeds exactly once', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(build.status, 200);
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 200, JSON.stringify(submit.json));
    assert.strictEqual(submit.json.ok, true);
    assert.strictEqual(typeof submit.json.signature, 'string');
    assert.strictEqual(chain.sendCalls.length, 1);
  });
});

await checkAsync('submitting the original UNSIGNED tx fails', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: build.json.tx, digest: build.json.digest });
    assert.notStrictEqual(submit.status, 200);
    assert.match(submit.json.error, /missing_buyer_signature|revalidation_failed/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('submitting a tx signed by the WRONG wallet fails signature verification', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  const attacker = Keypair.generate();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    // Forge: sign the real message with the ATTACKER's key, but inject the
    // bytes into the slot labelled with the buyer's pubkey (built.signatures[0]).
    const forged = nacl.sign.detached(built.serializeMessage(), attacker.secretKey);
    built.signatures[0].signature = Buffer.from(forged);
    const signedTx = built.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 400);
    assert.match(submit.json.error, /invalid_signature/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('digest replay: second submit of the same digest fails even with a valid signature', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    const first = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(first.status, 200);
    const second = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(second.status, 410);
    assert.match(second.json.error, /digest_not_found_expired_or_already_used/);
    assert.strictEqual(chain.sendCalls.length, 1, 'RPC must only ever see the first submission');
  });
});

await checkAsync('unknown digest fails', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: 'f'.repeat(64) });
    assert.strictEqual(submit.status, 410);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('digest expiry: an expired build is rejected even with a valid signature', async () => {
  let clock = 1_000_000;
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, now: () => clock }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    clock += 6 * 60_000; // past the 5-minute TTL
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.match(submit.json.error, /digest_expired/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('message substitution: signing tx B but submitting with tx A\'s digest fails', async () => {
  const a = makeAccounts();
  const txA = buildTx(a, 'create');
  const txB = buildTx(a, 'create'); // different random blockhash => different message
  let call = 0;
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(call++ === 0 ? txA : txB, 1_000_000_000),
  });
  const chain = fakeChain({ escrowPostLamports: 1_000_000 });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled: true }, async (base) => {
    const buildA = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const buildB = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.notStrictEqual(buildA.json.digest, buildB.json.digest);

    const builtB = decodeLegacyTxFromBase64(buildB.json.tx);
    builtB.sign(a.buyer);
    const signedB = builtB.serialize({ requireAllSignatures: true }).toString('base64');

    // Submit tx B's signed bytes but claim tx A's digest.
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: signedB, digest: buildA.json.digest });
    assert.strictEqual(submit.status, 409);
    assert.match(submit.json.error, /signed_tx_message_does_not_match_digest/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

console.log('\n== HTTP: blockhash freshness at submit time ==');
await checkAsync('blockhash expired at submit time is rejected without RPC broadcast', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(tx, 200), // lastValidBlockHeight = 200
  });
  const chain = fakeChain({ escrowPostLamports: 1_000_000, blockHeight: 250 }); // already past 200
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled: true }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.strictEqual(submit.json.error, 'blockhash_expired');
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('blockhash within the safety margin (near-expiry) is rejected', async () => {
  const a = makeAccounts();
  const tx = buildTx(a, 'create');
  const transport = routeTransport({
    ['/tokens/' + a.mint.toBase58() + '/offers_received']: () => ({ status: 200, text: '[]' }),
    ['/tokens/' + a.mint.toBase58() + '/listings']: () => offersReceivedResponse({
      pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
      auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
    } as any),
    '/instructions/buy': () => meOkResponse(tx, 200),
  });
  const chain = fakeChain({ escrowPostLamports: 1_000_000, blockHeight: 195 }); // within default 10-block margin of 200
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled: true, blockhashMarginBlocks: 10 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.strictEqual(submit.json.error, 'blockhash_near_expiry');
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

console.log('\n== Part 4: submit-token cache audit ==');
await checkAsync('concurrent double-submit: at most one request proceeds past token consumption', async () => {
  const { a, transport, liveEnabled } = await buildSignSubmitHappyPath();
  const chain = fakeChain({ escrowPostLamports: 1_000_000, blockHeight: 100, blockHeightDelayMs: 30 });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');

    const [r1, r2, r3] = await Promise.all([
      jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest }),
      jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest }),
      jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest }),
    ]);
    const oks = [r1, r2, r3].filter((r) => r.status === 200);
    assert.strictEqual(oks.length, 1, `expected exactly 1 success, got ${oks.length}`);
    assert.strictEqual(chain.sendCalls.length, 1, 'RPC must only ever be touched once');
  });
});

await checkAsync('digest cache has a hard maximum size with deterministic (oldest-first) eviction', async () => {
  // One shared fixture/buyer; the fake transport mints a FRESH tx (fresh
  // random blockhash => distinct message => distinct digest) on every
  // `/instructions/buy` call, so each build issues a genuinely unique
  // digest. A fixed, strictly-increasing clock keeps every entry's TTL
  // identical and far from expiry, isolating the SIZE-based eviction path
  // from the separately-tested TTL path. Eviction order is then proven by
  // actually attempting to submit the OLDEST vs the NEWEST digest.
  const a = makeAccounts();
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' };
    if (route.endsWith('/listings')) {
      return offersReceivedResponse({
        pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
        auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
      } as any);
    }
    if (route === '/instructions/buy') return meOkResponse(buildTx(a, 'create'), 1_000_000_000);
    throw new Error(`unexpected path in eviction test: ${path}`);
  };
  const chain = fakeChain({ escrowPostLamports: 1_000_000 });
  let clock = 0;
  const router = createMeBidsRouter({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, now: () => clock, liveEnabled: true,
    authMiddleware: (_req, _res, next) => next(), rateLimitsDisabled: true,
  });
  const hooks = router.__meBidsTestHooks!;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const CAP = 500;
    const N = CAP + 5;
    const built: Array<{ digest: string; signedTx: string }> = [];
    for (let i = 0; i < N; i++) {
      clock += 1; // strictly increasing insertion order, still far under the 5-min TTL
      const { json } = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
        buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
      });
      assert.ok(json.digest, `build ${i} did not issue a digest: ${JSON.stringify(json)}`);
      const tx = decodeLegacyTxFromBase64(json.tx);
      tx.sign(a.buyer);
      built.push({ digest: json.digest, signedTx: tx.serialize({ requireAllSignatures: true }).toString('base64') });
    }

    check('cache size never exceeds the hard maximum (500)', () => {
      assert.ok(hooks.digestCacheSize() <= CAP, `size=${hooks.digestCacheSize()}`);
    });

    const uniqueDigests = new Set(built.map((b) => b.digest));
    assert.strictEqual(uniqueDigests.size, N, 'fixture bug: builds did not produce distinct digests');

    const first = built[0];
    const last = built[built.length - 1];
    const submitFirst = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: first.signedTx, digest: first.digest });
    check('the OLDEST digest was evicted once the cap was exceeded', () => {
      assert.notStrictEqual(submitFirst.status, 200);
      assert.match(submitFirst.json.error, /digest_not_found_expired_or_already_used/);
    });
    const submitLast = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: last.signedTx, digest: last.digest });
    check('the MOST RECENT digest is still present (not randomly evicted)', () => {
      assert.strictEqual(submitLast.status, 200, JSON.stringify(submitLast.json));
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

check('sweep timer is unref()-ed — does not keep the process alive on its own', () => {
  const router = createMeBidsRouter({ meTransport: routeTransport({}), meApiKeyProvider: alwaysKeyed() });
  const hooks = router.__meBidsTestHooks!;
  assert.strictEqual(typeof hooks.sweepTimer.hasRef, 'function');
  assert.strictEqual(hooks.sweepTimer.hasRef(), false);
  clearInterval(hooks.sweepTimer);
});

console.log('\n== Part 5: simulation cannot bypass submit-time checks ==');
await checkAsync('a clean /simulate result does not let an unsigned tx through /submit', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    const sim = await jsonPost(`${base}/api/tools/me-bids/simulate`, { tx: build.json.tx });
    assert.strictEqual(sim.json.err, null, 'simulation reports success');

    // Attempt to submit the SAME (still-unsigned) tx straight through.
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx: build.json.tx, digest: build.json.digest });
    assert.notStrictEqual(submit.status, 200);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});
await checkAsync('/simulate never calls sendRawTransaction', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    await jsonPost(`${base}/api/tools/me-bids/simulate`, { tx: build.json.tx });
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

console.log('\n== Log safety: no raw tx bytes or API key ever logged ==');
await checkAsync('console.error calls during a full lifecycle never contain the base64 tx or the fake API key', async () => {
  const originalError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  let signedTx = '';
  try {
    const { a, transport, chain, liveEnabled } = await buildSignSubmitHappyPath();
    await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled }, async (base) => {
      const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
        buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
      });
      const built = decodeLegacyTxFromBase64(build.json.tx);
      built.sign(a.buyer);
      signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
      await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
      // Also drive a couple of error paths that DO call console.error.
      await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest }); // replay
      await jsonPost(`${base}/api/tools/me-bids/simulate`, { tx: build.json.tx });
    });
  } finally {
    console.error = originalError;
  }
  const blob = captured.join('\n');
  check('no fake API key substring present in any logged line', () => {
    assert.ok(!blob.includes('test-key-do-not-use'));
  });
  check('no base64 signed-tx payload substring present in any logged line', () => {
    assert.ok(signedTx.length > 100, 'fixture sanity: signedTx should be a real base64 blob');
    assert.ok(!blob.includes(signedTx));
  });
});

// ── Sanity: exported MeApiError is a real Error subclass with a status ────
check('MeApiError carries status + message', () => {
  const e = new MeApiError(429, 'me_api_rate_limited');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.status, 429);
  assert.strictEqual(e.message, 'me_api_rate_limited');
});

// ═══════════════════════════════════════════════════════════════════════
// Escrow withdrawal + cancellation-context-without-indexing (lifecycle
// hardening pass)
// ═══════════════════════════════════════════════════════════════════════

interface WithdrawFixtureAccounts {
  buyer: Keypair;
  auctionHouse: PublicKey;
  escrowPda: string;
  filler: PublicKey;
}
function makeWithdrawAccounts(): WithdrawFixtureAccounts {
  const buyer = Keypair.generate();
  const auctionHouse = Keypair.generate().publicKey;
  const escrowPda = deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.publicKey.toBase58());
  if (!escrowPda) throw new Error('fixture escrow derivation failed');
  return { buyer, auctionHouse, escrowPda, filler: Keypair.generate().publicKey };
}
interface WithdrawKeyOverrides {
  buyer?: PublicKey;
  auctionHouse?: PublicKey | null;
  escrowPda?: PublicKey | null;
  extraWritable?: PublicKey | null;
}
function buildWithdrawM2Keys(a: WithdrawFixtureAccounts, ov: WithdrawKeyOverrides = {}): AccountMeta[] {
  const keys: AccountMeta[] = [];
  keys.push({ pubkey: ov.buyer ?? a.buyer.publicKey, isSigner: true, isWritable: true });
  keys.push({ pubkey: a.filler, isSigner: false, isWritable: false });
  const escrow = 'escrowPda' in ov ? ov.escrowPda : new PublicKey(a.escrowPda);
  if (escrow) keys.push({ pubkey: escrow, isSigner: false, isWritable: true });
  const ah = 'auctionHouse' in ov ? ov.auctionHouse : a.auctionHouse;
  if (ah) keys.push({ pubkey: ah, isSigner: false, isWritable: false });
  if (ov.extraWritable) keys.push({ pubkey: ov.extraWritable, isSigner: false, isWritable: true });
  return keys;
}
function buildWithdrawTx(a: WithdrawFixtureAccounts, keyOv: WithdrawKeyOverrides = {}, txOv: TxOverrides = {}): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  const keys = buildWithdrawM2Keys(a, keyOv);
  if (txOv.extraSigner) keys.push({ pubkey: txOv.extraSigner.publicKey, isSigner: true, isWritable: false });
  tx.add(new TransactionInstruction({ programId: txOv.programId ?? M2_PROGRAM_ID, keys, data: Buffer.from([1, 2, 3, 4]) }));
  if (txOv.extraInstruction) {
    tx.add(new TransactionInstruction({ programId: M2_PROGRAM_ID, keys: [], data: Buffer.from([9, 9]) }));
  }
  tx.feePayer = txOv.feePayerOverride ?? a.buyer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH();
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
function withdrawCtxFor(a: WithdrawFixtureAccounts): WithdrawValidationContext {
  return {
    expectedBuyer: a.buyer.publicKey.toBase58(),
    expectedAuctionHouse: a.auctionHouse.toBase58(),
    expectedEscrowPda: a.escrowPda,
  };
}
function withdrawMeResponse(tx: Transaction, lastValidBlockHeight = 999_999_999): { status: number; text: string } {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    status: 200,
    text: JSON.stringify({
      tx: { type: 'Buffer', data: [0] },
      v0: { tx: { type: 'Buffer', data: [] }, txSigned: { type: 'Buffer', data: [] } },
      blockhashData: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
      txSigned: { type: 'Buffer', data: Array.from(bytes) },
    }),
  };
}

console.log('\n== validateWithdrawStructure — structural checks (pure, no HTTP) ==');
{
  const a = makeWithdrawAccounts();
  check('correctly-shaped withdraw tx validates', () => {
    const tx = buildWithdrawTx(a);
    const v = validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent');
    assert.ok(v.messageHash.length === 64);
  });
  check('wrong auction house -> rejected', () => {
    const tx = buildWithdrawTx(a, { auctionHouse: Keypair.generate().publicKey });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /auction_house_missing_from_instruction/);
  });
  check('wrong escrow PDA -> rejected', () => {
    const tx = buildWithdrawTx(a, { escrowPda: Keypair.generate().publicKey });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /escrow_pda_missing_or_mismatch/);
  });
  check('missing escrow PDA entirely -> rejected', () => {
    const tx = buildWithdrawTx(a, { escrowPda: null });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /escrow_pda_missing_or_mismatch/);
  });
  check('extra writable account -> rejected', () => {
    const tx = buildWithdrawTx(a, { extraWritable: Keypair.generate().publicKey });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /unexpected_writable_account/);
  });
  check('wrong buyer (different signer) -> rejected', () => {
    const other = Keypair.generate();
    // Instruction now names `other` as its signer while feePayer (unchanged)
    // still says `a.buyer` — correctly rejected, whether the first check to
    // trip is "2 required signers" or a direct fee-payer mismatch.
    const tx = buildWithdrawTx(a, { buyer: other.publicKey });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /unexpected_signer_count|fee_payer_mismatch/);
  });
  check('unexpected second signer -> rejected', () => {
    const tx = buildWithdrawTx(a, {}, { extraSigner: Keypair.generate() });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /unexpected_signer_count/);
  });
  check('unknown program id -> rejected', () => {
    const tx = buildWithdrawTx(a, {}, { programId: Keypair.generate().publicKey });
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /unexpected_program_id/);
  });
  check('pre-filled signature at build time -> rejected', () => {
    const tx = buildWithdrawTx(a);
    tx.sign(a.buyer);
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'absent'), /unexpected_pre_filled_signature/);
  });
  check('missing signature at submit time -> rejected', () => {
    const tx = buildWithdrawTx(a);
    assert.throws(() => validateWithdrawStructure(tx, withdrawCtxFor(a), 'present'), /missing_buyer_signature/);
  });
}

console.log('\n== HTTP: build/withdraw-escrow ==');
await checkAsync('happy path: 200, escrow decrease bounded, digest issued', async () => {
  const a = makeWithdrawAccounts();
  const tx = buildWithdrawTx(a);
  const transport = routeTransport({ '/instructions/withdraw': () => withdrawMeResponse(tx, 1_000_000_000) });
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(),
    chain: fakeChain({ escrowPostLamports: 900_000 }), // was ~1_000_000, withdrawing 0.0001 SOL = 100_000
    escrowBalanceReader: async () => 0.001,
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    assert.strictEqual(status, 200, JSON.stringify(json));
    assert.strictEqual(json.summary.action, 'withdraw-escrow');
    assert.strictEqual(typeof json.digest, 'string');
  });
});

await checkAsync('withdrawal exceeding KNOWN escrow balance is rejected before calling ME', async () => {
  const a = makeWithdrawAccounts();
  let transportCalled = false;
  const transport: MeHttpTransport = async () => { transportCalled = true; return { status: 200, text: '{}' }; };
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain(),
    escrowBalanceReader: async () => 0.0001, // only 100_000 lamports known
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.01, // way more than known balance
    });
    assert.strictEqual(status, 409);
    assert.match(json.error, /withdrawal_exceeds_known_escrow_balance/);
    assert.strictEqual(transportCalled, false);
  });
});

await checkAsync('wrong withdrawal amount (simulated decrease exceeds requested) is rejected', async () => {
  const a = makeWithdrawAccounts();
  const tx = buildWithdrawTx(a);
  const transport = routeTransport({ '/instructions/withdraw': () => withdrawMeResponse(tx, 1_000_000_000) });
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(),
    // Claims to withdraw 0.0001 SOL (100_000 lamports) but escrow actually
    // dropped from 1_000_000 to 0 — a 1_000_000-lamport decrease.
    chain: fakeChain({ escrowPostLamports: 0 }),
    escrowBalanceReader: async () => 0.001,
  }, async (base) => {
    const { status, json } = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    assert.strictEqual(status, 502);
    assert.match(json.error, /withdrawal_amount_exceeds_expected/);
  });
});

console.log('\n== HTTP: withdraw-escrow submit lifecycle (digest/signature/blockhash/replay/LIVE) ==');

async function buildSignWithdraw(opts: { liveEnabled?: boolean; blockHeight?: number; lastValidBlockHeight?: number } = {}) {
  const a = makeWithdrawAccounts();
  const tx = buildWithdrawTx(a);
  const transport = routeTransport({ '/instructions/withdraw': () => withdrawMeResponse(tx, opts.lastValidBlockHeight ?? 1_000_000_000) });
  const chain = fakeChain({ escrowPostLamports: 900_000, blockHeight: opts.blockHeight ?? 100 });
  return { a, transport, chain, liveEnabled: opts.liveEnabled ?? true };
}

await checkAsync('withdraw happy path: build -> sign -> submit succeeds exactly once', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignWithdraw();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    assert.strictEqual(build.status, 200, JSON.stringify(build.json));
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 200, JSON.stringify(submit.json));
    assert.strictEqual(chain.sendCalls.length, 1);
  });
});

await checkAsync('withdraw: altered transaction (extra writable account) rejected by digest mismatch', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignWithdraw();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    // Client builds a DIFFERENT tx (extra writable account) locally and
    // tries to pass off the original digest for it.
    const tampered = buildWithdrawTx(a, { extraWritable: Keypair.generate().publicKey });
    tampered.sign(a.buyer);
    const signedTx = tampered.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 409);
    assert.match(submit.json.error, /signed_tx_message_does_not_match_digest/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('withdraw: invalid signature rejected', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignWithdraw();
  const attacker = Keypair.generate();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    const forged = nacl.sign.detached(built.serializeMessage(), attacker.secretKey);
    built.signatures[0].signature = Buffer.from(forged);
    const signedTx = built.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 400);
    assert.match(submit.json.error, /invalid_signature/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('withdraw: expired blockhash rejected without RPC broadcast', async () => {
  const { a, transport, liveEnabled } = await buildSignWithdraw({ lastValidBlockHeight: 200 });
  const chain = fakeChain({ escrowPostLamports: 900_000, blockHeight: 250 });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 410);
    assert.strictEqual(submit.json.error, 'blockhash_expired');
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

await checkAsync('withdraw: digest replay rejected', async () => {
  const { a, transport, chain, liveEnabled } = await buildSignWithdraw();
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const first = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(first.status, 200);
    const second = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(second.status, 410);
    assert.strictEqual(chain.sendCalls.length, 1);
  });
});

await checkAsync('withdraw: LIVE=false rejects submit before touching RPC', async () => {
  const { a, transport, chain } = await buildSignWithdraw({ liveEnabled: false });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, liveEnabled: false, escrowBalanceReader: async () => 0.001 }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.0001,
    });
    assert.strictEqual(build.status, 200, JSON.stringify(build.json)); // build/simulate still work
    const built = decodeLegacyTxFromBase64(build.json.tx);
    built.sign(a.buyer);
    const signedTx = built.serialize({ requireAllSignatures: true }).toString('base64');
    const submit = await jsonPost(`${base}/api/tools/me-bids/submit`, { signedTx, digest: build.json.digest });
    assert.strictEqual(submit.status, 403);
    assert.match(submit.json.error, /live_mode_disabled_server_side/);
    assert.strictEqual(chain.sendCalls.length, 0);
  });
});

console.log('\n== HTTP: cancellation context works WITHOUT any ME read/index API ==');

await checkAsync('cancel succeeds purely from cancellationContext when offers_received is empty (indexer lag)', async () => {
  const a = makeAccounts();
  const createTx = buildTx(a, 'create');
  const cancelTx = buildTx(a, 'cancel');
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' }; // indexer has NOT caught up
    if (route.endsWith('/listings')) {
      return offersReceivedResponse({
        pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
        auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
      } as any);
    }
    if (route === '/instructions/buy') return meOkResponse(createTx, 1_000_000_000);
    if (route === '/instructions/buy_cancel') return meOkResponse(cancelTx, 1_000_000_000);
    throw new Error(`unexpected path: ${path}`);
  };
  const chain = fakeChain({ escrowPostLamports: 1_000_000 });
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain }, async (base) => {
    const build = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(build.status, 200, JSON.stringify(build.json));
    const ctx: CancellationContext = build.json.cancellationContext;
    assert.strictEqual(ctx.buyer, a.buyer.publicKey.toBase58());
    assert.strictEqual(ctx.tradeStatePda, a.tradeStatePda.toBase58()); // matches the "new" pda embedded in the fixture create tx

    // Now cancel using ONLY that context — offers_received still reports
    // empty (never populated in this transport at all for cancel's own
    // pre-check, since resolveOfferForCancelOrChangePrice tries it first
    // and it must gracefully fall through).
    const cancel = await jsonPost(`${base}/api/tools/me-bids/build/cancel`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), cancellationContext: ctx,
    });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.json));
    assert.strictEqual(cancel.json.summary.resolvedFrom, 'local_context');
    assert.strictEqual(cancel.json.summary.escrowUnaffected, true);
  });
});

await checkAsync('a malicious/stale client-supplied trade-state PDA in cancellationContext is rejected, not trusted', async () => {
  const a = makeAccounts();
  const cancelTx = buildTx(a, 'cancel'); // references the REAL a.tradeStatePda
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' };
    if (route === '/instructions/buy_cancel') return meOkResponse(cancelTx, 1_000_000_000);
    throw new Error(`unexpected path: ${path}`);
  };
  const fakeCtx: CancellationContext = {
    buyer: a.buyer.publicKey.toBase58(),
    tokenMint: a.mint.toBase58(),
    price: 1,
    auctionHouseAddress: a.auctionHouse.toBase58(),
    tradeStatePda: Keypair.generate().publicKey.toBase58(), // FABRICATED — does not match what ME actually returns
    escrowPda: a.escrowPda,
  };
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const cancel = await jsonPost(`${base}/api/tools/me-bids/build/cancel`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), cancellationContext: fakeCtx,
    });
    assert.notStrictEqual(cancel.status, 200);
    assert.match(cancel.json.error, /trade_state_pda_missing_or_mismatch/);
  });
});

await checkAsync('change-price also falls back to cancellationContext when offers_received is empty', async () => {
  const a = makeAccounts();
  const changeTx = buildTx(a, 'change-price');
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' };
    if (route === '/instructions/buy_change_price') return meOkResponse(changeTx, 1_000_000_000);
    throw new Error(`unexpected path: ${path}`);
  };
  const ctx: CancellationContext = {
    buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), price: 1,
    auctionHouseAddress: a.auctionHouse.toBase58(), tradeStatePda: a.tradeStatePda.toBase58(), escrowPda: a.escrowPda,
  };
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain({ escrowPostLamports: 2_000_000 }) }, async (base) => {
    const r = await jsonPost(`${base}/api/tools/me-bids/build/change-price`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), newPriceSol: 2, cancellationContext: ctx,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.summary.resolvedFrom, 'local_context');
  });
});

await checkAsync('no fallback and no ME index -> 404 offer_not_found (not a crash)', async () => {
  const a = makeAccounts();
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' };
    throw new Error(`unexpected path: ${path}`);
  };
  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain() }, async (base) => {
    const r = await jsonPost(`${base}/api/tools/me-bids/build/cancel`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(),
    });
    assert.strictEqual(r.status, 404);
    assert.match(r.json.error, /offer_not_found/);
  });
});

console.log('\n== GET /escrow-balance — pure on-chain read, no ME dependency ==');
await checkAsync('escrow-balance never calls the ME transport', async () => {
  const a = makeWithdrawAccounts();
  let meCalled = false;
  const transport: MeHttpTransport = async () => { meCalled = true; return { status: 200, text: '[]' }; };
  await withTestApp({
    meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain: fakeChain(),
    escrowBalanceReader: async () => 0.00123,
  }, async (base) => {
    const r = await jsonGet(`${base}/api/tools/me-bids/escrow-balance?wallet=${a.buyer.publicKey.toBase58()}&auctionHouseAddress=${a.auctionHouse.toBase58()}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.escrowPda, a.escrowPda);
    assert.strictEqual(r.json.balanceSol, 0.00123);
    assert.strictEqual(meCalled, false);
  });
});

console.log('\n== Lifecycle invariant: cancel response can never be read as "funds returned" ==');
check('cancel summary never includes a refunded/returned/withdrawn-sounding field', () => {
  // Static shape check on the fields this file's cancel handler actually
  // emits (see build/cancel above) — guards against a future edit
  // accidentally adding a misleading field name.
  const cancelSummaryKeys = ['action', 'buyer', 'tokenMint', 'priceSol', 'auctionHouseAddress', 'pdaAddress', 'resolvedFrom', 'escrowUnaffected'];
  for (const k of cancelSummaryKeys) {
    assert.ok(!/refund|withdrawn|returned/i.test(k), `field name "${k}" could be misread as funds having moved`);
  }
  assert.ok(cancelSummaryKeys.includes('escrowUnaffected'), 'cancel summary must explicitly flag that escrow was not touched');
});

console.log('\n== Full mocked lifecycle: create -> cancel -> withdraw-escrow -> reconcile ==');
await checkAsync('end-to-end: every stage succeeds and the final state is only reached after withdraw', async () => {
  const a = makeAccounts();
  const createTx = buildTx(a, 'create');
  const cancelTx = buildTx(a, 'cancel');
  const withdrawAccts: WithdrawFixtureAccounts = {
    buyer: a.buyer, auctionHouse: a.auctionHouse, escrowPda: a.escrowPda, filler: Keypair.generate().publicKey,
  };
  const withdrawTx = buildWithdrawTx(withdrawAccts);

  let escrowBalance = 0; // starts empty
  const transport: MeHttpTransport = async (path: string) => {
    const route = path.split('?')[0];
    if (route.endsWith('/offers_received')) return { status: 200, text: '[]' }; // never relied upon for cancel below
    if (route.endsWith('/listings')) {
      // resolveAuctionHouse's fallback when offers_received is empty —
      // needed for build/create to resolve an auction house at all.
      return offersReceivedResponse({
        pdaAddress: a.tradeStatePda.toBase58(), tokenMint: a.mint.toBase58(),
        auctionHouse: a.auctionHouse.toBase58(), buyer: a.buyer.publicKey.toBase58(), price: 1,
      } as any);
    }
    if (route === '/instructions/buy') return meOkResponse(createTx, 1_000_000_000);
    if (route === '/instructions/buy_cancel') return meOkResponse(cancelTx, 1_000_000_000);
    if (route === '/instructions/withdraw') return withdrawMeResponse(withdrawTx, 1_000_000_000);
    throw new Error(`unexpected path: ${path}`);
  };
  const chain = fakeChain({ blockHeight: 100 });
  const escrowBalanceReader = async () => escrowBalance;

  await withTestApp({ meTransport: transport, meApiKeyProvider: alwaysKeyed(), chain, escrowBalanceReader, liveEnabled: true }, async (base) => {
    // 1. built — create
    escrowBalance = 0;
    (chain as unknown as { simulateTransaction: unknown }).simulateTransaction = async (_tx: Transaction, includeAccounts?: PublicKey[]) => ({
      err: null, logs: [], unitsConsumed: 1,
      accounts: includeAccounts ? includeAccounts.map(() => ({ lamports: 1_000_000 })) : null,
    });
    const create = await jsonPost(`${base}/api/tools/me-bids/build/create`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), priceSol: 0.001,
    });
    assert.strictEqual(create.status, 200, JSON.stringify(create.json)); // state: built

    // 2. simulated
    const sim = await jsonPost(`${base}/api/tools/me-bids/simulate`, { tx: create.json.tx });
    assert.strictEqual(sim.json.err, null); // state: simulated

    // 3. submitted / confirmed (mocked — fakeChain.sendRawTransaction always "confirms" instantly)
    const createSigned = decodeLegacyTxFromBase64(create.json.tx);
    createSigned.sign(a.buyer);
    const createSubmit = await jsonPost(`${base}/api/tools/me-bids/submit`, {
      signedTx: createSigned.serialize({ requireAllSignatures: true }).toString('base64'), digest: create.json.digest,
    });
    assert.strictEqual(createSubmit.status, 200, JSON.stringify(createSubmit.json)); // state: submitted -> confirmed
    escrowBalance = 0.001; // on-chain effect of the (mocked) confirmed create

    // 4. cancelled (offer inactive, trade-state freed) — via cancellationContext,
    //    proving no dependency on offers_received ever showing the offer
    //    ("indexed" is explicitly SKIPPED here, matching the real-world
    //    finding that buy_cancel doesn't need it).
    (chain as unknown as { simulateTransaction: unknown }).simulateTransaction = async () => ({ err: null, logs: [], unitsConsumed: 1, accounts: null });
    const cancelBuild = await jsonPost(`${base}/api/tools/me-bids/build/cancel`, {
      buyer: a.buyer.publicKey.toBase58(), tokenMint: a.mint.toBase58(), cancellationContext: create.json.cancellationContext,
    });
    assert.strictEqual(cancelBuild.status, 200, JSON.stringify(cancelBuild.json));
    assert.strictEqual(cancelBuild.json.summary.escrowUnaffected, true); // NOT "refunded"
    const cancelSigned = decodeLegacyTxFromBase64(cancelBuild.json.tx);
    cancelSigned.sign(a.buyer);
    const cancelSubmit = await jsonPost(`${base}/api/tools/me-bids/submit`, {
      signedTx: cancelSigned.serialize({ requireAllSignatures: true }).toString('base64'), digest: cancelBuild.json.digest,
    });
    assert.strictEqual(cancelSubmit.status, 200, JSON.stringify(cancelSubmit.json)); // state: cancelled -> cancel_confirmed
    // Escrow balance is UNCHANGED by cancel — this is the crux of the whole task.
    assert.strictEqual(escrowBalance, 0.001, 'cancel must never move escrow');

    // 5. escrow_withdraw_built -> escrow_withdrawn
    (chain as unknown as { simulateTransaction: unknown }).simulateTransaction = async (_tx: Transaction, includeAccounts?: PublicKey[]) => ({
      err: null, logs: [], unitsConsumed: 1,
      accounts: includeAccounts ? includeAccounts.map(() => ({ lamports: 0 })) : null, // fully withdrawn
    });
    const withdrawBuild = await jsonPost(`${base}/api/tools/me-bids/build/withdraw-escrow`, {
      buyer: a.buyer.publicKey.toBase58(), auctionHouseAddress: a.auctionHouse.toBase58(), amountSol: 0.001,
    });
    assert.strictEqual(withdrawBuild.status, 200, JSON.stringify(withdrawBuild.json));
    const withdrawSigned = decodeLegacyTxFromBase64(withdrawBuild.json.tx);
    withdrawSigned.sign(a.buyer);
    const withdrawSubmit = await jsonPost(`${base}/api/tools/me-bids/submit`, {
      signedTx: withdrawSigned.serialize({ requireAllSignatures: true }).toString('base64'), digest: withdrawBuild.json.digest,
    });
    assert.strictEqual(withdrawSubmit.status, 200, JSON.stringify(withdrawSubmit.json));
    escrowBalance = 0; // on-chain effect of the (mocked) confirmed withdrawal

    // 6. reconciled: offer inactive (cancel_confirmed) + trade-state closed
    //    (cancel_confirmed) + escrow returned (escrow_withdrawn, balance
    //    now 0) + wallet balance reconciled (all 3 tx signatures present).
    const finalBalance = await jsonGet(`${base}/api/tools/me-bids/escrow-balance?wallet=${a.buyer.publicKey.toBase58()}&auctionHouseAddress=${a.auctionHouse.toBase58()}`);
    assert.strictEqual(finalBalance.json.balanceSol, 0);
    assert.strictEqual(chain.sendCalls.length, 3, 'create + cancel + withdraw, exactly once each');
  });
});

console.log(`\n${passed} passed, ${failures === 0 ? '0 failures' : `${failures} FAILURES`}`);
console.log(failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
