/**
 * Sibling candy machine lookup — given a collection, finds every OTHER
 * candy machine (either program family) whose on-chain `collection_mint`
 * field points at it.
 *
 * Surfaces "phase 2" drops: a second candy machine deployed after the
 * first sold out, but never linked from any front-end mint page — e.g.
 * CLOIDS, where a 1111-item Core CM #2 sat fully unminted for 18 days
 * because nothing pointed at it (found 2026-09-16 by manually diffing a
 * live mint's decoded collection against `getProgramAccounts`).
 *
 * Read-only: two getProgramAccounts memcmp calls (one per family) per
 * Inspect. Byte offsets are NOT imported from
 * `src/ingestion/mint-raw/index.ts` (which verified them live against a
 * real Core account — see that file's CM_SUPPLY_OFFSETS header) because
 * that file is the ingestion entrypoint; importing it would pull in its
 * module-scope listener wiring. Duplicated here instead — keep in sync.
 */
import bs58 from 'bs58';
import { rpcPost } from '../server/tools-mmm-pools';
import { CORE_CANDY_MACHINE_PROGRAM } from '../mint-analyzer/programs';
import { CANDY_MACHINE_V3_PROGRAM } from '../ingestion/mint-raw/launchpad-detector';
import type { CandyMintFamily } from './decode';

/** Both families set `mint_authority` to the Candy Guard PDA via a
 *  `SetMintAuthority` CPI at guard-Initialize time (confirmed live, CLOIDS
 *  CM #2: guard `4AwKoVWd…` == this field). Reading it back means a
 *  sibling can be Inspected directly (candyMachine+candyGuard route)
 *  without needing any landed mint signature for it — useful for a
 *  phase-2 CM that hasn't been minted from yet at all. */
const MINT_AUTHORITY_OFFSET: Record<CandyMintFamily, number> = {
  core:   40,
  legacy: 48,
};
const COLLECTION_MINT_OFFSET: Record<CandyMintFamily, number> = {
  core:   72,
  legacy: 80,
};
const SUPPLY_OFFSETS: Record<CandyMintFamily, { redeemed: number; available: number }> = {
  core:   { redeemed: 104, available: 112 },
  legacy: { redeemed: 112, available: 120 },
};
const CM_PROGRAM: Record<CandyMintFamily, string> = {
  core:   CORE_CANDY_MACHINE_PROGRAM,
  legacy: CANDY_MACHINE_V3_PROGRAM,
};

export interface SiblingCandyMachine {
  candyMachine:   string;
  candyGuard:     string;
  family:         CandyMintFamily;
  itemsRedeemed:  number;
  itemsAvailable: number;
}

interface GpaAccount {
  pubkey:  string;
  account: { data: [string, string] };
}

async function findForFamily(collectionMint: string, family: CandyMintFamily): Promise<GpaAccount[]> {
  const rows = await rpcPost('getProgramAccounts', [
    CM_PROGRAM[family],
    {
      encoding: 'base64',
      filters: [{ memcmp: { offset: COLLECTION_MINT_OFFSET[family], bytes: collectionMint } }],
      dataSlice: { offset: 0, length: 128 },
    },
  ]).catch(() => [] as GpaAccount[]);
  return (rows as GpaAccount[] | null) ?? [];
}

/** Every OTHER candy machine (either family) pointing at `collectionMint`,
 *  excluding `excludeCandyMachine` (the one already being inspected).
 *  Best-effort: an RPC failure on one family degrades to just the other,
 *  never throws — this is a bonus panel, not part of the mint path. */
export async function findSiblingCandyMachines(
  collectionMint: string,
  excludeCandyMachine: string,
): Promise<SiblingCandyMachine[]> {
  const [coreRows, legacyRows] = await Promise.all([
    findForFamily(collectionMint, 'core'),
    findForFamily(collectionMint, 'legacy'),
  ]);
  const out: SiblingCandyMachine[] = [];
  for (const { rows, family } of [
    { rows: coreRows, family: 'core' as const },
    { rows: legacyRows, family: 'legacy' as const },
  ]) {
    const { redeemed, available } = SUPPLY_OFFSETS[family];
    const authorityOffset = MINT_AUTHORITY_OFFSET[family];
    for (const row of rows) {
      if (row.pubkey === excludeCandyMachine) continue;
      const buf = Buffer.from(row.account.data[0], 'base64');
      if (buf.length < 128) continue;
      out.push({
        candyMachine:   row.pubkey,
        candyGuard:     bs58.encode(buf.subarray(authorityOffset, authorityOffset + 32)),
        family,
        itemsRedeemed:  Number(buf.readBigUInt64LE(redeemed)),
        itemsAvailable: Number(buf.readBigUInt64LE(available)),
      });
    }
  }
  return out;
}
