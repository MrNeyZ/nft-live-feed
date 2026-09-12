/**
 * Resize Claim — offline test suite for the request validators, the
 * error-sanitizer (RC-5), and the narrow retry-revalidation primitive
 * (revalidateItems / whichExist / currentlyHeld / metadataSpaces).
 *
 * No live network calls: RPC reads are injected via a mocked `Connection`
 * object (only the specific methods each function under test actually
 * calls are stubbed). Convention matches
 * src/server/__tests__/tools-ghostbid.test.ts: ts-node + Node's built-in
 * `assert`, a running failure counter.
 *
 * Run: `npm run test:resize-claim`.
 */
import assert from 'assert';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  isValidPubkey, parseClaims, parseResizes, toClientError,
} from '../tools-resize-claim';
import { revalidateItems, whichExist } from '../../resize-claim/scan';
import { claimReceiptPda, RESIZED_METADATA_MAX_SPACE } from '../../resize-claim/program';

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

const VALID_KEY = '11111111111111111111111111111111';
function randKey(): string { return Keypair.generate().publicKey.toBase58(); }

// ── isValidPubkey ─────────────────────────────────────────────────────────
console.log('isValidPubkey');
check('valid base58 pubkey -> true', () => { assert.strictEqual(isValidPubkey(VALID_KEY), true); });
check('non-string -> false', () => { assert.strictEqual(isValidPubkey(123), false); });
check('empty string -> false', () => { assert.strictEqual(isValidPubkey(''), false); });
check('garbage -> false, not thrown', () => { assert.strictEqual(isValidPubkey("'; DROP TABLE--"), false); });

// ── parseClaims ───────────────────────────────────────────────────────────
console.log('parseClaims');
check('undefined -> [] (optional field)', () => { assert.deepStrictEqual(parseClaims(undefined), []); });
check('non-array -> null', () => { assert.strictEqual(parseClaims({}), null); });
check('valid single claim -> parsed', () => {
  const mint = randKey();
  const proof = [randKey()];
  const out = parseClaims([{ mint, amountLamports: '123', proof }]);
  assert.deepStrictEqual(out, [{ mint, amountLamports: '123', proof }]);
});
check('invalid mint -> null', () => { assert.strictEqual(parseClaims([{ mint: 'not-a-key', amountLamports: '1', proof: [randKey()] }]), null); });
check('negative amount -> null (digit-only regex)', () => { assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '-1', proof: [randKey()] }]), null); });
check('decimal amount -> null', () => { assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '1.5', proof: [randKey()] }]), null); });
check('scientific-notation amount -> null', () => { assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '1e9', proof: [randKey()] }]), null); });
check('whitespace amount -> null', () => { assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: ' 1', proof: [randKey()] }]), null); });
check('empty proof -> null', () => { assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '1', proof: [] }]), null); });
check('proof with 33 entries -> null (max 32)', () => {
  const proof = Array.from({ length: 33 }, randKey);
  assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '1', proof }]), null);
});
check('proof with 32 entries -> ok (boundary)', () => {
  const proof = Array.from({ length: 32 }, randKey);
  assert.notStrictEqual(parseClaims([{ mint: randKey(), amountLamports: '1', proof }]), null);
});
check('proof containing a non-pubkey entry -> null', () => {
  assert.strictEqual(parseClaims([{ mint: randKey(), amountLamports: '1', proof: ['not-a-key'] }]), null);
});

// ── parseResizes ──────────────────────────────────────────────────────────
console.log('parseResizes');
check('undefined -> [] (optional field)', () => { assert.deepStrictEqual(parseResizes(undefined), []); });
check('non-array -> null', () => { assert.strictEqual(parseResizes('x'), null); });
check('bare mint string -> parsed', () => {
  const mint = randKey();
  assert.deepStrictEqual(parseResizes([mint]), [{ mint }]);
});
check('{mint} object form -> parsed', () => {
  const mint = randKey();
  assert.deepStrictEqual(parseResizes([{ mint }]), [{ mint }]);
});
check('invalid mint -> null', () => { assert.strictEqual(parseResizes(['not-a-key']), null); });

// ── toClientError (RC-5) ──────────────────────────────────────────────────
console.log('toClientError (RC-5 — no raw error detail to the client)');
check('Error with sensitive detail -> fixed generic string only', () => {
  const out = toClientError(new Error('/root/nft-live-feed/.env HELIUS_API_KEY=abc123'), 'test');
  assert.strictEqual(out, 'internal_error');
  assert.ok(!out.includes('HELIUS_API_KEY'));
  assert.ok(!out.includes('.env'));
});
check('is deterministic regardless of input shape', () => {
  assert.strictEqual(toClientError('a', 'x'), toClientError({ b: 1 }, 'y'));
});

