// Candy Mint — structural audit of the FINAL transaction bytes handed to
// Phantom (M5). Pure; @solana/web3.js only (the frontend has no metaplex
// SDK). Runs on the exact base64 that will be signed — for the single flow
// after the final rebuild, for each batch item after phase-1.5 rebuild —
// and fails CLOSED before any signature is requested.
//
// The layouts below are not guessed. They are documented from real
// production-builder output captured read-only from live candy machines
// (`src/candy-mint/__tests__/capture-fixtures.ts` -> ./fixtures/*.json) with
// the currently-installed SDK versions:
//   @metaplex-foundation/mpl-core-candy-machine ^0.3.0
//   @metaplex-foundation/mpl-candy-machine      ^6.1.0
//
// ── CORE  (Core Candy Guard `CMAGAK…` MintV1) ──────────────────────────────
//   top level: [ ComputeBudget SetComputeUnitLimit,
//                ComputeBudget SetComputeUnitPrice,
//                Core Candy Guard MintV1 ]           (exactly 3, nothing after)
//   MintV1 discriminator: 145,98,192,118,184,147,118,104
//   MintV1 accounts (13 fixed + guard extras; 14 observed with one solPayment):
//     0 candyGuard              6 owner (== minter, or the guard program id
//     1 candyMachineProgram        as the "not set" sentinel)
//     2 candyMachine (w)        7 asset       (signer, w) <- ephemeral
//     3 authorityPda (w, PDA)   8 collection  (w)
//     4 payer   (signer, w)     9 mplCoreProgram
//     5 minter  (signer, w)    10 systemProgram
//                              11 sysvarInstructions
//                              12 recentSlotHashes
//     [13+] guard extra accounts — e.g. solPayment destination at #13
//           (order depends on which guards are enabled)
//
// ── LEGACY  (Token-Metadata Candy Guard `Guard1J…` MintV2) ─────────────────
//   top level: [ CB SetComputeUnitLimit, CB SetComputeUnitPrice,
//                Candy Guard MintV2 ]                (exactly 3, nothing after)
//   MintV2 discriminator: 120,121,23,146,173,110,199,205
//   MintV2 accounts (25 fixed + guard extras; 26 with one solPayment):
//     0 candyGuard             13 collectionMint
//     1 candyMachineProgram    14 collectionMetadata (w, PDA)
//     2 candyMachine (w)       15 collectionMasterEdition (PDA)
//     3 authorityPda (w, PDA)  16 collectionUpdateAuthority
//     4 payer  (signer, w)     17 tokenMetadataProgram
//     5 minter (signer, w)     18 splTokenProgram
//     6 nftMint (signer, w) <- ephemeral   19 splAtaProgram
//     7 nftMintAuthority (signer, w) == minter   20 systemProgram
//     8 nftMetadata (w, PDA)   21 sysvarInstructions
//     9 nftMasterEdition (w)   22 recentSlotHashes
//    10 token (w, ATA/PDA)     23 authorizationRulesProgram (or sentinel)
//    11 tokenRecord (or sentinel)  24 authorizationRules (or sentinel)
//    12 collectionDelegateRecord (PDA)
//     [25+] guard extra accounts (solPayment destination, …)
//
// If any of the above drifts after an SDK bump, re-run the fixture capture,
// update the constants, and the regression tests force a deliberate review.
// Do NOT loosen a check to make a synthetic fixture pass.

import { Transaction } from '@solana/web3.js';
import type { FrozenMintIntent } from './intent';
import { intentPaymentDestinations } from './intent';

// ── program ids ───────────────────────────────────────────────────────────
export const PROGRAMS = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ataProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  tokenMetadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  mplCore: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  coreCandyGuard: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
  coreCandyMachine: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  legacyCandyGuard: 'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g',
  legacyCandyMachine: 'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR',
  sysvarInstructions: 'Sysvar1nstructions1111111111111111111111111',
  slotHashes: 'SysvarS1otHashes111111111111111111111111111',
} as const;

