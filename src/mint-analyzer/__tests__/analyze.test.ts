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
import txMintxNoFixture from './fixtures/tx_mintx_no.json';
import txVvvHolderFixture from './fixtures/tx_vvv_holder.json';
import txVvvPublicFixture from './fixtures/tx_vvv_public.json';
import txLmnftHolderFixture from './fixtures/tx_lmnft_holder.json';
import txLmnftTreasuryFixture from './fixtures/tx_lmnft_treasury.json';
import txLmnftPublicFixture from './fixtures/tx_lmnft_public.json';

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
// NO (MintX) — server-gated Core Candy Guard mint co-signed by two MintX
// backend signers, with a pre-mint SPL transfer (soft token gate) to a
// MintX treasury vault ATA. Not a burn.
const SIG_MINTX_NO = '4NJcYNEEeRAa1Xzsa8XQd1iPmHGhMmcw5VwHXfdoyc7LKA4m8Cayuu4J3tuy7Hn6bDayUjr7oWYNaBt9q8wik35K';

const RFND_WRAPPER = 'RFND9n8ewvgg2hQLuwfR652KLUYNRFwXRkCrhJB3V5y';
const FORGE_WRAPPER = 'foRGEL4EUjeQMd8U2QL5Rx8je75ZFpmtLoWRyyAxxr7';
// MintX backend co-signers + treasury vault ATA receiving the soft-gate token.
const MINTX_SIGNER_A = 'xbWUT2Z3DWUrc4f65keHjntdtXiD7ov8d4Wj11yuBh8';
const MINTX_SIGNER_B = 'EBxTysPFiZymqFswF5SyLKCC5ybj6ii8wg8s2Mbhseex';
const MINTX_VAULT_ATA = '2jKMmXtUkfPr7xeue57tJt8a5TCxqQEwR8MUzz6eCqTc';

// NO (generic, non-Candy-Guard) — vvv.so direct MPL Core CreateV2 mints whose
// access is gated by a per-collection backend co-signer (5FyF…) that is
// neither the fee-payer nor the minted asset. The vvv.so key here is NOT the
// hardcoded platform signer, so detection must be STRUCTURAL: holder + public
// phases of the same drop are on-chain identical and both must score NO.
const SIG_VVV_HOLDER = '5d2vkvWEqeU4RLNxaFQUfD4pCuGXXopMMFBK1QVXhpfg2omSeFevirMj81wPMPsWHsgnzYTJui1Phr6kZ6PCNADT';
const SIG_VVV_PUBLIC = '2Uc3e3oQ84hNf3QefWPbiBHsW8ez4PUtyovmRq4nff9CigYUrUo2rxQ6hfezmFRZdfF6FYzLftPaDBJu3DB4Vp3o';
const VVV_BACKEND_SIGNER = '5FyFCWQjN3SWqFtAXYK1qbYqNBZm2VD3kJe33Cvd7wuk';

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
// Backward compat: a CMAGAKJ mint with NO extra co-signer must NOT trip the
// new server-signature gate (its only signers are the payer + the asset).
check('no server_signature_gate (not backend-gated)', () => assert.ok(
  aBurn.flowClues.detectedGates.every(g =>
    g.type !== 'server_signature_gate' && g.type !== 'off_chain_token_transfer_gate'),
));
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

