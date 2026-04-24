/**
 * Historical sales backfill for one ME collection (slug-scoped).
 *
 *   Usage:
 *     npm run backfill:me -- <slug> [--days=N] [--max-pages=N]
 *
 *   Examples:
 *     npm run backfill:me -- caroots                       # default 30 days
 *     npm run backfill:me -- smb_gen3 --days=90            # last 90 days
 *     npm run backfill:me -- froganas --days=7 --max-pages=2
 *     npm run backfill:me -- --help
 *
 * Source
 *   GET https://api-mainnet.magiceden.dev/v2/collections/{slug}/activities
 *       ?type=buyNow&offset=&limit=500
 *   Public, no key. Same surface our live endpoints already proxy. Each entry
 *   contains everything sale_events needs: signature, blockTime (unix sec),
 *   tokenMint, seller, buyer, price (SOL), source (magiceden_v2 / mmm).
 *
 * Boundaries
 *   - Standalone script. Does NOT import live ingestion / enrichment / SSE
 *     code. Inserts raw rows directly via the existing INSERT_SQL column set.
 *   - Idempotent: ON CONFLICT (signature) DO NOTHING at the SQL level.
 *   - Default window 30 days; --days=N overrides. Stops paginating as soon
 *     as a page's oldest activity is older than the cutoff.
 *   - --max-pages=N safety cap (default 60 pages = 30 000 activities).
 *
 * Logging is intentionally minimal: one start line, one per page, one summary.
 */

import 'dotenv/config';   // auto-load .env so DATABASE_URL is always available
import { Pool } from 'pg';

const ME_API   = 'https://api-mainnet.magiceden.dev/v2';
const PAGE     = 500;
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_DAYS = 30;
const DEFAULT_MAX_PAGES = 60;

interface MeActivity {
  signature?:    string;
  type?:         string;     // 'buyNow' for fixed-price + AMM fills via ME
  source?:       string;     // 'magiceden_v2' | 'mmm' | 'tensor_marketplace' | …
  tokenMint?:    string;
  collection?:   string;     // slug
  collectionSymbol?: string; // also slug
  slot?:         number;
  blockTime?:    number;     // unix seconds
  buyer?:        string;
  seller?:       string;
  price?:        number;     // SOL (rounded — ME uses a non-lamport rawAmount scale on this endpoint, so this rounded value is the reliable source)
  /** ME item image URL — preserved into `image_url` so historical rows carry
   *  the same thumbnail ME's own activity view shows. Previously discarded. */
  image?:        string;
}

const INSERT_SQL = `
  INSERT INTO sale_events
    (signature, block_time, marketplace, nft_type, mint_address, collection_address,
     seller, buyer, price_lamports, price_sol, currency, raw_data,
     nft_name, image_url, collection_name, magic_eden_url, me_collection_slug)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  ON CONFLICT (signature) DO NOTHING
  RETURNING id
`;

interface CliArgs { slug: string; days: number; maxPages: number }

function printHelpAndExit(code: number): never {
  const lines = [
    'Usage:',
    '  npm run backfill:me -- <slug> [--days=N] [--max-pages=N]',
    '',
    'Args:',
    '  <slug>          Magic Eden collection symbol/slug (e.g. caroots, smb_gen3).',
    '                  This is the same slug used in /collection/<slug>.',
    `  --days=N        Lookback window in days. Default ${DEFAULT_DAYS}.`,
    `  --max-pages=N   Hard cap on pages fetched (each page = 500 activities).`,
    `                  Default ${DEFAULT_MAX_PAGES}.`,
    '  --help          Show this message.',
    '',
    'Examples:',
    '  npm run backfill:me -- caroots',
    '  npm run backfill:me -- smb_gen3 --days=90',
    '  npm run backfill:me -- froganas --days=7 --max-pages=2',
    '',
    'Inserts into sale_events with me_collection_slug=<slug>. Idempotent — ',
    'ON CONFLICT (signature) DO NOTHING; safe to re-run.',
  ];
  console.log(lines.join('\n'));
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) printHelpAndExit(0);
  const positional = argv.filter(a => !a.startsWith('--'));
  const slug = (positional[0] ?? '').trim();
  if (!slug) {
    console.error('error: missing <slug> argument\n');
    printHelpAndExit(2);
  }
  // ME slugs are alphanumeric + underscore + dash. Reject anything else fast
  // so we don't accidentally treat a flag typo (e.g. "-days=30") as a slug.
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    console.error(`error: invalid slug "${slug}" — expected [a-zA-Z0-9_-]+\n`);
    printHelpAndExit(2);
  }
  const flag = (name: string, def: number): number => {
    const m = argv.find(a => a.startsWith(`--${name}=`));
    if (!m) return def;
    const n = parseInt(m.split('=')[1], 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return { slug, days: flag('days', DEFAULT_DAYS), maxPages: flag('max-pages', DEFAULT_MAX_PAGES) };
}

async function fetchPage(slug: string, offset: number): Promise<MeActivity[]> {
  const url = `${ME_API}/collections/${encodeURIComponent(slug)}/activities`
            + `?type=buyNow&offset=${offset}&limit=${PAGE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ME activities HTTP ${res.status}`);
  const json = await res.json() as MeActivity[];
  if (!Array.isArray(json)) throw new Error('ME activities: non-array response');
  return json;
}

