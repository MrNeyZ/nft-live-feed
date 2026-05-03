/**
 * LaunchMyNFT on-chain collection-state decoder.
 *
 * Background: LMNFT's per-collection config account is owned by the
 * launchpad program (`F9Sixdq…`) and stores the URL `owner` pubkey,
 * the planned `max_items`, and a back-reference to the on-chain
 * Core collection asset (`collectionMint`). Concrete byte layout
 * (verified against
 *   tx xtJv8g4TjtFPrcXkayEzzA4fVbgBkd8fo5qj2uYasZxxvMdMumZSTUengVwe7viKJjneaneyHG2es4nmF3g2Uke
 *   → state account CnyTvf5w21gecsEpVVSKAX7CQRB6GcRmzLaQ2g1BuUwV
 *   → owner       8gvC332K6aFHX71Cr4sQLDpUTH5CTmZY7D2d7YQ9oNMf @49
 *   → maxSupply   10000                                        @226 (u32 LE)
 *   → collMint    3MXKf3sjmrV75YkqKJqXmWUFMZA6fvntpT2bwrKvnVmh @235):
 *
 *     ┌──────────────┬──────────────────────────────────────┐
 *     │   0 …  7     │  Anchor discriminator (8 bytes)       │
 *     │   8 … 39     │  pubkey #1 (LMNFT-internal — unused)  │
 *     │  40 … 48     │  9 misc bytes (u8 + u64-ish)          │
 *     │  49 … 80     │  owner pubkey (32 bytes)              │
 *     │  81 …225     │  misc fields (string name, etc.)      │
 *     │ 226 …229     │  maxSupply (u32 LE)                   │
 *     │ 230 …234     │  5 misc bytes (likely current count)  │
 *     │ 235 …266     │  collectionMint pubkey (32 bytes)     │
 *     │ 267 …        │  remainder (URI / phases / fees)      │
 *     └──────────────┴──────────────────────────────────────┘
 *
 * NOTE: the Firestore `collectionId` (URL second segment, e.g.
 * `9MvDgIKXG2RgDBHmxpHi`) is NOT stored on-chain — it lives only in
 * LMNFT's Firebase. This decoder gets us `owner` + `maxSupply`; the
 * `collectionId` half of the URL still requires the homepage scraper
 * (`src/enrichment/lmnft.ts`).
 *
 * Discovery strategy: the LMNFT state PDA's position in a MintCore tx
 * varies across collection versions, so we don't hardcode an ix-account
 * index. Instead we walk every account the tx touched, fetch its info,
 * and pick the one that:
 *   - is owned by the LMNFT program;
 *   - has a plausible state-account length (≥ 267 bytes);
 *   - decodes a collectionMint at offset 235 that matches the
 *     parser-extracted collection address (i.e. proves we picked the
 *     right account, not a sibling LMNFT-owned record).
 *
 * Cached by collectionMint for 1 hour — only the FIRST mint per
 * collection costs a `getAccountInfo` RPC call; everything after
 * hits the cache.
 */

import bs58 from 'bs58';
import { TtlCache } from './cache';

const LMNFT_PROGRAM = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
const STATE_TTL_MS  = 60 * 60_000;     // 1 h — config rarely changes
const SWEEP_MS      = 5 * 60_000;
const MIN_DATA_LEN  = 267;             // owner+maxSupply+collMint all readable

const OFF_OWNER          = 49;
const OFF_MAX_SUPPLY_U32 = 226;
const OFF_COLLECTION_MINT= 235;

export interface LmntfState {
  owner:          string;
  maxSupply:      number | null;
  collectionMint: string;
}

// Map<collectionMint, LmntfState | null>. Null is also cached so a
// confirmed miss doesn't re-walk every mint.
const cache    = new TtlCache<string, LmntfState | null>(STATE_TTL_MS, SWEEP_MS);
const inflight = new Map<string, Promise<LmntfState | null>>();

function readPubkey(data: Buffer, off: number): string {
  return bs58.encode(data.subarray(off, off + 32));
}

function decodeState(data: Buffer): LmntfState | null {
  if (data.length < MIN_DATA_LEN) return null;
  try {
    const owner          = readPubkey(data, OFF_OWNER);
    const maxSupply      = data.readUInt32LE(OFF_MAX_SUPPLY_U32);
    const collectionMint = readPubkey(data, OFF_COLLECTION_MINT);
    if (!owner || !collectionMint) return null;
    return {
      owner,
      maxSupply: maxSupply > 0 ? maxSupply : null,
      collectionMint,
    };
  } catch {
    return null;
  }
}

interface AccountInfoValue {
  owner: string;
  data:  [string, string]; // [base64, encoding]
}
async function getAccountInfo(addr: string): Promise<AccountInfoValue | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 'lmnft-state',
        method:  'getAccountInfo',
        params:  [addr, { encoding: 'base64' }],
      }),
      signal:  AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { value: AccountInfoValue | null } };
    return json.result?.value ?? null;
  } catch {
    return null;
  }
}

/** Walk the tx's account universe, pick LMNFT-owned candidates, fetch
 *  + decode each. Returns the FIRST decoded state whose embedded
 *  collectionMint matches the parser-extracted collection address —
 *  validates we landed on the right account (LMNFT processes can
 *  touch sibling state records in the same tx). */
async function discover(
  collectionMint: string,
  candidateAddrs: readonly string[],
): Promise<LmntfState | null> {
  for (const addr of candidateAddrs) {
    // Skip obvious non-state accounts (programs, sysvars). We don't
    // hard-code an exhaustive skip list; the dataLen + LMNFT-owner
    // gates below are sufficient — the only cost of an extra
    // candidate is one HTTP call we'd otherwise avoid.
    const info = await getAccountInfo(addr);
    if (!info) continue;
    if (info.owner !== LMNFT_PROGRAM) continue;
    const data = Buffer.from(info.data[0], 'base64');
    if (data.length < MIN_DATA_LEN) continue;
    const decoded = decodeState(data);
    if (!decoded) continue;
    if (decoded.collectionMint !== collectionMint) continue;
    return decoded;
  }
  return null;
}

/** Public: resolve LMNFT state for a known collectionMint, given the
 *  set of candidate accounts that appeared in the originating
 *  MintCore tx. Cached + single-flight; subsequent mints in the same
 *  collection skip the RPC entirely. Returns null when:
 *    - no candidate is owned by LMNFT (collection is non-LMNFT);
 *    - decoded layout doesn't match (LMNFT version drift);
 *    - HELIUS_API_KEY is missing.
 *  Never throws. */
export async function getLmnftStateForCollection(
  collectionMint: string,
  candidateAddrs: readonly string[],
): Promise<LmntfState | null> {
  const hit = cache.get(collectionMint);
  if (hit !== undefined) return hit;
  const live = inflight.get(collectionMint);
  if (live) return live;
  const p = (async () => {
    try {
      const r = await discover(collectionMint, candidateAddrs);
      cache.set(collectionMint, r);
      return r;
    } finally {
      inflight.delete(collectionMint);
    }
  })();
  inflight.set(collectionMint, p);
  return p;
}
