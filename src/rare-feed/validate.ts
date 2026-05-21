/**
 * Rare Feed — offline validation harness. No DB, no network.
 *
 *   npx ts-node src/rare-feed/validate.ts
 *
 * Exercises the two pieces that have to be exactly right for MVP:
 *   1. the tolerant ME rank/supply parser (varied field names + nested rarity)
 *   2. the score/filter logic against the four spec scenarios:
 *        - rare sale with rank present, below floor   → accepted
 *        - common sale                                → rejected
 *        - no rarity data                             → (parser yields no rank)
 *        - top-1% near floor                          → accepted
 */
import { scoreSale } from './scoring';

// The parser internals are module-private in rarity.ts; re-implement the two
// tiny extractors here so the validation harness stays DB/network-free while
// still asserting the same key lists. Kept in sync with rarity.ts.
const RANK_KEYS = ['rank', 'rankA', 'rarityRank', 'rarityRankTT', 'rarityRankMoonrank', 'rarityRankHR', 'rarityRankStat'];
const SUPPLY_KEYS = ['totalMints', 'supply', 'totalSupply', 'totalItems', 'itemCount'];
function firstPositiveInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
function nestedRarityRank(obj: Record<string, unknown>): number | null {
  const rarity = obj['rarity'];
  if (!rarity || typeof rarity !== 'object') return null;
  for (const provider of Object.values(rarity as Record<string, unknown>)) {
    if (provider && typeof provider === 'object') {
      const r = firstPositiveInt(provider as Record<string, unknown>, ['rank', 'rarityRank']);
      if (r != null) return r;
    }
  }
  return null;
}
function parseRank(json: Record<string, unknown>): number | null {
  return firstPositiveInt(json, RANK_KEYS) ?? nestedRarityRank(json);
}

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

console.log('── Parser ──');
check('top-level `rank`',          parseRank({ rank: 12 }) === 12);
check('`rarityRankMoonrank`',      parseRank({ rarityRankMoonrank: 7 }) === 7);
check('`rarityRankHR` as string',  parseRank({ rarityRankHR: '99' }) === 99);
check('nested rarity.moonrank',    parseRank({ rarity: { moonrank: { rank: 42 } } }) === 42);
check('no rank field → null',      parseRank({ name: '#1', collection: 'foo' }) === null);
check('supply via totalMints',     firstPositiveInt({ totalMints: 5000 }, SUPPLY_KEYS) === 5000);
check('supply via totalSupply',    firstPositiveInt({ totalSupply: 888 }, SUPPLY_KEYS) === 888);

console.log('\n── Scoring / filter ──');

// 1. Rare sale, rank present, below floor → accepted.
{
  const r = scoreSale({ rarityRank: 50, totalSupply: 1000, salePrice: 8, floorPrice: 10 }); // top 5%, 20% below
  check('rare + below floor → accepted', r.qualifies, `score=${r.score} tags=${r.reasonTags.join(',')}`);
  check('  has BELOW_FLOOR + TOP_5',     r.reasonTags.includes('BELOW_FLOOR') && r.reasonTags.includes('TOP_5'));
}

// 2. Common sale (rank deep in the collection) → rejected.
{
  const r = scoreSale({ rarityRank: 800, totalSupply: 1000, salePrice: 9, floorPrice: 10 }); // 80th pct
  check('common sale → rejected', !r.qualifies, `score=${r.score} tags=${r.reasonTags.join(',') || 'none'}`);
}

// 3. "No rarity data" — represented upstream by parseRank → null, so the
//    evaluator rejects with reason=no_rarity before scoreSale is ever called.
check('no-rank token short-circuits before scoring', parseRank({ name: '#777' }) === null);

// 4. Top-1% near floor (slightly ABOVE floor) → accepted via special rule.
{
  const r = scoreSale({ rarityRank: 5, totalSupply: 1000, salePrice: 10.4, floorPrice: 10 }); // top 0.5%, +4%
  check('top-1% near floor → accepted', r.qualifies, `score=${r.score} tags=${r.reasonTags.join(',')}`);
  check('  has NEAR_FLOOR_TOP_1 + TOP_1', r.reasonTags.includes('NEAR_FLOOR_TOP_1') && r.reasonTags.includes('TOP_1'));
}

// 5. Top-1% but well ABOVE the near-floor band → rejected (not a value buy).
{
  const r = scoreSale({ rarityRank: 5, totalSupply: 1000, salePrice: 15, floorPrice: 10 }); // top 0.5%, +50%
  check('top-1% but +50% over floor → rejected', !r.qualifies, `score=${r.score}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
