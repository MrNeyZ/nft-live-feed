/**
 * One-off inspection of 3 provided ME signatures.
 * Run: npx ts-node src/ingestion/me-raw/inspect-sigs.ts
 */
import 'dotenv/config';
import bs58 from 'bs58';
import { anchorDisc } from './programs';

const API_KEY = process.env.HELIUS_API_KEY!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const SIGS = [
  { sig: '2KTu5TRKipTz58HxwnzfkJ8qM36qzJn83pxepWt5XvQZWRRdDdMSctZTYeaFNpfeN9b5v3r13bw1wRskTThKmgJs', label: 'tx1 – suspected BuyV2 listing purchase' },
  { sig: '2bZoCmoKCiQ7qsp9tMfURxEY3RkPoMUnVxBf7sCFpzg5yFdEWaMYnVztKfSDY7yKJnHeYpv6MrXCAA3igRNs98vE', label: 'tx2 – suspected BuyV2 listing purchase' },
  { sig: 'nTgwSDwXUxRChV8gdJDzRaDiyq23ZqJD36Zm2NnDhneYusu6YR68UL1RcH4SrDKop8jxrdXEHHHuEtJ7AL7E9ni',  label: 'tx3 – suspected AMM core path' },
];

const ME_V2    = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const MMM      = 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';
const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

const CANDIDATES = [
  { name: 'mip1ExecuteSaleV2',   disc: anchorDisc('mip1_execute_sale_v2') },
  { name: 'executeSale',         disc: anchorDisc('execute_sale') },
  { name: 'executeSaleV2',       disc: anchorDisc('execute_sale_v2') },
  { name: 'buy',                 disc: anchorDisc('buy') },
  { name: 'buyV2',               disc: anchorDisc('buy_v2') },
  { name: 'deposit',             disc: anchorDisc('deposit') },
  { name: 'sell',                disc: anchorDisc('sell') },
  { name: 'solFulfillBuy',       disc: anchorDisc('sol_fulfill_buy') },
  { name: 'solFulfillSell',      disc: anchorDisc('sol_fulfill_sell') },
  { name: 'coreFulfillSell_obs', disc: Buffer.from('fce7c9b01ed57612', 'hex') },
  { name: 'coreFulfillBuy_obs',  disc: Buffer.from('aba722c170158e59', 'hex') },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTx(sig: string): Promise<any> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await r.json() as { result?: any };
  return j.result;
}

function disc8(data: string): string {
  try { return Buffer.from(bs58.decode(data)).subarray(0, 8).toString('hex'); } catch { return '?'; }
}

async function main() {
for (const { sig, label } of SIGS) {
  const tx = await getTx(sig);
  if (!tx) { console.log(`\n${label}\nNULL response`); continue; }

  // Build full key list (static + loadedAddresses)
  const keys: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const k of (tx.transaction?.message?.accountKeys ?? [])) keys.push(typeof k === 'string' ? k : k.pubkey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const pk of (tx.meta?.loadedAddresses?.writable ?? [])) keys.push(pk as string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const pk of (tx.meta?.loadedAddresses?.readonly  ?? [])) keys.push(pk as string);

  // Flatten all instructions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allIxs: Array<{ path: string; prog: string; accounts: string[]; data: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [i, ix] of (tx.transaction.message.instructions ?? []).entries()) {
    allIxs.push({
      path: `outer[${i}]`,
      prog: keys[ix.programIdIndex] ?? '?',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accounts: (ix.accounts ?? []).map((a: number) => keys[a] ?? '?'),
      data: ix.data ?? '',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const grp of (tx.meta?.innerInstructions ?? [])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [j, ix] of (grp.instructions ?? []).entries()) {
      allIxs.push({
        path: `inner[${grp.index}][${j}]`,
        prog: keys[ix.programIdIndex] ?? '?',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        accounts: (ix.accounts ?? []).map((a: number) => keys[a] ?? '?'),
        data: ix.data ?? '',
      });
    }
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`LABEL : ${label}`);
  console.log(`SIG   : ${sig.slice(0, 48)}...`);
  console.log(`STATUS: ${tx.meta?.err ? 'FAILED ⚠️' : 'OK ✅'}`);

  // ME / MMM instructions
  const meIxs = allIxs.filter(i => i.prog === ME_V2 || i.prog === MMM);
  for (const ix of meIxs) {
    const tag = ix.prog === ME_V2 ? 'ME_V2' : 'MMM';
    const d = disc8(ix.data);
    console.log(`\n  [${ix.path}] ${tag}  disc=${d}`);

    const raw = ix.data ? Buffer.from(bs58.decode(ix.data)) : Buffer.alloc(0);
    for (const c of CANDIDATES) {
      if (raw.length >= 8 && c.disc.every((b, i) => b === raw[i])) {
        console.log(`    ✅ MATCHES: ${c.name}`);
      }
    }

    for (const [i, a] of ix.accounts.entries()) {
      console.log(`    [${i}] ${a}`);
    }
  }

  // SOL deltas
  const pre:  number[] = tx.meta?.preBalances  ?? [];
  const post: number[] = tx.meta?.postBalances ?? [];
  console.log(`\n  SOL deltas (non-zero):`);
  let maxOut = 0n, maxIn = 0n, buyer = '', seller = '';
  keys.forEach((pk, i) => {
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    if (delta === 0n) return;
    const sol = (Number(delta) / 1e9).toFixed(6);
    console.log(`    [${i}] ${pk}  ${delta > 0n ? '+' : ''}${sol} SOL`);
    if (-delta > maxOut) { maxOut = -delta; buyer  = pk; }
    if ( delta > maxIn)  { maxIn  =  delta; seller = pk; }
  });
  console.log(`    → buyer:  ${buyer}`);
  console.log(`    → seller: ${seller}`);
  console.log(`    → price:  ${(Number(maxOut) / 1e9).toFixed(6)} SOL`);

  // SPL token mints (decimals=0, NFTs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preTok  = (tx.meta?.preTokenBalances  ?? []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postTok = (tx.meta?.postTokenBalances ?? []) as any[];
  const mints = new Set([...preTok, ...postTok].map(t => t.mint as string));
  const nftMints: string[] = [];
  for (const mint of mints) {
    const p0 = preTok.find(t => t.mint === mint);
    const p1 = postTok.find(t => t.mint === mint);
    if ((p0?.uiTokenAmount?.decimals ?? p1?.uiTokenAmount?.decimals) !== 0) continue;
    nftMints.push(mint);
    console.log(`  SPL NFT mint: ${mint}  pre=${p0?.uiTokenAmount?.amount ?? 0}→post=${p1?.uiTokenAmount?.amount ?? 0}`);
  }
  if (nftMints.length === 0) console.log(`  SPL token balances: none`);

  // MPL Core inner ixs
  const coreIxs = allIxs.filter(i => i.prog === MPL_CORE);
  if (coreIxs.length) {
    console.log(`\n  MPL Core ixs:`);
    for (const ix of coreIxs) {
      console.log(`    [${ix.path}] disc=${disc8(ix.data)}`);
      for (const [i, a] of ix.accounts.entries()) console.log(`      [${i}] ${a}`);
    }
  }
}

console.log(`\n${'═'.repeat(72)}\nDONE`);
}
main().catch(e => { console.error(e); process.exit(1); });
