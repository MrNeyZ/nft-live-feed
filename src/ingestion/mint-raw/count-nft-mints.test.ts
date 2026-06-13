/**
 * Regression test for countNftMints() — the Live Mint Feed per-tx NFT count.
 *
 * Guards the bulk-mint over-count fix:
 *   - Candy Machine v3 mints wrapped by Candy Guard log `Instruction: MintV2`
 *     TWICE (guard wrapper + inner machine) for ONE NFT. A plain substring
 *     count reported ×2. We now scope MintV2 to the Candy Machine program.
 *   - Bulk MPL Core launchpad mints must still report their true count
 *     (program-scoped `Instruction: Create`).
 *
 * Run: npx ts-node src/ingestion/mint-raw/count-nft-mints.test.ts
 */
import 'dotenv/config';
import { countNftMints } from './index';
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
    sig:    '36cLwZh7ynSfwdAjBfkSMQmqMZ9PoRUbw5RHNpapYXBLsefwo4RM28CPzUsVX86bFS7JRpfF59mhtjmqeTTJdV1Z',
    label:  'false bulk — CM v3 + Candy Guard single mint (MintV2 logged ×2)',
    expect: 1, // before fix: 2
  },
  {
    sig:    '4s8MDypMAmJ6hfvfvBQ6rxM2CTwoCjn6n5VQJSUPCEW4bdkbqjQcDnVXuxvwebJHWTuQB74cBp2vhBQy3sKbwE9J',
    label:  'true bulk — MPL Core ×12 (program-scoped Create)',
    expect: 12,
  },
  {
    sig:    '4bYBKnwEbJ5FsLvmvGsXZfdiXzfNm6sWXPeSj3L8NH5NKSK9wHpUX6KHFKEraz2WRi5oFx5j7AZL5k8CvMFarFh9',
    label:  'single — MPL Core ×1',
    expect: 1,
  },
  {
    sig:    '4X4stqDxmEyFCYCZLW9ERd5sWhMfjyVTqTNhhV1wyFHmRRcqdjvHQuQAyhiHQcV8Wcw1trYbiVuTCGFQ8ujaLf4w',
    label:  'forge/merge — prm1az… deposit+merge, 2 Core Create + 2 Core Burn = 1 NFT',
    expect: 1, // before burn-guard: 2 (false bulk)
  },
  {
    sig:    '5Ya3tAjULZefHGhDR49akvo3jifJ3zV8dnyGPD99da3X4DBkg1dAC6Qpc5dcA7xjcCLJhMneuWpc22aBhzw63xS3',
    label:  'forge/merge — prm1az… deposit only, 1 Core Create / 0 Burn = 1 NFT',
    expect: 1,
  },
];

async function main() {
  console.log('countNftMints — bulk over-count regression\n');
  let pass = 0, fail = 0;
  for (const tc of CASES) {
    const tx = await getTx(tc.sig);
    if (!tx) { console.log(`❌ ${tc.label}\n   fetch returned null`); fail++; continue; }
    const got = countNftMints(tx);
    if (got === tc.expect) {
      console.log(`✅ ${tc.label}\n   nftCount=${got} (sig ${tc.sig.slice(0, 16)}…)`);
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
