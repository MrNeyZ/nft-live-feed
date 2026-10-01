/**
 * Candy Mint tool — third-party-cosigned drops.
 *
 * Some Core Candy Guard drops gate every group with `thirdPartySigner`: the
 * mint ix needs a signature from a key only the project's backend holds. On
 * chain that is the ONLY gate beyond solPayment/redeemedAmount — so minting
 * directly works as long as we get the project's own signing endpoint to
 * cosign our transaction, exactly like their website does.
 *
 * Their endpoint only cosigns a transaction whose message is byte-identical to
 * what their own frontend builds (it rebuilds the expected tx server-side and
 * compares `serializeMessage()`), so each adapter replicates that builder
 * EXACTLY: same instruction order, same compute-unit limit, same extra
 * instructions (e.g. a token burn), same mintArgs. Any deviation = their
 * server refuses to sign; it can't make us mint something different.
 *
 * Flow: build here (asset keypair partial-signed) -> wallet signs in Phantom
 * -> POST /api/tools/candy-mint/cosign (proxies to the adapter's signUrl,
 * verifies the returned message is unchanged) -> broadcast.
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey as umiPublicKey, signerIdentity, some, none } from '@metaplex-foundation/umi';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { mplCandyMachine as mplCoreCandyMachine, mintV1 } from '@metaplex-foundation/mpl-core-candy-machine';

export interface CosignerAdapter {
  id: string;
  /** thirdPartySigner.signerKey on-chain. */
  signerKey: string;
  candyMachine: string;
  collection: string;
  signUrl: string;
  /** Groups the project's server is known to cosign (null = no-group/base). */
  signableGroups: (string | null)[];
  computeUnitLimit: number;
  maxComputeUnitPrice: number;
  /** A per-asset Token-2022 BurnChecked the project's frontend prepends. */
  burn: { mint: string; amount: bigint; decimals: number } | null;
  /** Per-group burn amount override (raw atoms); default = burn.amount. */
  burnAmountByGroup?: Record<string, bigint>;
}

/** The burn the adapter's server expects for this group (null = none). */
export function burnFor(adapter: Pick<CosignerAdapter, 'burn' | 'burnAmountByGroup'>, group: string | null): CosignerAdapter['burn'] {
  if (!adapter.burn) return null;
  const amount = (group != null ? adapter.burnAmountByGroup?.[group] : undefined) ?? adapter.burn.amount;
  return { ...adapter.burn, amount };
}

// printerotc.fun — mint.js `vC()` (route "metaplex-core-cosigned-token2022-v1").
// Per asset: [BurnChecked PRINTER (token-2022, owner ATA), MintV1 group w/
// solPayment + thirdPartySigner]. "normal" = 0.5 SOL + 100k burn (mint.js
// `Vv()`). f0xx groups: every landed f010/f015/f020 mint (2026-10-01) burns
// 10k with the identical layout — enabled on that evidence; NOT yet confirmed
// that /api/mint/sign (vs the fire-sale flow) cosigns them. A refusal is safe:
// nothing is broadcast. w0xx: no landed mint seen, left off.
export const COSIGNER_ADAPTERS: Record<string, CosignerAdapter> = {
  DaprcA3JKHFeoMN1PdXGgDTtU6YHNeiNz51kWJQ3NZqX: {
    id: 'printerotc',
    signerKey: 'DaprcA3JKHFeoMN1PdXGgDTtU6YHNeiNz51kWJQ3NZqX',
    candyMachine: 'CVWE9UzXbXmpQjZVAiRLTJoyhhfYZwuUkgbyqYe68gmw',
    collection: 'E2cjysGtVPjDiL7RtfkyTgou8g2vRRfgkh4JtWtopJoA',
    signUrl: 'https://printerotc.fun/api/mint/sign',
    signableGroups: ['normal', null, 'f010', 'f015', 'f020', 'f025', 'f045'],
    computeUnitLimit: 800_000,
    maxComputeUnitPrice: 250_000,
    burn: { mint: '3e6to4qrHByU19Sij9DVKPB4AQD5RuyhH2Sj2ESLpump', amount: 100_000_000_000n, decimals: 6 },
    burnAmountByGroup: { f010: 10_000_000_000n, f015: 10_000_000_000n, f020: 10_000_000_000n, f025: 10_000_000_000n, f045: 10_000_000_000n },
  },
};

type GuardOption = { __option: 'Some' | 'None'; value?: unknown };

/** The thirdPartySigner key of a (merged) guard set, or null. */
export function thirdPartySignerKey(guards: Record<string, GuardOption>): string | null {
  const g = guards.thirdPartySigner;
  if (g?.__option !== 'Some') return null;
  const v = g.value as { signerKey?: unknown } | undefined;
  return v?.signerKey != null ? String(v.signerKey) : null;
}

