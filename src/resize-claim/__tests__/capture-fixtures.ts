/**
 * Resize Claim — regression-fixture capture.
 *
 * Produces DETERMINISTIC, OFFLINE, "synthetic-real-builder" fixtures: the
 * REAL production `buildTransactions()` (this exact file's own
 * ../build.ts + ../program.ts, unmodified) is called against a MOCKED
 * `Connection` (no network, no signing, no broadcast) — only
 * `getLatestBlockhash` and `getAddressLookupTable` are stubbed, both with
 * plausible-shaped fake data. This is explicitly NOT a live-mainnet
 * verification (that already happened once, read-only, in this repo's own
 * docs/resize-claim-audit-2026-09-12.md §27, for the claim path) — it is a
 * deterministic regression fixture for the frontend structural auditor
 * (audit.ts / audit.test.ts), which needs stable, reproducible real-builder
 * bytes to test both positive and adversarial-mutation cases against.
 *
 * Run: `npm run capture:resize-claim-fixtures`. Re-run only if
 * program.ts's account layout deliberately changes — the frontend
 * regression tests exist specifically to force that to be a deliberate act.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { buildTransactions } from '../build';
import { MPL_DISTRO_PROGRAM_ID, TM_RESIZE_DISTRIBUTION, WSOL_MINT, CLAIM_ALT_ADDRESS, distributionVault } from '../program';

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

function fakeAlt(): AddressLookupTableAccount {
  // Same deterministic, non-signer, non-instance-specific accounts every
  // claim transaction references — a plausible stand-in for Metaplex's real
  // shared ALT (see program.ts's header for what those fixed accounts are).
  return new AddressLookupTableAccount({
    key: CLAIM_ALT_ADDRESS,
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [
        TM_RESIZE_DISTRIBUTION,
        WSOL_MINT,
        distributionVault(),
        MPL_DISTRO_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        SystemProgram.programId,
        SYSVAR_INSTRUCTIONS,
      ],
    },
  });
}

function mockConnection(): Connection {
  return {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 300_000_000,
    }),
    getAddressLookupTable: async () => ({ value: fakeAlt(), context: { slot: 0 } }),
  } as unknown as Connection;
}

async function main() {
  const wallet = Keypair.generate().publicKey.toBase58();
  const claimMint = Keypair.generate().publicKey.toBase58();
  const amountLamports = '2324640'; // matches the real live-verified example in the audit's §27
  const proof = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());

  const resizeMints = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  const conn = mockConnection();
  const out = await buildTransactions({
    conn,
    wallet,
    claims: [{ mint: claimMint, amountLamports, proof }],
    resizes: resizeMints.map((mint) => ({ mint })),
  });

  const claimTx = out.txs.find((t) => t.kind === 'claim');
  const resizeTx = out.txs.find((t) => t.kind === 'resize');
  if (!claimTx || !resizeTx) throw new Error('expected both a claim and a resize tx from the fixture build');

  const alt = fakeAlt();
  const fixture = {
    note: 'SYNTHETIC-REAL-BUILDER — built by the real buildTransactions()/program.ts against a mocked Connection. Not live-mainnet-verified (see docs/resize-claim-audit-2026-09-12.md §27 for the one live-verified claim). Regenerate via `npm run capture:resize-claim-fixtures` only after a deliberate program.ts layout change.',
    capturedAt: new Date().toISOString(),
    wallet,
    claim: { mint: claimMint, amountLamports, proof },
    resizeMints,
    blockhash: out.blockhash,
    lastValidBlockHeight: out.lastValidBlockHeight,
    claimTxBase64: claimTx.txBase64,
    resizeTxBase64: resizeTx.txBase64,
    alts: { [alt.key.toBase58()]: alt.state.addresses.map((a) => a.toBase58()) },
  };

  const outPath = join(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'tools', 'resize-claim', '__fixtures__', 'resize-claim-fixtures.json');
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