// ── NO (MintX): two backend co-signers → blocked_server_captcha_signature,
//    with the off-chain soft-token gate visible as a pre-mint SPL transfer
//    to the MintX treasury vault (NOT a burn). Locks in the MintX pattern. ─
const aMintx = analyze(resultOf(txMintxNoFixture), SIG_MINTX_NO);
console.log('\ntx_mintx_no — MintX server-gated Core Candy Guard MPL Core CreateV2');
check('status success', () => assert.strictEqual(aMintx.status, 'success'));
check('primitive mpl_core_create_v2', () => assert.strictEqual(aMintx.likelyMintPrimitive, 'mpl_core_create_v2'));
check('backend signer observed', () => assert.strictEqual(aMintx.backendSignerObserved, true));
check('xbWUT2… backend signer labelled MintX', () => assert.ok(
  aMintx.signers.some(s => s.address === MINTX_SIGNER_A && s.class === 'known_platform_signer' && /MintX/i.test(s.label ?? '')),
));
check('EBxTys… backend signer labelled MintX', () => assert.ok(
  aMintx.signers.some(s => s.address === MINTX_SIGNER_B && s.class === 'known_platform_signer' && /MintX/i.test(s.label ?? '')),
));
check('verdict blocked_server_captcha_signature', () => assert.strictEqual(aMintx.verdict, 'blocked_server_captcha_signature'));
// AddressGate key (xbWUT2…) is detected STRUCTURALLY (referenced by the Core
// Candy Guard ix, not fee-payer, not the asset) — so a new MintX drop whose
// AddressGate key rotates would still be caught without hardcoding the key.
check('xbWUT2… is a structural backend co-signer in guard ix', () => assert.ok(
  aMintx.signers.some(s => s.address === MINTX_SIGNER_A
    && (s.class === 'known_platform_signer' || s.class === 'unknown_program_signer')),
));
// Core Candy Guard (CMAGAKJ…) is the real entry primitive, so the spurious
// System-funding "wrapper" is suppressed for server-gated mints.
check('customWrapper suppressed (Candy Guard is a primitive)', () => assert.strictEqual(aMintx.customWrapper, null));
check('verdictReasons mention server-gated / AddressGate', () => assert.ok(
  aMintx.verdictReasons.some(r => /server-gated|AddressGate|backend co-signature/i.test(r)),
));
// Flow Clues — the three new server-gate markers:
check('flowClues: server_signature_gate present', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'server_signature_gate'),
));
check('flowClues: server_signature_gate lists backend signers', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'server_signature_gate'
    && (g.signers ?? []).includes(MINTX_SIGNER_B)),
));
check('flowClues: off_chain_token_transfer_gate present, enforcedOnChain=false', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'off_chain_token_transfer_gate' && g.enforcedOnChain === false),
));
check('flowClues: soft_transfer_not_burn present', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'soft_transfer_not_burn'),
));
// The soft gate is NOT mislabelled as a plain/on-chain transfer or burn gate.
check('flowClues: NOT a plain spl_token_transfer_gate', () => assert.ok(
  aMintx.flowClues.detectedGates.every(g => g.type !== 'spl_token_transfer_gate'),
));
check('flowClues: transfer to MintX treasury vault 2jKM…', () => assert.ok(
  aMintx.flowClues.transferredAssets.some(t => t.to === MINTX_VAULT_ATA),
));
check('flowClues: gate is NOT a burn', () => assert.ok(
  aMintx.flowClues.burnedAssets.length === 0
    && aMintx.flowClues.detectedGates.every(g => g.type !== 'nft_burn_gate' && g.type !== 'spl_token_burn_gate'),
));
check('flowClues: candy_machine_v3 gate present', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'candy_machine_v3'),
));
check('flowClues: mpl_core_create present', () => assert.ok(
  aMintx.flowClues.detectedGates.some(g => g.type === 'mpl_core_create'),
));

