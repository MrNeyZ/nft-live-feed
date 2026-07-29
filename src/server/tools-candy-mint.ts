/**
 * Candy Mint tool — personal use only, not a public feature.
 *
 * Reconstructs a Candy Guard mint transaction from a real, already-landed
 * mint signature (or directly from candyMachine/candyGuard addresses) and
 * returns an unsigned tx for the connecting wallet to sign. Exists because
 * candy machines get closed (rent reclaimed) the moment they sell out —
 * sometimes minutes after a still-open-looking frontend shows the mint as
 * live — so "paste a recent mint's signature" is the fastest way to check
 * whether minting is still actually possible on-chain and, if so, do it
 * directly.
 *
 * Two families (see ../candy-mint/decode.ts's header comment for the
 * account-order verification behind both): 'core' (MPL Core Candy Guard)
 * and 'legacy' (Token Metadata Candy Guard). Resolved from the reference
 * signature automatically, or auto-detected from the candyGuard account's
 * on-chain owner when entering via raw addresses.
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — this endpoint is not meant to be reachable by anyone outside the
 * operator's own allowed wallet.
 *
 *   GET  /api/tools/candy-mint/inspect?sig=<signature>[&wallet=]
 *   GET  /api/tools/candy-mint/inspect?candyMachine=&candyGuard=[&wallet=]
 *      (wallet is optional — when supplied, each group's mintLimit guard
 *      also gets `used`/`remaining` filled in against that specific wallet)
 *   POST /api/tools/candy-mint/build-tx   { family, candyMachine, candyGuard, collection, collectionUpdateAuthority?, group, wallet }
 *   POST /api/tools/candy-mint/simulate-tx { transactionBase64, wallet }
 *
 * Broadcast reuses the existing generic `/api/tools/mmm-pools/send-tx` proxy
 * (same pattern as tools-dotland.ts / tools-me-bids.ts).
 */

import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { decodeCandyMintSignature, detectFamilyFromGuardAddress, type CandyMintFamily } from '../candy-mint/decode';
import { inspectCandyMachine } from '../candy-mint/guard-config';
import { buildCandyMintTx } from '../candy-mint/build';
import { simulateCandyMintTx } from '../candy-mint/simulate';
import { getAsset } from '../enrichment/helius-das';

function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function createCandyMintRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 20, windowMs: 60_000, label: 'tools/candy-mint' });

  router.get('/tools/candy-mint/inspect', limit, requireAuth, async (req: Request, res: Response) => {
    try {
      const sig = req.query.sig as string | undefined;
      const candyMachineQ = req.query.candyMachine as string | undefined;
      const candyGuardQ = req.query.candyGuard as string | undefined;
      const walletQ = req.query.wallet as string | undefined;
      const wallet = isValidPubkey(walletQ) ? walletQ : null;

      let candyMachine: string; let candyGuard: string; let collection: string | null = null;
      let collectionUpdateAuthority: string | null = null; let group: string | null = null;
      let family: CandyMintFamily;

      if (sig) {
        const decoded = await decodeCandyMintSignature(sig);
        if (!decoded.ok) return res.status(422).json({ ok: false, error: decoded.error });
        family = decoded.decoded.family;
        candyMachine = decoded.decoded.candyMachine;
        candyGuard = decoded.decoded.candyGuard;
        collection = decoded.decoded.collection;
        collectionUpdateAuthority = decoded.decoded.collectionUpdateAuthority;
        group = decoded.decoded.group;
      } else if (isValidPubkey(candyMachineQ) && isValidPubkey(candyGuardQ)) {
        candyMachine = candyMachineQ;
        candyGuard = candyGuardQ;
        const detected = await detectFamilyFromGuardAddress(candyGuard);
        if (!detected) return res.status(422).json({ ok: false, error: 'unrecognized_candy_guard_program' });
        family = detected;
      } else {
        return res.status(400).json({ ok: false, error: 'provide_sig_or_candyMachine_and_candyGuard' });
      }

      const inspection = await inspectCandyMachine(family, candyMachine, candyGuard, wallet);

      // Best-effort — the launchpad-style hero (image/name/creator) is a
      // display nicety, not a gate. A DAS miss (fresh/never-indexed
      // collection, rate limit) must never block minting itself.
      let collectionMeta: { name: string | null; image: string | null; description: string | null; creator: string | null } | null = null;
      const collectionAddr = inspection.collection ?? collection;
      if (collectionAddr) {
        try {
          const meta = await getAsset(collectionAddr, 'manual_tools');
          collectionMeta = {
            name: meta.nftName,
            image: meta.imageUrl,
            description: meta.description ?? null,
            creator: meta.verifiedCreators?.[0] ?? null,
          };
        } catch {
          // leave collectionMeta null — inspection result is still fully usable
        }
      }

      return res.json({
        ok: true, family, referenceCollection: collection,
        referenceCollectionUpdateAuthority: collectionUpdateAuthority,
        referenceGroup: group, inspection, collectionMeta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] inspect error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/candy-mint/build-tx', limit, requireAuth, async (req: Request, res: Response) => {
    try {
      const {
        family, candyMachine, candyGuard, collection, collectionUpdateAuthority, group, wallet,
      } = req.body as {
        family?: string; candyMachine?: string; candyGuard?: string; collection?: string;
        collectionUpdateAuthority?: string | null; group?: string | null; wallet?: string;
      };
      if (family !== 'core' && family !== 'legacy') {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_family' });
      }
      if (!isValidPubkey(candyMachine) || !isValidPubkey(candyGuard) || !isValidPubkey(collection) || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      if (family === 'legacy' && collectionUpdateAuthority != null && !isValidPubkey(collectionUpdateAuthority)) {
        return res.status(400).json({ ok: false, error: 'invalid_collectionUpdateAuthority' });
      }
      const result = await buildCandyMintTx({
        family, candyMachine, candyGuard, collection, wallet,
        collectionUpdateAuthority: collectionUpdateAuthority ?? null,
        group: typeof group === 'string' && group.length > 0 ? group : null,
      });
      if (!result.ok) return res.status(409).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] build-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/candy-mint/simulate-tx', limit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { transactionBase64, wallet } = req.body as { transactionBase64?: string; wallet?: string };
      if (typeof transactionBase64 !== 'string' || !transactionBase64 || !isValidPubkey(wallet)) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_fields' });
      }
      const result = await simulateCandyMintTx(transactionBase64, wallet);
      if (!result.ok) return res.status(502).json(result);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/candy-mint] simulate-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
