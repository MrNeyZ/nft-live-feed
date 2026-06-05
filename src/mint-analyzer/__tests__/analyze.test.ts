/**
 * Mint Analyzer — offline fixture tests.
 *
 * Runs `analyze()` against five committed `getTransaction` captures and
 * asserts the documented classifications, covering all four UI verdict
 * states. No network, no RPC, no DB — the fixtures ARE the test surface.
 * Run: `npm run test:mint-analyzer`.
 */
import assert from 'assert';
import { analyze } from '../analyze';
import type { RawRpcTx, MintAnalysis } from '../types';

import tx1Fixture from './fixtures/tx1.json';
import tx2Fixture from './fixtures/tx2.json';
import tx3Fixture from './fixtures/tx3.json';
import txMaybeFixture from './fixtures/tx_maybe.json';
import txNoFixture from './fixtures/tx_no.json';
import txBurnGateFixture from './fixtures/tx_burn_gate.json';

const SIG1 ='5wkbhQ3QHti69S3dqo4F1Y8PtTKofLSRWzeNW5foMrBCXkz7ntNDGTJMCHi7S21ChHghwUC8UZRHSmTLwKR6ujYr';
const SIG2 = '2ZshWXyj47naARpnWBDUKtg1AH1ZAWF2YRhg9gFd44zKEVYJMPkA8zJBs8yJQpy4sY5AJ9Rq6k9iyKuihjYXqvLA';
const SIG3 = '3zLWyBWJDNctGdEe6v57hgQW5j8Kxwdwv4FeU6DL1rvLeg9rGS26frEtA9vM2MhGbLEGCAtFFrq166kpBEsFFGZS';
// MAYBE — LaunchMyNFT (entry program in KNOWN_LAUNCHPAD_IDS).
const SIG_MAYBE = '3qjW71UQFuq9X65Fk4bKVmGyPs6XVGc8rtHF1UiqzBJ7AfQ9ZA1RVX1PpKYFGJfG93vwcCcuTR5edV2zXNtDDUeQ';
// NO — vvv.so mint co-signed by the vvv.so platform signer.
const SIG_NO = '4nvMBRxq7L7eY7spzMWggj1QjenbcZ5uUMEKb49Fy8vCMRUvSKc62gWtdxWRz7EEQtKFyrgPC72EfG2FvCjCxv4Q';
// MANUAL RE + burn-gate flow clues — Core Candy Guard mint gated by an SPL
// burn of 1 SagaPass (Shaolin Saga Mint Pass) before the MPL Core create.
const SIG_BURN_GATE = '3KbsQgTpLjWGa1w87WRoRS9mNw9nYjVRi269HB2BrZo23KXufj3iZKwZ6RLgedpdfvz9zUjzDZXvAqM955rjckrp';

const RFND_WRAPPER = 'RFND9n8ewvgg2hQLuwfR652KLUYNRFwXRkCrhJB3V5y';
const FORGE_WRAPPER = 'foRGEL4EUjeQMd8U2QL5Rx8je75ZFpmtLoWRyyAxxr7';

function resultOf(fixture: unknown): RawRpcTx {
  return (fixture as { result: RawRpcTx }).result;
}

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
  } catch (err) {
    failures++;
    console.error(`  ❌ ${label}\n     ${(err as Error).message}`);
  }
}

function programIds(a: MintAnalysis): string[] {
  return a.programs.map(p => p.programId);
}

// ── tx1: Candy Machine v3 + Candy Guard MintV2, reconstructable ────────────
const a1 = analyze(resultOf(tx1Fixture), SIG1);
console.log('\ntx1 — Candy Machine v3 + Candy Guard MintV2');
check('status success', () => assert.strictEqual(a1.status, 'success'));
check('primitive candy_machine_v3_mintv2', () => assert.strictEqual(a1.likelyMintPrimitive, 'candy_machine_v3_mintv2'));
check('candy guard detected', () => assert.strictEqual(a1.guardAuth.candyGuard, true));
check('mintV2 instruction decoded', () => assert.ok(a1.instructions.some(i => i.instructionName === 'mintV2')));
check('no custom wrapper', () => assert.strictEqual(a1.customWrapper, null));
check('no backend signer observed', () => assert.strictEqual(a1.backendSignerObserved, false));
check('verdict direct_mint_likely_reconstructable', () => assert.strictEqual(a1.verdict, 'direct_mint_likely_reconstructable'));

// ── tx2: custom RFND wrapper + MPL Core CreateV2, manual RE ────────────────
const a2 = analyze(resultOf(tx2Fixture), SIG2);
console.log('\ntx2 — custom RFND launchpad wrapper + MPL Core CreateV2');
check('status success', () => assert.strictEqual(a2.status, 'success'));
check('primitive mpl_core_create_v2', () => assert.strictEqual(a2.likelyMintPrimitive, 'mpl_core_create_v2'));
check('CreateV2 instruction decoded', () => assert.ok(a2.instructions.some(i => i.instructionName === 'CreateV2')));
check('custom wrapper = RFND', () => assert.strictEqual(a2.customWrapper?.programId, RFND_WRAPPER));
check('RFND in programs called', () => assert.ok(programIds(a2).includes(RFND_WRAPPER)));
check('no backend signer observed', () => assert.strictEqual(a2.backendSignerObserved, false));
check('verdict custom_program_manual_re_required', () => assert.strictEqual(a2.verdict, 'custom_program_manual_re_required'));