// ── NO (generic): vvv.so direct MPL Core mints gated by a structural backend
//    co-signer. The holder and public phases are on-chain identical — both
//    must flip from the old false YES to NO via the generic (non-Candy-Guard)
//    backend-signer rule. ─────────────────────────────────────────────────
for (const [phase, fixture, sig] of [
  ['holder', txVvvHolderFixture, SIG_VVV_HOLDER] as const,
  ['public', txVvvPublicFixture, SIG_VVV_PUBLIC] as const,
]) {
  const aV = analyze(resultOf(fixture), sig);
  console.log(`\ntx_vvv_${phase} — vvv.so direct MPL Core CreateV2 with backend co-signer`);
  check('status success', () => assert.strictEqual(aV.status, 'success'));
  check('primitive mpl_core_create_v2', () => assert.strictEqual(aV.likelyMintPrimitive, 'mpl_core_create_v2'));
  check('verdict blocked_server_captcha_signature', () => assert.strictEqual(aV.verdict, 'blocked_server_captcha_signature'));
  check('backend signer observed', () => assert.strictEqual(aV.backendSignerObserved, true));
  check('no custom wrapper (direct mint)', () => assert.strictEqual(aV.customWrapper, null));
  check('5FyF… classified as backend co-signer', () => assert.ok(
    aV.signers.some(s => s.address === VVV_BACKEND_SIGNER
      && s.class === 'unknown_program_signer' && /backend co-signer/i.test(s.label ?? '')),
  ));
  check('fee payer NOT a backend signer', () => assert.ok(
    aV.signers[0].class === 'fee_payer',
  ));
  check('flowClues: server_signature_gate present', () => assert.ok(
    aV.flowClues.detectedGates.some(g => g.type === 'server_signature_gate'),
  ));
  check('flowClues: server_signature_gate lists 5FyF…', () => assert.ok(
    aV.flowClues.detectedGates.some(g => g.type === 'server_signature_gate'
      && (g.signers ?? []).includes(VVV_BACKEND_SIGNER)),
  ));
  check('verdictReason mentions extra backend co-signature', () => assert.ok(
    aV.verdictReasons.some(r => /extra backend co-signature that is neither the minter nor the minted asset/i.test(r)),
  ));
  // Generic gate only — no burn/transfer gate, and not mislabelled as Candy Guard.
  check('no burn/transfer gate', () => assert.ok(
    aV.flowClues.detectedGates.every(g =>
      !['nft_burn_gate', 'spl_token_burn_gate', 'nft_transfer_gate', 'spl_token_transfer_gate',
        'off_chain_token_transfer_gate', 'soft_transfer_not_burn'].includes(g.type)),
  ));
}

// ── Access-type layer (additive; orthogonal to verdict) ───────────────────
// LMNFT same-collection drop, three access phases that the verdict triad alone
// cannot tell apart (all three are verdict=MAYBE LaunchMyNFT). Structural
// signals: holder = invoked Account Compression verifyLeaf; treasury = fee
// payer fills the wrapper-ix treasury slots; public = short minimal payload.
const SIG_LMNFT_HOLDER = '5Y8RKLYSTA22qyDAv6KnwmpLpbVHTBVxWQKuvZvvW7H74KGUYWUZc22UtReka2PSuqoqCxEE4sEAbdP4XVNCaMZ6';
const SIG_LMNFT_TREASURY = '5aVQogzJewKfhj8J73y19AfBQAsZmyaskHA14nRAeaWTUJg2Ny5rSfDQ7UzD6WAmW9XNZ5qbsBUMteivj7YrkR5T';
const SIG_LMNFT_PUBLIC = 'USh3pn3KVjcNqyMPA5mqHWwHJjiXafquW19fvTEzY6GoPLWN1i1fud8qxFGtAQndof98Nyczk6hg2U3j74PD7W6';

const aLmHolder = analyze(resultOf(txLmnftHolderFixture), SIG_LMNFT_HOLDER);
console.log('\ntx_lmnft_holder — LaunchMyNFT MintCore gated by Account Compression verifyLeaf');
check('verdict unchanged (MAYBE / possible_requires_extra_inputs)', () => assert.strictEqual(aLmHolder.verdict, 'possible_requires_extra_inputs'));
check('knownLaunchpad = LaunchMyNFT', () => assert.strictEqual(aLmHolder.knownLaunchpad?.name, 'LaunchMyNFT'));
check('accessType = nft_holder_gate', () => assert.strictEqual(aLmHolder.accessType, 'nft_holder_gate'));
check('accessClues include launchmynft_wrapper', () => assert.ok((aLmHolder.accessClues ?? []).includes('launchmynft_wrapper')));
check('accessClues include account_compression_verify_leaf', () => assert.ok((aLmHolder.accessClues ?? []).includes('account_compression_verify_leaf')));
check('not misclassified backend_gated', () => assert.strictEqual(aLmHolder.backendSignerObserved, false));

