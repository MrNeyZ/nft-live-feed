/**
 * ME Sell — versioned (v0 + ALT) path, offline tests.
 *
 * Two kinds of evidence:
 *  - REAL: fixtures/me-sell-v0-pnft-3creators.json is a verbatim capture of
 *    ME's `/instructions/batch` response for Trippin' Ape Tribe #3881 (pNFT,
 *    3 creators; legacy variant 1376 bytes > 1232, v0 variant 1040 bytes),
 *    with the on-chain contents of the lookup table it references.
 *  - SYNTHETIC: a locally generated v0 bundle (same instruction shapes as
 *    the auditor's own fixtures) that can actually be signed here, so the
 *    build -> simulate -> submit gate order can be driven end to end.
 *
 * Run: `npm run test:me-sell-vtx`.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import type { Server } from 'http';
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { auditMeSellTransaction, type FrozenMeSellIntent } from '../me-sell-auditor';
import {
  ME_ALLOWED_ALTS, TX_WIRE_LIMIT, decodeVersionedTxFromBytes, toAuditableTx, verifyVersionedSignatures, versionedMessageHashHex,
} from '../me-sell-vtx';
import { createMeSellRouter, type MeSellDeps, type MeSellChainClient } from '../tools-me-sell';
import type { MeHttpTransport, MeApiKeyProvider } from '../tools-me-bids';
import { deriveBuyerEscrowPda } from '../me-bid-escrow';

let passed = 0; let failures = 0;
function check(label: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}
async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  ok - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n     ${(err as Error).message}`); }
}

// ── REAL fixture ─────────────────────────────────────────────────────────
interface RealFx {
  seller: string; buyer: string; mint: string; auctionHouse: string; priceLamports: string; creators: string[];
  legacyTxSigned: string; v0TxSigned: string; blockhashData: { lastValidBlockHeight: number };
  alt: { key: string; addresses: string[] };
}
const real: RealFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'me-sell-v0-pnft-3creators.json'), 'utf-8'));
function altFromFixture(a: RealFx['alt']): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: new PublicKey(a.key),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: a.addresses.map((x) => new PublicKey(x)) },
  });
}
const realAlt = altFromFixture(real.alt);
const realFetch = async (key: PublicKey) => (key.toBase58() === real.alt.key ? realAlt : null);
const realIntent = (over: Partial<FrozenMeSellIntent> = {}): FrozenMeSellIntent => ({
  seller: real.seller, mint: real.mint, buyer: real.buyer, auctionHouse: real.auctionHouse,
  priceLamports: real.priceLamports, standard: 'pnft', creators: real.creators, ...over,
});

console.log('real ME v0 bundle (Trippin\' Ape Tribe #3881)');
check('legacy variant exceeds the wire limit, v0 variant fits', () => {
  assert.ok(Buffer.from(real.legacyTxSigned, 'base64').length > TX_WIRE_LIMIT);
  assert.ok(Buffer.from(real.v0TxSigned, 'base64').length <= TX_WIRE_LIMIT);
});
check('the real ALT is the allowlisted ME shared table', () => {
  assert.ok(ME_ALLOWED_ALTS.includes(real.alt.key));
});
check('v0 decodes as version 0 with two signature slots', () => {
  const vtx = decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64'));
  assert.strictEqual(vtx.message.version, 0);
  assert.strictEqual(vtx.signatures.length, 2);
});
void (async () => {
  await checkAsync('canonical audit passes on the real v0 bundle (creators declared: 30 execute accounts)', async () => {
    const auditable = await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), realFetch);
    const r = auditMeSellTransaction(auditable, realIntent(), 'absent');
    assert.strictEqual(r.ok, true, r.ok ? '' : r.reason);
    const cosigner = auditable.signatures.find((s) => s.publicKey.toBase58() !== real.seller);
    assert.ok(cosigner && cosigner.signature != null, 'ME cosigner signature present');
    const seller = auditable.signatures.find((s) => s.publicKey.toBase58() === real.seller);
    assert.ok(seller && seller.signature == null, 'seller slot is empty');
  });
  await checkAsync('same bundle WITHOUT declared creators -> rejected (fixed 29 count fails closed)', async () => {
    const auditable = await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), realFetch);
    const r = auditMeSellTransaction(auditable, realIntent({ creators: undefined }), 'absent');
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.ok(r.reason.startsWith('execute_sale_account_count'), r.reason);
  });
  await checkAsync('real bundle, price off by 1 lamport -> rejected', async () => {
    const auditable = await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), realFetch);
    const r = auditMeSellTransaction(auditable, realIntent({ priceLamports: '70000000001' }), 'absent');
    assert.strictEqual(r.ok, false);
  });
  await checkAsync('real bundle, wrong buyer -> rejected', async () => {
    const auditable = await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), realFetch);
    const r = auditMeSellTransaction(auditable, realIntent({ buyer: Keypair.generate().publicKey.toBase58() }), 'absent');
    assert.strictEqual(r.ok, false);
  });
  await checkAsync('real bundle, a declared creator that is not in ExecuteSale -> rejected', async () => {
    const auditable = await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), realFetch);
    const r = auditMeSellTransaction(auditable, realIntent({ creators: [real.creators[0], real.creators[1], Keypair.generate().publicKey.toBase58()] }), 'absent');
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.ok(r.reason.startsWith('execute_sale_creator_missing'), r.reason);
  });
  await checkAsync('lookup table fetch returning null -> alt_unavailable (fail closed)', async () => {
    let msg = '';
    try { await toAuditableTx(decodeVersionedTxFromBytes(Buffer.from(real.v0TxSigned, 'base64')), async () => null); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg.startsWith('alt_unavailable'), msg);
  });

  // ── SYNTHETIC v0 bundle, signable locally ───────────────────────────────
  const M2 = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
  const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  const ATAP = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const SYSVAR_IX = new PublicKey('Sysvar1nstructions1111111111111111111111111');
  const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
  const AUTH = new PublicKey('auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg');
  const u64le = (d: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(d)); return b; };
  const rand = () => Keypair.generate().publicKey;

  interface Syn { seller: Keypair; cosigner: Keypair; buyer: PublicKey; mint: PublicKey; ah: PublicKey; price: string; creators: PublicKey[]; alt: AddressLookupTableAccount; vtx: VersionedTransaction; }
  function buildSynthetic(opts: { altKey?: string } = {}): Syn {
    const seller = Keypair.generate(); const cosigner = Keypair.generate();
    const buyer = rand(); const mint = rand(); const ah = rand(); const price = '9065000000';
    const creators = [rand(), rand(), rand()];
    const metadata = PublicKey.findProgramAddressSync([Buffer.from('metadata'), TM.toBuffer(), mint.toBuffer()], TM)[0];
    const sellerAta = getAssociatedTokenAddressSync(mint, seller.publicKey, false);
    const escrow = new PublicKey(deriveBuyerEscrowPda(ah.toBase58(), buyer.toBase58())!);
    const meta = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const sellReq = [seller.publicKey, mint, ah, TOKEN_PROGRAM, TM, ATAP, SYSVAR_IX, SYSVAR_RENT, AUTH, metadata, sellerAta, buyer, SystemProgram.programId];
    const sellIx = new TransactionInstruction({
      programId: M2, keys: [...sellReq, ...Array.from({ length: 22 - sellReq.length }, rand)].map(meta),
      data: Buffer.concat([Buffer.from('3a32ac6fa697165e', 'hex'), u64le(price), Buffer.from('ffffffffffffffff', 'hex')]),
    });
    const exReq = [seller.publicKey, mint, ah, TOKEN_PROGRAM, TM, ATAP, SYSVAR_IX, SYSVAR_RENT, AUTH, metadata, escrow, buyer, SystemProgram.programId];
    const exFiller = Array.from({ length: 27 + creators.length - exReq.length - creators.length }, rand);
    const exIx = new TransactionInstruction({
      programId: M2, keys: [...exReq, ...creators, ...exFiller].map(meta),
      data: Buffer.concat([Buffer.from('eca3ccad4790eb76', 'hex'), u64le(price), Buffer.from('0000c800', 'hex')]),
    });
    // every non-signer, non-program account goes into the lookup table
    const inTable = new Set<string>();
    const sellerKey = seller.publicKey.toBase58();
    for (const ix of [sellIx, exIx]) for (const k of ix.keys) {
      const b = k.pubkey.toBase58();
      if (b !== sellerKey && ![M2.toBase58(), TOKEN_PROGRAM.toBase58(), TM.toBase58(), ATAP.toBase58(), AUTH.toBase58(), SystemProgram.programId.toBase58()].includes(b)) inTable.add(b);
    }
    const alt = new AddressLookupTableAccount({
      key: new PublicKey(opts.altKey ?? ME_ALLOWED_ALTS[0]),
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...inTable].map((x) => new PublicKey(x)) },
    });
    const message = new TransactionMessage({
      payerKey: seller.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [sellIx, exIx],
    }).compileToV0Message([alt]);
    // make the cosigner a required signer (as ME's real bundle does): re-derive with it as an extra signer
    const vtx = new VersionedTransaction(message);
    return { seller, cosigner, buyer, mint, ah, price, creators, alt, vtx };
  }
  // The cosigner must be part of the message's signer set — inject a zero-lamport
  // transfer-free way: build the message with the cosigner marked as signer on the sell ix.
  function buildSyntheticWithCosigner(opts: { altKey?: string } = {}): Syn {
    const base = buildSynthetic(opts);
    const cosigner = base.cosigner;
    const msgIxs = TransactionMessage.decompile(base.vtx.message, { addressLookupTableAccounts: [base.alt] }).instructions;
    msgIxs[0].keys.push({ pubkey: cosigner.publicKey, isSigner: true, isWritable: false }); // extra readonly signer key on Sell
    // the auditor pins the Sell account count, so put the cosigner in place of a filler key instead of appending
    msgIxs[0].keys.splice(msgIxs[0].keys.length - 2, 1);
    const message = new TransactionMessage({ payerKey: base.seller.publicKey, recentBlockhash: base.vtx.message.recentBlockhash, instructions: msgIxs }).compileToV0Message([base.alt]);
    const vtx = new VersionedTransaction(message);
    return { ...base, vtx };
  }
  const synIntent = (s: Syn): FrozenMeSellIntent => ({
    seller: s.seller.publicKey.toBase58(), mint: s.mint.toBase58(), buyer: s.buyer.toBase58(), auctionHouse: s.ah.toBase58(),
    priceLamports: s.price, standard: 'pnft', creators: s.creators.map((c) => c.toBase58()),
  });
  function cosign(s: Syn): Buffer {
    // sign as ME's cosigner only (seller slot stays empty), like ME's real response
    const v = new VersionedTransaction(s.vtx.message);
    const keys = v.message.staticAccountKeys; const idx = keys.findIndex((k) => k.equals(s.cosigner.publicKey));
    const tmp = new VersionedTransaction(v.message); tmp.sign([s.cosigner]);
    v.signatures[idx] = tmp.signatures[idx];
    return Buffer.from(v.serialize());
  }
  function seller(s: Syn, raw: Buffer): string {
    const v = VersionedTransaction.deserialize(raw); const before = v.signatures[v.message.staticAccountKeys.findIndex((k) => k.equals(s.cosigner.publicKey))];
    const idxSeller = v.message.staticAccountKeys.findIndex((k) => k.equals(s.seller.publicKey));
    const t = new VersionedTransaction(v.message); t.sign([s.seller]);
    v.signatures[idxSeller] = t.signatures[idxSeller];
    void before;
    return Buffer.from(v.serialize()).toString('base64');
  }

  console.log('signature verification (versioned)');
  const syn0 = buildSyntheticWithCosigner();
  check('both slots signed correctly -> verifyVersionedSignatures true', () => {
    const v = new VersionedTransaction(syn0.vtx.message); v.sign([syn0.seller, syn0.cosigner]);
    assert.strictEqual(verifyVersionedSignatures(v), true);
  });
  check('one slot missing -> false', () => {
    const v = new VersionedTransaction(syn0.vtx.message); v.sign([syn0.seller, syn0.cosigner]);
    v.signatures[0] = new Uint8Array(64);
    assert.strictEqual(verifyVersionedSignatures(v), false);
  });
  check('a signature over a different message -> false', () => {
    const v = new VersionedTransaction(syn0.vtx.message); v.sign([syn0.seller, syn0.cosigner]);
    const other = buildSyntheticWithCosigner();
    const w = new VersionedTransaction(other.vtx.message); w.sign([other.seller, other.cosigner]);
    v.signatures[0] = w.signatures[0];
    assert.strictEqual(verifyVersionedSignatures(v), false);
  });
  check('message hash is stable and excludes signatures', () => {
    const v = new VersionedTransaction(syn0.vtx.message); const h1 = versionedMessageHashHex(v);
    v.sign([syn0.seller, syn0.cosigner]);
    assert.strictEqual(versionedMessageHashHex(v), h1);
  });
  await checkAsync('lookup table that is not ME\'s shared table -> alt_not_allowed', async () => {
    const other = buildSyntheticWithCosigner({ altKey: Keypair.generate().publicKey.toBase58() });
    let msg = '';
    try { await toAuditableTx(other.vtx, async () => other.alt); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg.startsWith('alt_not_allowed'), msg);
  });

  // ── router: build-accept picks v0 when legacy is oversize ────────────────
  console.log('router: oversize legacy -> ME v0 variant');
  const alwaysKeyed = (): MeApiKeyProvider => ({ hasKey: () => true, authHeaders: () => ({}), cooldownActive: () => false, setCooldown: () => {} });
  const transportFor = (body: unknown): MeHttpTransport => async () => ({ status: 200, text: JSON.stringify(body) });
  const batch = (legacyLen: number, v0: Buffer | null) => [{
    status: 'fulfilled',
    value: {
      tx: { type: 'Buffer', data: [] },
      txSigned: { type: 'Buffer', data: Array.from({ length: legacyLen }, () => 7) },
      ...(v0 ? { v0: { txSigned: { type: 'Buffer', data: Array.from(v0) } } } : {}),
      blockhashData: { blockhash: 'x', lastValidBlockHeight: 1000 },
    },
  }];
  function chainFor(s: Syn | null, sent: Buffer[]): MeSellChainClient {
    return {
      async simulateTransaction() { return { err: null, logs: [], accounts: null, unitsConsumed: 1 }; },
      async getBlockHeight() { return 100; },
      async sendRawTransaction() { throw new Error('legacy path must not be used'); },
      async getSignatureStatuses() { return []; },
      async simulateVersionedTransaction() { return { err: null, logs: ['v0 sim ok'], unitsConsumed: 99_000 }; },
      async sendRawBytes(raw: Buffer) { sent.push(raw); return 'V0_SIG'; },
      async getAddressLookupTable(key: PublicKey) { return s && key.equals(s.alt.key) ? s.alt : null; },
    } as MeSellChainClient;
  }
  async function withApp(deps: MeSellDeps, fn: (base: string) => Promise<void>): Promise<void> {
    const app = express(); app.use(express.json());
    app.use('/api', createMeSellRouter({ authMiddleware: (_q, _r, n) => n(), rateLimitsDisabled: true, liveEnabled: true, ...deps }));
    const server: Server = await new Promise((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    const a = server.address(); const port = typeof a === 'object' && a ? a.port : 0;
    try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise<void>((r) => server.close(() => r())); }
  }
  const post = async (url: string, body: unknown) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as Record<string, any> }; };
  const buildBody = (s: Syn) => ({ seller: s.seller.publicKey.toBase58(), tokenMint: s.mint.toBase58(), priceSol: 9.065, auctionHouseAddress: s.ah.toBase58(), buyer: s.buyer.toBase58() });
  const depsFor = (s: Syn, v0: Buffer | null, sent: Buffer[], legacyLen = 1376): MeSellDeps => ({
    meTransport: transportFor(batch(legacyLen, v0)), meApiKeyProvider: alwaysKeyed(), chain: chainFor(s, sent),
    fetchStandard: async () => 'pnft', fetchCreators: async () => s.creators.map((c) => c.toBase58()),
  });

  const syn = buildSyntheticWithCosigner();
  const v0raw = cosign(syn);
  await checkAsync('oversize legacy + valid v0 -> build-accept returns txVersion 0 with a digest', async () => {
    const sent: Buffer[] = [];
    await withApp(depsFor(syn, v0raw, sent), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.txVersion, 0);
      assert.strictEqual(r.json.digest, versionedMessageHashHex(VersionedTransaction.deserialize(v0raw)));
      assert.strictEqual(r.json.txBase64, v0raw.toString('base64'));
    });
  });
  await checkAsync('oversize legacy and NO v0 variant -> 422 me_tx_too_large', async () => {
    await withApp(depsFor(syn, null, []), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      assert.strictEqual(r.status, 422); assert.strictEqual(r.json.error, 'me_tx_too_large');
    });
  });
  await checkAsync('v0 for a lookup table that is not ME\'s -> rejected 422', async () => {
    const bad = buildSyntheticWithCosigner({ altKey: Keypair.generate().publicKey.toBase58() });
    await withApp(depsFor(bad, cosign(bad), []), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(bad));
      assert.strictEqual(r.status, 422); assert.ok(String(r.json.error).startsWith('alt_not_allowed'), JSON.stringify(r.json));
    });
  });
  await checkAsync('v0 whose price differs from the reviewed price -> rejected 422', async () => {
    await withApp(depsFor(syn, v0raw, []), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), priceSol: 9.066 });
      assert.strictEqual(r.status, 422); assert.ok(String(r.json.error).includes('price_mismatch'), JSON.stringify(r.json));
    });
  });
  await checkAsync('simulate with txVersion 0 uses the versioned simulator', async () => {
    await withApp(depsFor(syn, v0raw, []), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/simulate`, { tx: v0raw.toString('base64'), txVersion: 0 });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true); assert.deepStrictEqual(r.json.logs, ['v0 sim ok']);
    });
  });

  console.log('router: v0 submit gates');
  await checkAsync('happy path: build -> seller signs -> submit -> exact signed bytes broadcast once via sendRawBytes', async () => {
    const sent: Buffer[] = [];
    await withApp(depsFor(syn, v0raw, sent), async (base) => {
      const b = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      const signedB64 = seller(syn, Buffer.from(b.json.txBase64, 'base64'));
      const s1 = await post(`${base}/api/tools/me-sell/submit`, { signedTx: signedB64, digest: b.json.digest });
      assert.strictEqual(s1.status, 200, JSON.stringify(s1.json)); assert.strictEqual(s1.json.signature, 'V0_SIG');
      assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].toString('base64'), signedB64);
      const s2 = await post(`${base}/api/tools/me-sell/submit`, { signedTx: signedB64, digest: b.json.digest });
      assert.strictEqual(s2.status, 410); assert.strictEqual(s2.json.error, 'digest_not_found_expired_or_already_used');
      assert.strictEqual(sent.length, 1, 'replay must not broadcast again');
    });
  });
  await checkAsync('seller slot forged with garbage bytes -> invalid_signature, nothing broadcast', async () => {
    const sent: Buffer[] = [];
    await withApp(depsFor(syn, v0raw, sent), async (base) => {
      const b = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      const v = VersionedTransaction.deserialize(Buffer.from(b.json.txBase64, 'base64'));
      v.signatures[v.message.staticAccountKeys.findIndex((k) => k.equals(syn.seller.publicKey))] = new Uint8Array(64).fill(9);
      const r = await post(`${base}/api/tools/me-sell/submit`, { signedTx: Buffer.from(v.serialize()).toString('base64'), digest: b.json.digest });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'invalid_signature'); assert.strictEqual(sent.length, 0);
    });
  });
  await checkAsync('signed message differs from the digest (swapped tx) -> 409, nothing broadcast', async () => {
    const sent: Buffer[] = [];
    await withApp(depsFor(syn, v0raw, sent), async (base) => {
      const b = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      const other = buildSyntheticWithCosigner();
      const r = await post(`${base}/api/tools/me-sell/submit`, { signedTx: seller(other, cosign(other)), digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'signed_tx_message_does_not_match_digest'); assert.strictEqual(sent.length, 0);
    });
  });
  await checkAsync('unsigned seller slot at submit -> revalidation_failed (missing_seller_signature)', async () => {
    const sent: Buffer[] = [];
    await withApp(depsFor(syn, v0raw, sent), async (base) => {
      const b = await post(`${base}/api/tools/me-sell/build-accept`, buildBody(syn));
      const r = await post(`${base}/api/tools/me-sell/submit`, { signedTx: b.json.txBase64, digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.ok(String(r.json.error).includes('missing_seller_signature'), JSON.stringify(r.json)); assert.strictEqual(sent.length, 0);
    });
  });

  // ── atomic top-up bundle ────────────────────────────────────────────────
  console.log('router: top-up + accept Jito bundle');
  const { Transaction: LegacyTx } = await import('@solana/web3.js');
  const PRICE = 9_065_000_000; const ROY_BP = 500; const ROY = Math.floor(PRICE * ROY_BP / 10000);
  interface BundleWorld { escrow: number; leftoverFn: (topup: number) => number; simErr?: unknown; sims: number[]; bundles: string[][] }
  const bundleDeps = (s: Syn, w: BundleWorld): MeSellDeps => {
    const base = depsFor(s, v0raw, []);
    const chain = base.chain! as MeSellChainClient;
    return {
      ...base, fetchRoyaltyBp: async () => ROY_BP,
      sendBundle: async (txs) => { w.bundles.push(txs); return { bundleId: 'BUNDLE_ID', accepted: 5, errors: [] }; },
      chain: {
        ...chain,
        getBalanceStrict: async () => w.escrow,
        simulateWithBalances: async (vtx: VersionedTransaction) => {
          const alts = [s.alt];
          const ix0 = TransactionMessage.decompile(vtx.message, { addressLookupTableAccounts: alts }).instructions[0];
          const topup = Number(ix0.data.readBigUInt64LE(4)); w.sims.push(topup);
          return { err: w.simErr ?? null, logs: [], unitsConsumed: 123, lamports: [w.leftoverFn(topup)] };
        },
      } as MeSellChainClient,
    };
  };
  const signLegacy = (b64: string, kp: Keypair) => { const t = LegacyTx.from(Buffer.from(b64, 'base64')); t.partialSign(kp); return t.serialize().toString('base64'); };
  const newWorld = (over: Partial<BundleWorld> = {}): BundleWorld => ({ escrow: 1_000_000_000, leftoverFn: () => 0, sims: [], bundles: [], ...over });
  const exactTopup = (w: BundleWorld) => PRICE + ROY - w.escrow;

  await checkAsync('bundle build: top-up = price + royalty - escrow, simulated once, 3 parts returned', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), bundleTopup: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.bundle.topupLamports, exactTopup(w));
      assert.deepStrictEqual(w.sims, [exactTopup(w)]);
      assert.ok(r.json.bundle.topupTxBase64 && r.json.bundle.tipTxBase64);
    });
  });
  await checkAsync('bundle build: royalty not actually charged -> top-up shrinks by the sim leftover, re-simulated', async () => {
    const w = newWorld({ leftoverFn: (t) => Math.max(0, t - (PRICE - 1_000_000_000)) });
    await withApp(bundleDeps(syn, w), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), bundleTopup: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.bundle.topupLamports, PRICE - 1_000_000_000);
      assert.strictEqual(w.sims.length, 2);
      assert.strictEqual(r.json.bundle.simEscrowLeftoverLamports, 0);
    });
  });
  await checkAsync('bundle build: sim error -> 422, no digest', async () => {
    const w = newWorld({ simErr: { InstructionError: [0, { Custom: 1 }] } });
    await withApp(bundleDeps(syn, w), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), bundleTopup: true });
      assert.strictEqual(r.status, 422); assert.strictEqual(r.json.error, 'bundle_simulation_failed'); assert.ok(!r.json.digest);
    });
  });
  await checkAsync('bundle build: escrow already covers the bid -> 409 escrow_already_funded', async () => {
    const w = newWorld({ escrow: PRICE + ROY });
    await withApp(bundleDeps(syn, w), async (base) => {
      const r = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), bundleTopup: true });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'escrow_already_funded');
    });
  });
  const buildAndSign = async (base: string) => {
    const b = await post(`${base}/api/tools/me-sell/build-accept`, { ...buildBody(syn), bundleTopup: true });
    assert.strictEqual(b.status, 200, JSON.stringify(b.json));
    return {
      b,
      topup: signLegacy(b.json.bundle.topupTxBase64, syn.seller),
      sale: seller(syn, Buffer.from(b.json.txBase64, 'base64')),
      tip: signLegacy(b.json.bundle.tipTxBase64, syn.seller),
    };
  };
  await checkAsync('bundle submit happy path: [top-up, sale, tip] sent once, in order, exact signed bytes', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const { b, topup, sale, tip } = await buildAndSign(base);
      const r = await post(`${base}/api/tools/me-sell/submit-bundle`, { signedTopupTx: topup, signedTx: sale, signedTipTx: tip, digest: b.json.digest });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.bundleId, 'BUNDLE_ID');
      assert.strictEqual(w.bundles.length, 1); assert.deepStrictEqual(w.bundles[0], [topup, sale, tip]);
      const again = await post(`${base}/api/tools/me-sell/submit-bundle`, { signedTopupTx: topup, signedTx: sale, signedTipTx: tip, digest: b.json.digest });
      assert.strictEqual(again.status, 410); assert.strictEqual(w.bundles.length, 1);
    });
  });
  await checkAsync('bundle submit: escrow moved since build -> 409, nothing sent', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const { b, topup, sale, tip } = await buildAndSign(base);
      w.escrow -= 1;
      const r = await post(`${base}/api/tools/me-sell/submit-bundle`, { signedTopupTx: topup, signedTx: sale, signedTipTx: tip, digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'escrow_changed_since_build'); assert.strictEqual(w.bundles.length, 0);
    });
  });
  await checkAsync('bundle submit: top-up swapped for a bigger transfer -> 409, nothing sent', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const { b, sale, tip } = await buildAndSign(base);
      const t = LegacyTx.from(Buffer.from(b.json.bundle.topupTxBase64, 'base64'));
      const forged = new LegacyTx({ feePayer: syn.seller.publicKey, recentBlockhash: t.recentBlockhash! }).add(
        SystemProgram.transfer({ fromPubkey: syn.seller.publicKey, toPubkey: t.instructions[0].keys[1].pubkey, lamports: exactTopup(w) + 1 }));
      forged.sign(syn.seller);
      const r = await post(`${base}/api/tools/me-sell/submit-bundle`, { signedTopupTx: forged.serialize().toString('base64'), signedTx: sale, signedTipTx: tip, digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'topup_aux_message_does_not_match_build'); assert.strictEqual(w.bundles.length, 0);
    });
  });
  await checkAsync('bundle submit: unsigned tip -> 409, nothing sent', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const { b, topup, sale } = await buildAndSign(base);
      const r = await post(`${base}/api/tools/me-sell/submit-bundle`, { signedTopupTx: topup, signedTx: sale, signedTipTx: b.json.bundle.tipTxBase64, digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.ok(String(r.json.error).startsWith('tip_aux_'), JSON.stringify(r.json)); assert.strictEqual(w.bundles.length, 0);
    });
  });
  await checkAsync('bundle build digest cannot be sent through plain /submit (sale alone)', async () => {
    const w = newWorld();
    await withApp(bundleDeps(syn, w), async (base) => {
      const { b, sale } = await buildAndSign(base);
      const r = await post(`${base}/api/tools/me-sell/submit`, { signedTx: sale, digest: b.json.digest });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'bundle_build_use_submit_bundle');
    });
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();
