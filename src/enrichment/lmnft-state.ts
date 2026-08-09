/**
 * LaunchMyNFT on-chain collection-state decoder.
 *
 * Background: LMNFT's per-collection config account is owned by the
 * launchpad program (`F9Sixdq…`) and stores the URL `owner` pubkey,
 * the planned `max_items`, and a back-reference to the on-chain
 * Core collection asset (`collectionMint`).
 *
 * Byte layout — the FIRST fixed-offset version of this decoder
 * (owner@49, maxSupply@226, collMint@235, all hardcoded) was reverse
 * -engineered from a single fixture tx and shipped assuming those
 * offsets were universal. They aren't: three Borsh strings (symbol,
 * base URI, name) sit between the owner pubkey and maxSupply, and
 * their combined length varies per collection — so maxSupply/collMint
 * drift per collection (confirmed empirically: CATE's real maxSupply
 * sits at 219, not 226; collMint at 228, not 235). The fixed-offset
 * version silently returned null for any collection whose 3 strings
 * didn't sum to exactly the fixture's length — i.e. almost everything
 * except that one fixture — and cached the null for an hour, so
 * non-featured LMNFT drops (anything not on the homepage scrape in
 * `lmnft.ts`) never got a SUPPLY value at all.
 *
 *     ┌──────────────┬──────────────────────────────────────────┐
 *     │   0 …  7     │  Anchor discriminator (8 bytes)           │
 *     │   8 … 39     │  pubkey #1 (LMNFT-internal — unused)      │
 *     │  40 … 48     │  9 misc bytes (u8 + u64-ish)              │
 *     │  49 … 80     │  owner pubkey (32 bytes)                  │
 *     │  81          │  1 flag/version byte                      │
 *     │  82 …        │  symbol   — Borsh string (u32 len + utf8) │
 *     │      …       │  baseUri  — Borsh string (u32 len + utf8) │
 *     │      …       │  name     — Borsh string (u32 len + utf8) │
 *     │      … +32   │  pubkey #2 (creator — dupes owner so far) │
 *     │      … + 7   │  7 misc bytes (fixed-size, not variable)  │
 *     │      … + 4   │  maxSupply (u32 LE)                       │
 *     │      … + 4   │  mintedCount (u32 LE, see note below)     │
 *     │      … + 1   │  1 misc byte                              │
 *     │      … +32   │  collectionMint pubkey (32 bytes)         │
 *     │      …       │  remainder (URI / phases / fees)          │
 *     └──────────────┴──────────────────────────────────────────┘
 *
 * Everything from the flag byte through pubkey #2 and the 7 misc
 * bytes is walked dynamically (Borsh string = u32 LE length prefix +
 * utf8 bytes); only the tail from maxSupply onward is fixed-relative
 * to wherever that walk lands. `decodeState` still verifies the
 * decoded collectionMint against the caller-supplied address before
 * trusting the result, so a genuine future layout drift still fails
 * safe (returns null) instead of surfacing garbage.
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
 *   - decodes a collectionMint (at the dynamically-walked offset) that
 *     matches the parser-extracted collection address (i.e. proves we
 *     picked the right account, not a sibling LMNFT-owned record).
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

const OFF_OWNER            = 49;
const OFF_STRINGS_START    = 81;       // flag byte, then 3 Borsh strings
const GAP_AFTER_PUBKEY2    = 7;        // fixed-size misc bytes, not variable
const GAP_AFTER_MINTED     = 1;        // fixed-size misc byte before collMint

export interface LmntfState {
  owner:          string;
  maxSupply:      number | null;
  /** Running count of NFTs minted from this LMNFT collection. Decoded
   *  from the on-chain LMNFT state account at offset 230. Null when
   *  the value reads zero (genuinely no mints yet) or when it falls
   *  outside the sane [0, maxSupply] range (defensive — prefer no
   *  data over a wrong value). */
  mintedCount:    number | null;
  collectionMint: string;
}

// Map<collectionMint, LmntfState | null>. Null is also cached so a
// confirmed miss doesn't re-walk every mint.
const cache    = new TtlCache<string, LmntfState | null>(STATE_TTL_MS, SWEEP_MS);
const inflight = new Map<string, Promise<LmntfState | null>>();

function readPubkey(data: Buffer, off: number): string {
  return bs58.encode(data.subarray(off, off + 32));
}

/** Reads one Borsh string (u32 LE length prefix + utf8 bytes) at `off`.
 *  Returns the byte offset immediately after the string, or null if
 *  the length prefix or content would run past the buffer / exceeds a
 *  sane cap (guards against walking a mis-detected account into
 *  garbage lengths). */
function skipBorshString(data: Buffer, off: number): number | null {
  if (off + 4 > data.length) return null;
  const len = data.readUInt32LE(off);
  // 4 KB is generously above any real symbol/URI/name field this
  // account stores — anything larger means we've drifted into the
  // wrong account or a layout we don't understand.
  if (len > 4096) return null;
  const next = off + 4 + len;
  if (next > data.length) return null;
  return next;
}

function decodeState(data: Buffer): LmntfState | null {
  if (data.length < MIN_DATA_LEN) return null;
  try {
    const owner = readPubkey(data, OFF_OWNER);
    if (!owner) return null;

    // Walk: 1 flag byte, then 3 Borsh strings (symbol, baseUri, name),
    // then a second 32-byte pubkey, then a fixed misc-byte gap. Only
    // the strings vary in length per collection — everything else is
    // a fixed-size field, so their combined length is what shifts
    // maxSupply/collMint relative to the old hardcoded offsets.
    let off = OFF_STRINGS_START + 1;
    for (let i = 0; i < 3; i++) {
      const next = skipBorshString(data, off);
      if (next == null) return null;
      off = next;
    }
    off += 32; // pubkey #2 (creator — currently a dupe of owner)
    off += GAP_AFTER_PUBKEY2;

    if (off + 4 + 4 + GAP_AFTER_MINTED + 32 > data.length) return null;
    const maxSupplyRaw   = data.readUInt32LE(off);
    const mintedRaw      = data.readUInt32LE(off + 4);
    const collectionMint = readPubkey(data, off + 4 + 4 + GAP_AFTER_MINTED);
    if (!collectionMint) return null;

    const maxSupply = maxSupplyRaw > 0 ? maxSupplyRaw : null;
    // Sanity: mintedCount must be 0..maxSupply (inclusive). Outside
    // that range the offset assumption is wrong for this LMNFT
    // version — return null so the caller falls back to other
    // sources rather than displaying garbage.
    const mintedCount =
      mintedRaw > 0 && (maxSupply == null || mintedRaw <= maxSupply)
        ? mintedRaw
        : null;
    return {
      owner,
      maxSupply,
      mintedCount,
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
    const res = await fetch(`https://beta.helius-rpc.com/?api-key=${apiKey}`, {
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
