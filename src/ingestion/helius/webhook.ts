import { Router, Request, Response } from 'express';
import { HeliusEnhancedTransaction } from './types';
import { parseHeliusTransaction } from './parser';
import { insertSaleEvent } from '../../db/insert';
import { ingestMeRaw } from '../me-raw/ingest';
import { ingestTensorRaw } from '../tensor-raw/ingest';

// ─── Batch diagnostics ────────────────────────────────────────────────────────

interface BatchStats {
  total: number;
  inserted: number;
  duplicate: number;
  insertErrors: number;
  skipped: {
    notNftEvent: number;    // tx had no events.nft block — not an NFT tx at all
    notSale: number;        // NFT event present but type is listing/bid/transfer/etc.
    cnftThreshold: number;  // cNFT price ≤ 0.002 SOL hard filter
    zeroPrice: number;
    missingParties: number;
    noMint: number;
    other: number;
  };
  // Raw source/type distribution for ALL incoming txs (before parse).
  // This is the ground-truth view of what Helius is actually delivering.
  byRawSource: Record<string, number>;
  byRawType: Record<string, number>;
  // Breakdown of successfully inserted sales only.
  byMarketplace: Record<string, number>;
  byNftType: Record<string, number>;
}

function newStats(total: number): BatchStats {
  return {
    total,
    inserted: 0,
    duplicate: 0,
    insertErrors: 0,
    skipped: {
      notNftEvent: 0,
      notSale: 0,
      cnftThreshold: 0,
      zeroPrice: 0,
      missingParties: 0,
      noMint: 0,
      other: 0,
    },
    byRawSource: {},
    byRawType: {},
    byMarketplace: {},
    byNftType: {},
  };
}

function inc(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function categoriseSkip(
  reason: string
): keyof BatchStats['skipped'] {
  if (reason === 'no nft event block')       return 'notNftEvent';
  if (reason.startsWith('not a sale type'))  return 'notSale';
  if (reason.startsWith('cnft below min'))   return 'cnftThreshold';
  if (reason === 'zero price')               return 'zeroPrice';
  if (reason === 'missing buyer or seller')  return 'missingParties';
  if (reason === 'no mint in nft event')     return 'noMint';
  return 'other';
}

function fmtMap(map: Record<string, number>): string {
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ') || '—';
}

function logBatchSummary(s: BatchStats) {
  const totalSkipped =
    s.skipped.notNftEvent +
    s.skipped.notSale +
    s.skipped.cnftThreshold +
    s.skipped.zeroPrice +
    s.skipped.missingParties +
    s.skipped.noMint +
    s.skipped.other;

  const skipDetail = Object.entries(s.skipped)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ') || '—';

  const soldDetail = Object.entries(s.byMarketplace)
    .sort(([, a], [, b]) => b - a)
    .map(([mp, v]) => {
      // pair each marketplace with its nft-type breakdown
      return `${mp}:${v}`;
    })
    .join('  ') || '—';

  // Show nft-type breakdown separately for clarity
  const nftTypeDetail = fmtMap(s.byNftType) || '—';

  console.log(
    `[helius/batch] recv=${s.total}  ` +
    `inserted=${s.inserted}  dup=${s.duplicate}  ` +
    `skipped=${totalSkipped}  err=${s.insertErrors}`
  );
  if (totalSkipped > 0) {
    console.log(`[helius/batch]   skip     → ${skipDetail}`);
  }
  console.log(`[helius/batch]   src      → ${fmtMap(s.byRawSource)}`);
  console.log(`[helius/batch]   txType   → ${fmtMap(s.byRawType)}`);
  if (s.inserted > 0) {
    console.log(`[helius/batch]   sold by  → ${soldDetail}`);
    console.log(`[helius/batch]   nft type → ${nftTypeDetail}`);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createHeliusRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const authHeader = req.headers['authorization'];
    if (process.env.HELIUS_WEBHOOK_AUTH && authHeader !== process.env.HELIUS_WEBHOOK_AUTH) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = req.body as HeliusEnhancedTransaction[];
    if (!Array.isArray(body)) {
      res.status(400).json({ error: 'expected array' });
      return;
    }

    const stats = newStats(body.length);

    // ── TIMING PROBE ────────────────────────────────────────────────────────────
    const webhookT = Date.now();
    for (const tx of body) {
      const nftTs = tx.events?.nft?.timestamp;
      if (nftTs) {
        const ageSec = ((webhookT - nftTs * 1000) / 1000).toFixed(1);
        console.log(`[timing] webhook  sig=${tx.signature.slice(0,12)}  blockAge=${ageSec}s  webhookT=${webhookT}`);
      }
    }
    // ── END TIMING PROBE ────────────────────────────────────────────────────────

    // Fire ME raw parser only for Magic Eden family transactions.
    // Helius sets tx.source = 'MAGIC_EDEN' for both ME v2 and ME AMM.
    // Filters out Tensor and any other marketplace — no RPC call is made for them.
    // Runs concurrently while the Helius path processes below.
    // ON CONFLICT (signature) DO NOTHING deduplicates; [me_raw] logs track source.
    const rawIngests = body
      .filter((tx) => tx.source === 'MAGIC_EDEN')
      .map((tx) =>
        ingestMeRaw(tx.signature, tx).catch((err) =>
          console.error('[me_raw] unhandled error', err)
        )
      );

    // Fire Tensor raw parser for Tensor family transactions.
    // Helius sets tx.source = 'TENSOR' for both TComp listings and TAMM pool trades.
    // Same fire-and-collect pattern as ME raw; dedup via ON CONFLICT DO NOTHING.
    const tensorRawIngests = body
      .filter((tx) => tx.source === 'TENSOR')
      .map((tx) =>
        ingestTensorRaw(tx.signature, tx).catch((err) =>
          console.error('[tensor_raw] unhandled error', err)
        )
      );

    for (const tx of body) {
      // Capture raw Helius classification before we parse — this is the
      // ground truth for what Helius is actually delivering to us.
      const rawSource = (tx.source ?? tx.events?.nft?.source ?? '(none)').toString();
      const rawType   = (tx.type   ?? '(none)').toString();
      inc(stats.byRawSource, rawSource);
      inc(stats.byRawType,   rawType);

      const result = parseHeliusTransaction(tx);

      if (!result.ok) {
        stats.skipped[categoriseSkip(result.reason)]++;
        continue;
      }

      try {
        const id = await insertSaleEvent(result.event);
        if (id) {
          stats.inserted++;
          inc(stats.byMarketplace, result.event.marketplace);
          inc(stats.byNftType,     result.event.nftType);
          console.log(
            `[helius] sale  ${result.event.marketplace}/${result.event.nftType}` +
            `  ${result.event.priceSol.toFixed(4)} SOL` +
            `  mint=${result.event.mintAddress.slice(0, 8)}...`
          );
        } else {
          stats.duplicate++;
        }
      } catch (err) {
        stats.insertErrors++;
        console.error('[helius] insert error', err);
      }
    }

    // Respond to Helius immediately — do NOT await raw ingests.
    // Raw ingests do their own RPC fetches with retries; blocking the HTTP response
    // here caused Helius to queue subsequent webhook batches, adding 20-60s latency.
    logBatchSummary(stats);
    res.json({
      inserted: stats.inserted,
      duplicate: stats.duplicate,
      skipped: stats.skipped,
      total: stats.total,
    });

    // Raw ingests continue in the background after the response is sent.
    // Errors are already caught and logged inside each ingestMeRaw / ingestTensorRaw call.
    Promise.allSettled([...rawIngests, ...tensorRawIngests]).catch(() => {});
  });

  return router;
}