// Exactly what build.ts prepends. Asserted, not merely bounded — a change in
// the builder must be a deliberate re-audit (a fixture regen + these
// constants). A too-low price is fine; a runaway priority price is a fee
// drain, so `computeUnitPrice` is the one value given headroom rather than
// an exact pin.
export const EXPECTED_COMPUTE_UNIT_LIMIT = 400_000;
export const EXPECTED_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 50_000;
// 2x the builder's constant — catches a runaway (e.g. a compromised builder
// setting 50_000_000 µL, which at 400k CU is 0.02 SOL of priority fee).
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 100_000;

const CORE_MINT_V1_DISCRIMINATOR = [145, 98, 192, 118, 184, 147, 118, 104];
const LEGACY_MINT_V2_DISCRIMINATOR = [120, 121, 23, 146, 173, 110, 199, 205];

const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

// ── guard remaining-account containment (exact count) ─────────────────────
// The Candy Guard MintV1/MintV2 instruction's account list is a FIXED base
// set + one contiguous tail of per-guard "remaining accounts", in enabled-
// guard order. The base size and each guard's tail size are deterministic in
// the current SDKs — verified directly from
//   node_modules/@metaplex-foundation/mpl-{core-,}candy-machine/dist/src/
//     defaultGuards/*.js  (mintParser.remainingAccounts)
// So for a KNOWN set of enabled guards the total account count is exact. An
// account count ABOVE that total means the backend injected an extra account
// — which is the only way an unauthorized payment-affecting account could
// ride along beside the legit one. Below → a guard was dropped / added.
//
// If the reviewed guard set contains a guard NOT in this table (a freeze
// guard, or a future addition), the exact check is skipped and the auditor
// falls back to positive destination containment + paymentAuthorizationMatches
// only — see the audit report's guard matrix.
const GUARD_MINT_ACCOUNTS: Record<string, { core: number; legacy: number }> = {
  botTax:          { core: 0, legacy: 0 },
  startDate:       { core: 0, legacy: 0 },
  endDate:         { core: 0, legacy: 0 },
  redeemedAmount:  { core: 0, legacy: 0 },
  addressGate:     { core: 0, legacy: 0 },
  solPayment:      { core: 1, legacy: 1 },  // destination (w)
  solFixedFee:     { core: 1, legacy: 1 },  // destination (w) — core SDK only in practice
  mintLimit:       { core: 1, legacy: 1 },  // mint-counter PDA (w, deterministic)
  allocation:      { core: 1, legacy: 1 },  // allocation-tracker PDA (w, deterministic)
  tokenPayment:    { core: 3, legacy: 2 },  // sourceAta(w), destinationAta(w) [+ splToken(r) on core]
  token2022Payment:{ core: 4, legacy: 3 },  // sourceAta(w), destinationAta(w), mint(r) [+ token2022(r) on core]
  // freezeSolPayment / freezeTokenPayment are intentionally ABSENT — their
  // mint-side tail includes route-derived PDAs whose count has varied across
  // SDK minors; positive containment + paymentAuthorizationMatches still
  // cover the spend.
};
const BASE_MINT_ACCOUNTS = { core: 13, legacy: 25 };

// SPL Token / Token-2022 instruction opcodes that move or re-authorize
// value — never legitimately a TOP-LEVEL instruction in a candy mint (the
// guard does its own payment CPIs internally).
const FORBIDDEN_TOKEN_OPCODES = new Set([
  3,  // Transfer
  4,  // Approve
  6,  // SetAuthority
  8,  // Burn
  9,  // CloseAccount
  12, // TransferChecked
  13, // ApproveChecked
  15, // BurnChecked
]);
// SystemProgram instruction indexes that move lamports.
const FORBIDDEN_SYSTEM_OPCODES = new Set([
  2,  // Transfer
  11, // TransferWithSeed
]);

