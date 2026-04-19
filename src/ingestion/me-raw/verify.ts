/**
 * Live verification script for the ME raw parser.
 *
 * Fetches real recent transactions from ME v2 and MMM programs via
 * the Helius RPC and verifies parser assumptions against actual on-chain data.
 *
 * Run with: npx ts-node src/ingestion/me-raw/verify.ts
 * Requires HELIUS_API_KEY in .env
 */
import 'dotenv/config';
import bs58 from 'bs58';
import { anchorDisc, ME_V2_SALE_INSTRUCTIONS, MMM_SALE_INSTRUCTIONS } from './programs';

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) { console.error('HELIUS_API_KEY not set'); process.exit(1); }

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const ME_V2   = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const ME_AMM  = 'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';

// ─── RPC helpers ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function getSignatures(address: string, limit = 25) {
  return rpc('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]) as
    Promise<Array<{ signature: string; err: unknown }>>;
}

// Use jsonParsed encoding so accountKeys come back as objects with pubkey/signer/writable.
// Custom-program instruction data is still base58 in this encoding.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTx(sig: string): Promise<any> {
  return rpc('getTransaction', [sig, {
    encoding: 'jsonParsed',
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  }]);
}

// ─── Discriminator helpers ────────────────────────────────────────────────────

function disc8(base58data: string): string {
  try {
    return Buffer.from(bs58.decode(base58data)).subarray(0, 8).toString('hex');
  } catch { return '(decode-error)'; }
}

function discHex(name: string): string {
  return anchorDisc(name).toString('hex');
}

function matchDisc(base58data: string, disc: Buffer): boolean {
  try {
    const buf = Buffer.from(bs58.decode(base58data));
    return buf.length >= 8 && disc.every((b, i) => b === buf[i]);
  } catch { return false; }
}

// ─── Instruction extractor ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allIxs(tx: any): Array<{ programId: string; accounts: string[]; data: string; path: string }> {
  const result: Array<{ programId: string; accounts: string[]; data: string; path: string }> = [];
  const accountKeys: string[] = (tx.transaction.message.accountKeys ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (k: any) => (typeof k === 'string' ? k : k.pubkey)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [i, ix] of (tx.transaction.message.instructions ?? []).entries()) {
    const programId = ix.programId ?? accountKeys[ix.programIdIndex] ?? '?';
    const accounts  = ix.accounts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (ix.accounts as any[]).map((a) => typeof a === 'string' ? a : accountKeys[a])
      : [];
    result.push({ programId, accounts, data: ix.data ?? '', path: `outer[${i}]` });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const group of (tx.meta?.innerInstructions ?? [])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [j, ix] of (group.instructions ?? []).entries()) {
      const programId = ix.programId ?? accountKeys[ix.programIdIndex] ?? '?';
      const accounts  = ix.accounts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (ix.accounts as any[]).map((a) => typeof a === 'string' ? a : accountKeys[a])
        : [];
      result.push({ programId, accounts, data: ix.data ?? '', path: `inner[${group.index}][${j}]` });
    }
  }
  return result;
}

// ─── Per-transaction report ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inspectTx(sig: string, tx: any, targetProgram: string) {
  const accountKeys: string[] = (tx.transaction.message.accountKeys ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (k: any) => (typeof k === 'string' ? k : k.pubkey)
  );
  const pre:  number[] = tx.meta?.preBalances  ?? [];
  const post: number[] = tx.meta?.postBalances ?? [];
  const preTok  = tx.meta?.preTokenBalances  ?? [];
  const postTok = tx.meta?.postTokenBalances ?? [];

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`SIG: ${sig}`);

  // All programs involved
  const programs = new Set(allIxs(tx).map((i) => i.programId));
  console.log(`PROGRAMS: ${[...programs].join(', ')}`);

  // Instructions calling our target program
  const targetIxs = allIxs(tx).filter((i) => i.programId === targetProgram);
  if (targetIxs.length === 0) {
    console.log(`  → no instructions for ${targetProgram}`);
    return;
  }

  for (const ix of targetIxs) {
    const d8 = disc8(ix.data);
    console.log(`\nIX [${ix.path}] disc=${d8}`);

    // Match against known sale instruction discriminators
    if (targetProgram === ME_V2) {
      for (const def of ME_V2_SALE_INSTRUCTIONS) {
        const expected = discHex(def.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''));
        const matched  = matchDisc(ix.data, def.disc);
        console.log(`  check ${def.name.padEnd(22)} expected=${def.disc.toString('hex')} → ${matched ? '✅ MATCH' : '❌'}`);
      }
    } else {
      for (const def of MMM_SALE_INSTRUCTIONS) {
        const matched = matchDisc(ix.data, def.disc);
        console.log(`  check ${def.name.padEnd(26)} expected=${def.disc.toString('hex')} → ${matched ? '✅ MATCH' : '❌'}`);
      }
    }

    // Account positions
    console.log(`  accounts (${ix.accounts.length}):`);
    ix.accounts.forEach((a, idx) => console.log(`    [${idx}] ${a}`));
  }

  // Token balance changes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenChanges = postTok.filter((p: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pre = preTok.find((b: any) => b.accountIndex === p.accountIndex && b.mint === p.mint);
    return p.uiTokenAmount.decimals === 0 &&
           p.uiTokenAmount.amount !== (pre?.uiTokenAmount?.amount ?? p.uiTokenAmount.amount);
  });

  if (tokenChanges.length > 0) {
    console.log(`\nTOKEN CHANGES:`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of tokenChanges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preEntry = preTok.find((b: any) => b.accountIndex === p.accountIndex);
      console.log(`  mint=${p.mint}`);
      console.log(`    acct[${p.accountIndex}]=${accountKeys[p.accountIndex]}`);
      console.log(`    owner_pre=${preEntry?.owner ?? '(absent)'}  amount_pre=${preEntry?.uiTokenAmount?.amount ?? '0'}`);
      console.log(`    owner_post=${p.owner ?? '(absent)'}  amount_post=${p.uiTokenAmount.amount}`);
    }
  }

  // SOL balance changes (non-zero, non-program accounts)
  console.log(`\nSOL DELTAS (non-zero):`);
  accountKeys.forEach((pk, i) => {
    const delta = (post[i] ?? 0) - (pre[i] ?? 0);
    if (delta !== 0) {
      const solDelta = (delta / 1e9).toFixed(6);
      console.log(`  [${i}] ${pk}  ${delta > 0 ? '+' : ''}${solDelta} SOL`);
    }
  });
}

