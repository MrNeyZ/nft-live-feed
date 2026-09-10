/**
 * Candy Mint — real production-builder fixture capture (READ-ONLY).
 *
 *   HELIUS_API_KEY=… npx ts-node src/candy-mint/__tests__/capture-fixtures.ts
 *
 * Decodes a real, recently-landed candy-guard mint signature for each family,
 * then drives the ACTUAL production builder (buildCandyMintTx / build.ts) with
 * a throwaway wallet pubkey. NOTHING is signed or broadcast — the wallet is a
 * noop signer, and the returned transaction is written verbatim to
 * ./fixtures/{core,legacy}-mintv1.json alongside the frozen-intent values it
 * must audit against.
 *
 * The candy machine has to still be ALIVE on-chain (not sold out / closed) for
 * a build to succeed — pass fresh signatures via CORE_SIG / LEGACY_SIG env if
 * the defaults below have since been reclaimed.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Keypair, Transaction } from '@solana/web3.js';
import { decodeCandyMintSignature } from '../decode';
import { inspectCandyMachine } from '../guard-config';
import { buildCandyMintTx } from '../build';

const CORE_SIG = process.env.CORE_SIG
  ?? '2AhnnEcwj9SpJZArbES3bc1bFnFdUabp2D6HZ6DUdxJrubVio3F3ETZt8hP1C2Zv6ao2EM7NYnwvAe2oz9rkf9UD';
const LEGACY_SIG = process.env.LEGACY_SIG
  ?? '52VC1GBnqDJ3hRr2LeHfrXbti7SNy8f48jtDmRBviwixZJapXuLeJRSeSGb2p9MjG57bBKTJZKBo5WDy7864uNNY';

async function capture(label: 'core' | 'legacy', sig: string) {
  const wallet = Keypair.generate().publicKey.toBase58();
  console.log(`\n[${label}] decoding ${sig.slice(0, 12)}…`);
  const decoded = await decodeCandyMintSignature(sig);
  if (!decoded.ok) throw new Error(`${label}: decode failed: ${decoded.error}`);
  const d = decoded.decoded;
  console.log(`[${label}] family=${d.family} cm=${d.candyMachine} guard=${d.candyGuard} group=${d.group ?? '(root)'}`);
  if (d.family !== label) throw new Error(`${label}: signature decoded as ${d.family}`);

  const inspection = await inspectCandyMachine(d.family, d.candyMachine, d.candyGuard, wallet);
  const forced = process.env[`${label.toUpperCase()}_GROUP`];
  // A wallet-signature-only build needs a SUPPORTED group; the reference
  // signature's own group is often an allowlist stage. Prefer supported.
  const group = (forced ? inspection.groups.find((g) => (g.label ?? '') === forced) : null)
    ?? inspection.groups.find((g) => g.label === d.group && g.supported)
    ?? inspection.groups.find((g) => g.supported)
    ?? inspection.groups.find((g) => g.label === d.group)
    ?? inspection.groups[0];
  if (!group) throw new Error(`${label}: no guard group`);
  if (!group.supported) throw new Error(`${label}: no supported guard group (best: "${group.label}" needs ${group.unsupportedGuards})`);
  console.log(`[${label}] group="${group.label ?? '(root)'}" supported=${group.supported} enabled=[${group.enabledGuards}]`);

  const built = await buildCandyMintTx({
    family: d.family,
    candyMachine: d.candyMachine,
    candyGuard: d.candyGuard,
    collection: inspection.collection ?? d.collection,
    collectionUpdateAuthority: d.collectionUpdateAuthority,
    group: group.label,
    wallet,
  });
  if (!built.ok) throw new Error(`${label}: build failed: ${built.error}`);

  // Decode the produced tx for the layout documentation section of the fixture.
  const tx = Transaction.from(Buffer.from(built.transactionBase64, 'base64'));
  const layout = tx.instructions.map((ix, i) => ({
    index: i,
    programId: ix.programId.toBase58(),
    dataFirst8: [...ix.data.subarray(0, 8)],
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable,
    })),
  }));

  const fixture = {
    capturedAt: new Date().toISOString(),
    family: d.family,
    referenceSignature: sig,
    frozenIntent: {
      wallet,
      family: d.family,
      candyMachine: d.candyMachine,
      candyGuard: d.candyGuard,
      collection: inspection.collection ?? d.collection,
      collectionUpdateAuthority: d.collectionUpdateAuthority,
      group: group.label,
      enabledGuards: group.enabledGuards,
      // The reviewed payment authorization for this group — identical to
      // build.resolvedGuardPayment at capture time. The frozen intent's
      // `payment` is built from this in the auditor tests.
      payment: group.payment,
    },
    build: {
      transactionBase64: built.transactionBase64,
      asset: built.asset,
      feePayer: built.feePayer,
      requiresSignatureFrom: built.requiresSignatureFrom,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      resolvedGuardPayment: built.resolvedGuardPayment,
      resolvedEnabledGuards: built.resolvedEnabledGuards,
    },
    observedLayout: layout,
  };

  const json = JSON.stringify(fixture, null, 2);
  // Written to BOTH the backend __tests__ dir (this script's home) and the
  // frontend auditor test's dir — they must never drift, and the frontend
  // build can't import from src/.
  const targets = [
    join(__dirname, 'fixtures', `${label}-mintv1.json`),
    join(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'tools', 'candy-mint', 'fixtures', `${label}-mintv1.json`),
  ];
  for (const p of targets) writeFileSync(p, json);
  console.log(`[${label}] wrote ${targets.length} copies — ${tx.instructions.length} top-level instructions, ${Buffer.from(built.transactionBase64, 'base64').length} bytes`);
  for (const l of layout) console.log(`   #${l.index} ${l.programId}  disc=${l.dataFirst8.join(',')}  accts=${l.accounts.length}`);
}

(async () => {
  await capture('core', CORE_SIG);
  await capture('legacy', LEGACY_SIG);
  console.log('\nOK — fixtures captured into both src/candy-mint/__tests__/fixtures/');
  console.log('and frontend/src/app/tools/candy-mint/fixtures/. Re-run the tests:');
  console.log('  npm run test:candy-mint && npm run test:candy-mint-frontend');
})().catch((e) => { console.error('\nCAPTURE FAILED:', e); process.exit(1); });
