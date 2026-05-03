/**
 * LaunchMyNFT MintCore tx → config-account inspector.
 *
 *   npm run debug:lmnft-config -- <signature>
 *
 * Without LMNFT's IDL we can't decode the launchpad's config account
 * directly to extract `owner` / `collectionId` / `maxSupply`. But the
 * outer ix's account list always includes a few candidates: the LMNFT
 * collection-state PDA (owned by the LMNFT program, ~344 bytes), the
 * LMNFT update authority (smaller), the treasury (lamports-only),
 * etc. This script fetches a tx, extracts every account it touched,
 * and prints `{pubkey, owner, dataLen, lamports, dataPrefix}` for
 * each candidate that's plausibly a config record (skips system /
 * SPL programs, payer, and the new asset).
 *
 * Output is enough to diff two LMNFT collections with known supplies
 * and pinpoint the byte offset of `max_items` / Firestore-id within
 * the collection-state account. Once that's confirmed, wire the
 * decoder into `src/enrichment/lmnft.ts` and call `patchAccumulatorLmnft`.
 */
import 'dotenv/config';

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : PUBLIC_RPC;

const LMNFT_PROGRAM = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
const SKIP_PROGRAMS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK',
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
  'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY',
  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  'SysvarRent111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
  LMNFT_PROGRAM,
]);

interface ParsedTx {
  meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } };
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }> } };
}
interface AccountInfoValue { owner: string; data: [string, string]; lamports: number }
interface RpcResp<T> { result?: T; error?: { message: string } }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as RpcResp<T>;
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

async function getAccountInfo(addr: string): Promise<AccountInfoValue | null> {
  try {
    const r = await rpc<{ value: AccountInfoValue | null }>(
      'getAccountInfo', [addr, { encoding: 'base64' }],
    );
    return r.value;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sig = process.argv[2];
  if (!sig) {
    console.error('usage: npm run debug:lmnft-config -- <signature>');
    process.exit(1);
  }
  console.log(`sig: ${sig}`);
  console.log(`rpc: ${RPC_URL.replace(/api-key=[^&]+/, 'api-key=…')}`);
  const tx = await rpc<ParsedTx>('getTransaction', [
    sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ]);
  const message = tx.transaction?.message;
  const rawKeys = message?.accountKeys ?? [];
  const buyer   = typeof rawKeys[0] === 'string' ? rawKeys[0] : rawKeys[0]?.pubkey;
  const newMint = typeof rawKeys[1] === 'string' ? rawKeys[1] : rawKeys[1]?.pubkey;
  const allKeys: string[] = rawKeys.map(k => typeof k === 'string' ? k : k.pubkey);
  for (const a of tx.meta?.loadedAddresses?.writable ?? []) allKeys.push(a);
  for (const a of tx.meta?.loadedAddresses?.readonly ?? []) allKeys.push(a);

  console.log(`buyer:   ${buyer}`);
  console.log(`newMint: ${newMint}`);
  const candidates = allKeys.filter(k => k !== buyer && k !== newMint && !SKIP_PROGRAMS.has(k));
  console.log(`candidates: ${candidates.length}`);
  for (const addr of candidates) {
    const info = await getAccountInfo(addr);
    if (!info) {
      console.log(`  [${addr}]  (no account info)`);
      continue;
    }
    const data = Buffer.from(info.data[0], 'base64');
    const headHex = data.subarray(0, Math.min(96, data.length)).toString('hex');
    console.log(
      `  [${addr}] owner=${info.owner} dataLen=${data.length} lamports=${info.lamports}\n` +
      `    head96=${headHex}`,
    );
  }
  console.log(
    '\nLook for an account with `owner = F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf` and dataLen ~ 200-400 bytes.\n' +
    'The first 8 bytes are the Anchor discriminator; subsequent fields likely include max_items + a Firestore id.\n' +
    'Diff two collections with known supplies to confirm offsets, then wire decoding into src/enrichment/lmnft.ts.',
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