export type AuditResult = { ok: true } | { ok: false; reason: string };

function fail(reason: string): AuditResult { return { ok: false, reason }; }

interface Pin { i: number; want: string; label: string; signer?: boolean; writable?: boolean }

export function auditCandyMintTx(
  base64: string,
  intent: FrozenMintIntent,
  opts: { expectedAsset: string; connectedWallet?: string },
): AuditResult {
  // 0 — parse
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(base64, 'base64'));
  } catch (e) {
    return fail(`transaction did not parse: ${(e as Error).message}`);
  }

  // 1 — recent blockhash present
  if (!tx.recentBlockhash || typeof tx.recentBlockhash !== 'string') {
    return fail('transaction has no recent blockhash');
  }

  // 2 — fee payer == frozen wallet (and, if given, the live connected wallet)
  const feePayer = tx.feePayer?.toBase58();
  if (feePayer !== intent.wallet) {
    return fail(`fee payer ${feePayer ?? '<none>'} != reviewed wallet ${intent.wallet.slice(0, 8)}…`);
  }
  if (opts.connectedWallet && opts.connectedWallet !== intent.wallet) {
    return fail('connected wallet changed since the mint was reviewed — reconnect and start over');
  }

  const ixs = tx.instructions;
  if (ixs.length < 3) return fail(`expected 3 top-level instructions, got ${ixs.length}`);

  // 3 — top-level shape: 1-2 ComputeBudget, then exactly one Candy Guard
  //     instruction, then NOTHING.
  const guardProgram = intent.family === 'core' ? PROGRAMS.coreCandyGuard : PROGRAMS.legacyCandyGuard;
  let guardIdx = -1;
  let sawLimit = false;
  let sawPrice = false;
  for (let i = 0; i < ixs.length; i++) {
    const pid = ixs[i].programId.toBase58();
    if (pid === PROGRAMS.computeBudget) {
      if (guardIdx !== -1) return fail(`ComputeBudget instruction #${i} appears after the Candy Guard instruction`);
      const op = ixs[i].data[0];
      if (op === CB_SET_UNIT_LIMIT) {
        if (sawLimit) return fail('duplicate SetComputeUnitLimit');
        sawLimit = true;
        if (ixs[i].data.length < 5) return fail('malformed SetComputeUnitLimit');
        const units = ixs[i].data.readUInt32LE(1);
        if (units !== EXPECTED_COMPUTE_UNIT_LIMIT) {
          return fail(`compute unit limit ${units} != expected ${EXPECTED_COMPUTE_UNIT_LIMIT}`);
        }
      } else if (op === CB_SET_UNIT_PRICE) {
        if (sawPrice) return fail('duplicate SetComputeUnitPrice');
        sawPrice = true;
        if (ixs[i].data.length < 9) return fail('malformed SetComputeUnitPrice');
        const price = ixs[i].data.readBigUInt64LE(1);
        if (price > BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)) {
          return fail(`compute unit price ${price} µL exceeds the ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS} µL ceiling`);
        }
      } else {
        return fail(`unexpected ComputeBudget opcode ${op} (only SetComputeUnitLimit/SetComputeUnitPrice allowed)`);
      }
      continue;
    }
    if (pid === guardProgram) {
      if (guardIdx !== -1) return fail('more than one Candy Guard instruction');
      guardIdx = i;
      continue;
    }
    return fail(`unexpected top-level program ${pid.slice(0, 8)}… (only ComputeBudget + the ${intent.family} Candy Guard are allowed)`);
  }
  if (guardIdx === -1) return fail(`no ${intent.family} Candy Guard instruction found`);
  if (guardIdx !== ixs.length - 1) return fail('instructions present after the Candy Guard instruction');

  // 4 — belt-and-braces: no forbidden value-moving instruction anywhere at
  //     the top level (step 3 already restricts programs, this names the
  //     specific danger for a clearer message and future-proofs the check).
  for (let i = 0; i < ixs.length; i++) {
    const pid = ixs[i].programId.toBase58();
    const op = ixs[i].data[0];
    if (pid === PROGRAMS.system && FORBIDDEN_SYSTEM_OPCODES.has(op)) {
      return fail(`top-level SystemProgram value transfer (opcode ${op}) is not allowed`);
    }
    if ((pid === PROGRAMS.splToken || pid === PROGRAMS.token2022) && FORBIDDEN_TOKEN_OPCODES.has(op)) {
      return fail(`top-level SPL Token instruction (opcode ${op}) is not allowed`);
    }
  }

  // 5 — the Candy Guard instruction: discriminator + account pins
  const guard = ixs[guardIdx];
  const disc = [...guard.data.subarray(0, 8)];
  const wantDisc = intent.family === 'core' ? CORE_MINT_V1_DISCRIMINATOR : LEGACY_MINT_V2_DISCRIMINATOR;
  if (disc.length !== 8 || !wantDisc.every((b, k) => disc[k] === b)) {
    return fail(`Candy Guard instruction discriminator [${disc}] != expected ${intent.family} MintV${intent.family === 'core' ? '1' : '2'}`);
  }

  const keys = guard.keys;
  const at = (i: number): string | undefined => keys[i]?.pubkey?.toBase58();

  const pins: Pin[] = intent.family === 'core'
    ? [
        { i: 0, want: intent.candyGuard, label: 'candyGuard' },
        { i: 1, want: PROGRAMS.coreCandyMachine, label: 'candyMachineProgram' },
        { i: 2, want: intent.candyMachine, label: 'candyMachine', writable: true },
        { i: 4, want: intent.wallet, label: 'payer', signer: true, writable: true },
        { i: 5, want: intent.wallet, label: 'minter', signer: true, writable: true },
        { i: 7, want: opts.expectedAsset, label: 'asset signer', signer: true, writable: true },
        { i: 8, want: intent.collection, label: 'collection', writable: true },
        { i: 9, want: PROGRAMS.mplCore, label: 'mplCoreProgram' },
        { i: 10, want: PROGRAMS.system, label: 'systemProgram' },
      ]
    : [
        { i: 0, want: intent.candyGuard, label: 'candyGuard' },
        { i: 1, want: PROGRAMS.legacyCandyMachine, label: 'candyMachineProgram' },
        { i: 2, want: intent.candyMachine, label: 'candyMachine', writable: true },
        { i: 4, want: intent.wallet, label: 'payer', signer: true, writable: true },
        { i: 5, want: intent.wallet, label: 'minter', signer: true, writable: true },
        { i: 6, want: opts.expectedAsset, label: 'nftMint signer', signer: true, writable: true },
        { i: 7, want: intent.wallet, label: 'nftMintAuthority', signer: true, writable: true },
        { i: 13, want: intent.collection, label: 'collectionMint' },
        { i: 17, want: PROGRAMS.tokenMetadata, label: 'tokenMetadataProgram' },
        { i: 18, want: PROGRAMS.splToken, label: 'splTokenProgram' },
        { i: 19, want: PROGRAMS.ataProgram, label: 'splAtaProgram' },
        { i: 20, want: PROGRAMS.system, label: 'systemProgram' },
      ];

  for (const p of pins) {
    const got = at(p.i);
    if (got !== p.want) {
      return fail(`Candy Guard account #${p.i} (${p.label}) is ${got?.slice(0, 8) ?? '<missing>'}…, expected ${p.want.slice(0, 8)}…`);
    }
    if (p.signer && !keys[p.i].isSigner) return fail(`Candy Guard account #${p.i} (${p.label}) must be a signer`);
    if (p.writable && !keys[p.i].isWritable) return fail(`Candy Guard account #${p.i} (${p.label}) must be writable`);
  }

  // core `owner` (#6): either the wallet (explicitly set) or the guard
  // program id (Umi's "not provided" sentinel -> program mints to minter).
  if (intent.family === 'core') {
    const owner = at(6);
    if (owner !== intent.wallet && owner !== PROGRAMS.coreCandyGuard) {
      return fail(`Candy Guard account #6 (owner) is ${owner?.slice(0, 8) ?? '<missing>'}…, expected the connected wallet or the unset sentinel`);
    }
  }

  // legacy collectionUpdateAuthority (#16) — only pinnable when the reviewed
  // intent carried it (reference-signature path). Raw-address entry leaves it
  // for the backend to resolve live, so we can't pin it here.
  if (intent.family === 'legacy' && intent.collectionUpdateAuthority) {
    const cua = at(16);
    if (cua !== intent.collectionUpdateAuthority) {
      return fail(`collectionUpdateAuthority #16 is ${cua?.slice(0, 8) ?? '<missing>'}…, expected ${intent.collectionUpdateAuthority.slice(0, 8)}…`);
    }
  }

  // 6 — signature slots: the ephemeral asset must be pre-signed by the
  //     backend; the ONLY outstanding signature is the connected wallet's.
  const sigForAsset = tx.signatures.find((s) => s.publicKey.toBase58() === opts.expectedAsset);
  if (!sigForAsset || !sigForAsset.signature) {
    return fail('ephemeral asset/mint keypair is not pre-signed by the builder');
  }
  const sigForWallet = tx.signatures.find((s) => s.publicKey.toBase58() === intent.wallet);
  if (!sigForWallet) return fail('connected wallet is not a required signer of the transaction');
  if (sigForWallet.signature) return fail('connected wallet signature slot is already filled (unexpected)');
  const otherUnfilled = tx.signatures.filter(
    (s) => !s.signature && s.publicKey.toBase58() !== intent.wallet,
  );
  if (otherUnfilled.length > 0) {
    return fail(`unexpected additional unsigned signer(s): ${otherUnfilled.map((s) => s.publicKey.toBase58().slice(0, 6)).join(', ')}`);
  }

  // 7a — EXACT remaining-account count for a known reviewed guard set. Catches
  //      an injected extra account (the only way an unauthorized payment
  //      account could coexist with the legit one) and a guard added/removed
  //      since review. Skipped only when a guard isn't in the count table.
  const fam = intent.family;
  const known = intent.enabledGuards.every((g) => g in GUARD_MINT_ACCOUNTS);
  if (known) {
    const expected = BASE_MINT_ACCOUNTS[fam]
      + intent.enabledGuards.reduce((n, g) => n + GUARD_MINT_ACCOUNTS[g][fam], 0);
    if (keys.length !== expected) {
      return fail(
        `Candy Guard instruction has ${keys.length} accounts; the reviewed guard set `
        + `[${intent.enabledGuards.join(', ') || 'none'}] requires exactly ${expected}`,
      );
    }
  }

  // 7b — payment containment: every SOL/token destination the REVIEWED guard
  //      config authorizes must actually appear in the built Candy Guard
  //      instruction's account list. A destination that isn't there means the
  //      backend pointed payment somewhere the user didn't review.
  const guardAccts = new Set(keys.map((k) => k.pubkey.toBase58()));
  for (const dest of intentPaymentDestinations(intent)) {
    if (!guardAccts.has(dest)) {
      return fail(`reviewed payment destination ${dest.slice(0, 8)}… is not present in the built transaction`);
    }
  }

  // 8 — addressGate: the mint is gated to a single wallet on-chain. If the
  //     reviewed config has one and it isn't the connected wallet, the mint
  //     is a guaranteed on-chain failure — fail closed here too (the UI also
  //     blocks it earlier, M7).
  if (intent.payment.addressGateAddress && intent.payment.addressGateAddress !== intent.wallet) {
    return fail(`this drop is address-gated to ${intent.payment.addressGateAddress.slice(0, 8)}… — the connected wallet cannot mint it`);
  }

  return { ok: true };
}
