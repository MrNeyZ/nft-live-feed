/**
 * Targeted verification against ground-truth Tensor sale transactions.
 *
 * Only the exact signatures provided by the user are fetched.
 * No network scanning. No getSignaturesForAddress.
 *
 * Run: npx ts-node src/ingestion/tensor-raw/verify-known.ts
 */
import 'dotenv/config';
import bs58 from 'bs58';
import { anchorDisc, TCOMP_SALE_INSTRUCTIONS, TAMM_SALE_INSTRUCTIONS } from './programs';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const TCOMP = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';
const TAMM  = 'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg';

// ─── Ground-truth transactions (provided by user) ─────────────────────────────

const KNOWN: Array<{ sig: string; label: string }> = [
  {
    sig:   '587eAobQmnWvGiqtYABdKut8rqvcXXGG2KUzvW56mY7kn55H3SSDdQwacRV2JGJ8XHuzjqzmcyzxVYv3toss6j5G',
    label: 'Simple listing buy (Metaplex Core)',
  },
  {
    sig:   'P7w6yhSsAfLatJtCK8YWNWXXoxnpgsRP52vUS5uZ4Hx8gLVuLxUtj7NKqeQNNFVFpd4bs1XQNbDz25pGwnCyx8Y',
    label: 'Sale into simple bid (Metaplex Core)',
  },
  {
    sig:   '2F1BkqCqCcmyWfH1yFXe2qJLPxMdpRNfdyaFFnBNWqWwM1C9DHgGGi3Vyt6qC8zrPjiJDyS8exB3rFA129yRRdAp',
    label: 'Sale into AMM pool (Metaplex Core)',
  },
  {
    sig:   '5zVed96S1QmUsfxCvVeQE7ZSxmgqy5DWtjmjmQrdxSZ1b4KdB9JjPTtFy9qRK1Ugut86YXPW1WdvgA1mJ7NxMFFw',
    label: 'Buy from AMM pool (Metaplex Core)',
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

// Extra candidate discriminators to probe — camelCase variants and other guesses
const EXTRA_CANDIDATES = [
  // TComp candidates (camelCase, snake, alternate names)
  { name: 'buy (camel)',                disc: anchorDisc('buy') },
  { name: 'buyV2',                      disc: anchorDisc('buy_v2') },
  { name: 'list (snake)',               disc: anchorDisc('list') },
  { name: 'takeBid (snake)',            disc: anchorDisc('take_bid') },
  { name: 'takeBid (camel)',            disc: anchorDisc('takeBid') },
  { name: 'takeBidFullMeta (camel)',    disc: anchorDisc('takeBidFullMeta') },
  { name: 'takeBidMetaHash (camel)',    disc: anchorDisc('takeBidMetaHash') },
  { name: 'buyNft',                     disc: anchorDisc('buy_nft') },
  { name: 'executeSale',               disc: anchorDisc('execute_sale') },
  // TSwap candidates
  { name: 'buyNft (camel)',             disc: anchorDisc('buyNft') },
  { name: 'buySingleListing (camel)',   disc: anchorDisc('buySingleListing') },
  { name: 'sellNftTokenPool (camel)',   disc: anchorDisc('sellNftTokenPool') },
  { name: 'sellNftTradePool (camel)',   disc: anchorDisc('sellNftTradePool') },
];

// ─── Instruction flattener ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allIxs(tx: any): Array<{
  programId: string;
  accounts: string[];
  data: string;
  path: string;
}> {
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
function inspect(sig: string, label: string, tx: any) {
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
  console.log(`SIG    : ${sig.slice(0, 44)}...`);
  console.log(`STATUS : ${tx.meta?.err ? 'FAILED ⚠️' : 'SUCCESS ✅'}`);

  // Programs involved
  const allPrograms = [...new Set(allIxs(tx).map((i) => i.programId))];
  console.log(`\nALL PROGRAMS:`);
  for (const p of allPrograms) {
    const isTcomp = p === TCOMP;
    const isTamm  = p === TAMM;
    const tag = isTcomp ? '  ← TCOMP ✅' : isTamm ? '  ← TAMM ✅' : '';
    console.log(`  ${p}${tag}`);
  }

  // All instructions — show discriminator + matching candidates
  console.log(`\nALL INSTRUCTIONS:`);
  for (const ix of allIxs(tx)) {
    const isTensor = ix.programId === TCOMP || ix.programId === TAMM;
    const d8 = ix.data ? disc8(ix.data) : '(no data)';
    const prefix = isTensor ? '  ★ ' : '    ';
    console.log(`${prefix}[${ix.path}] program=${ix.programId.slice(0,8)}... disc=${d8}`);

    if (isTensor) {
      // Check scaffolded definitions
      const allDefs = [...TCOMP_SALE_INSTRUCTIONS, ...TAMM_SALE_INSTRUCTIONS];
      for (const def of allDefs) {
        if (matchDisc(ix.data, def.disc)) {
          console.log(`    ✅ MATCHES scaffolded: ${def.name} (${def.disc.toString('hex')})`);
        }
      }
      // Check extra candidates
      for (const c of EXTRA_CANDIDATES) {
        if (matchDisc(ix.data, c.disc)) {
          console.log(`    ✅ MATCHES candidate:  ${c.name} (${c.disc.toString('hex')})`);
        }
      }
    }
  }

  // Tensor instructions — full account layout
  const tensorIxs = allIxs(tx).filter((i) => i.programId === TCOMP || i.programId === TAMM);
  if (tensorIxs.length > 0) {
    console.log(`\nTENSOR INSTRUCTION ACCOUNTS:`);
    for (const ix of tensorIxs) {
      const prog = ix.programId === TCOMP ? 'TCOMP' : 'TAMM';
      console.log(`  [${ix.path}] ${prog}  disc=${disc8(ix.data)}`);
      ix.accounts.forEach((a, idx) => console.log(`    [${idx}] ${a}`));
    }
  }

  // MPL Core program involvement
  const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
  const coreIxs = allIxs(tx).filter((i) => i.programId === MPL_CORE);
  if (coreIxs.length > 0) {
    console.log(`\nMPL CORE INSTRUCTIONS:`);
    for (const ix of coreIxs) {
      console.log(`  [${ix.path}] disc=${disc8(ix.data)}`);
      ix.accounts.forEach((a, idx) => console.log(`    [${idx}] ${a}`));
    }
  }

  // Token balances (expect none for Core)
  const allMints = new Set([...preTok, ...postTok].map((t: { mint: string }) => t.mint));
  if (allMints.size > 0) {
    console.log(`\nSPL TOKEN BALANCES (${allMints.size} mint(s)):`);
    for (const mint of allMints) {
      const preE  = preTok.filter((t: { mint: string })  => t.mint === mint);
      const postE = postTok.filter((t: { mint: string }) => t.mint === mint);
      const dec = [...preE, ...postE][0]?.uiTokenAmount?.decimals ?? '?';
      console.log(`  mint=${mint}  decimals=${dec}`);
    }
  } else {
    console.log(`\nSPL TOKEN BALANCES: none (expected for Core NFTs)`);
  }

  // SOL deltas
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
    if (-delta > maxOut) { maxOut = -delta; buyerCandidate  = pk; }
    if ( delta > maxIn)  { maxIn  =  delta; sellerCandidate = pk; }
  });

  console.log(`\nSUMMARY:`);
  console.log(`  Price (largest SOL out) : ${(Number(maxOut) / 1e9).toFixed(6)} SOL  (${maxOut} lamports)`);
  console.log(`  Buyer  candidate        : ${buyerCandidate}`);
  console.log(`  Seller candidate        : ${sellerCandidate}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Tensor Raw Parser — Ground-Truth Verification');
  console.log('Using ONLY provided confirmed-sale signatures. No scanning.\n');

  console.log('Confirmed discriminators (✅ verified from live txs):');
  for (const def of TCOMP_SALE_INSTRUCTIONS) {
    console.log(`  TComp ${def.name.padEnd(20)} ${def.disc.toString('hex')}`);
  }
  for (const def of TAMM_SALE_INSTRUCTIONS) {
    console.log(`  TAMM  ${def.name.padEnd(20)} ${def.disc.toString('hex')}`);
  }

  for (const { sig, label } of KNOWN) {
    const tx = await getTx(sig);
    if (!tx) {
      console.log(`\n${label}: null response for ${sig.slice(0, 32)}...`);
      continue;
    }
    inspect(sig, label, tx);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log('DONE');
}

main().catch((err) => { console.error(err); process.exit(1); });