// ── tx3: custom foRGE wrapper + MPL Core CreateV2, manual RE ───────────────
const a3 = analyze(resultOf(tx3Fixture), SIG3);
console.log('\ntx3 — custom foRGE wrapper + MPL Core CreateV2');
check('status success', () => assert.strictEqual(a3.status, 'success'));
check('primitive mpl_core_create_v2', () => assert.strictEqual(a3.likelyMintPrimitive, 'mpl_core_create_v2'));
check('CreateV2 instruction decoded', () => assert.ok(a3.instructions.some(i => i.instructionName === 'CreateV2')));
check('custom wrapper = foRGE', () => assert.strictEqual(a3.customWrapper?.programId, FORGE_WRAPPER));
check('foRGE in programs called', () => assert.ok(programIds(a3).includes(FORGE_WRAPPER)));
check('no backend signer observed', () => assert.strictEqual(a3.backendSignerObserved, false));
check('verdict custom_program_manual_re_required', () => assert.strictEqual(a3.verdict, 'custom_program_manual_re_required'));

// ── MAYBE: LaunchMyNFT launchpad → possible_requires_extra_inputs ───────────
const aMaybe = analyze(resultOf(txMaybeFixture), SIG_MAYBE);
console.log('\ntx_maybe — LaunchMyNFT launchpad + MPL Core CreateV2');
check('status success', () => assert.strictEqual(aMaybe.status, 'success'));
check('primitive mpl_core_create_v2', () => assert.strictEqual(aMaybe.likelyMintPrimitive, 'mpl_core_create_v2'));
check('knownLaunchpad name = LaunchMyNFT', () => assert.strictEqual(aMaybe.knownLaunchpad?.name, 'LaunchMyNFT'));
check('no custom wrapper', () => assert.strictEqual(aMaybe.customWrapper, null));
check('no backend signer observed', () => assert.strictEqual(aMaybe.backendSignerObserved, false));
check('verdict possible_requires_extra_inputs', () => assert.strictEqual(aMaybe.verdict, 'possible_requires_extra_inputs'));

// ── NO: vvv.so platform co-signer → blocked_server_captcha_signature ────────
const aNo = analyze(resultOf(txNoFixture), SIG_NO);
console.log('\ntx_no — vvv.so platform-signed MPL Core CreateV2');
check('status success', () => assert.strictEqual(aNo.status, 'success'));
check('primitive mpl_core_create_v2', () => assert.strictEqual(aNo.likelyMintPrimitive, 'mpl_core_create_v2'));
check('backend signer observed', () => assert.strictEqual(aNo.backendSignerObserved, true));
check('a signer is labelled vvv.so platform signer', () => assert.ok(
  aNo.signers.some(s => s.class === 'known_platform_signer' && (s.label ?? '').includes('vvv.so platform signer')),
));
check('verdict blocked_server_captcha_signature', () => assert.strictEqual(aNo.verdict, 'blocked_server_captcha_signature'));

// ── burn-gate: Flow Clues surface an NFT burn gate without changing verdict ─
const aBurn = analyze(resultOf(txBurnGateFixture), SIG_BURN_GATE);
console.log('\ntx_burn_gate — Core Candy Guard mint gated by SagaPass burn');
check('status success', () => assert.strictEqual(aBurn.status, 'success'));
check('verdict still custom_program_manual_re_required', () => assert.strictEqual(aBurn.verdict, 'custom_program_manual_re_required'));
check('primitive still mpl_core_create_v2', () => assert.strictEqual(aBurn.likelyMintPrimitive, 'mpl_core_create_v2'));
check('backendSignerObserved unchanged (false)', () => assert.strictEqual(aBurn.backendSignerObserved, false));
check('detectedGates contains nft_burn_gate', () => assert.ok(
  aBurn.flowClues.detectedGates.some(g => g.type === 'nft_burn_gate'),
));
check('nft_burn_gate confidence HIGH', () => assert.ok(
  aBurn.flowClues.detectedGates.some(g => g.type === 'nft_burn_gate' && g.confidence === 'high'),
));
check('burnedAssets contains SagaPass', () => assert.ok(
  aBurn.flowClues.burnedAssets.some(b => b.name === 'SagaPass'),
));
check('detectedGates contains candy_machine_v3', () => assert.ok(
  aBurn.flowClues.detectedGates.some(g => g.type === 'candy_machine_v3'),
));
check('mintFlow burn precedes candy machine / create', () => {
  const flow = aBurn.flowClues.mintFlow;
  const burnIdx = flow.findIndex(s => /burn/i.test(s));
  const mintIdx = flow.findIndex(s => /candy machine|create/i.test(s));
  assert.ok(burnIdx >= 0, 'mintFlow has a burn step');
  assert.ok(mintIdx >= 0, 'mintFlow has a candy-machine/create step');
  assert.ok(burnIdx < mintIdx, 'burn step precedes the mint step');
});

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
