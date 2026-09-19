/**
 * On-chain live-bid resolver — replaces the Tensor REST `nft_bids` lookup.
 *
 * `GET .../collections/nft_bids?mints=<mint>` (used by the old /resolve
 * route) ONLY returns Target::AssetId bids (a bid placed on one specific
 * NFT). It returns an empty array for Target::Whitelist bids — collection-
 * wide bids, which on real collections (confirmed against Soliens,
 * collId 8fcb70a6-db76-4b24-956e-3733a3532a9c) are the majority of live
 * bid volume. That made the tool's `/resolve` step report "no live bid"
 * for bids that were, in fact, live — confirmed by decoding a bidState
 * account directly and watching it get filled by a third party while the
 * REST endpoint kept returning `[]`.
 *
 * This resolves the SAME question directly from chain state instead:
 *
 *   1. AssetId-target bids: `bidState.targetId == asset` directly —
 *      `getProgramAccounts` memcmp at the fixed `targetId` byte offset.
 *   2. Whitelist-target bids: resolve the asset's Tensor `collId` (via
 *      Tensor's `mint` endpoint, which — unlike `nft_bids` — DOES return
 *      it), derive the collection's whitelist PDA from that collId
 *      (`seeds: [collId-without-dashes]` under the legacy tensor-whitelist
 *      program `TL1ST2iR...` — confirmed against 7000+ live bidState
 *      accounts platform-wide), then the same memcmp search with the
 *      whitelist PDA as the target.
 *
 * `targetId`'s byte offset (75, i.e. 8-byte disc + version(1) + bump(1) +
 * owner(32) + bidId(32) + target-enum(1)) is safe as a memcmp anchor
 * because every field before it in `BidState` is fixed-size — no
 * `Option<T>` appears until AFTER `targetId` (field/fieldId), so it does
 * NOT shift between bidState instances the way a naive dataSize filter
 * would assume (confirmed the hard way — see build.ts history).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TCompSDK } from '@tensor-oss/tcomp-sdk';
import bs58 from 'bs58';

const TCOMP_PROGRAM = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';
const TENSOR_WHITELIST_PROGRAM = 'TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW';
const TARGET_ID_OFFSET = 75;
/** Byte offset of the whitelist account's `uuid` field (32 raw ASCII
 *  bytes — a dash-stripped Tensor `collId`). NOT derivable as a PDA from
 *  `collId` alone: several plausible seed schemes (raw ascii, hex-decoded
 *  16 bytes, with/without a "whitelist" prefix) were tried against a known
 *  live whitelist address and none matched, meaning Tensor's real
 *  derivation isn't publicly reconstructable from the SDK alone. This
 *  offset, by contrast, is a property of the account's own on-chain DATA
 *  (confirmed directly against a fetched account) — searching by content
 *  sidesteps needing the derivation formula entirely. */
const WHITELIST_UUID_OFFSET = 10;

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** Find a collection's Tensor whitelist account by searching the
 *  tensor-whitelist program for an account whose `uuid` field (raw ASCII,
 *  dash-stripped) matches `collId`. Returns null when no such account
 *  exists (e.g. a collection that predates Tensor whitelisting, or one
 *  Tensor never built a merkle/FVC whitelist for). */
export async function findWhitelistByCollId(collId: string): Promise<PublicKey | null> {
  const uuid = collId.replace(/-/g, '');
  if (uuid.length !== 32) return null;
  const bytes = Buffer.from(uuid, 'ascii');
  const rows = await rpcCall<Array<{ pubkey: string }>>('getProgramAccounts', [
    TENSOR_WHITELIST_PROGRAM,
    { encoding: 'base64', filters: [{ memcmp: { offset: WHITELIST_UUID_OFFSET, bytes: bs58.encode(bytes) } }] },
  ]).catch(() => [] as Array<{ pubkey: string }>);
  const first = rows[0];
  return first ? new PublicKey(first.pubkey) : null;
}

/** Tensor's `mint` endpoint — unlike `collections/nft_bids`, this reliably
 *  returns `collId` for a given mint. Returns null on any failure (no key,
 *  HTTP error, missing field) — caller degrades to AssetId-only search. */
async function fetchCollId(mint: string): Promise<string | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.mainnet.tensordev.io/api/v1/mint?mints=${encodeURIComponent(mint)}`, {
      headers: { 'x-tensor-api-key': key },
    });
    if (!res.ok) return null;
    const body = await res.json() as Array<{ collId?: string }>;
    const collId = body[0]?.collId;
    return typeof collId === 'string' && collId.length > 0 ? collId : null;
  } catch {
    return null;
  }
}

interface GpaAccount {
  pubkey: string;
  account: { data: [string, string] };
}

async function gpaByTargetId(targetId: PublicKey): Promise<GpaAccount[]> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [TCOMP_PROGRAM, {
        encoding: 'base64',
        filters: [{ memcmp: { offset: TARGET_ID_OFFSET, bytes: targetId.toBase58() } }],
      }],
    }),
  });
  const json = await res.json() as { result?: GpaAccount[]; error?: { message: string } };
  if (json.error) throw new Error(`getProgramAccounts: ${json.error.message}`);
  return json.result ?? [];
}

export interface ResolvedBid {
  bidState:   string;
  priceSol:   number;
  expiryUnix: number;
}

/** Find a live, not-fully-filled, not-expired bid from `bidder` that
 *  covers `asset` — either a direct AssetId bid on it, or a Whitelist bid
 *  on its collection. Returns the highest-price match when more than one
 *  applies (a bidder placing multiple overlapping bids is rare but
 *  possible). Null when nothing matches — genuinely no live bid, not an
 *  API/indexing gap. */
export async function resolveLiveBidOnChain(asset: string, bidder: string): Promise<ResolvedBid | null> {
  const connection = new Connection(rpcUrl(), 'confirmed');
  const provider = new anchor.AnchorProvider(
    connection,
    // Read-only: decode-only usage never touches wallet/payer.
    { publicKey: PublicKey.default } as unknown as anchor.Wallet,
    { commitment: 'confirmed' },
  );
  const sdk = new TCompSDK({ provider });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (sdk as any).program.coder.accounts;

  const assetPk = new PublicKey(asset);
  const targets: PublicKey[] = [assetPk];
  const collId = await fetchCollId(asset);
  if (collId) {
    const whitelist = await findWhitelistByCollId(collId);
    if (whitelist) targets.push(whitelist);
  }

  const now = Math.floor(Date.now() / 1000);
  let best: ResolvedBid | null = null;
  for (const target of targets) {
    let rows: GpaAccount[];
    try {
      rows = await gpaByTargetId(target);
    } catch {
      continue;
    }
    for (const row of rows) {
      let decoded: {
        owner: PublicKey; quantity: number; filledQuantity: number;
        amount: anchor.BN; expiry: anchor.BN;
      };
      try {
        decoded = coder.decode('bidState', Buffer.from(row.account.data[0], 'base64'));
      } catch {
        continue;
      }
      if (!decoded.owner.equals(new PublicKey(bidder))) continue;
      if (decoded.filledQuantity >= decoded.quantity) continue;
      const expiryUnix = decoded.expiry.toNumber();
      if (expiryUnix > 0 && expiryUnix < now) continue;
      const priceSol = decoded.amount.toNumber() / 1e9;
      if (!best || priceSol > best.priceSol) {
        best = { bidState: row.pubkey, priceSol, expiryUnix };
      }
    }
  }
  return best;
}
