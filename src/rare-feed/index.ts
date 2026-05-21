/**
 * Rare Feed MVP — entry point. Wires the evaluator onto the existing sale
 * event bus and starts retention cleanup. Gated by RARE_FEED_ENABLED (default
 * on) so the whole feature can be killed without a code change.
 *
 * Architecture:
 *   sale event (existing bus) → rarity enrichment (ME, DB-cached)
 *     → score/filter → rare_feed_events → GET /api/tools/rare-feed/recent
 *     → /tools/rare-feed page.
 */
import { startRareFeedEvaluator } from './evaluator';
import { startRareFeedRetention } from './store';

export function startRareFeed(): void {
  const enabled = (process.env.RARE_FEED_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[rare/feed] disabled (RARE_FEED_ENABLED=false)');
    return;
  }
  startRareFeedEvaluator();
  startRareFeedRetention();
  console.log('[rare/feed] started');
}
