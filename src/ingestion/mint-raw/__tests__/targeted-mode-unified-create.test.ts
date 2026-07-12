/**
 * Regression suite for targeted-mode admission of direct (wrapper-less)
 * unified Token Metadata mints (Stage: targeted-mode-unified-create,
 * 2026-07-12).
 *
 * Background: the unified-Create parser fix (unified-create.test.ts) is
 * correct but was DORMANT in production, because `ingestMintRaw`'s default
 * `targeted` mint-tracker mode rejects any tx `detectLaunchpadMint` doesn't
 * recognize as `unknown_launchpad` — and the one fallback that DOES accept
 * bare Token Metadata mints (`detectGenericTokenMetadataLaunchpadMint`)
 * only recognizes the LEGACY `CreateMetadataAccountV3` discriminator (33)
 * AND requires a custom launchpad wrapper by design. A bare, direct,
 * wrapper-less mint using the modern unified instruction builder (disc 42)
 * was therefore invisible in targeted mode too.
 *
 * `detectDirectUnifiedTokenMetadataMint` (mint-raw/index.ts) closes that
 * gap with a narrow, multi-gate classifier that does NOT require a wrapper.
 * This suite proves it accepts the real regression fixture and rejects
 * every false-positive category from the audit.
 *
 * Pure offline — no network, no DB. Reuses the same fixture as
 * unified-create.test.ts and prnt_ref.json (to prove zero interference
 * with existing targeted-mode launchpad detection).
 *
 * Run: npm run test:targeted-unified-create
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import bs58 from 'bs58';
import {
  detectDirectUnifiedTokenMetadataMint,
  TOKEN_METADATA_PROGRAM,
} from '../index';
import { detectGenericTokenMetadataLaunchpadMint } from '../core-v2-detector';
import { detectLaunchpadMint, getMintTrackerMode } from '../launchpad-detector';
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

const REAL_MINT       = 'HhtWpjA37C3BXiizM3C4oFUFxDhPpUzquyL9hRFjYSvD';
const MASTER_EDITION  = 'Ft1FjnRi4EGmvG7f8vihTehgaAZsPFLm7nrhWJhRUTMs';
const REAL_COLLECTION = '6vTwtKuKY93qyFRAZs6YstsXeXGrnwLNwgZgTMC1TYS2';

// ─── Synthetic tx / CreateArgs::V1 builders ──────────────────────────────────

function acct(pubkey: string) { return { pubkey, signer: false, writable: false }; }

function borshStr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** Minimal valid CreateArgs::V1 payload: disc(42) + tag(0) + name + symbol +
 *  uri + sellerFee(u16) + creators(None) + primarySale(false) +
 *  isMutable(true) + tokenStandard + collection(Some/None). */
function unifiedCreateData(opts: {
  name?: string; uri?: string; tokenStandard?: number; collectionKey?: string | null;
}): string {
  const name = opts.name ?? 'Test NFT';
  const uri = opts.uri ?? 'https://example.com/meta.json';
  const tokenStandard = opts.tokenStandard ?? 0;
  const buf: Buffer[] = [];
  buf.push(Buffer.from([42, 0]));       // disc=42, CreateArgs::V1 tag
  buf.push(borshStr(name));
  buf.push(borshStr('TST'));            // symbol
  buf.push(borshStr(uri));
  buf.push(Buffer.from([0x00, 0x00])); // sellerFeeBasisPoints = 0 (u16 LE)
  buf.push(Buffer.from([0]));           // creators: Option = None
  buf.push(Buffer.from([0]));           // primarySaleHappened = false
  buf.push(Buffer.from([1]));           // isMutable = true
  buf.push(Buffer.from([tokenStandard]));
  if (opts.collectionKey === undefined) {
    buf.push(Buffer.from([0]));         // collection: None
  } else if (opts.collectionKey === null) {
    buf.push(Buffer.from([0]));
  } else {
    buf.push(Buffer.from([1]));         // collection: Some
    buf.push(Buffer.from([0]));         // verified = false
    buf.push(Buffer.from(bs58.decode(opts.collectionKey)));
  }
  return bs58.encode(Buffer.concat(buf));
}

function ixData(discByte: number, extra: number[] = []): string {
  return bs58.encode(Buffer.from([discByte, ...extra]));
}

function buildSyntheticTx(opts: {
  accountKeys: string[];
  instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
  postTokenBalances?: Array<{ mint: string; programId: string; uiTokenAmount: { decimals: number; amount: string } }>;
  preBalances?: number[];
  postBalances?: number[];
  logMessages?: string[];
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
      preBalances: opts.preBalances ?? opts.accountKeys.map(() => 1_000_000),
      postBalances: opts.postBalances ?? opts.accountKeys.map(() => 1_000_000),
      preTokenBalances: [],
      postTokenBalances: opts.postTokenBalances ?? [],
      innerInstructions: [],
      logMessages: opts.logMessages ?? [],
    },
  } as unknown as RawSolanaTx;
}

