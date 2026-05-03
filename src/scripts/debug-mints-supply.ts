/**
 * Manual investigator for launchpad max-supply extraction.
 *
 *   npm run debug:mints:supply
 *
 * For each known reference tx (LMNFT + vvv.so) the script:
 *   1. fetches the tx via Helius (jsonParsed) so we can list its
 *      account keys + outer-ix accounts;
 *   2. picks candidate config / collection accounts by elimination
 *      (signers, system/program accounts, payer, the new mint, ATA,
 *      compute-budget, etc. are all filtered out);
 *   3. fetches `getAccountInfo` for each candidate and prints:
 *        - owner program
 *        - data length
 *        - first 64 bytes (hex) — usually contains a discriminator
 *          and the leading u64/u32 fields where `max_items` lives;
 *   4. for the MPL Core collection asset (vvv.so path), additionally
 *      calls DAS `getAsset` and dumps the relevant supply/plugins
 *      fields so the operator can confirm the right field name.
 *
 * No max-supply extraction is committed to the live ingest path yet —
 * once an offset / DAS field is confirmed against multiple txs, wire
 * it through `setMintMaxSupply()` from the appropriate detector or
 * enricher path.
 */
import 'dotenv/config';

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

const LMNFT_PROGRAM = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
const MPL_CORE      = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

interface Fixture {
  label:   string;
  sig:     string;
  source:  'LaunchMyNFT' | 'VVV';
}
const FIXTURES: Fixture[] = [
  {
    label:  'LaunchMyNFT',
    sig:    '3qjW71UQFuq9X65Fk4bKVmGyPs6XVGc8rtHF1UiqzBJ7AfQ9ZA1RVX1PpKYFGJfG93vwcCcuTR5edV2zXNtDDUeQ',
    source: 'LaunchMyNFT',
  },
  {
    label:  'vvv.so',
    sig:    '4nvMBRxq7L7eY7spzMWggj1QjenbcZ5uUMEKb49Fy8vCMRUvSKc62gWtdxWRz7EEQtKFyrgPC72EfG2FvCjCxv4Q',
    source: 'VVV',
  },
];

async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

interface ParsedTx {
  meta?: {
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  };
  transaction?: {
    message?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accountKeys?: Array<string | { pubkey: string; signer?: boolean; source?: string; writable?: boolean }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instructions?: Array<{ programId?: string; programIdIndex?: number; accounts?: Array<number | string> }>;
    };
  };
}

interface AccountInfoValue {
  owner: string;
  data:  [string, string]; // [base64, encoding]
  lamports: number;
  executable: boolean;
}

async function getAccountInfo(addr: string): Promise<AccountInfoValue | null> {
  const url = process.env.HELIUS_API_KEY ? RPC_URL : PUBLIC_RPC;
  try {
    const r = await rpc<{ value: AccountInfoValue | null }>(url, 'getAccountInfo', [addr, { encoding: 'base64' }]);
    return r.value;
  } catch {
    return null;
  }
}

interface DasAsset {
  ownership?:   { owner?: string; ownership_model?: string };
  grouping?:    Array<{ group_key: string; group_value: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins?:     Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collection_metadata?: any;
  supply?:      { print_max_supply?: number; print_current_supply?: number; edition_nonce?: number };
}
async function getAssetDas(addr: string): Promise<DasAsset | null> {
  if (!process.env.HELIUS_API_KEY) return null;
  try {
    const r = await rpc<DasAsset>(RPC_URL, 'getAsset', [addr]);
    return r ?? null;
  } catch {
    return null;
  }
}

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
  'SysvarS1otHashes111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  LMNFT_PROGRAM,
  MPL_CORE,
]);

async function inspect(fixture: Fixture): Promise<void> {
  console.log(`\n— ${fixture.label} (${fixture.source}) —`);
  console.log(`  sig: ${fixture.sig}`);
  const tx = await rpc<ParsedTx>(PUBLIC_RPC, 'getTransaction', [
    fixture.sig,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ]);
  const message = tx.transaction?.message;
  if (!message) { console.log('  no message'); return; }
  const keys = (message.accountKeys ?? []).map(k => typeof k === 'string' ? k : k.pubkey);

  // Candidates: every distinct account in the tx that's NOT a program /
  // sysvar / well-known fixed account, NOT obviously the buyer (signer
  // index 0), and NOT the new mint asset. The remaining short list
  // includes the launchpad config / collection / treasury accounts.
  const buyer = keys[0];
  const newMintAsset = (message.accountKeys ?? []).find(k => typeof k !== 'string' && k.signer && k.pubkey !== buyer);
  const newMintAddr = typeof newMintAsset === 'string' ? newMintAsset : newMintAsset?.pubkey;
  const candidates = keys.filter(k => k !== buyer && k !== newMintAddr && !SKIP_PROGRAMS.has(k));

  console.log(`  buyer:        ${buyer}`);
  console.log(`  newMint:      ${newMintAddr ?? '—'}`);
  console.log(`  candidates:   ${candidates.length}`);
  for (const addr of candidates) {
    const info = await getAccountInfo(addr);
    if (!info) {
      console.log(`    [${addr}] (no account info)`);
      continue;
    }
    const data = Buffer.from(info.data[0], 'base64');
    const headHex = data.subarray(0, Math.min(64, data.length)).toString('hex');
    console.log(
      `    [${addr}] owner=${info.owner} dataLen=${data.length} ` +
      `lamports=${info.lamports} head64=${headHex}`,
    );
  }

  // VVV path — known collection asset address from the inner Core
  // CreateV2 ix. The launchpad detector already extracts it as the
  // recorded `collectionAddress`; print DAS for it directly.
  if (fixture.source === 'VVV') {
    const collectionGuess = candidates.find(c => /^9irtKRLZkY/.test(c)) ?? candidates[0];
    if (collectionGuess) {
      console.log(`  DAS getAsset(${collectionGuess}):`);
      const a = await getAssetDas(collectionGuess);
      console.log(`    supply:    ${JSON.stringify(a?.supply ?? null)}`);
      console.log(`    plugins:   ${a?.plugins ? Object.keys(a.plugins).join(',') : '—'}`);
      console.log(`    grouping:  ${JSON.stringify(a?.grouping ?? [])}`);
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.HELIUS_API_KEY) {
    console.warn('HELIUS_API_KEY not set — getAccountInfo + DAS will use the public RPC fallback / be skipped.');
  }
  for (const f of FIXTURES) {
    try { await inspect(f); }
    catch (e) { console.log(`  ERROR: ${(e as Error).message}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
