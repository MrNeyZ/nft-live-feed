/**
 * LaunchMyNFT instruction-name survey.
 *
 *   npm run debug:mints:launchpad-survey
 *
 * Pulls the most recent ~100 signatures for the LMNFT program, fetches
 * each tx's parsed payload, extracts the `Instruction: …` log line
 * emitted by LMNFT, and groups by name. For each distinct dispatcher
 * the script reports:
 *   - count of txs in the sample
 *   - one example signature
 *   - whether the tx LOOKS mint-like (inner CPI to MPL Core / Token
 *     Metadata / Bubblegum, or a System createAccount that allocates
 *     a fresh asset / mint account)
 *   - inferred standard (Core / Legacy / pNFT / cNFT / unknown) based
 *     on which inner program was invoked
 *
 * Output guides whether the detector should accept additional ix names
 * beyond `Instruction: MintCore`. Production detector is NOT changed.
 *
 * Uses Helius RPC when HELIUS_API_KEY is set; falls back to the public
 * mainnet RPC otherwise (slower, more 429s — sample size is automatically
 * trimmed via the `LIMIT` constant if the public RPC keeps throttling).
 */
import 'dotenv/config';

const LMNFT_PROGRAM        = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
const MPL_CORE             = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TOKEN_METADATA       = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const BUBBLEGUM            = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';

const RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const LIMIT          = 100;       // signatures to pull
const FETCH_PAR      = 4;         // concurrent getTransaction fetches
const PER_TX_TIMEOUT = 10_000;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(PER_TX_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!('result' in json)) throw new Error('no result');
  return json.result as T;
}

interface SigInfo { signature: string; err: unknown }

interface ParsedInner {
  index: number;
  instructions: Array<{ program?: string; programId?: string; programIdIndex?: number; parsed?: { type?: string } }>;
}
interface ParsedTx {
  meta?: { err: unknown; logMessages?: string[]; innerInstructions?: ParsedInner[] };
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
}

interface Verdict {
  ix:           string;          // e.g. "MintCore"
  count:        number;
  exampleSig:   string;
  mintLike:     boolean;
  standard:     'Core' | 'Legacy' | 'pNFT' | 'cNFT' | 'unknown';
}

function logInstructionName(logs: string[]): string | null {
  // LMNFT emits exactly one `Program log: Instruction: <Name>` line per
  // call. Anchor convention puts it right after the program-invoke line.
  for (const l of logs) {
    if (typeof l !== 'string') continue;
    const m = l.match(/^Program log: Instruction:\s*(\S+)/);
    if (m) return m[1];
  }
  return null;
}

function classifyInner(tx: ParsedTx): { mintLike: boolean; standard: Verdict['standard'] } {
  const inner = tx.meta?.innerInstructions ?? [];
  const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(k => typeof k === 'string' ? k : k.pubkey);
  let sawCore = false, sawTM = false, sawBubble = false, sawSysCreate = false;
  for (const grp of inner) {
    for (const ix of grp.instructions) {
      const pid = ix.programId
        ?? (typeof ix.programIdIndex === 'number' ? accountKeys[ix.programIdIndex] : undefined)
        ?? (ix.program === 'system' ? '11111111111111111111111111111111' : undefined);
      if (pid === MPL_CORE)       sawCore   = true;
      if (pid === TOKEN_METADATA) sawTM     = true;
      if (pid === BUBBLEGUM)      sawBubble = true;
      if (ix.parsed?.type === 'createAccount') sawSysCreate = true;
    }
  }
  if (sawCore)   return { mintLike: true, standard: 'Core' };
  if (sawBubble) return { mintLike: true, standard: 'cNFT' };
  if (sawTM) {
    // Discriminate Legacy vs pNFT via the program log: pNFT mints have
    // a "mip1" log mention; legacy doesn't. Best-effort.
    const logs = tx.meta?.logMessages ?? [];
    const sawMip1 = logs.some(l => typeof l === 'string' && l.includes('mip1'));
    return { mintLike: true, standard: sawMip1 ? 'pNFT' : 'Legacy' };
  }
  if (sawSysCreate) return { mintLike: true, standard: 'unknown' };
  return { mintLike: false, standard: 'unknown' };
}

async function main(): Promise<void> {
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Fetching last ${LIMIT} signatures for LMNFT program…`);
  const sigs = await rpc<SigInfo[]>('getSignaturesForAddress', [LMNFT_PROGRAM, { limit: LIMIT }]);
  const sample = sigs.filter(s => !s.err);
  console.log(`Got ${sample.length} non-failed signatures (of ${sigs.length}).`);

  const verdicts = new Map<string, Verdict>();
  let done = 0;
  // Bounded parallelism via simple worker loop so the public RPC doesn't
  // 429 the whole survey.
  const queue = sample.slice();
  const workers: Promise<void>[] = [];
  for (let w = 0; w < FETCH_PAR; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const s = queue.shift();
        if (!s) break;
        try {
          const tx = await rpc<ParsedTx>('getTransaction', [
            s.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx) continue;
          const ixName = logInstructionName(tx.meta?.logMessages ?? []) ?? 'UNKNOWN';
          const c = classifyInner(tx);
          const cur = verdicts.get(ixName);
          if (!cur) {
            verdicts.set(ixName, {
              ix: ixName, count: 1, exampleSig: s.signature,
              mintLike: c.mintLike, standard: c.standard,
            });
          } else {
            cur.count++;
            // Promote to mint-like + standard if any sample of this ix
            // name was mint-like (others may have been edge cases).
            if (c.mintLike && !cur.mintLike) { cur.mintLike = true; cur.standard = c.standard; cur.exampleSig = s.signature; }
          }
        } catch (e) {
          // Ignore individual failures — public RPC throttles, dropped txs.
          if (process.env.SURVEY_DEBUG) console.error(`  skip ${s.signature.slice(0,12)}…: ${(e as Error).message}`);
        } finally {
          done++;
          if (done % 10 === 0) console.log(`  fetched ${done}/${sample.length}…`);
        }
      }
    })());
  }
  await Promise.all(workers);

  const rows = [...verdicts.values()].sort((a, b) => b.count - a.count);
  console.log('\n— LMNFT instruction-name distribution —');
  console.log('count  mint?  std       instruction                        example sig');
  for (const r of rows) {
    console.log(
      `${String(r.count).padStart(5)}  ${r.mintLike ? 'YES' : 'no '}    ` +
      `${r.standard.padEnd(8)}  ${r.ix.padEnd(36)}  ${r.exampleSig.slice(0, 16)}…`,
    );
  }
  const mintIxs = rows.filter(r => r.mintLike).map(r => r.ix);
  console.log(`\nDistinct mint-like ix names: ${mintIxs.length}`);
  console.log(mintIxs.length === 0 ? '  (none)' : '  ' + mintIxs.join(', '));
  console.log('\nProduction detector is unchanged. Use this output to decide whether to extend');
  console.log('the LMNFT branch in src/ingestion/mint-raw/launchpad-detector.ts.');
}
main().catch((e) => { console.error(e); process.exit(1); });
