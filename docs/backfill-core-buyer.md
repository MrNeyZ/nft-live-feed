# Backfill TODO: ME v2 Core buyer attribution

Status: **audit complete (read-only), backfill NOT run**. This doc is the
handoff for whoever runs the mutation phase later.

## Why

`sale_events.buyer` for `marketplace='magic_eden'` /
`raw_data->>'_instruction'='coreExecuteSaleV2'` rows was, before the
2026-08-05 parser fix (commit `d4b08be`), sometimes attributed to a
program-owned ME v2 escrow PDA instead of the real buyer wallet. Root
cause: the old buyer-resolution fallback (`extractPaymentInfo`'s SOL-flow
"largest decrease" heuristic) picks whichever account lost the most SOL in
the transaction. In ME v2's `Deposit → BuyV2 → CoreExecuteSaleV2` flow, the
buyer can draw from a personal escrow PDA that carries a standing balance
across transactions — whenever that escrow's own outflow in one instruction
(observed near-constant ~3.56M lamports) exceeds the buyer's fresh top-up
in *this* transaction, the heuristic picks the escrow, not the buyer.

The parser fix (`resolveCoreBuyerDetailed` in
`src/ingestion/me-raw/parser.ts`) is live and prevents new rows from having
this problem. This doc is about the **historical rows already in the DB**
that were written by the old parser.

## Audit results (2026-08-05 run)

Full read-only pass, `npm run audit:core-buyer-attribution`, no `--limit`:

| metric | count |
|---|---|
| scanned | 37,200 |
| buyer_changed (proposed fix) | 532 (1.4%) |
| buyer_unchanged | 34,557 |
| unsupported_or_ambiguous | 2,111 |
| transaction_unavailable | 0 |
| rpc_retryable_error | 0 |

Of the 532 proposed changes: **100%** have `oldBuyerWasSigner=false`
(every misattributed buyer was provably never a transaction signer — the
core invariant the fix checks). 91.5% are priced under 0.03 SOL (matches
the "cheap sale, escrow draw exceeds top-up" mechanism). 90.8% show the
expected `Deposit → BuyV2` log shape; the remaining 9.2% ("other" shape,
49 rows) still pass all three `resolveCoreBuyerDetailed` gates but don't
show a `Deposit` log line in this specific transaction — plausibly a buyer
whose escrow already had a sufficient balance from an earlier top-up, but
**this bucket needs the manual review below before trusting it**.

Artifacts from this run (local only, gitignored, NOT committed — re-running
the audit regenerates them):
```
data/audits/core-buyer-attribution-changes.jsonl      # 532 proposed changes, full detail
data/audits/core-buyer-attribution-issues.jsonl        # 2,111 unsupported/ambiguous rows
data/audits/core-buyer-attribution-summary.json        # counts + breakdowns
data/audits/core-buyer-attribution-checkpoint.json     # resume cursor (block_time, id)
```

## Prerequisites before running the backfill

1. **Manual stratified review of `core-buyer-attribution-changes.jsonl`** —
   not yet done. Required sample, per the original audit request:
   - several low-price (<0.03 SOL) changes — the bulk of the population
   - several normal/higher-price changes (>0.1 SOL) — smaller bucket (39
     rows total), worth checking the mechanism still holds at higher price
   - any row that looks Lucky-Buy/relayed-adjacent (should be ZERO, since
     `resolveCoreBuyerDetailed` explicitly excludes `isLuckyBuyTx` — a
     changed row with lucky-buy characteristics would be a real bug)
   - any row that looks seller-initiated (`CoreSell`-shaped) — should also
     be ZERO per the delta-sign gate; same "would be a bug" logic
   - the `txShape: "other"` bucket (49 rows) specifically — confirm these
     are genuinely buyer-initiated with a pre-funded escrow, not some
     other unaccounted-for flow
   - group by `proposedBuyer` and inspect any wallet appearing many times
     — confirm it's a real repeat buyer, not a second PDA pattern the fix
     missed

