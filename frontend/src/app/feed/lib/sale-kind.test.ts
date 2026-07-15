// Standalone (no test framework — the frontend has none) verification of the
// canonical AMM-badge precedence rule (2026-07-15 fix). Compile + run:
//   npx tsc src/app/feed/lib/sale-kind.ts src/app/feed/lib/sale-kind.test.ts \
//     --outDir /tmp/sk --module commonjs --target es2020 --esModuleInterop \
//     --skipLibCheck && node /tmp/sk/app/feed/lib/sale-kind.test.js
//
// Covers the regression this fix closes: a stale/wrong/unresolved ME
// `poolType` lookup must never override the authoritative, transaction-time
// `ammFill` signal — including a confirmed `false` (ordinary bid acceptance),
// which is just as authoritative as a confirmed `true`.
import assert from 'assert';
import { saleKind, SALE_TYPE_SELL, SALE_TYPE_BUY_AMM, SALE_TYPE_SELL_AMM, type PoolType } from './sale-kind';
import type { SaleKind } from './types';

interface Case {
  label: string;
  saleTypeRaw: string;
  isPoolMarketplace: boolean;
  poolType?: PoolType | null;
  ammFill?: boolean | null;
  expected: SaleKind;
}

const CASES: Case[] = [
  // ── ammFill is authoritative: true always wins, regardless of poolType ──────
  {
    label: 'REPORTED #1: ammFill=true, poolType=two_sided (both agree) → sellAmm',
    saleTypeRaw: SALE_TYPE_SELL_AMM, isPoolMarketplace: true, poolType: 'two_sided', ammFill: true,
    expected: 'sellAmm',
  },
  {
    label: 'REPORTED #2: ammFill=true, poolType unresolved (ME could not classify) → sellAmm',
    saleTypeRaw: SALE_TYPE_SELL_AMM, isPoolMarketplace: true, poolType: null, ammFill: true,
    expected: 'sellAmm',
  },
  {
    label: 'ammFill=true, poolType=buy (ME lookup WRONG/stale) → sellAmm anyway (ammFill wins)',
    saleTypeRaw: SALE_TYPE_SELL_AMM, isPoolMarketplace: true, poolType: 'buy', ammFill: true,
    expected: 'sellAmm',
  },
  {
    label: 'ammFill=true on pool_buy direction → buyAmm',
    saleTypeRaw: SALE_TYPE_BUY_AMM, isPoolMarketplace: true, poolType: null, ammFill: true,
    expected: 'buyAmm',
  },
  // ── ammFill=false is AUTHORITATIVE non-AMM — must NEVER fall back to poolType ──
  {
    label: 'ammFill=false (confirmed lp_fee=0 bid accept) + poolType=two_sided (STALE) → sell, NOT sellAmm',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, poolType: 'two_sided', ammFill: false,
    expected: 'sell',
  },
  {
    label: 'ammFill=false + poolType unresolved → plain sell',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, poolType: null, ammFill: false,
    expected: 'sell',
  },
  // ── ammFill undefined/null (no evidence) → poolType fallback allowed ────────
  {
    label: 'ammFill undefined, poolType=two_sided (legacy/historical row) → sellAmm (fallback)',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, poolType: 'two_sided', ammFill: undefined,
    expected: 'sellAmm',
  },
  {
    label: 'ammFill null, poolType=two_sided → sellAmm (fallback, null treated same as undefined)',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, poolType: 'two_sided', ammFill: null,
    expected: 'sellAmm',
  },
  {
    label: 'ammFill undefined, poolType=buy → plain sell',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, poolType: 'buy', ammFill: undefined,
    expected: 'sell',
  },
  {
    label: 'ammFill undefined, poolType undefined (fully unresolved) → plain sell',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: true, ammFill: undefined,
    expected: 'sell',
  },
  // ── isPoolMarketplace=false gates everything off regardless of signals ──────
  {
    label: 'ammFill=true but NOT a pool marketplace (e.g. plain ME v2) → plain sell, never AMM',
    saleTypeRaw: SALE_TYPE_SELL, isPoolMarketplace: false, poolType: 'two_sided', ammFill: true,
    expected: 'sell',
  },
  // ── price/direction/marketplace regressions unaffected by this fix ──────────
  {
    label: 'normal_sale untouched by ammFill/poolType entirely → buy',
    saleTypeRaw: 'normal_sale', isPoolMarketplace: true, poolType: 'two_sided', ammFill: true,
    expected: 'buy',
  },
];

let failures = 0;
for (const c of CASES) {
  const got = saleKind(c.saleTypeRaw, c.isPoolMarketplace, c.poolType, c.ammFill);
  const ok = got === c.expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label} → got=${got} want=${c.expected}`);
}
assert.strictEqual(failures, 0, `${failures} sale-kind AMM-precedence case(s) failed`);
console.log('\nAll sale-kind AMM-precedence cases passed.');
