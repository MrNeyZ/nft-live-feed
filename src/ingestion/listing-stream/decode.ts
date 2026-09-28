/**
 * Pure decoder: marketplace instruction → listing action (list / delist /
 * edit). No network, no state. Account positions + arg layouts come from the
 * program IDLs:
 *   ME M2  — on-chain Anchor IDL `m2` v0.1.0
 *   TComp  — tensor-foundation/marketplace `program/idl.json` v0.7.1
 *             (the on-chain IDL is stale: no list_legacy / list_t22 / list_wns)
 *
 * cNFT listings (TComp `list` / ME cNFT program) are out of scope: they touch
 * a merkle tree, not a mint account.
 */

import { anchorDisc, ME_V2_PROGRAM } from '../me-raw/programs';
import { TCOMP_PROGRAM } from '../tensor-raw/programs';

export type ListingActionKind = 'list' | 'delist' | 'edit';

export interface ListingAction {
  kind:        ListingActionKind;
  marketplace: 'ME' | 'TENSOR';
  ix:          string;              // instruction name, for stats/logs
  /** NFT mint (legacy / pNFT / T22) or MPL Core asset. Null only for TComp
   *  `edit`, which carries just the list-state PDA. */
  mint:        string | null;
  listState:   string | null;       // TComp only
  seller:      string;
  priceLamports: number | null;     // list / edit only
  /** MPL Core collection address when the ix carries it. */
  collection:  string | null;
  /** ME list only: auction house + the token account the NFT sits in (the
   *  asset itself for Core) — exactly what ME's buy_now takes, so a buy can
   *  skip re-fetching the listing. Null when the ix doesn't carry them. */
  auctionHouse: string | null;
  tokenAccount: string | null;
}

interface Spec {
  name:        string;
  kind:        ListingActionKind;
  mintIdx:     number | null;
  sellerIdx:   number;
  listStateIdx?: number;
  collectionIdx?: number;
  ahIdx?:      number;
  tokenAccountIdx?: number;
  /** Byte offset of the u64 price in ix data (after the 8-byte disc). */
  priceOff?:   number;
  /** TComp arg tail: `expireInSec: Option<u64>, currency: Option<Pubkey>` —
   *  a Some(currency) means a non-SOL price → skip. */
  tcompCurrencyTail?: boolean;
}

const ME_SPECS: Spec[] = [
  // sell args: sellerStateBump u8, programAsSignerBump u8, buyerPrice u64, …
  // ahIdx / tokenAccountIdx per M2 IDL, checked against ME's listing
  // `auctionHouse` / `tokenAddress`: mip1Sell → tokenAta 10 (not tokenAccount 3),
  // coreSell → the asset. Legacy `sell` token account is unverified, so it
  // stays unset and a buy falls back to ME's listing fetch.
  { name: 'sell',             kind: 'list',   mintIdx: 4, sellerIdx: 0, priceOff: 10, ahIdx: 7 },
  { name: 'mip1_sell',        kind: 'list',   mintIdx: 4, sellerIdx: 0, priceOff: 8,  ahIdx: 6, tokenAccountIdx: 10 },
  { name: 'core_sell',        kind: 'list',   mintIdx: 4, sellerIdx: 1, priceOff: 8, collectionIdx: 11, ahIdx: 5, tokenAccountIdx: 4 },
  { name: 'ext_sell',         kind: 'list',   mintIdx: 6, sellerIdx: 1, priceOff: 8 },
  { name: 'ocp_sell',         kind: 'list',   mintIdx: 4, sellerIdx: 0, priceOff: 8 },
  { name: 'cancel_sell',      kind: 'delist', mintIdx: 3, sellerIdx: 0 },
  { name: 'mip1_cancel_sell', kind: 'delist', mintIdx: 4, sellerIdx: 0 },
  { name: 'core_cancel_sell', kind: 'delist', mintIdx: 4, sellerIdx: 1, collectionIdx: 9 },
  { name: 'ext_cancel_sell',  kind: 'delist', mintIdx: 6, sellerIdx: 1 },
  { name: 'ocp_cancel_sell',  kind: 'delist', mintIdx: 4, sellerIdx: 0 },
];

