/**
 * Targeted verification against ground-truth ME sale transactions.
 *
 * Each signature below is a CONFIRMED sale of a specific type.
 * No network scanning — only these exact transactions are fetched.
 *
 * Run: npx ts-node src/ingestion/me-raw/verify-known.ts
 */
import 'dotenv/config';
import bs58 from 'bs58';
import { anchorDisc, ME_V2_SALE_INSTRUCTIONS, MMM_SALE_INSTRUCTIONS } from './programs';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const ME_V2   = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const ME_AMM  = 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';

// ─── Ground-truth sale transactions (provided by user) ────────────────────────

const KNOWN_SALES: Array<{ sig: string; label: string; program: string }> = [
  {
    sig:     '2XzShACVyFDvVuER4m1jwSB2XhA9eai4dHt8Jiyjai5cp9QHx4uwHbH28RyBLji8gui396jqpgsGxpT4XKFRE8w9',
    label:   'pNFT sale (ME v2)',
    program: ME_V2,
  },
  {
    sig:     '5V2uBoC3aGMzgCzhjAUWrXTvStn5JaJevS8pJ5J1UtmCJVdFo1bvRAW7C6cAsQv51fenKeU9vKQNXcTLFGpNgTbi',
    label:   'pNFT lucky-buy (ME v2)',
    program: ME_V2,
  },
  {
    sig:     'QTGPCUYbQW89JBtwq8YUSUGJKozGUDqmnDEanqMFsN3a9fHTL4Aqh6Gi86jh11aVAoBmV9dKPYMtzm52iPYQepX',
    label:   'Metaplex Core sale (ME v2)',
    program: ME_V2,
  },
  {
    sig:     '4ppESjBcfkv66Nb4RZHECchAx8bCZpdfAyTD9sKM5jbhLYZ26U71YEx4Vu14dRuV6vxzTxneRdBaeg3X5yyTTVQx',
    label:   'Metaplex Core bid-sale (ME v2)',
    program: ME_V2,
  },
  {
    sig:     '4hcnU6GiUDkna95vNuVuGih945fcsXMMo8Fe5RQ2y8xitntx9whMrjYrrEPfLdCCYfm1fgr7XMCreBnqzM6t2oaQ',
    label:   'Legacy NFT bid-sale (ME v2)',
    program: ME_V2,
  },
  {
    sig:     '5jTqq33sK9Fzay8m54pWpyDvFEGHZ4T7v4Nyzosqp1SVgSzkKnjumL1tiMMKv9SeLTFdxs79Uwmgg5N48QmR1LhJ',
    label:   'AMM Core NFT — sell into pool (fulfillBuy)',
    program: ME_AMM,
  },
  {
    sig:     '348yTcaTcZFq1FrQmkfQdT2fM6XcMPFXCryVNUPBtwGNoSFwLo6hA7KTK843D4PCNmzfGpDzoxqZMhybLo7YDbWY',
    label:   'AMM Core NFT — buy from pool (fulfillSell)',
    program: ME_AMM,
  },
  {
    sig:     '2rg9XUPcR4DLJ7cCfPf1wdxUZCAso8eMNhptqResaQWqG6Kne5L7SZEBJcJ6faJsXhRfFGemZj9fkMTvcGLkxeiX',
    label:   'AMM pNFT — buy from pool (fulfillSell)',
    program: ME_AMM,
  },
];

// ─── RPC ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTx(sig: string): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [sig, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as { result?: any; error?: { message: string } };
  if (json.error) throw new Error(`getTransaction: ${json.error.message}`);
  return json.result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function disc8(base58data: string): string {
  try {
    const buf = Buffer.from(bs58.decode(base58data));
    return buf.length >= 8 ? buf.subarray(0, 8).toString('hex') : '(short)';
  } catch { return '(decode-error)'; }
}

function matchDisc(base58data: string, disc: Buffer): boolean {
  try {
    const buf = Buffer.from(bs58.decode(base58data));
    return buf.length >= 8 && disc.every((b, i) => b === buf[i]);
  } catch { return false; }
}

// ─── Per-instruction flattener ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allIxs(tx: any): Array<{ programId: string; accounts: string[]; data: string; path: string }> {
  const out: Array<{ programId: string; accounts: string[]; data: string; path: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keys: string[] = (tx.transaction.message.accountKeys ?? []).map((k: any) =>
    typeof k === 'string' ? k : k.pubkey
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [i, ix] of (tx.transaction.message.instructions ?? []).entries()) {
    const prog = ix.programId ?? keys[ix.programIdIndex] ?? '?';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs = (ix.accounts as any[] ?? []).map((a) => typeof a === 'string' ? a : keys[a]);
    out.push({ programId: prog, accounts: accs, data: ix.data ?? '', path: `outer[${i}]` });
  }

  for (const group of (tx.meta?.innerInstructions ?? [])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [j, ix] of (group.instructions ?? []).entries()) {
      const prog = ix.programId ?? keys[ix.programIdIndex] ?? '?';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accs = (ix.accounts as any[] ?? []).map((a) => typeof a === 'string' ? a : keys[a]);
      out.push({ programId: prog, accounts: accs, data: ix.data ?? '', path: `inner[${group.index}][${j}]` });
    }
  }
  return out;
}

