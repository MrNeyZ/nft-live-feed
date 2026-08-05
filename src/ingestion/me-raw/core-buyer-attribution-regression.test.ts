/**
 * End-to-end regression for the 2026-08-05 ME v2 Core buyer-attribution fix.
 *
 * Root cause: `parseMeV2Sale`'s buyer resolution fell back to
 * `extractPaymentInfo` (SOL-flow "largest decrease") whenever token-flow
 * couldn't resolve a buyer — always true for MPL Core sales, which carry no
 * SPL token-balance entries. ME v2's `Deposit → BuyV2 → CoreExecuteSaleV2`
 * flow lets a buyer draw SOL from a personal escrow PDA that can carry a
 * standing balance across transactions; whenever that escrow's own
 * single-instruction outflow (observed near-constant ~3.56M lamports)
 * exceeds the signer's fresh top-up in THIS transaction, the SOL-flow
 * heuristic picked the escrow PDA — a program-owned account with no
 * signing authority — instead of the real buyer.
 *
 * Fix: `resolveCoreBuyer` (parser.ts) uses the matched instruction's own
 * verified `buyerAcctIdx` (programs.ts — currently only `coreExecuteSaleV2`)
 * and requires the candidate to be BOTH a confirmed transaction signer AND
 * have a net non-positive SOL delta (i.e. they actually paid) before
 * trusting it — failing closed (falls through to the pre-fix chain,
 * unchanged) for any unverified variant, for Lucky Buy specifically (a
 * relayed wrapper where accounts[0] is ME's own treasury — genuinely a
 * signer with a genuinely negative delta, but NOT the buyer; confirmed
 * live on sig 4wwGGJHBAucL…), and for a SELLER-initiated
 * `CoreSell → CoreExecuteSaleV2` flow that matches the same discriminator
 * with accounts[0] = the listing seller instead (confirmed live on sig
 * t9WL1dm2…, where accounts[0] RECEIVED SOL — the delta-sign check is what
 * catches this one, since that account is a genuine signer).
 *
 * This test fetches real transactions live and runs them through the
 * ACTUAL parser (parseRawMeTransaction) — same pattern as the sibling
 * seller-attribution-regression.test.ts in this directory.
 *
 * Run: npx ts-node src/ingestion/me-raw/core-buyer-attribution-regression.test.ts
 */
import 'dotenv/config';
import { parseRawMeTransaction } from './parser';
import { RawSolanaTx } from './types';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://beta.helius-rpc.com/?api-key=${API_KEY}`;

async function getTx(sig: string): Promise<RawSolanaTx | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  const json = await res.json() as { result?: any; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  if (!json.result) return null;
  const tx = json.result;
  const staticKeys: Array<string | { pubkey: string }> = tx.transaction?.message?.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses ?? {};
  const loadedWritable: string[] = loaded.writable ?? [];
  const loadedReadonly:  string[] = loaded.readonly  ?? [];
  // Mirrors fetchRawTx's REAL reconstruction (me-raw/ingest.ts) exactly —
  // this test is specifically exercising the signer-validation gate
  // (isConfirmedSigner), so it must carry true signer flags through, not
  // the simplified signer:false-everywhere the sibling seller-attribution
  // test uses (that test never needed signer info). With raw 'json'
  // encoding the per-key `signer` flag is NOT in the RPC payload — it's
  // derived from the message header (numRequiredSignatures = first N
  // static keys are signers).
  const numRequiredSignatures: number = tx.transaction?.message?.header?.numRequiredSignatures ?? 0;
  tx.transaction.message.accountKeys = [
    ...staticKeys.map((k, i) => {
      const isSigner = i < numRequiredSignatures;
      return typeof k === 'string' ? { pubkey: k, signer: isSigner, writable: false } : { ...k, signer: isSigner };
    }),
    ...loadedWritable.map((pk: string) => ({ pubkey: pk, signer: false, writable: true })),
    ...loadedReadonly.map((pk: string) => ({ pubkey: pk, signer: false, writable: false })),
  ];
  tx.signature = sig;
  return tx as RawSolanaTx;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
  else      { console.log(`❌ ${name} — ${detail}`); fail++; }
}