// ─── Helius enhanced API — known-sale signature discovery ────────────────────

/**
 * Use Helius enhanced API to find sale sigs for a program.
 * Handles the 404 "search period" boundary by following the before-cursor hint.
 */
async function getSaleSigsViaHelius(
  programAddress: string, txType: string, limit = 10, beforeSig?: string
): Promise<string[]> {
  let url = `https://api.helius.xyz/v0/addresses/${programAddress}/transactions` +
    `?api-key=${API_KEY}&type=${txType}&limit=${limit}`;
  if (beforeSig) url += `&before=${beforeSig}`;

  const res = await fetch(url);
  if (res.status === 404) {
    const body = await res.text();
    // Extract the suggested before-cursor and retry once
    const match = /`before-signature`[^`]*`([A-Za-z0-9]{80,})`/.exec(body)
      ?? /set to ([A-Za-z0-9]{80,})/.exec(body);
    if (match && !beforeSig) {
      console.log(`  404 boundary hit — retrying with before=${match[1].slice(0, 16)}...`);
      return getSaleSigsViaHelius(programAddress, txType, limit, match[1]);
    }
    console.log(`  Helius: no ${txType} events found (404, boundary exhausted)`);
    return [];
  }
  if (!res.ok) throw new Error(`Helius enhanced API ${res.status}: ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txs = await res.json() as any[];
  if (!Array.isArray(txs)) return [];
  return txs.map((t: { signature?: string }) => t.signature).filter(Boolean) as string[];
}

/**
 * Fallback: fetch raw sigs (no type filter) and pick those with significant SOL flow.
 * Used when the enhanced API returns no results for a given type.
 */
async function getSaleSigsRaw(programAddress: string, scanLimit = 150): Promise<string[]> {
  console.log(`  Falling back to raw sig scan (limit=${scanLimit}, filtering by SOL flow ≥ 0.05 SOL)...`);
  const allSigs = await getSignatures(programAddress, scanLimit);
  const candidates: string[] = [];
  let fetched = 0;

  for (const { signature, err } of allSigs) {
    if (err !== null) continue;
    const tx = await getTx(signature);
    if (!tx?.meta) continue;
    fetched++;

    const pre:  number[] = tx.meta.preBalances  ?? [];
    const post: number[] = tx.meta.postBalances ?? [];
    const maxOut = Math.max(0, ...pre.map((p: number, i: number) => p - (post[i] ?? 0)));
    if (maxOut >= 50_000_000) { // ≥ 0.05 SOL
      candidates.push(signature);
      if (candidates.length >= 5) break;
    }
    if (fetched >= 50) break; // cap API calls
  }
  console.log(`  Scanned ${fetched} txs, found ${candidates.length} with SOL flow ≥ 0.05 SOL`);
  return candidates;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function verifyWithKnownSales(programId: string, label: string, txType: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`VERIFYING: ${label}`);
  console.log(`${'═'.repeat(70)}`);

  let sigs = await getSaleSigsViaHelius(programId, txType, 10);
  if (sigs.length === 0) {
    // Helius enhanced API found nothing — scan raw transactions for SOL flow
    sigs = await getSaleSigsRaw(programId);
  }
  console.log(`Inspecting ${sigs.length} candidate transactions`);

  for (const sig of sigs.slice(0, 5)) {
    const tx = await getTx(sig);
    if (!tx) { console.log(`  ${sig}: null tx response`); continue; }
    inspectTx(sig, tx, programId);
  }
}

async function main() {
  console.log('ME Raw Parser — Live Verification (sale-specific pass)');
  console.log('Expected discriminators (computed):');
  for (const def of ME_V2_SALE_INSTRUCTIONS) {
    console.log(`  ME v2  ${def.name.padEnd(22)} ${def.disc.toString('hex')}`);
  }
  for (const def of MMM_SALE_INSTRUCTIONS) {
    console.log(`  MMM    ${def.name.padEnd(22)} ${def.disc.toString('hex')}`);
  }

  // Use Helius enhanced API to find actual sale txs, then inspect them raw.
  // This avoids drowning in listing/bid noise from getSignaturesForAddress.
  await verifyWithKnownSales(ME_V2,  'ME v2 — legacy+pNFT+Core', 'NFT_SALE');
  await verifyWithKnownSales(ME_AMM, 'ME AMM — pool fulfillments', 'NFT_SALE');
}

main().catch((err) => { console.error(err); process.exit(1); });