const TCOMP_SPECS: Spec[] = [
  { name: 'list_legacy', kind: 'list', mintIdx: 4, sellerIdx: 0, listStateIdx: 2, priceOff: 8, tcompCurrencyTail: true },
  { name: 'list_t22',    kind: 'list', mintIdx: 4, sellerIdx: 0, listStateIdx: 2, priceOff: 8, tcompCurrencyTail: true },
  { name: 'list_wns',    kind: 'list', mintIdx: 4, sellerIdx: 0, listStateIdx: 2, priceOff: 8 },
  { name: 'list_core',   kind: 'list', mintIdx: 0, sellerIdx: 3, listStateIdx: 2, collectionIdx: 1, priceOff: 8, tcompCurrencyTail: true },
  { name: 'edit',        kind: 'edit', mintIdx: null, sellerIdx: 1, listStateIdx: 0, priceOff: 8, tcompCurrencyTail: true },
  { name: 'delist_legacy', kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'delist_t22',    kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'delist_wns',    kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'delist_core',   kind: 'delist', mintIdx: 0, sellerIdx: 2, listStateIdx: 3, collectionIdx: 1 },
  { name: 'close_expired_listing_legacy', kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'close_expired_listing_t22',    kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'close_expired_listing_wns',    kind: 'delist', mintIdx: 4, sellerIdx: 0, listStateIdx: 2 },
  { name: 'close_expired_listing_core',   kind: 'delist', mintIdx: 1, sellerIdx: 3, listStateIdx: 0, collectionIdx: 2 },
];

function table(specs: Spec[]): Map<string, Spec> {
  const m = new Map<string, Spec>();
  for (const s of specs) m.set(anchorDisc(s.name).toString('hex'), s);
  return m;
}
const BY_PROGRAM: Record<string, { mp: 'ME' | 'TENSOR'; specs: Map<string, Spec> }> = {
  [ME_V2_PROGRAM]: { mp: 'ME',     specs: table(ME_SPECS) },
  [TCOMP_PROGRAM]: { mp: 'TENSOR', specs: table(TCOMP_SPECS) },
};

export const STREAM_PROGRAMS = Object.keys(BY_PROGRAM);

/** Log names of instructions that consume a listing in the same tx (instant
 *  sale / bid fill). A `sell` ix in such a tx is not a standing listing — the
 *  sales pipeline owns it. */
const SALE_LOG_RE = /Instruction: (\w*ExecuteSale\w*|Buy(Legacy|T22|Wns|Core|Spl)?|TakeBid\w*|BuyV2)$/;

export function txHasSale(logs: readonly string[]): boolean {
  return logs.some(l => SALE_LOG_RE.test(l));
}

function readU64(data: Uint8Array, off: number): number | null {
  if (data.length < off + 8) return null;
  const v = Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(off);
  return Number(v);
}

/** Non-SOL currency in the TComp arg tail (`Option<u64>` then `Option<Pubkey>`). */
function tcompHasCurrency(data: Uint8Array, off: number): boolean {
  let o = off;
  if (data.length <= o) return false;
  o += data[o] === 1 ? 9 : 1;            // expireInSec
  if (data.length <= o) return false;
  return data[o] === 1;                  // currency Some(...)
}

/**
 * Decode one instruction. `accounts` are the ix's account addresses (already
 * resolved from the tx's key table), `data` its raw bytes.
 */
export function decodeIx(programId: string, accounts: string[], data: Uint8Array): ListingAction | null {
  const prog = BY_PROGRAM[programId];
  if (!prog || data.length < 8) return null;
  const spec = prog.specs.get(Buffer.from(data.subarray(0, 8)).toString('hex'));
  if (!spec) return null;

  let price: number | null = null;
  if (spec.priceOff != null) {
    price = readU64(data, spec.priceOff);
    if (price == null) return null;
    if (spec.tcompCurrencyTail && tcompHasCurrency(data, spec.priceOff + 8)) return null;
  }
  const mint = spec.mintIdx != null ? accounts[spec.mintIdx] ?? null : null;
  const seller = accounts[spec.sellerIdx];
  if (!seller || (spec.mintIdx != null && !mint)) return null;
  return {
    kind:        spec.kind,
    marketplace: prog.mp,
    ix:          spec.name,
    mint,
    listState:   spec.listStateIdx != null ? accounts[spec.listStateIdx] ?? null : null,
    seller,
    priceLamports: price,
    collection:  spec.collectionIdx != null ? accounts[spec.collectionIdx] ?? null : null,
    auctionHouse: spec.ahIdx != null ? accounts[spec.ahIdx] ?? null : null,
    tokenAccount: spec.tokenAccountIdx != null ? accounts[spec.tokenAccountIdx] ?? null : null,
  };
}