async function main() {
  // ── 1. The two confirmed-live bug fixtures: buyer now resolves to the
  //      real signer, NOT the escrow PDA ──────────────────────────────────
  const bugFixtures: { sig: string; expectBuyer: string; expectNotBuyer: string; label: string }[] = [
    {
      sig: '5S3SApzuL3iSCwg6nG28QHwVW3rFjT6wh5DnaG76Hy98RDyTHpPpSnK5Q6WNbmDh1iFtHvUdzYW3PDDYu7SbueLn',
      expectBuyer:    'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE',   // true signer
      expectNotBuyer: 'EZER73fpYAeau6CSR7UKo8nrEAosKzi2Hu8BS7ktJ78j',   // escrow PDA (old wrong value)
      label: 'reported regression',
    },
    {
      sig: '5Nsxwxf4BGmtivwy85k15K3Nh3daX1VvgbRPh6ekY1gsFk1FaUFFuFjt2a5kds2oar3brU77MzZstyTXp7QESQtj',
      expectBuyer:    '3bE1Tbv3euEWPFcnCBdrjCstf3pmh3nMP5XLZFjFGvE3',   // true signer (from audit sample)
      expectNotBuyer: 'CKgwR4GBXfma1qRez4547s7E4FB5xaxqtq3pBxKEaPvY',   // escrow PDA (old wrong value, DB row)
      label: 'random-sample audit find',
    },
  ];
  for (const f of bugFixtures) {
    const tx = await getTx(f.sig);
    if (!tx) { check(`${f.label}: tx fetched`, false, 'null response'); continue; }
    const result = parseRawMeTransaction(tx);
    if (!result.ok) { check(`${f.label}: parse ok`, false, result.reason); continue; }
    check(`${f.label}: buyer resolves to the real signer`, result.event.buyer === f.expectBuyer,
      `buyer=${result.event.buyer}`);
    check(`${f.label}: buyer is NOT the escrow PDA`, result.event.buyer !== f.expectNotBuyer,
      `buyer=${result.event.buyer}`);
  }

  // ── 1b. Seller-initiated CoreSell → CoreExecuteSaleV2: the SAME
  //       discriminator matches, but accounts[0] here is the LISTING
  //       SELLER, not the buyer — resolveCoreBuyer's delta-sign check must
  //       reject it and fall through to the pre-fix chain UNCHANGED
  //       (documented open issue: the true buyer for THIS variant is not
  //       independently verified, so this fix deliberately does not touch
  //       it — see the report for the separate follow-up recommendation) ──
  {
    const sig = 't9WL1dm2juFBecShy7ZbeReZYHz7PQRjofq743eUyA43bzHLTUdWvSNA7jpVjovMWy6hAkYhNcCrPVhasY75EbY';
    const sellerInitiatedSigner = '3kMXsSMP2xqNYGrvDVcdvAK61kdtz1QcwqbwvByAxXju'; // the LISTING SELLER, confirmed positive delta
    const tx = await getTx(sig);
    if (!tx) { check('seller-initiated CoreSell: tx fetched', false, 'null response'); }
    else {
      const result = parseRawMeTransaction(tx);
      check('seller-initiated CoreSell: parse ok (unchanged from pre-fix)', result.ok, result.ok ? '' : result.reason);
      if (result.ok) {
        check('seller-initiated CoreSell: buyer resolution correctly rejects the seller at accounts[0]',
          result.event.buyer !== sellerInitiatedSigner, `buyer=${result.event.buyer}`);
      }
    }
  }

  // ── 2. Known-good direct Core sale: unaffected, still correct ──────────
  {
    const sig = '4WFXmhJoykeum3cwRcrMgvCswbjnp8BBksTK5FbohmDtxJVbJ6DufsnDAGVjSmCVdRSLvGyaEB3EFBe5nhGG9gVg';
    const expectBuyer = 'EL37PPDuAZ7oghtnHsMFE5cs69o7uAfHjQqFnVJ9m2uZ'; // == already-correct DB row
    const tx = await getTx(sig);
    if (!tx) { check('known-good Core sale: tx fetched', false, 'null response'); }
    else {
      const result = parseRawMeTransaction(tx);
      check('known-good Core sale: parse ok', result.ok, result.ok ? '' : result.reason);
      if (result.ok) {
        check('known-good Core sale: buyer unchanged (no regression)', result.event.buyer === expectBuyer,
          `buyer=${result.event.buyer}`);
      }
    }
  }

  // ── 3. Lucky Buy (relayed): excluded by design — buyer must NOT become
  //      the treasury/relay account merely because it's a signer ─────────
  {
    const sig = '4wwGGJHBAucLqoZJ64DRp9aFtBLjCkyVNGKqNuo1EQEaHhWUuDAQPv6UYzjoYzPHuNUf2vTxXYkmGjKZKuANEb2A';
    const treasury = 'NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd'; // ME_TREASURY — the tx's genuine signer/fee-payer, NOT the raffle buyer
    const tx = await getTx(sig);
    if (!tx) { check('Lucky Buy: tx fetched', false, 'null response'); }
    else {
      const result = parseRawMeTransaction(tx);
      check('Lucky Buy: parse ok', result.ok, result.ok ? '' : result.reason);
      if (result.ok) {
        check('Lucky Buy: buyer is NOT the treasury/relay account (fail-closed exclusion works)',
          result.event.buyer !== treasury, `buyer=${result.event.buyer}`);
      }
    }
  }

  // ── 4. pNFT (mip1ExecuteSaleV2) sale: unaffected (token-flow path, no
  //      buyerAcctIdx set for this variant) ──────────────────────────────
  {
    const sig = 'neRnuH2uaM9m4esNPuYwxFTxyPzVURrXLmeC7RXirHejscdyokDwgkVa63gRoc29DRkJ1Ev3PgdMuW5Uf1Y3Fpo';
    const expectBuyer  = 'tvMPmWEke7VB6ZQouxppYDZ74FZVHjKTkCATB2iMtxQ';
    const expectSeller = '7zcRWrKMimPowkEnvqw7q3RznLSGieKFCoM4wNmxyUg4';
    const expectMint   = 'DuCpLFB4MxCjXn72i8uxxuQuEmA5wJ8Wq4RrdVDPXH5f';
    const tx = await getTx(sig);
    if (!tx) { check('pNFT sale: tx fetched', false, 'null response'); }
    else {
      const result = parseRawMeTransaction(tx);
      check('pNFT sale: parse ok', result.ok, result.ok ? '' : result.reason);
      if (result.ok) {
        check('pNFT sale: buyer unchanged', result.event.buyer === expectBuyer, `buyer=${result.event.buyer}`);
        check('pNFT sale: seller unchanged', result.event.seller === expectSeller, `seller=${result.event.seller}`);
        check('pNFT sale: mint unchanged', result.event.mintAddress === expectMint, `mint=${result.event.mintAddress}`);
      }
    }
  }

  // ── 5. Determinism (parser-level idempotency proxy): parsing the same
  //      tx twice must yield identical seller/buyer/mint/price ───────────
  {
    const sig = '5S3SApzuL3iSCwg6nG28QHwVW3rFjT6wh5DnaG76Hy98RDyTHpPpSnK5Q6WNbmDh1iFtHvUdzYW3PDDYu7SbueLn';
    const tx = await getTx(sig);
    if (!tx) { check('determinism: tx fetched', false, 'null response'); }
    else {
      const r1 = parseRawMeTransaction(tx);
      const r2 = parseRawMeTransaction(tx);
      const same = r1.ok && r2.ok &&
        r1.event.buyer === r2.event.buyer &&
        r1.event.seller === r2.event.seller &&
        r1.event.mintAddress === r2.event.mintAddress &&
        r1.event.priceLamports === r2.event.priceLamports;
      check('determinism: re-parsing the same tx yields an identical event', same,
        `r1.ok=${r1.ok} r2.ok=${r2.ok}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