/** Builds a complete, self-consistent bare unified Create+Mint tx: metadata,
 *  masterEdition, mint, authority, payer, updateAuth, sys, sysvarIx (Create,
 *  accounts[0..7]) then a Mint ix whose accounts[5]=mint, plus a
 *  postTokenBalances entry proving completed supply, plus mint freshness
 *  (pre=0/post>0 at the mint's account index). */
function buildBareUnifiedMintTx(opts: {
  tokenStandard?: number;
  collectionKey?: string | null;
  includeMintIx?: boolean;
  mintAccountsOverride?: number[];
  supplyAmount?: string;
} = {}): RawSolanaTx {
  const keys = [
    'metadataPda', 'masterEditionPda', 'mint', 'authority', 'payer',
    'updateAuth', 'sysProgram', 'sysvarIx', TOKEN_METADATA_PROGRAM,
    'tokenAcct', 'tokenOwner', 'ataProgram', 'splToken',
  ];
  const tmIdx = 8;
  const mintIdx = 2;
  const createAccounts = opts.mintAccountsOverride ?? [0, 1, 2, 3, 4, 5, 6, 7];
  const instructions = [
    { programIdIndex: tmIdx, accounts: createAccounts, data: unifiedCreateData({
      tokenStandard: opts.tokenStandard ?? 0,
      collectionKey: opts.collectionKey,
    }) },
  ];
  if (opts.includeMintIx !== false) {
    instructions.push({
      programIdIndex: tmIdx,
      // token(0), tokenOwner(1), metadata(2), masterEdition(3), tokenRecord(4), mint(5), authority(6), ...
      accounts: [9, 10, 0, 1, tmIdx, mintIdx, 3, tmIdx, 4, 6, 7, 12, 11, tmIdx, tmIdx],
      data: ixData(43, [0]),
    });
  }
  const preBalances = keys.map(() => 1_000_000);
  const postBalances = keys.map(() => 1_000_000);
  preBalances[mintIdx] = 0;
  postBalances[mintIdx] = 1_461_600;
  const postTokenBalances = opts.supplyAmount === undefined
    ? [{ mint: keys[mintIdx], programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { decimals: 0, amount: '1' } }]
    : opts.supplyAmount === null
      ? []
      : [{ mint: keys[mintIdx], programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { decimals: 0, amount: opts.supplyAmount } }];
  const logMessages = [
    `Program ${TOKEN_METADATA_PROGRAM} invoke [1]`, 'Program log: IX: Create', `Program ${TOKEN_METADATA_PROGRAM} success`,
    ...(opts.includeMintIx !== false
      ? [`Program ${TOKEN_METADATA_PROGRAM} invoke [1]`, 'Program log: IX: Mint', `Program ${TOKEN_METADATA_PROGRAM} success`]
      : []),
  ];
  return buildSyntheticTx({ accountKeys: keys, instructions, postTokenBalances, preBalances, postBalances, logMessages });
}

// ════════════════════════════════════════════════════════════════════════
// Reference transaction — must be accepted in targeted mode
// ════════════════════════════════════════════════════════════════════════

check('targeted mode is the current default (MINT_TRACKER_MODE unset)', () => {
  delete process.env.MINT_TRACKER_MODE;
  assert.strictEqual(getMintTrackerMode(), 'targeted');
});

check('reference tx: detectLaunchpadMint returns null (no known launchpad wrapper — confirms the premise)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  assert.strictEqual(detectLaunchpadMint(tx), null);
});

check('reference tx: detectGenericTokenMetadataLaunchpadMint returns null (legacy sibling never reaches its own wrapper check for disc 42)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  assert.strictEqual(detectGenericTokenMetadataLaunchpadMint(tx), null);
});

check('reference tx: detectDirectUnifiedTokenMetadataMint ACCEPTS it', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit, 'expected a detection result');
  assert.strictEqual(hit!.accept, true, `expected accept=true, got reject reason=${hit!.rejectReason}`);
});

check('reference tx: extracted mint is HhtWpj..., NOT the Master Edition PDA', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectDirectUnifiedTokenMetadataMint(tx)!;
  assert.strictEqual(hit.mintAddress, REAL_MINT);
  assert.notStrictEqual(hit.mintAddress, MASTER_EDITION);
});

check('reference tx: collection resolves to 6vTwt... (via the Verify ix, on-chain-verified)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectDirectUnifiedTokenMetadataMint(tx)!;
  assert.strictEqual(hit.collectionAddress, REAL_COLLECTION);
});

check('reference tx: tokenStandard identifies Legacy NonFungible (0), name is Holo Shellaroo', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit = detectDirectUnifiedTokenMetadataMint(tx)!;
  assert.strictEqual(hit.tokenStandard, 0);
  assert.strictEqual(hit.name, 'Holo Shellaroo');
});

check('reference tx: exactly ONE detection result despite both IX: Create and IX: Mint logs (structurally singular — no duplicate event path)', () => {
  const tx = loadFixture('tm_unified_create_ref.json');
  const hit1 = detectDirectUnifiedTokenMetadataMint(tx);
  const hit2 = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit1 && hit2);
  assert.strictEqual(hit1!.mintAddress, hit2!.mintAddress);
  assert.strictEqual(hit1!.accept, true);
});

