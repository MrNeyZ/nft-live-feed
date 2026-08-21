/**
 * mallow.art detector — offline fixture tests.
 *
 * Proves the two targeted Mallow branches of `detectLaunchpadMint`:
 *   1. accepts the reference direct 1/1 mint (bare Token Metadata Create +
 *      exact platform-fee transfer) with the expected asset / collection /
 *      minter, AND
 *   2. rejects that same tx once the fee amount is tampered with (proves
 *      the gate checks the EXACT amount, not just destination presence),
 *      AND
 *   3. accepts the reference "Buy Edition" mint (MALLOW_PROGRAM + inner
 *      MPL Core Create) as Mallow / core.
 *
 * Pure offline — fixtures captured from mainnet via getTransaction
 * (encoding=json) and pre-merged with loadedAddresses to mirror
 * `fetchRawTx` output. Runner: `npm run test:mallow-detector`
 * (ts-node + Node assert, no network).
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import bs58 from 'bs58';
import { detectLaunchpadMint } from '../launchpad-detector';
import type { RawSolanaTx } from '../../me-raw/types';

const FIX = join(__dirname, 'fixtures');
function load(name: string): RawSolanaTx {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8')) as RawSolanaTx;
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 1. Reference direct 1/1 mint → accepted as Mallow / token_metadata.
check('reference direct-mint tx classifies as Mallow', () => {
  const hit = detectLaunchpadMint(load('mallow_direct_tm.json'));
  assert(hit, 'expected a launchpad hit');
  assert.strictEqual(hit!.source, 'Mallow');
  assert.strictEqual(hit!.standard, 'token_metadata');
  assert.strictEqual(hit!.mintAddress, '6JvoGvnCxMfank92RG7RZZhJgLZDJsQyntoF3Mxrbx4G');
  assert.strictEqual(hit!.collectionAddress, '2PUyFCF6apbPKvX84NMaVkboEN9ajdMbZM6yt9srFSps');
  assert.strictEqual(hit!.minter, '9hKXRJvMxJsxF2QEZg7mFVqViuZEZHc25GRR3du69DzT');
});

// 2. Same tx, fee amount tampered → must NOT classify as Mallow. Proves
//    the gate checks the exact lamport amount, not just that SOME transfer
//    reached MALLOW_FEE_WALLET (that wallet is also mallow's general
//    ops/treasury address — see the constant's doc comment).
check('tampered fee amount is rejected', () => {
  const tx = load('mallow_direct_tm.json');
  const top = tx.transaction.message.instructions as unknown as Array<{ data: string }>;
  for (const ix of top) {
    // SystemProgram transfer of 11_000_000 lamports, base58-encoded.
    // Replace with a transfer of 1 lamport (still valid SystemInstruction
    // ix=2 layout) by re-encoding via the same bs58 alphabet the decoder
    // expects — simplest correct mutation is to swap in a KNOWN-different
    // encoded payload for a 1-lamport transfer with the same 12-byte
    // layout (ix=2, lamports=1).
    let buf: Buffer;
    try { buf = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
    if (buf.length >= 12 && buf.readUInt32LE(0) === 2 && Number(buf.readBigUInt64LE(4)) === 11_000_000) {
      buf.writeBigUInt64LE(1n, 4);
      ix.data = bs58.encode(buf);
    }
  }
  const hit = detectLaunchpadMint(tx);
  assert(!hit || hit.source !== 'Mallow', 'tampered fee amount must not classify as Mallow');
});

// 3. Reference "Buy Edition" mint → accepted as Mallow / core.
check('reference edition-purchase tx classifies as Mallow (core)', () => {
  const hit = detectLaunchpadMint(load('mallow_edition_core.json'));
  assert(hit, 'expected a launchpad hit');
  assert.strictEqual(hit!.source, 'Mallow');
  assert.strictEqual(hit!.standard, 'core');
});

console.log(`\nmallow.art detector: ${passed}/3 checks passed`);