export function adapterFor(guards: Record<string, GuardOption>, candyMachine: string): CosignerAdapter | null {
  const key = thirdPartySignerKey(guards);
  const a = key ? COSIGNER_ADAPTERS[key] : undefined;
  return a && a.candyMachine === candyMachine ? a : null;
}

function burnCheckedIx(owner: PublicKey, burn: NonNullable<CosignerAdapter['burn']>): TransactionInstruction {
  const mint = new PublicKey(burn.mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const data = Buffer.alloc(10);
  data[0] = 15; // BurnChecked
  data.writeBigUInt64LE(burn.amount, 1);
  data[9] = burn.decimals;
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: ata, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: true, isSigner: false },
      { pubkey: owner, isWritable: false, isSigner: true },
    ],
    data,
  });
}

export interface CosignedBuild {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  asset: string;
}

/** Byte-for-byte replica of the adapter's own frontend builder (1 asset). */
export async function buildCosignedTx(opts: {
  adapter: CosignerAdapter;
  rpcUrl: string;
  wallet: string;
  group: string | null;
  solPaymentDestination: string | null;
  microLamports: number;
}): Promise<CosignedBuild> {
  const { adapter } = opts;
  if (!adapter.signableGroups.includes(opts.group)) {
    throw new Error(`cosigner_group_not_signable: ${adapter.id} only cosigns ${adapter.signableGroups.map((g) => g ?? '<default>').join(', ')}`);
  }
  if (opts.microLamports < 0 || opts.microLamports > adapter.maxComputeUnitPrice) throw new Error('priority_fee_out_of_range');

  const owner = new PublicKey(opts.wallet);
  const walletSigner = createNoopSigner(umiPublicKey(opts.wallet));
  const umi = createUmi(opts.rpcUrl).use(mplCoreCandyMachine()).use(signerIdentity(walletSigner));
  const assetSigner = generateSigner(umi);

  // Remaining accounts follow the guard manifest order, not key order.
  const mintArgs: Record<string, unknown> = {
    thirdPartySigner: { signer: createNoopSigner(umiPublicKey(adapter.signerKey)) },
  };
  if (opts.solPaymentDestination) mintArgs.solPayment = { destination: umiPublicKey(opts.solPaymentDestination) };

  const builder = mintV1(umi, {
    candyMachine: umiPublicKey(adapter.candyMachine),
    collection: umiPublicKey(adapter.collection),
    asset: assetSigner,
    group: opts.group ? some(opts.group) : none(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mintArgs: mintArgs as any,
  });

  const conn = new Connection(opts.rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: adapter.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
  );
  const burn = burnFor(adapter, opts.group);
  if (burn) tx.add(burnCheckedIx(owner, burn));
  tx.add(...builder.getInstructions().map((ix) => toWeb3JsInstruction(ix)));
  tx.partialSign(Keypair.fromSecretKey(assetSigner.secretKey));

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    asset: assetSigner.publicKey.toString(),
  };
}

export type CosignResult =
  | { ok: true; transactionBase64: string }
  | { ok: false; error: string };

/**
 * Forward a wallet-signed tx to the project's signing endpoint and verify the
 * cosigned result: same message bytes, every required signature present.
 */
export async function requestCosign(adapter: CosignerAdapter, signedBase64: string, lastValidBlockHeight: number): Promise<CosignResult> {
  const sent = Transaction.from(Buffer.from(signedBase64, 'base64'));
  const sentMsg = sent.serializeMessage();
  const requiredSigners = sent.compileMessage().accountKeys
    .slice(0, sent.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58());
  if (!requiredSigners.includes(adapter.signerKey)) return { ok: false, error: 'tx_does_not_require_cosigner' };

  let r: Response;
  try {
    r = await fetch(adapter.signUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(adapter.signUrl).origin,
        referer: `${new URL(adapter.signUrl).origin}/`,
      },
      body: JSON.stringify({ transaction: signedBase64, lastValidBlockHeight }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `cosigner_unreachable: ${(err as Error).message}` };
  }
  const text = await r.text();
  let j: { transaction?: string; error?: string } = {};
  try { j = JSON.parse(text); } catch { /* non-JSON (Cloudflare page etc) */ }
  if (!r.ok || !j.transaction) {
    return { ok: false, error: `cosigner_refused (${r.status}): ${j.error ?? text.slice(0, 200)}` };
  }
  const back = Transaction.from(Buffer.from(j.transaction, 'base64'));
  if (!back.serializeMessage().equals(sentMsg)) return { ok: false, error: 'cosigner_changed_transaction' };
  if (!back.verifySignatures(true)) return { ok: false, error: 'cosigned_tx_missing_or_invalid_signatures' };
  return { ok: true, transactionBase64: j.transaction };
}