function marketplaceFor(source: string | undefined): string {
  return source === 'mmm' ? 'magic_eden_amm' : 'magic_eden';
}

async function insertActivity(pool: Pool, slug: string, a: MeActivity): Promise<boolean> {
  if (!a.signature || !a.tokenMint || !a.buyer || !a.seller
      || typeof a.price !== 'number' || a.price <= 0
      || typeof a.blockTime !== 'number' || a.blockTime <= 0) {
    return false;
  }
  const marketplace = marketplaceFor(a.source);
  // ME's /activities endpoint reports `price` as rounded SOL. Its
  // `priceInfo.solPrice.rawAmount` uses a non-lamport scale on this
  // endpoint (observed 5.2484 SOL → rawAmount "5248400000000000000"),
  // so we stick to price * 1e9 — rounded but correct in units.
  const priceLamports = BigInt(Math.round(a.price * 1e9));
  const blockTime = new Date(a.blockTime * 1000);
  const magicEdenUrl = `https://magiceden.io/item-details/${a.tokenMint}`;
  // Preserve every ME-provided field that influences Collection-page
  // presentation. `_meType` lets the canonical sale-type helper specialize
  // for backfill rows in the future without needing another DB migration.
  const rawData = {
    _parser:  'me_v2_backfill',
    _source:  a.source ?? null,
    _slot:    a.slot   ?? null,
    _meType:  a.type   ?? null,
  };

  const result = await pool.query(INSERT_SQL, [
    a.signature,
    blockTime,
    marketplace,
    'legacy',                // ME activities don't carry standard; live raw parser would correct
    a.tokenMint,
    null,                    // collection_address — not in ME activities response
    a.seller,
    a.buyer,
    priceLamports.toString(),
    a.price,
    'SOL',
    JSON.stringify(rawData),
    null,                    // nft_name — not exposed by ME /activities
    a.image ?? null,         // image_url — ME's thumbnail for this NFT
    null,                    // collection_name — not exposed by ME /activities
    magicEdenUrl,
    slug,                    // me_collection_slug — so /collection/<slug> finds the row
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}

async function main(): Promise<void> {
  const { slug, days, maxPages } = parseArgs(process.argv.slice(2));
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  const cutoffSec = Math.floor(cutoffMs / 1000);

  // Self-contained pool — script does not share state with running backend.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
  });

  console.log(`[backfill:me] start  slug=${slug}  days=${days}  cutoff=${new Date(cutoffMs).toISOString()}`);

  let offset = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalDup = 0;
  let pagesRun = 0;
  let stoppedReason = 'reached cutoff';

  try {
    for (let page = 0; page < maxPages; page++) {
      let acts: MeActivity[];
      try {
        acts = await fetchPage(slug, offset);
      } catch (err) {
        console.error(`[backfill:me] page=${page} fetch error: ${(err as Error).message}`);
        stoppedReason = 'fetch error';
        break;
      }
      pagesRun++;
      if (acts.length === 0) {
        stoppedReason = 'empty page';
        break;
      }

      let inserted = 0;
      let dup = 0;
      let oldestBt = Infinity;
      for (const a of acts) {
        if (typeof a.blockTime === 'number') oldestBt = Math.min(oldestBt, a.blockTime);
        const ok = await insertActivity(pool, slug, a);
        if (ok) inserted++; else dup++;
      }
      totalFetched += acts.length;
      totalInserted += inserted;
      totalDup += dup;

      const oldestIso = Number.isFinite(oldestBt) ? new Date(oldestBt * 1000).toISOString() : 'n/a';
      console.log(`[backfill:me] page=${page}  fetched=${acts.length}  inserted=${inserted}  dup=${dup}  oldest=${oldestIso}`);

      // Stop once this page reaches before our cutoff — no point paginating further.
      if (Number.isFinite(oldestBt) && oldestBt < cutoffSec) {
        stoppedReason = 'reached cutoff';
        break;
      }
      // Short page → likely the end of available history.
      if (acts.length < PAGE) {
        stoppedReason = 'short page (end of history)';
        break;
      }
      offset += PAGE;
    }

    console.log(`[backfill:me] done   slug=${slug}  pages=${pagesRun}  fetched=${totalFetched}  inserted=${totalInserted}  dup=${totalDup}  stop=${stoppedReason}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[backfill:me] fatal', err);
  process.exit(1);
});