const aLmTreasury = analyze(resultOf(txLmnftTreasuryFixture), SIG_LMNFT_TREASURY);
console.log('\ntx_lmnft_treasury — LaunchMyNFT MintCore self-minted by the treasury/authority');
check('verdict unchanged (MAYBE / possible_requires_extra_inputs)', () => assert.strictEqual(aLmTreasury.verdict, 'possible_requires_extra_inputs'));
check('accessType = treasury_manual_allowlist', () => assert.strictEqual(aLmTreasury.accessType, 'treasury_manual_allowlist'));
check('accessClues include treasury_signer', () => assert.ok((aLmTreasury.accessClues ?? []).includes('treasury_signer')));
check('no verifyLeaf clue (not a holder gate)', () => assert.ok(!(aLmTreasury.accessClues ?? []).includes('account_compression_verify_leaf')));

const aLmPublic = analyze(resultOf(txLmnftPublicFixture), SIG_LMNFT_PUBLIC);
console.log('\ntx_lmnft_public — LaunchMyNFT MintCore, arms-length public mint');
check('verdict unchanged (MAYBE / possible_requires_extra_inputs)', () => assert.strictEqual(aLmPublic.verdict, 'possible_requires_extra_inputs'));
check('accessType = public', () => assert.strictEqual(aLmPublic.accessType, 'public'));
check('accessClues include short_public_payload', () => assert.ok((aLmPublic.accessClues ?? []).includes('short_public_payload')));
check('no verifyLeaf clue', () => assert.ok(!(aLmPublic.accessClues ?? []).includes('account_compression_verify_leaf')));
check('no treasury_signer clue', () => assert.ok(!(aLmPublic.accessClues ?? []).includes('treasury_signer')));

// Backend-gated mints (VVV direct, MintX guard) carry accessType globally.
const aVvvAccess = analyze(resultOf(txVvvHolderFixture), SIG_VVV_HOLDER);
check('VVV holder accessType = backend_gated', () => assert.strictEqual(aVvvAccess.accessType, 'backend_gated'));
const aMintxAccess = analyze(resultOf(txMintxNoFixture), SIG_MINTX_NO);
check('MintX accessType = backend_gated', () => assert.strictEqual(aMintxAccess.accessType, 'backend_gated'));
// Direct YES (Candy Machine) is not LMNFT and not backend-gated → unknown (not forced).
const aDirectAccess = analyze(resultOf(tx1Fixture), SIG1);
check('tx1 direct accessType = unknown (not forced)', () => assert.strictEqual(aDirectAccess.accessType, 'unknown'));

// ── Access-type matrix ─────────────────────────────────────────────────────
console.log('\n── access-type matrix ──');
const matrix: Array<[string, string, MintAnalysis]> = [
  ['lmnft_holder', SIG_LMNFT_HOLDER, aLmHolder],
  ['lmnft_treasury', SIG_LMNFT_TREASURY, aLmTreasury],
  ['lmnft_public', SIG_LMNFT_PUBLIC, aLmPublic],
  ['vvv_holder', SIG_VVV_HOLDER, aVvvAccess],
  ['mintx', SIG_MINTX_NO, aMintxAccess],
  ['tx1_direct', SIG1, aDirectAccess],
];
for (const [label, sig, a] of matrix) {
  console.log(
    `  ${label.padEnd(15)} ${sig.slice(0, 8)}… | verdict=${a.verdict} | accessType=${a.accessType}` +
    ` | launchpad=${a.knownLaunchpad?.name ?? a.customWrapper?.programId?.slice(0, 8) ?? '—'}` +
    ` | primitive=${a.likelyMintPrimitive} | clues=[${(a.accessClues ?? []).join(', ')}]`,
  );
}

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
