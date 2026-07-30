/**
 * DotLand direct-mint tool — personal use only, not a public feature.
 *
 * Calls the public `buy_plot` instruction on DotLand's own Anchor program
 * directly, bypassing their (occasionally overloaded) frontend. Confirmed
 * via the program's own on-chain-shipped IDL that `buy_plot` has no
 * off-chain gate (no cosigner, no backend signature, no merkle proof) —
 * it's a plain permissionless purchase, same as calling any public
 * contract instruction directly. `buy_plot_allowlisted` (the free/holder
 * path) DOES require a merkle proof and is intentionally NOT implemented
 * here.
 *
 * Every route requires `requireAuth` (site-wide SIWS + UI_ALLOWED_WALLETS
 * gate) — this endpoint is not meant to be reachable by anyone outside
 * the operator's own allowed wallet.
 *
 *   GET  /api/tools/dotland/config              — live price/paused/stats
 *   POST /api/tools/dotland/build-tx             — { buyer, x, y, width, height }
 *                                                   -> { tx: base64 } partially
 *                                                   signed by the fresh asset
 *                                                   keypair; buyer signs client-side.
 *
 * Broadcast reuses the existing generic `/api/tools/mmm-pools/send-tx` proxy.
 */

import { Router, Request, Response } from 'express';
import {
  PublicKey, Connection, Keypair, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

const PROGRAM_ID = new PublicKey('EiWfPJ5yYaZTzSzpoUXCCWNL2Hz3XAymvDTokLFZka7n');
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const COLLECTION = new PublicKey('FASMrm8q4Z9xSejvpbyZP6uzuory8DCwqRskhuGJV2MX');
// GridState: "occupancy bitmap for all 10_000 blocks", "one bit per block,
// indexed y * GRID_SIZE + x" (program's own IDL docstring). 1250 bytes =
// 10_000 bits = GRID_SIZE^2 with GRID_SIZE=100.
const GRID_TOTAL_BLOCKS = 10_000n;
const GRID_SIZE = 100;

// buy_plot discriminator — sha256("global:buy_plot")[0:8], read from the
// program's own Anchor IDL (shipped publicly in dotland.io's JS bundle).
const BUY_PLOT_DISCRIMINATOR = Buffer.from([215, 251, 11, 234, 64, 163, 40, 181]);

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

function deriveConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
}
function deriveGridStatePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('grid')], PROGRAM_ID)[0];
}
function deriveUpdateAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('authority')], PROGRAM_ID)[0];
}
function derivePlotPda(x: number, y: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('plot'), Buffer.from([x]), Buffer.from([y])],
    PROGRAM_ID,
  )[0];
}

interface DotlandConfig {
  admin: string;
  treasury: string;
  pricePerBlockLamports: string;
  updateFeeLamports: string;
  maxBlocksPerPurchase: number;
  paused: boolean;
  plotsSold: string;
  blocksSold: string;
  collection: string;
  blocksRemaining: string;
}

async function readConfig(conn: Connection): Promise<DotlandConfig> {
  const config = deriveConfigPda();
  const info = await conn.getAccountInfo(config);
  if (!info) throw new Error('Config account not found');
  const data = info.data;
  let o = 8; // Anchor discriminator
  const admin = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const pricePerBlock = data.readBigUInt64LE(o); o += 8;
  const updateFee = data.readBigUInt64LE(o); o += 8;
  const maxBlocks = data.readUInt32LE(o); o += 4;
  const paused = data.readUInt8(o) === 1; o += 1;
  const plotsSold = data.readBigUInt64LE(o); o += 8;
  const blocksSold = data.readBigUInt64LE(o); o += 8;
  const collection = new PublicKey(data.subarray(o, o + 32)); o += 32;
  return {
    admin: admin.toBase58(),
    treasury: treasury.toBase58(),
    pricePerBlockLamports: pricePerBlock.toString(),
    updateFeeLamports: updateFee.toString(),
    maxBlocksPerPurchase: maxBlocks,
    paused,
    plotsSold: plotsSold.toString(),
    blocksSold: blocksSold.toString(),
    collection: collection.toBase58(),
    blocksRemaining: (GRID_TOTAL_BLOCKS - blocksSold).toString(),
  };
}

async function readGridBitmap(conn: Connection): Promise<Buffer> {
  const info = await conn.getAccountInfo(deriveGridStatePda());
  if (!info) throw new Error('GridState account not found');
  return info.data.subarray(8, 8 + 1250); // discriminator + bitmap(1250 bytes)
}

function isBlockSold(bitmap: Buffer, x: number, y: number): boolean {
  const bitIndex = y * GRID_SIZE + x;
  const byte = bitmap[bitIndex >> 3];
  return ((byte >> (bitIndex & 7)) & 1) === 1;
}

