/**
 * Regression suite for modern unified MPL Token Metadata `Create`/`Mint`
 * support in mint-raw ingestion (Stage: unified-create-support, 2026-07-11).
 *
 * Root cause fixed here (see the audit trail in the module's own comments):
 *   1. Neither `hasMintInstructionLog` nor `detectProgramSource` recognized
 *      the modern unified instruction builder's bare `IX: Create` / `IX:
 *      Mint` log lines — every mint using it was silently dropped at the
 *      WS prefilter, before `fetchRawTx` ever ran.
 *   2. Even if admitted, `findMintInstruction` blindly picked the FIRST
 *      Token-Metadata-owned instruction regardless of which one it was —
 *      for this exact tx shape (Create, then Mint, then Verify, all
 *      top-level) that's still correct by luck, but the account-layout
 *      assumption baked into extraction (`mint = accounts[1]`) is NOT:
 *      the unified `Create` instruction's accounts[1] is the (optional)
 *      Master Edition PDA, not the mint — accounts[2] is the mint.
 *
 * Fixture `tm_unified_create_ref.json` is the REAL regression transaction
 * (5ZZHZZrrAf2hmzCRYZ91JdTxtJwCaZfzt7848Ux9iZqZQ6ofZphwALcnMurYntAebw4XrPp
 * TmttvjbStiaqpoMrz), captured via `getTransaction` (`encoding: 'json'`)
 * and pre-merged with loaded addresses to mirror `fetchRawTx` output —
 * same convention as `prnt_ref.json` in this same fixtures directory.
 *
 * Pure offline — no network, no DB, no RPC. `ingestMintRaw` itself (which
 * DOES call `fetchRawTx` over the network) is deliberately NOT invoked
 * here; its real behavior on this signature is proven separately by the
 * live replay script (see the accompanying audit report), not by this
 * fixture suite.
 *
 * Run: npm run test:mint-unified-create
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import bs58 from 'bs58';
import {
  hasMintInstructionLog,
  detectProgramSource,
  findMintInstruction,
  extractMintAccounts,
  decodeUnifiedCreateArgsV1,
  describeTmTokenStandard,
  TOKEN_METADATA_PROGRAM,
  MPL_CORE_PROGRAM,
} from '../index';
import type { RawSolanaTx } from '../../me-raw/types';

const FIX = join(__dirname, 'fixtures');
function loadFixture(name: string): RawSolanaTx {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8')) as RawSolanaTx;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ─── Synthetic fixture builder for the smaller edge cases ───────────────────
// Only the fields `hasMintInstructionLog` / `detectProgramSource` /
// `findMintInstruction` / `extractMintAccounts` actually read are populated —
// these four functions never touch balances/DAS/accumulator state, so a
// minimal synthetic tx is a faithful, deterministic substitute for a real
// one for THESE specific assertions.
function acct(pubkey: string) { return { pubkey, signer: false, writable: false }; }
function ixData(discByte: number, extra: number[] = []): string {
  return bs58.encode(Buffer.from([discByte, ...extra]));
}
function buildSyntheticTx(opts: {
  logMessages: string[];
  accountKeys: string[];
  instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
}): RawSolanaTx {
  return {
    signature: 'synthetic',
    blockTime: 1_752_000_000,
    slot: 1,
    transaction: {
      signatures: ['synthetic'],
      message: {
        accountKeys: opts.accountKeys.map(acct),
        instructions: opts.instructions,
      },
    },
    meta: {
      err: null,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: opts.logMessages,
    },
  } as unknown as RawSolanaTx;
}

const REAL_MINT           = 'HhtWpjA37C3BXiizM3C4oFUFxDhPpUzquyL9hRFjYSvD';
const MASTER_EDITION_PDA  = 'Ft1FjnRi4EGmvG7f8vihTehgaAZsPFLm7nrhWJhRUTMs';
const REAL_COLLECTION     = '6vTwtKuKY93qyFRAZs6YstsXeXGrnwLNwgZgTMC1TYS2';

// ════════════════════════════════════════════════════════════════════════
// Reference transaction — the confirmed regression fixture
// ════════════════════════════════════════════════════════════════════════

check('reference tx: hasMintInstructionLog accepts (bare IX: Create/Mint no longer silently dropped)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  assert.strictEqual(hasMintInstructionLog(tx.meta!.logMessages), true);
});

check('reference tx: detectProgramSource returns token_metadata + tm_unified_create_bare variant', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectProgramSource(tx);
  assert(hit, 'expected a hit');
  assert.strictEqual(hit!.programSource, 'mpl_token_metadata');
  assert.strictEqual(hit!.variant, 'tm_unified_create_bare');
});

check('reference tx: findMintInstruction selects the unified Create ix (disc 42)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit);
  assert(found, 'expected a found instruction');
  assert.strictEqual(found!.layout, 'tm_unified_create');
  assert.strictEqual(bs58.decode(found!.ix.data)[0], 42);
});

check('reference tx: extracted mint is HhtWpj... (accounts[2]), NOT Ft1Fjn... (Master Edition PDA, accounts[1])', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit)!;
  const extracted = extractMintAccounts(found);
  assert.strictEqual(extracted.mintAddress, REAL_MINT);
  assert.notStrictEqual(extracted.mintAddress, MASTER_EDITION_PDA);
});

check('reference tx: collection resolves to 6vTwt... via the Create ix\'s own borsh payload', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit)!;
  const extracted = extractMintAccounts(found);
  assert.strictEqual(extracted.collectionAddress, REAL_COLLECTION);
});

check('reference tx: tokenStandard resolves to Legacy NonFungible; name is Holo Shellaroo', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit)!;
  const decoded = decodeUnifiedCreateArgsV1(found.ix.data);
  assert(decoded, 'expected the CreateArgs payload to decode');
  assert.strictEqual(describeTmTokenStandard(decoded!.tokenStandard), 'Legacy NonFungible');
  assert.strictEqual(decoded!.name, 'Holo Shellaroo');
});

check('reference tx: BOTH IX: Create and IX: Mint are present, but detectProgramSource/findMintInstruction each return exactly ONE hit — Create wins, no duplicate event path', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  assert(tx.meta!.logMessages!.some(l => l.includes('IX: Create')));
  assert(tx.meta!.logMessages!.some(l => l.includes('IX: Mint')));
  const hit = detectProgramSource(tx);
  assert(hit, 'expected exactly one hit object (structurally singular — never an array)');
  assert.strictEqual(hit!.variant, 'tm_unified_create_bare', 'Create must win priority over Mint when both are present in one tx');
  const found = findMintInstruction(tx, hit!);
  assert(found, 'expected exactly one selected instruction');
  assert.strictEqual(bs58.decode(found!.ix.data)[0], 42, 'the selected instruction must be Create (42), not Mint (43)');
});

// ════════════════════════════════════════════════════════════════════════
// Legacy CreateMetadataAccountV3 — must be completely unaffected
// ════════════════════════════════════════════════════════════════════════

check('legacy CreateMetadataAccountV3: still extracts mint at accounts[1] (unchanged)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  // accounts order per the CreateMetadataAccountV3 IDL: metadata, mint,
  // mintAuthority, payer, updateAuthority, systemProgram.
  const keys = ['payer', 'metadataPda', 'legacyMint', 'mintAuthority', 'updateAuthorityKey', 'systemProgram', TM];
  const tx = buildSyntheticTx({
    logMessages: [
      `Program ${TM} invoke [1]`,
      'Program log: Instruction: CreateMetadataAccountV3',
      `Program ${TM} success`,
    ],
    accountKeys: keys,
    instructions: [{ programIdIndex: 6, accounts: [1, 2, 3, 0, 4, 5], data: ixData(33) }],
  });
  assert.strictEqual(hasMintInstructionLog(tx.meta!.logMessages), true);
  const hit = detectProgramSource(tx);
  assert(hit);
  assert.strictEqual(hit!.variant, 'tm_legacy_create_needle');
  const found = findMintInstruction(tx, hit!);
  assert(found);
  assert.strictEqual(found!.layout, 'tm_legacy_create');
  const extracted = extractMintAccounts(found!);
  assert.strictEqual(extracted.mintAddress, 'legacyMint');
});

check('legacy pNFT "Instruction: Mint" bare (pre-existing anchored regex) still classifies as token_metadata', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const logs = [
    `Program ${TM} invoke [1]`,
    'Program log: Instruction: Mint',
    `Program ${TM} success`,
  ];
  assert.strictEqual(hasMintInstructionLog(logs), true);
  const tx = buildSyntheticTx({ logMessages: logs, accountKeys: [TM], instructions: [] });
  const hit = detectProgramSource(tx);
  assert(hit);
  assert.strictEqual(hit!.variant, 'tm_legacy_mint_bare');
});

// ════════════════════════════════════════════════════════════════════════
// MPL Core — must be completely unaffected
// ════════════════════════════════════════════════════════════════════════

check('MPL Core CreateV1: mint extraction unchanged (accounts[0]=asset, accounts[2]=collection)', () => {
  const CORE = MPL_CORE_PROGRAM;
  const keys = ['coreAsset', 'authority', 'coreCollection', 'updateAuth', 'x', 'minter', CORE];
  const tx = buildSyntheticTx({
    logMessages: [
      `Program ${CORE} invoke [1]`,
      'Program log: Instruction: CreateV1',
      `Program ${CORE} success`,
    ],
    accountKeys: keys,
    instructions: [{ programIdIndex: 6, accounts: [0, 1, 2, 3, 4, 5], data: ixData(0) }],
  });
  const hit = detectProgramSource(tx);
  assert(hit);
  assert.strictEqual(hit!.programSource, 'mpl_core');
  assert.strictEqual(hit!.variant, 'core_create_needle');
  const found = findMintInstruction(tx, hit!);
  assert(found);
  assert.strictEqual(found!.layout, 'core');
  const extracted = extractMintAccounts(found!);
  assert.strictEqual(extracted.mintAddress, 'coreAsset');
  assert.strictEqual(extracted.collectionAddress, 'coreCollection');
});

// ════════════════════════════════════════════════════════════════════════
// New failure-mode coverage
// ════════════════════════════════════════════════════════════════════════

check('IX: CreateEscrowAccount does not pass hasMintInstructionLog / is not classified as a create hit', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const logs = [
    `Program ${TM} invoke [1]`,
    'Program log: IX: CreateEscrowAccount',
    `Program ${TM} success`,
  ];
  assert.strictEqual(hasMintInstructionLog(logs), false, 'anchored regex must not substring-match CreateEscrowAccount');
  const tx = buildSyntheticTx({ logMessages: logs, accountKeys: [TM], instructions: [] });
  assert.strictEqual(detectProgramSource(tx), null);
});

check('bare IX: Mint with NO Create ix in the same tx: detected as mint-only, findMintInstruction returns null (no guessing)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['payer', 'someAccount', TM];
  const tx = buildSyntheticTx({
    logMessages: [
      `Program ${TM} invoke [1]`,
      'Program log: IX: Mint',
      `Program ${TM} success`,
    ],
    accountKeys: keys,
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(43) }],
  });
  const hit = detectProgramSource(tx);
  assert(hit);
  assert.strictEqual(hit!.variant, 'tm_unified_mint_bare');
  const found = findMintInstruction(tx, hit!);
  assert.strictEqual(found, null, 'a Mint-only tx must not select ANY instruction as the create instruction');
});

check('malformed unified Create (<3 accounts) fails closed — no silent fallback to a different index', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['metadataPda', 'someOtherAccount', TM];
  const tx = buildSyntheticTx({
    logMessages: [
      `Program ${TM} invoke [1]`,
      'Program log: IX: Create',
      `Program ${TM} success`,
    ],
    accountKeys: keys,
    // Only 2 accounts — accounts[2] (mint, for the unified layout) doesn't exist.
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(42) }],
  });
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit)!;
  assert(found, 'the instruction still matches on discriminator — selection itself must succeed');
  assert.strictEqual(found.layout, 'tm_unified_create');
  const extracted = extractMintAccounts(found);
  assert.strictEqual(extracted.mintAddress, null, 'must fail closed to null, never fall back to accounts[0]/[1]');
});

check('Verify following Create does not replace the selected create instruction', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = [
    'metadataPda', 'masterEditionPda', 'realMint', 'authority', 'payer',
    'updateAuth', 'sysProgram', 'sysvarIx', TM, 'collMint', 'collMeta', 'collME',
  ];
  const tmIdx = 8;
  const tx = buildSyntheticTx({
    logMessages: [
      `Program ${TM} invoke [1]`, 'Program log: IX: Create', `Program ${TM} success`,
      `Program ${TM} invoke [1]`, 'Program log: IX: Verify', `Program ${TM} success`,
    ],
    accountKeys: keys,
    instructions: [
      // Create: metadata, masterEdition, mint, authority, payer, updateAuth, sys, sysvarIx
      { programIdIndex: tmIdx, accounts: [0, 1, 2, 3, 4, 5, 6, 7], data: ixData(42) },
      // Verify (CollectionV1): authority, delegateRecord(placeholder=TM), metadata, collMint, collMeta, collME, sys, sysvarIx
      { programIdIndex: tmIdx, accounts: [4, tmIdx, 0, 9, 10, 11, 6, 7], data: ixData(52, [1]) },
    ],
  });
  const hit = detectProgramSource(tx)!;
  const found = findMintInstruction(tx, hit)!;
  assert.strictEqual(found.layout, 'tm_unified_create');
  assert.strictEqual(bs58.decode(found.ix.data)[0], 42, 'must select Create, not Verify, even though Verify is also TM-owned and appears later');
  const extracted = extractMintAccounts(found);
  assert.strictEqual(extracted.mintAddress, 'realMint');
});

console.log(`\n${passed} checks passed`);
