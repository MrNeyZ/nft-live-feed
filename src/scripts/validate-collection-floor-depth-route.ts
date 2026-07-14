/**
 * One-off live validation of GET /collections/floor-depth against 5 real
 * collections, using the EXISTING listings-store.ts snapshot machinery
 * (ensureFresh + getByCollection) through the actual new route handler —
 * not a direct call to computeFloorDepth() (that's already covered by
 * src/scripts/validate-floor-depth.ts). This script starts a throwaway
 * Express instance on an ephemeral local port, mounts ONLY the new Floor
 * Depth router, and makes real HTTP GETs against it — same collections
 * validate-floor-depth.ts already uses, so results are directly comparable.
 *
 * Local-only: does not touch the live pm2 process, does not rebuild/deploy
 * anything. ME/MMM/Tensor calls happen exactly as they already do for any
 * other consumer of listings-store.ts — no new external call path.
 *
 * Run: npx ts-node src/scripts/validate-collection-floor-depth-route.ts
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createCollectionFloorDepthRouter } from '../server/collection-floor-depth';

const COLLECTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'claynosaurz',        label: 'High-volume'                 },
  { slug: 'pegui',              label: 'Thin-floor (few listings)'   },
  { slug: 'wobots',             label: 'Low-price'                   },
  { slug: 'trippin_ape_tribe',  label: 'MMM pool asks present'       },
  { slug: 'okay_bears',         label: 'Cross-market (ME + Tensor)'  },
];

function get(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    }).on('error', reject);
  });
}

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toFixed(4);
}

async function main() {
  const app = express();
  app.use('/collections', createCollectionFloorDepthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}/collections/floor-depth`;

  for (const { slug, label } of COLLECTIONS) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${slug}  (${label})`);
    console.log('='.repeat(70));
    try {
      const t0 = Date.now();
      const { status, body } = await get(`${base}?slug=${encodeURIComponent(slug)}`);
      const ms = Date.now() - t0;
      console.log(`HTTP status:          ${status}  (${ms}ms)`);
      if (status !== 200 || !body) {
        console.log(`  body: ${JSON.stringify(body)}`);
        continue;
      }
      const r = body.depth;
      console.log(`rawCount (raw store): ${body.listingSnapshot.rawCount}`);
      console.log(`uniqueMintCount:      ${body.listingSnapshot.uniqueMintCount}`);
      console.log(`floorSol:             ${fmt(r.floorSol)}`);
      console.log(`secondListingSol:     ${fmt(r.secondListingSol)}`);
      console.log(`spreadPct:            ${r.spreadPct === null ? '—' : (r.spreadPct * 100).toFixed(2) + '%'}`);
      console.log(`confidence:           ${r.confidence}`);
      console.log(`depth:`);
      for (const k of ['within1Pct', 'within2Pct', 'within5Pct', 'within10Pct']) {
        console.log(`  ${k.padEnd(12)} count=${String(r.depth[k].count).padStart(3)}  costSol=${fmt(r.depth[k].costSol)}`);
      }
      console.log(`moveFloor (est. SOL to move price by X%):`);
      for (const k of ['toPlus1Pct', 'toPlus2Pct', 'toPlus5Pct', 'toPlus10Pct']) {
        console.log(`  ${k.padEnd(12)} listingsToBuy=${String(r.moveFloor[k].listingsToBuy).padStart(3)}  costSol=${fmt(r.moveFloor[k].costSol)}`);
      }
      console.log(`sourceBreakdown:      ME=${r.sourceBreakdown.magicEden} Tensor=${r.sourceBreakdown.tensor} MMMPool=${r.sourceBreakdown.mmmPool} TensorPool=${r.sourceBreakdown.tensorPool} Other=${r.sourceBreakdown.other}`);
      console.log(`warnings:             ${r.warnings.length === 0 ? 'none' : ''}`);
      for (const w of r.warnings) console.log(`  - ${w}`);
    } catch (err) {
      console.error(`  ERROR validating ${slug}:`, (err as Error)?.message ?? err);
    }
  }
  server.close();
  process.exit(0);
}

main();