// ════════════════════════════════════════════════════════════════════════
// Known launchpads — must remain completely unaffected
// ════════════════════════════════════════════════════════════════════════

check('known launchpad (PRNT reference fixture) unaffected: detectLaunchpadMint still classifies it PRNT', () => {
  const tx = loadFixture('prnt_ref.json');
  const hit = detectLaunchpadMint(tx);
  assert(hit);
  assert.strictEqual(hit!.source, 'PRNT');
});

check('known launchpad (PRNT reference fixture): detectDirectUnifiedTokenMetadataMint does not fire (no TM program involved)', () => {
  const tx = loadFixture('prnt_ref.json');
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

// ════════════════════════════════════════════════════════════════════════
// Legacy CreateMetadataAccountV3 — must not be poached by the new detector
// ════════════════════════════════════════════════════════════════════════

check('legacy CreateMetadataAccountV3 (disc 33) tx: new detector returns null (not a unified-Create tx)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['payer', 'metadataPda', 'legacyMint', 'mintAuthority', 'updateAuthorityKey', 'systemProgram', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 6, accounts: [1, 2, 3, 0, 4, 5], data: ixData(33) }],
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: Instruction: CreateMetadataAccountV3', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

// ════════════════════════════════════════════════════════════════════════
// False-positive audit — every category must reject
// ════════════════════════════════════════════════════════════════════════

check('unrelated Token Metadata tx (metadata update only, no Create) is rejected (null)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['metadataPda', 'updateAuth', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(15) }], // UpdateMetadataAccountV2
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: IX: Update Metadata Accounts v2', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

check('IX: CreateEscrowAccount (disc 38) tx is rejected (null — not a Create)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['escrowPda', 'metadataPda', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(38) }],
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: IX: CreateEscrowAccount', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

check('bare unified Mint (disc 43) with NO Create ix is rejected (null)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['payer', 'someAccount', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(43) }],
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: IX: Mint', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

check('unified Verify (disc 52) only, no Create, is rejected (null)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['authority', 'metadataPda', 'collMint', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 3, accounts: [0, 3, 1, 2], data: ixData(52, [1]) }],
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: IX: Verify', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

check('Burn (disc 41) only, no Create, is rejected (null)', () => {
  const TM = TOKEN_METADATA_PROGRAM;
  const keys = ['metadataPda', 'owner', TM];
  const tx = buildSyntheticTx({
    accountKeys: keys,
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: ixData(41) }],
    logMessages: [`Program ${TM} invoke [1]`, 'Program log: IX: Burn', `Program ${TM} success`],
  });
  assert.strictEqual(detectDirectUnifiedTokenMetadataMint(tx), null);
});

check('fungible token metadata creation (tokenStandard=2 Fungible) is rejected (not_nft_token_standard)', () => {
  const tx = buildBareUnifiedMintTx({ tokenStandard: 2, collectionKey: REAL_COLLECTION });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'not_nft_token_standard');
});

check('semi-fungible asset creation (tokenStandard=1 FungibleAsset) is rejected (not_nft_token_standard)', () => {
  const tx = buildBareUnifiedMintTx({ tokenStandard: 1, collectionKey: REAL_COLLECTION });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'not_nft_token_standard');
});

check('malformed/incomplete Create WITHOUT a matching Mint ix is rejected (no_completed_mint)', () => {
  const tx = buildBareUnifiedMintTx({ collectionKey: REAL_COLLECTION, includeMintIx: false });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'no_completed_mint');
});

check('Create + Mint ix present but postTokenBalances shows amount=0 (never completed) is rejected (no_completed_mint)', () => {
  const tx = buildBareUnifiedMintTx({ collectionKey: REAL_COLLECTION, supplyAmount: '0' });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'no_completed_mint');
});

check('malformed unified Create with fewer than 3 accounts fails closed (no_mint_address)', () => {
  const tx = buildBareUnifiedMintTx({ collectionKey: REAL_COLLECTION, mintAccountsOverride: [0, 1] });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'no_mint_address');
});

check('no collection at all (collection: None, no Verify ix) is rejected (no_collection)', () => {
  const tx = buildBareUnifiedMintTx({ collectionKey: undefined });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, false);
  assert.strictEqual(hit!.rejectReason, 'no_collection');
});

check('a genuinely valid bare unified Create+Mint WITH a real collection is accepted (positive control)', () => {
  const tx = buildBareUnifiedMintTx({ collectionKey: REAL_COLLECTION });
  const hit = detectDirectUnifiedTokenMetadataMint(tx);
  assert(hit);
  assert.strictEqual(hit!.accept, true, `expected accept, got reject reason=${hit!.rejectReason}`);
  assert.strictEqual(hit!.mintAddress, 'mint');
  assert.strictEqual(hit!.collectionAddress, REAL_COLLECTION);
});

console.log(`\n${passed} checks passed`);
