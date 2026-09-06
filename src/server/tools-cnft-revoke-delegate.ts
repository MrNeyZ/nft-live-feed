/**
 * cNFT delegate-revoke tool — personal use, throwaway.
 *
 * Airdropped compressed NFTs (Bubblegum) frequently arrive with a project
 * delegate still set on the leaf (`ownership.delegated: true`). It is NOT
 * frozen and NOT custodial — the leaf owner is still the holder — so the
 * owner can override it with a single Bubblegum `delegate` instruction
 * that sets `newLeafDelegate = owner` (i.e. revoke). Marketplaces that
 * refuse to list a delegated cNFT then let it through.
 *
 *   GET  /api/tools/cnft-revoke-delegate/asset?mint=   — decoded leaf state
 *   POST /api/tools/cnft-revoke-delegate/build         — { owner, mint } -> { tx: base64 }
 *
 * Single-signer legacy tx (owner only). Frontend signs via Phantom
 * signAndSendTransaction — same flow as the other /tools signing pages.
 * Every route is requireAuth-gated (site SIWS + UI_ALLOWED_WALLETS).
 */

import { Router, Request, Response } from 'express';
import { PublicKey, Connection, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createDelegateInstruction,
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
} from '@metaplex-foundation/mpl-bubblegum';
import {
  ConcurrentMerkleTreeAccount,
  SPL_NOOP_PROGRAM_ID,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
} from '@solana/spl-account-compression';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
}

async function das<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'vl', method, params }),
  });
  const j = await res.json() as { result?: T; error?: { message?: string } };
  if (j.error || j.result === undefined) throw new Error(j.error?.message ?? `${method} failed`);
  return j.result;
}

interface DasAsset {
  interface: string;
  content?: { metadata?: { name?: string }; links?: { image?: string } };
  ownership?: { owner?: string; delegate?: string | null; delegated?: boolean };
  compression?: {
    compressed?: boolean; tree?: string; leaf_id?: number;
    data_hash?: string; creator_hash?: string;
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
}

interface AssetView {
  mint: string;
  name: string | null;
  image: string | null;
  collection: string | null;
  compressed: boolean;
  owner: string | null;
  delegated: boolean;
  delegate: string | null;
  tree: string | null;
}

function toView(mint: string, a: DasAsset): AssetView {
  const g = (a.grouping ?? []).find((x) => x.group_key === 'collection');
  return {
    mint,
    name: a.content?.metadata?.name ?? null,
    image: a.content?.links?.image ?? null,
    collection: g?.group_value ?? null,
    compressed: a.compression?.compressed === true,
    owner: a.ownership?.owner ?? null,
    delegated: a.ownership?.delegated === true,
    delegate: a.ownership?.delegate ?? null,
    tree: a.compression?.tree ?? null,
  };
}

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createCnftRevokeDelegateRouter(): Router {
  const router = Router();
  const readLimit  = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/cnft-revoke-delegate/read' });
  const buildLimit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/cnft-revoke-delegate/build' });

  router.get('/tools/cnft-revoke-delegate/asset', readLimit, requireAuth, async (req: Request, res: Response) => {
    const mint = String(req.query.mint ?? '').trim();
    if (!ADDR_RE.test(mint)) { res.status(400).json({ ok: false, error: 'bad_mint' }); return; }
    try {
      const a = await das<DasAsset>('getAsset', { id: mint });
      res.json({ ok: true, asset: toView(mint, a) });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  router.post('/tools/cnft-revoke-delegate/build', buildLimit, requireAuth, async (req: Request, res: Response) => {
    const owner = String(req.body?.owner ?? '').trim();
    const mint  = String(req.body?.mint ?? '').trim();
    if (!ADDR_RE.test(owner) || !ADDR_RE.test(mint)) { res.status(400).json({ ok: false, error: 'bad_input' }); return; }

    try {
      const a = await das<DasAsset>('getAsset', { id: mint });
      const v = toView(mint, a);

      if (!v.compressed)             { res.status(400).json({ ok: false, error: 'not_compressed' }); return; }
      if (!v.owner)                  { res.status(400).json({ ok: false, error: 'no_owner' }); return; }
      if (v.owner !== owner)         { res.status(400).json({ ok: false, error: 'not_owner', owner: v.owner }); return; }
      if (!v.delegated || !v.delegate) { res.status(400).json({ ok: false, error: 'not_delegated' }); return; }

      const proof = await das<{ proof: string[]; root: string }>('getAssetProof', { id: mint });
      const tree = new PublicKey(a.compression!.tree!);
      const conn = new Connection(rpcUrl(), 'confirmed');
      const treeAcc = await ConcurrentMerkleTreeAccount.fromAccountAddress(conn, tree);
      const canopy = treeAcc.getCanopyDepth();
      const proofNodes = proof.proof
        .slice(0, canopy > 0 ? proof.proof.length - canopy : proof.proof.length)
        .map((p) => new PublicKey(p));

      const [treeAuthority] = PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_PROGRAM_ID);
      const ownerPk = new PublicKey(owner);
      const leafId = a.compression!.leaf_id!;

      const ix = createDelegateInstruction(
        {
          treeAuthority,
          leafOwner: ownerPk,
          previousLeafDelegate: new PublicKey(v.delegate),
          newLeafDelegate: ownerPk,               // self => revoke
          merkleTree: tree,
          logWrapper: SPL_NOOP_PROGRAM_ID,
          compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
          anchorRemainingAccounts: proofNodes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        },
        {
          root: [...bs58.decode(proof.root)],
          dataHash: [...bs58.decode(a.compression!.data_hash!)],
          creatorHash: [...bs58.decode(a.compression!.creator_hash!)],
          nonce: leafId,
          index: leafId,
        },
      );

      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction();
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;
      tx.add(ix);

      const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      res.json({ ok: true, tx: b64, asset: v });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