// Every occupied cell in [x, x+width) x [y, y+height), clipped to the grid.
function occupiedCellsInRange(
  bitmap: Buffer, x: number, y: number, width: number, height: number,
): Array<{ x: number; y: number }> {
  const occupied: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < height; dy++) {
    const cy = y + dy;
    if (cy >= GRID_SIZE) continue;
    for (let dx = 0; dx < width; dx++) {
      const cx = x + dx;
      if (cx >= GRID_SIZE) continue;
      if (isBlockSold(bitmap, cx, cy)) occupied.push({ x: cx, y: cy });
    }
  }
  return occupied;
}

export function createDotlandRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 20, windowMs: 60_000, label: 'tools/dotland' });
  const conn = new Connection(rpcUrl(), 'confirmed');

  router.get('/tools/dotland/config', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const cfg = await readConfig(conn);
      return res.json({ ok: true, config: cfg });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/dotland/availability', limit, requireAuth, async (req: Request, res: Response) => {
    try {
      const bx = Number(req.query.x), by = Number(req.query.y);
      const bw = req.query.width !== undefined ? Number(req.query.width) : 1;
      const bh = req.query.height !== undefined ? Number(req.query.height) : 1;
      for (const [name, v] of [['x', bx], ['y', by], ['width', bw], ['height', bh]] as const) {
        if (!Number.isInteger(v) || v < 0 || v > 255) {
          return res.status(400).json({ ok: false, error: `invalid_${name}` });
        }
      }
      const bitmap = await readGridBitmap(conn);
      const occupied = occupiedCellsInRange(bitmap, bx, by, bw, bh);
      return res.json({
        ok: true,
        totalBlocks: bw * bh,
        occupiedBlocks: occupied.length,
        free: occupied.length === 0,
        occupied,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/dotland/build-tx', limit, requireAuth, async (req: Request, res: Response) => {
    try {
      const { buyer, x, y, width, height } = req.body as {
        buyer?: string; x?: number; y?: number; width?: number; height?: number;
      };
      if (!buyer) return res.status(400).json({ ok: false, error: 'missing_buyer' });
      const bx = Number(x), by = Number(y);
      const bw = width !== undefined ? Number(width) : 1;
      const bh = height !== undefined ? Number(height) : 1;
      for (const [name, v] of [['x', bx], ['y', by], ['width', bw], ['height', bh]] as const) {
        if (!Number.isInteger(v) || v < 0 || v > 255) {
          return res.status(400).json({ ok: false, error: `invalid_${name}` });
        }
      }

      const buyerPk = new PublicKey(buyer);
      const cfg = await readConfig(conn);
      if (cfg.paused) return res.status(409).json({ ok: false, error: 'mint_paused' });
      const blocks = bw * bh;
      if (blocks > cfg.maxBlocksPerPurchase) {
        return res.status(400).json({ ok: false, error: 'exceeds_max_blocks_per_purchase' });
      }

      const plot = derivePlotPda(bx, by);
      const plotInfo = await conn.getAccountInfo(plot);
      if (plotInfo) {
        return res.status(409).json({ ok: false, error: 'plot_already_taken', plot: plot.toBase58() });
      }
      // Corner PDA free doesn't mean the rectangle is: an existing plot with
      // a different top-left corner can still overlap this one. Check the
      // occupancy bitmap for every cell in range before building the tx.
      const bitmap = await readGridBitmap(conn);
      const occupied = occupiedCellsInRange(bitmap, bx, by, bw, bh);
      if (occupied.length > 0) {
        return res.status(409).json({ ok: false, error: 'range_overlaps_sold_blocks', occupied });
      }

      const config = deriveConfigPda();
      const gridState = deriveGridStatePda();
      const updateAuthority = deriveUpdateAuthorityPda();
      const asset = Keypair.generate();

      const data = Buffer.concat([BUY_PLOT_DISCRIMINATOR, Buffer.from([bx, by, bw, bh])]);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: buyerPk, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: true },
          { pubkey: gridState, isSigner: false, isWritable: true },
          { pubkey: new PublicKey(cfg.treasury), isSigner: false, isWritable: true },
          { pubkey: plot, isSigner: false, isWritable: true },
          { pubkey: COLLECTION, isSigner: false, isWritable: true },
          { pubkey: updateAuthority, isSigner: false, isWritable: false },
          { pubkey: asset.publicKey, isSigner: true, isWritable: true },
          { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ix,
      );
      tx.feePayer = buyerPk;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      // Partial-sign with the fresh asset keypair now — the buyer's own
      // wallet signature is added client-side via wallet-adapter, exactly
      // like the existing MMM co-sign flows in this app. The asset
      // keypair itself is thrown away after this (its pubkey isn't a
      // secret; only its signature over THIS tx matters).
      tx.partialSign(asset);

      const serialized = tx.serialize({ requireAllSignatures: false }).toString('base64');
      const totalPriceLamports = BigInt(cfg.pricePerBlockLamports) * BigInt(blocks);

      return res.json({
        ok: true,
        tx: serialized,
        lastValidBlockHeight,
        plot: plot.toBase58(),
        asset: asset.publicKey.toBase58(),
        blocks,
        totalPriceLamports: totalPriceLamports.toString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/dotland] build-tx error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