2. **Check for downstream dependents on `sale_events.buyer`** — not yet
   done. Grep for: materialized views, wallet-analytics caches (this repo
   or the sibling `wallet-checker` repo), any denormalized aggregate that
   reads `sale_events.buyer` and would need its own correction after a
   backfill (e.g. a "top buyers" leaderboard, per-wallet sale-count cache).
   Updating `sale_events.buyer` alone is insufficient if something else
   already computed and cached state from the wrong value.

3. Re-run the audit (see below) close to backfill time if more than a few
   days have passed, so newly-ingested rows are covered too — the live
   parser fix already prevents NEW rows from having this problem, but the
   audit's `unsupported_or_ambiguous`/counts should be refreshed.

## Exact CLI commands

Read-only audit (already run once; safe to re-run — resumes from the
saved checkpoint and only scans NEW rows since the last cursor position,
or pass `--restart` for a full fresh pass):

```bash
npm run audit:core-buyer-attribution                    # resume / incremental
npm run audit:core-buyer-attribution -- --restart        # full fresh pass
npm run audit:core-buyer-attribution -- --limit=5000     # cap this run
npm run audit:core-buyer-attribution -- --batch=6 --page-size=300 --sleep-ms=150
```

Zero database mutations in any invocation of this script — it only
`SELECT`s and writes local files under `data/audits/`.

**The mutation/backfill command does not exist yet.** It must be written
as a separate script (mirroring `src/scripts/backfill-me-v2-logprice.ts`'s
dry-run-by-default / `--apply` pattern) that reads
`core-buyer-attribution-changes.jsonl` and applies each `saleEventId` →
`proposedBuyer` update. Keep it a distinct file/command from the audit CLI
(`audit-core-buyer-attribution.ts`) — do not add a mutation path to the
audit script itself.

## Estimated runtime / RPC cost

The full 37,200-row scan took **~15 minutes** (2026-08-05 19:43–19:58 UTC)
at `--batch=4` (default), issuing one `getTransaction` RPC call per row —
**37,200 Helius `getTransaction` calls total** for the audit pass. A
backfill `--apply` run only needs to touch the 532 already-identified
`buyer_changed` rows (no re-fetch required — the audit already stored
`proposedBuyer` in the JSONL) — the mutation phase itself should be
**532 lightweight `UPDATE ... WHERE id = $1` calls**, on the order of
seconds to low minutes, not another RPC pass.

## Validation steps after completion

1. Row count sanity: `SELECT count(*) FROM sale_events WHERE buyer IN (<the 532 old PDA values>)` should return 0 after the backfill (every old value fully replaced).
2. Spot-check 5-10 updated rows against Magic Eden's own `/v2/tokens/{mint}/activities` API (the same ground-truth source used to verify the seller-attribution fix) to independently confirm the new buyer.
3. Re-run the audit CLI with `--restart` — `buyer_changed` should drop to ~0 for the backfilled range (any remainder should only be NEW rows ingested after the backfill, or genuinely unresolved `unsupported_or_ambiguous` cases, never a repeat of an already-fixed row).
4. Check whatever downstream caches were identified in prerequisite #2 — refresh/invalidate them for the affected wallets.

## Rollback strategy

The mutation script must write an audit trail on every row it touches
(mirroring `backfill-me-v2-logprice.ts`'s pattern: fold a
`_buyerAttributionFix: { oldBuyer, fixedAt }` object into `raw_data` in the
SAME update statement) so a rollback is a single deterministic query:

```sql
UPDATE sale_events
   SET buyer    = raw_data->'_buyerAttributionFix'->>'oldBuyer',
       raw_data = raw_data - '_buyerAttributionFix'
 WHERE raw_data ? '_buyerAttributionFix';
```

No backup table needed given this — the old value travels with the row
itself. Requiring the mutation script to be transactional per-row (or
batched in explicit `BEGIN`/`COMMIT` chunks) and idempotent (an already-
fixed row — `raw_data` already carrying `_buyerAttributionFix` — must be
skipped on a second run, not re-applied) is a hard requirement for the
eventual `--apply` implementation, matching the existing
`backfill-me-v2-logprice.ts` precedent.