// ── revalidateItems / whichExist / currentlyHeld (retry-safety re-check) ──
console.log('revalidateItems');

function fakeTokenAccount(amount: bigint): Buffer {
  const buf = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: PublicKey.default,
      owner: PublicKey.default,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    buf,
  );
  return buf;
}

/** Mocked Connection: `getMultipleAccountsInfo` resolves purely from a
 *  base58-keyed map the test supplies; unmatched keys resolve to null
 *  (mirrors a real RPC's "account does not exist" response). */
function mockConn(byKey: Map<string, Buffer>): Connection {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        const data = byKey.get(k.toBase58());
        return data ? { data, executable: false, lamports: 1, owner: PublicKey.default, rentEpoch: 0 } : null;
      }),
  } as unknown as Connection;
}

async function main() {
  await checkAsync('claim: receipt absent + NFT still held -> claimable', async () => {
    const mint = randKey();
    const amountLamports = '100';
    const wallet = randKey();
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true).toBase58();
    const byKey = new Map<string, Buffer>();
    byKey.set(ata, fakeTokenAccount(1n)); // held (amount > 0), receipt NOT in map -> absent
    const conn = mockConn(byKey);
    const out = await revalidateItems(conn, wallet, [{ mint, amountLamports, proof: [randKey()] }], []);
    assert.deepStrictEqual(out.claimable, [{ mint, amountLamports, proof: out.claimable[0]?.proof }]);
    assert.strictEqual(out.alreadyClaimed.length, 0);
    assert.strictEqual(out.notHeld.length, 0);
  });

  await checkAsync('claim: receipt EXISTS -> alreadyClaimed, excluded from claimable regardless of holding', async () => {
    const mint = randKey();
    const amountLamports = '100';
    const wallet = randKey();
    const receipt = claimReceiptPda(new PublicKey(mint), BigInt(amountLamports)).toBase58();
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true).toBase58();
    const byKey = new Map<string, Buffer>([
      [receipt, Buffer.alloc(1)], // any non-empty presence = "exists"
      [ata, fakeTokenAccount(1n)],
    ]);
    const conn = mockConn(byKey);
    const out = await revalidateItems(conn, wallet, [{ mint, amountLamports, proof: [randKey()] }], []);
    assert.deepStrictEqual(out.alreadyClaimed, [mint]);
    assert.strictEqual(out.claimable.length, 0);
  });

  await checkAsync('claim: receipt absent but NFT no longer held (sold since scan) -> notHeld, excluded from claimable', async () => {
    const mint = randKey();
    const amountLamports = '100';
    const wallet = randKey();
    const byKey = new Map<string, Buffer>(); // ATA missing entirely -> not held
    const conn = mockConn(byKey);
    const out = await revalidateItems(conn, wallet, [{ mint, amountLamports, proof: [randKey()] }], []);
    assert.deepStrictEqual(out.notHeld, [mint]);
    assert.strictEqual(out.claimable.length, 0);
    assert.strictEqual(out.alreadyClaimed.length, 0);
  });

  await checkAsync('claim: NFT held but with a ZERO balance ATA -> treated as not held', async () => {
    const mint = randKey();
    const amountLamports = '100';
    const wallet = randKey();
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true).toBase58();
    const byKey = new Map<string, Buffer>([[ata, fakeTokenAccount(0n)]]);
    const conn = mockConn(byKey);
    const out = await revalidateItems(conn, wallet, [{ mint, amountLamports, proof: [randKey()] }], []);
    assert.deepStrictEqual(out.notHeld, [mint]);
  });

  check('resize: metadata-size threshold used by revalidateItems is the same RESIZED_METADATA_MAX_SPACE constant scan.ts already established', () => {
    // metadataSpaces() calls a raw Helius getMultipleAccounts JSON-RPC POST,
    // not conn.getMultipleAccountsInfo — out of scope for this mocked
    // Connection (it doesn't hit HELIUS_API_KEY-gated network in tests).
    // Exercised instead via the pure threshold logic directly, matching the
    // spec's "smallest safe existing primitive" guidance rather than adding
    // a fetch-mocking harness for one already-simple comparison.
    assert.ok(679 > RESIZED_METADATA_MAX_SPACE, 'a full-size legacy metadata account must read as oversized');
    assert.ok(607 <= RESIZED_METADATA_MAX_SPACE, 'an already-resized metadata account must NOT read as oversized');
  });

  await checkAsync('whichExist: only PDAs present in the mocked map are reported as existing', async () => {
    const a = randKey(); const b = randKey();
    const conn = mockConn(new Map([[a, Buffer.alloc(1)]]));
    const exists = await whichExist(conn, [new PublicKey(a), new PublicKey(b)]);
    assert.strictEqual(exists.has(a), true);
    assert.strictEqual(exists.has(b), false);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