// ─── Inspector ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inspect(sig: string, label: string, tx: any, targetProgram: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keys: string[] = (tx.transaction.message.accountKeys ?? []).map((k: any) =>
    typeof k === 'string' ? k : k.pubkey
  );
  const pre:  number[] = tx.meta?.preBalances  ?? [];
  const post: number[] = tx.meta?.postBalances ?? [];
  const preTok  = tx.meta?.preTokenBalances  ?? [];
  const postTok = tx.meta?.postTokenBalances ?? [];

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`LABEL  : ${label}`);
  console.log(`SIG    : ${sig}`);
  console.log(`STATUS : ${tx.meta?.err ? 'FAILED ⚠️' : 'SUCCESS ✅'}`);

  // All programs seen
  const progs = [...new Set(allIxs(tx).map((i) => i.programId))];
  console.log(`PROGRAMS:`);
  for (const p of progs) console.log(`  ${p}`);

  // Instructions from our target program
  const targetIxs = allIxs(tx).filter((i) => i.programId === targetProgram);
  if (targetIxs.length === 0) {
    console.log(`\n  ⚠️  No instructions for target program ${targetProgram}`);
    return;
  }

  console.log(`\nTARGET INSTRUCTIONS (${targetProgram === ME_V2 ? 'ME v2' : 'ME AMM'}):`);

  for (const ix of targetIxs) {
    const d8 = disc8(ix.data);
    console.log(`\n  [${ix.path}] disc = ${d8}`);

    // Check against all known discriminators for this program
    if (targetProgram === ME_V2) {
      let anyMatch = false;
      for (const def of ME_V2_SALE_INSTRUCTIONS) {
        if (matchDisc(ix.data, def.disc)) {
          console.log(`    ✅ MATCHES ${def.name} (computed=${def.disc.toString('hex')})`);
          anyMatch = true;
        }
      }
      if (!anyMatch) console.log(`    ❌ no match in ME_V2_SALE_INSTRUCTIONS`);

      // Also try camelCase variants (Anchor may use camelCase in some versions)
      const camelVariants = [
        { name: 'executeSale (camelCase)',        disc: anchorDisc('executeSale') },
        { name: 'executeSaleV2 (camelCase)',      disc: anchorDisc('executeSaleV2') },
        { name: 'mip1ExecuteSaleV2 (camelCase)', disc: anchorDisc('mip1ExecuteSaleV2') },
        { name: 'buy (snake)',                   disc: anchorDisc('buy') },
        { name: 'sell (snake)',                  disc: anchorDisc('sell') },
        { name: 'buyV2 (snake)',                 disc: anchorDisc('buy_v2') },
      ];
      for (const v of camelVariants) {
        if (matchDisc(ix.data, v.disc)) {
          console.log(`    ✅ CAMEL MATCH: ${v.name} (disc=${v.disc.toString('hex')})`);
        }
      }
    } else {
      let anyMatch = false;
      for (const def of MMM_SALE_INSTRUCTIONS) {
        if (matchDisc(ix.data, def.disc)) {
          console.log(`    ✅ MATCHES ${def.name} (computed=${def.disc.toString('hex')})`);
          anyMatch = true;
        }
      }
      if (!anyMatch) console.log(`    ❌ no match in MMM_SALE_INSTRUCTIONS`);

      // camelCase variants for MMM
      const camelMmm = [
        { name: 'solFulfillBuy (camelCase)',      disc: anchorDisc('solFulfillBuy') },
        { name: 'solFulfillSell (camelCase)',     disc: anchorDisc('solFulfillSell') },
        { name: 'coreFulfillBuy (camelCase)',     disc: anchorDisc('coreFulfillBuy') },
        { name: 'coreFulfillSell (camelCase)',    disc: anchorDisc('coreFulfillSell') },
        { name: 'solMip1FulfillBuy (camelCase)', disc: anchorDisc('solMip1FulfillBuy') },
        { name: 'solMip1FulfillSell (camelCase)',disc: anchorDisc('solMip1FulfillSell') },
      ];
      for (const v of camelMmm) {
        if (matchDisc(ix.data, v.disc)) {
          console.log(`    ✅ CAMEL MATCH: ${v.name} (disc=${v.disc.toString('hex')})`);
        }
      }
    }

    // Account layout
    console.log(`    accounts (${ix.accounts.length}):`);
    ix.accounts.forEach((a, idx) => console.log(`      [${idx}] ${a}`));
  }

  // Token balance changes — identify NFT mint + ownership transfer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMints = new Set([...preTok, ...postTok].map((t: any) => t.mint));
  const nftMints: string[] = [];

  for (const mint of allMints) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preEntries  = preTok.filter((t: any)  => t.mint === mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postEntries = postTok.filter((t: any) => t.mint === mint);
    // Only integers with decimals=0 are NFT mints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isNft = [...preEntries, ...postEntries].every((t: any) => t.uiTokenAmount.decimals === 0);
    if (!isNft) continue;

    // Find the entry where amount changed 0→1 (buyer received) or 1→0 (seller sent)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const received = postEntries.find((p: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pre = preEntries.find((b: any) => b.accountIndex === p.accountIndex);
      return Number(p.uiTokenAmount.amount) === 1 &&
             Number(pre?.uiTokenAmount?.amount ?? 0) === 0;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = preEntries.find((p: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const post = postEntries.find((b: any) => b.accountIndex === p.accountIndex);
      return Number(p.uiTokenAmount.amount) === 1 &&
             Number(post?.uiTokenAmount?.amount ?? 0) === 0;
    });
    if (received || sent) nftMints.push(mint);
  }

  if (nftMints.length > 0 || allMints.size > 0) {
    console.log(`\nTOKEN BALANCES:`);
    for (const mint of allMints) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preEntries  = preTok.filter((t: any)  => t.mint === mint);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const postEntries = postTok.filter((t: any) => t.mint === mint);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decimals = [...preEntries, ...postEntries][0]?.uiTokenAmount?.decimals ?? '?';
      const isNft = nftMints.includes(mint);
      console.log(`  mint=${mint} (decimals=${decimals}${isNft ? ' ← NFT' : ''})`);

      const seenIdxs = new Set([
        ...preEntries.map((t: { accountIndex: number }) => t.accountIndex),
        ...postEntries.map((t: { accountIndex: number }) => t.accountIndex),
      ]);
      for (const idx of seenIdxs) {
        const pre  = preEntries.find((t: { accountIndex: number })  => t.accountIndex === idx);
        const post = postEntries.find((t: { accountIndex: number }) => t.accountIndex === idx);
        const preAmt  = pre?.uiTokenAmount?.amount  ?? '0';
        const postAmt = post?.uiTokenAmount?.amount ?? '0';
        if (preAmt === postAmt) continue; // unchanged
        const preOwner  = pre?.owner  ?? '(absent)';
        const postOwner = post?.owner ?? '(absent)';
        console.log(`    acct[${idx}]=${keys[idx]}`);
        console.log(`      pre:  owner=${preOwner}  amount=${preAmt}`);
        console.log(`      post: owner=${postOwner}  amount=${postAmt}`);
        if (isNft) {
          if (Number(preAmt) === 1 && Number(postAmt) === 0) {
            console.log(`      → SELLER (sent NFT): ${preOwner}`);
          } else if (Number(preAmt) === 0 && Number(postAmt) === 1) {
            console.log(`      → BUYER  (received NFT): ${postOwner}`);
          }
        }
      }
    }
  } else {
    console.log(`\nTOKEN BALANCES: none (Core asset or no SPL token)`);
  }

  // SOL deltas — price extraction
  console.log(`\nSOL DELTAS (non-zero):`);
  let maxOut = 0n;
  let maxIn  = 0n;
  let buyerCandidate  = '';
  let sellerCandidate = '';

  keys.forEach((pk, i) => {
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    if (delta === 0n) return;
    const sol = (Number(delta) / 1e9).toFixed(6);
    console.log(`  [${i}] ${pk}  ${delta > 0n ? '+' : ''}${sol} SOL`);
    if (delta < -maxOut) { maxOut = -delta; buyerCandidate = pk; }
    if (delta >  maxIn)  { maxIn  =  delta; sellerCandidate = pk; }
  });

  if (nftMints.length > 0) {
    console.log(`\nNFT MINT(S): ${nftMints.join(', ')}`);
  }
  console.log(`PRICE ESTIMATE (largest SOL out): ${(Number(maxOut) / 1e9).toFixed(6)} SOL`);
  if (buyerCandidate)  console.log(`BUYER  candidate (largest SOL decrease): ${buyerCandidate}`);
  if (sellerCandidate) console.log(`SELLER candidate (largest SOL increase): ${sellerCandidate}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('ME Raw Parser — Ground-Truth Verification');
  console.log('Using ONLY provided confirmed-sale signatures. No scanning.\n');

  console.log('Expected discriminators (computed, snake_case Anchor):');
  for (const def of ME_V2_SALE_INSTRUCTIONS) {
    console.log(`  ME v2 ${def.name.padEnd(24)} ${def.disc.toString('hex')}`);
  }
  for (const def of MMM_SALE_INSTRUCTIONS) {
    console.log(`  MMM   ${def.name.padEnd(24)} ${def.disc.toString('hex')}`);
  }

  for (const { sig, label, program } of KNOWN_SALES) {
    const tx = await getTx(sig);
    if (!tx) {
      console.log(`\n${label}: null response for ${sig}`);
      continue;
    }
    inspect(sig, label, tx, program);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log('DONE');
}

main().catch((err) => { console.error(err); process.exit(1); });
