/**
 * Route-level regression suite for GET /collections/floor-depth.
 *
 * Real HTTP over an ephemeral local port (no supertest dependency in this
 * repo) with `listings-store`'s `ensureFresh`/`getByCollection` swapped for
 * injectable fakes (`FloorDepthDeps`) — no network, no DB, no RPC.
 *
 * `mk()` below is a local copy of floor-depth.test.ts's fixture builder,
 * not an import — floor-depth.test.ts runs its assertions (and calls
 * `process.exit`) as a side effect of module load, so importing it here
 * would execute that whole suite a second time, out of order, every time
 * this file runs. Keep the two shapes in sync by hand if `Listing` changes.
 *
 * Run: npx ts-node src/server/collection-floor-depth.test.ts
 */

import http from 'http';
import express from 'express';
import { createCollectionFloorDepthRouter, type FloorDepthDeps, type FloorDepthRouteResponse } from './collection-floor-depth';
import { computeFloorDepth } from '../analytics/floor-depth';
import type { Listing, ListingSource, ListingType } from './listings-store';

let mkSeq = 0;
function mk(
  mint: string,
  priceSol: number,
  opts: { source?: ListingSource; type?: ListingType; seller?: string } = {},
): Listing {
  mkSeq++;
  const source = opts.source ?? 'ME';
  const type   = opts.type   ?? 'listing';
  const seller = opts.seller ?? `seller${mkSeq}`;
  return {
    id:           `${source}:${type === 'pool' ? `pool${mkSeq}:` : ''}${mint}:${seller}`,
    mint,
    priceSol,
    source,
    type,
    seller,
    slug:         'test_collection',
    auctionHouse: source === 'MMM' ? '' : 'AH1',
    tokenAta:     '',
    rank:         null,
    listedAt:     null,
    nftName:      null,
    imageUrl:     null,
  };
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else      { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

function startServer(deps: FloorDepthDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  const router = createCollectionFloorDepthRouter(deps);
  app.use('/collections', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}/collections`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function get(url: string): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { /* leave null for non-JSON assertions */ }
        resolve({ status: res.statusCode ?? 0, body, raw });
      });
    }).on('error', reject);
  });
}

/** Recursively confirms no NaN/Infinity/-Infinity survived JSON encoding
 *  (JSON.stringify silently turns them into `null`, which would otherwise
 *  hide the bug — this walks the ORIGINAL object, not the encoded string). */
function hasNonFiniteNumber(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNonFiniteNumber);
  if (v && typeof v === 'object') return Object.values(v).some(hasNonFiniteNumber);
  return false;
}

async function main() {
  // ── 1. Route delegates to the real computeFloorDepth() — no duplicate math ─
  {
    const listings: Listing[] = [mk('a', 1), mk('b', 1.02), mk('c', 2)];
    const expected = computeFloorDepth(listings);
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => listings };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=test_collection`);
    await close();

    const b = body as FloorDepthRouteResponse;
    check('delegate: 200 OK', status === 200, `got ${status}`);
    check('delegate: slug echoed', b.slug === 'test_collection');
    check('delegate: depth.floorSol matches computeFloorDepth() directly', b.depth.floorSol === expected.floorSol);
    check('delegate: depth.spreadPct matches', b.depth.spreadPct === expected.spreadPct);
    check('delegate: depth bands match exactly (JSON-identical)', JSON.stringify(b.depth.depth) === JSON.stringify(expected.depth));
    check('delegate: moveFloor bands match exactly', JSON.stringify(b.depth.moveFloor) === JSON.stringify(expected.moveFloor));
    check('delegate: sourceBreakdown matches', JSON.stringify(b.depth.sourceBreakdown) === JSON.stringify(expected.sourceBreakdown));
    check('delegate: warnings match', JSON.stringify(b.depth.warnings) === JSON.stringify(expected.warnings));
    check('delegate: rawCount = raw store row count (3)', b.listingSnapshot.rawCount === 3, `got ${b.listingSnapshot.rawCount}`);
    check('delegate: uniqueMintCount = depth.uniqueMintCount', b.listingSnapshot.uniqueMintCount === b.depth.uniqueMintCount);
  }

  // ── 2. Unknown slug (valid shape, zero rows) — 200 with a valid analytical response, not an error ─
  {
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => [] };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=totally_unknown_slug`);
    await close();
    const b = body as FloorDepthRouteResponse;
    check('unknown slug: 200 OK (not 404/500)', status === 200, `got ${status}`);
    check('unknown slug: floorSol null', b.depth.floorSol === null);
    check('unknown slug: confidence low', b.depth.confidence === 'low');
    check('unknown slug: rawCount 0', b.listingSnapshot.rawCount === 0);
  }

  // ── 3. Only one valid listing ────────────────────────────────────────────
  {
    const listings: Listing[] = [mk('solo', 3.3)];
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => listings };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=thin_collection`);
    await close();
    const b = body as FloorDepthRouteResponse;
    check('one listing: 200 OK', status === 200);
    check('one listing: floorSol 3.3', b.depth.floorSol === 3.3);
    check('one listing: secondListingSol null', b.depth.secondListingSol === null);
    check('one listing: confidence low', b.depth.confidence === 'low');
  }

  // ── 4. ensureFresh throws (simulated marketplace-refresh failure) — must NOT become a 500 when cached data exists ─
  {
    const listings: Listing[] = [mk('cached1', 1), mk('cached2', 1.01)];
    const deps: FloorDepthDeps = {
      ensureFresh: async () => { throw new Error('simulated upstream timeout'); },
      getByCollection: () => listings, // store still has last-known rows
    };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=partial_outage`);
    await close();
    const b = body as FloorDepthRouteResponse;
    check('refresh failure: 200 OK, not 500 (cached data still served)', status === 200, `got ${status}`);
    check('refresh failure: floor computed from cached rows', b.depth.floorSol === 1);
    check('refresh failure: rawCount reflects cached snapshot (2)', b.listingSnapshot.rawCount === 2);
  }

  // ── 5. getByCollection returns nothing even after a successful ensureFresh (empty upstream, e.g. Tensor key absent + no ME/MMM listings) ─
  {
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => [] };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=no_listings_anywhere`);
    await close();
    const b = body as FloorDepthRouteResponse;
    check('empty upstream: 200 OK', status === 200);
    check('empty upstream: warns no valid listings', b.depth.warnings.some((w) => w.includes('no valid listings')));
  }

  // ── 6. Malformed / zero / negative rows + duplicate mint across ME and MMM — must reach computeFloorDepth() untouched, not be pre-filtered by the route ─
  {
    const listings: Listing[] = [
      mk('good', 1.5),
      mk('zero', 0),
      mk('neg', -1),
      mk('dup', 2.0, { source: 'ME' }),
      mk('dup', 1.8, { source: 'MMM', type: 'pool' }),
    ];
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => listings };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=dirty_data`);
    await close();
    const b = body as FloorDepthRouteResponse;
    check('dirty data: 200 OK', status === 200);
    check('dirty data: rawCount is the untouched store length (5)', b.listingSnapshot.rawCount === 5, `got ${b.listingSnapshot.rawCount}`);
    check('dirty data: depth.listingCount only counts structurally valid rows (3: good + dup + dup)', b.depth.listingCount === 3, `got ${b.depth.listingCount}`);
    check('dirty data: uniqueMintCount dedupes the ME/MMM duplicate (2: good + dup)', b.depth.uniqueMintCount === 2, `got ${b.depth.uniqueMintCount}`);
    // "good" (1.5) is cheaper than the deduped "dup" (min(2.0, 1.8) = 1.8), so floor is 1.5.
    check('dirty data: floorSol is 1.5 (the cheapest valid, non-dup row)', b.depth.floorSol === 1.5, `got ${b.depth.floorSol}`);
    check('dirty data: warns about excluded invalid prices', b.depth.warnings.some((w) => w.includes('invalid (non-positive/NaN) price')));
    check('dirty data: warns about the collapsed duplicate', b.depth.warnings.some((w) => w.includes('duplicate row')));
  }

  // ── 7. Invalid slug shapes — clear 4xx, no store call at all ─────────────
  {
    let calledEnsureFresh = false;
    const deps: FloorDepthDeps = {
      ensureFresh: async () => { calledEnsureFresh = true; },
      getByCollection: () => [],
    };
    const { base, close } = await startServer(deps);
    const { status: s1 } = await get(`${base}/floor-depth`); // missing slug
    const { status: s2 } = await get(`${base}/floor-depth?slug=${encodeURIComponent('bad slug with spaces!')}`);
    const { status: s3 } = await get(`${base}/floor-depth?slug=${'a'.repeat(200)}`); // too long
    await close();
    check('invalid slug: missing -> 400', s1 === 400, `got ${s1}`);
    check('invalid slug: malformed -> 400', s2 === 400, `got ${s2}`);
    check('invalid slug: too long -> 400', s3 === 400, `got ${s3}`);
    check('invalid slug: store never touched for any invalid input', !calledEnsureFresh);
  }

  // ── 8. JSON contains no NaN/Infinity anywhere in the response ────────────
  {
    const listings: Listing[] = [mk('a', 1), mk('b', 1.02), mk('c', 2), mk('d', 100)];
    const deps: FloorDepthDeps = { ensureFresh: async () => {}, getByCollection: () => listings };
    const { base, close } = await startServer(deps);
    const { status, body } = await get(`${base}/floor-depth?slug=finite_check`);
    await close();
    check('finite: 200 OK', status === 200);
    check('finite: no NaN/Infinity anywhere in the response body', !hasNonFiniteNumber(body));
  }

  // ── 9. Repeated requests reuse listings-store freshness — the route never calls ensureFresh more than once per request, and never bypasses the store's own TTL logic itself (it has no cache of its own) ─
  {
    let ensureFreshCalls = 0;
    const listings: Listing[] = [mk('a', 1)];
    const deps: FloorDepthDeps = {
      ensureFresh: async () => { ensureFreshCalls++; },
      getByCollection: () => listings,
    };
    const { base, close } = await startServer(deps);
    await get(`${base}/floor-depth?slug=hot_collection`);
    await get(`${base}/floor-depth?slug=hot_collection`);
    await get(`${base}/floor-depth?slug=hot_collection`);
    await close();
    // Exactly one ensureFresh call per request — the route adds no batching/
    // dedup of its own; TTL-based coalescing is listings-store's job (already
    // proven by its own test suite), not this route's.
    check('reuse: exactly one ensureFresh call per request (3 requests -> 3 calls, no route-level cache)', ensureFreshCalls === 3, `got ${ensureFreshCalls}`);
  }

  // ── 10. No second/duplicate floor-depth implementation exists in this file ─
  {
    const src = require('fs').readFileSync(__dirname + '/collection-floor-depth.ts', 'utf8');
    check('no reimplementation: route file does not define its own depth/spread math',
      !/floorSol\s*=.*Math\.min|spreadPct\s*=.*floorSol/.test(src));
    check('no reimplementation: route file imports computeFloorDepth rather than reimplementing it',
      /import\s*\{[^}]*computeFloorDepth[^}]*\}\s*from\s*['"]\.\.\/analytics\/floor-depth['"]/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
