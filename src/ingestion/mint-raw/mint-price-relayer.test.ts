/**
 * Regression test for extractMintPriceLamports() — the relayer single-mint
 * price fix.
 *
 * Bug: direct Metaplex Core CreateV2 mints submitted by a RELAYER
 * (fee-payer / accountKeys[0] != real minter) showed as FREE. The
 * transfer extractor needs a count>=2 batch repeat, which a single-NFT mint
 * paying two distinct creator/treasury wallets never produces, so it fell to
 * the index-0 signer-delta — but index 0 is the relayer, who net-RECEIVES its
 * rent+fee reimbursement, so the delta clamps to 0 → bogus free.
 *
 * Fix: extractRelayerSingleMintPrice() sums the minter->creator legs
 * (src != feePayer, dest != feePayer, dest pre-balance > 0), wired into
 * precedence AFTER escrow + batch-transfer and BEFORE the signer-delta
 * fallback, so direct-payer and batch mints are untouched.
 *
 * Guards:
 *   - relayer single-mint (the audited tx + a sibling) now prices correctly;
 *   - a direct-payer priced LMNFT mint is unchanged;
 *   - a direct-payer priced Candy Machine mint is unchanged;
 *   - a genuine free Core mint stays free (0).
 *
 * Run: npx ts-node src/ingestion/mint-raw/mint-price-relayer.test.ts
 */
import 'dotenv/config';
import { extractMintPriceLamports } from './index';
import type { RawSolanaTx } from '../me-raw/types';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

async function getTx(sig: string): Promise<RawSolanaTx | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  const json = await res.json() as { result?: RawSolanaTx | null; error?: { message: string } };
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  if (!json.result) return null;
  const tx = json.result;
  tx.signature = sig;
  return tx;
}

interface Case { sig: string; label: string; expect: number; }
const CASES: Case[] = [
  {
    sig:    '41fx7U8R4WcGjpAjUwVr7FkGehDbEPq3vxfebW53BzM6Qx1L6jjqeZBh3WF2ovRegLBfSv2r4gAibPSExG4d69DG',
    label:  'relayer single-mint — TurtleToddlers (audited tx)',
    expect: 20000000, // before fix: 0 (FREE); 0.005 + 0.015 SOL creator/treasury
  },
  {
    sig:    '5q92HVmkq2jqiedtZeDJkufT5akKmAPeQx46QrucFyhgfkCdu4rzTWU8qEBCv6d2JXnixPMVMocncCcKT8L1JHa6',
    label:  'relayer single-mint — TurtleToddlers (sibling)',
    expect: 20000000, // before fix: 0 (FREE)
  },
  {
    sig:    '41GvAExDTdEPdBnJQBSj4N5HHgxiRipQWYMTr8X6kCDJkwvJT3PMJ7PQHeARBuk2hQCz35PUnUZYf2X7AfbLMHYw',
    label:  'direct-payer priced — LaunchMyNFT (must stay unchanged)',
    expect: 29206320,
  },
  {
    sig:    '3f9brfFYgu6bwbvbo2uDCCSm4D4Bi2tWxRCr474RGegg7wQcJ7AQwbZjteAbmuFNoGLAVjKSmmhy1sDChbPuLRrP',
    label:  'direct-payer priced — Candy Machine (must stay unchanged)',
    expect: 19646560,
  },
  {
    sig:    '37Uu3fEtwDa4jdbohiLAPK56vpDZdmJWCQvESmjipUKVznz3TLY5YusNUczjhtZyfpSx3czWAEjepfJXwNPhXDhY',
    label:  'genuine free Core mint (must stay FREE)',
    expect: 0,
  },
];

async function main(): Promise<void> {
  console.log('extractMintPriceLamports — relayer single-mint regression\n');
  let pass = 0, fail = 0;
  for (const tc of CASES) {
    const tx = await getTx(tc.sig);
    if (!tx) { console.log(`❌ ${tc.label}\n   fetch returned null (tx pruned?)`); fail++; continue; }
    const got = extractMintPriceLamports(tx);
    if (got === tc.expect) {
      console.log(`✅ ${tc.label}\n   priceLamports=${got} (sig ${tc.sig.slice(0, 16)}…)`);
      pass++;
    } else {
      console.log(`❌ ${tc.label}\n   expected ${tc.expect}, got ${got} (sig ${tc.sig.slice(0, 16)}…)`);
      fail++;
    }
  }
  console.log(`\nRESULT: ${pass} passed  ${fail} failed  (${CASES.length} total)`);
  if (fail > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
