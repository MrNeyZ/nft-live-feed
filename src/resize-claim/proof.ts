/**
 * Merkle-proof source for the "TM Resize" distribution.
 *
 * resize.metaplex.com never builds the 21.7M-leaf tree client-side — it
 * calls a single unauthenticated Next.js Server Action that returns, per
 * NFT mint, the fixed payout `amount` and the keccak merkle `proof`
 * (25 × 32-byte nodes). We proxy that exact call.
 *
 *   POST https://resize.metaplex.com/nft_resize
 *   Next-Action: 759ecd4a1cce4aa129ebcf598819afd80408c863
 *   Accept: text/x-component
 *   Content-Type: text/plain;charset=UTF-8
 *   body: [["<mint>", …]]                       (batch; UI uses 100)
 *
 *   → "1:[{ "mint": "...", "amount": "2324640", "index": 17364303,
 *           "proof": ["<b58 32-byte>", … 25] }, …]"
 *
 * Mints that are NOT leaves in the tree are silently omitted from the
 * response array. The proof is keyed by mint only and is stable
 * regardless of who holds the NFT or whether it has been claimed — a
 * returned proof does NOT imply "unclaimed" (that's a separate on-chain
 * ClaimReceipt check).
 *
 * This is a third-party endpoint with no SLA. At bot scale it can rate-
 * limit or block by IP; callers should batch, back off, and treat a miss
 * as "unknown", never as "ineligible".
 */

import { PublicKey } from '@solana/web3.js';

const PROOF_ENDPOINT = 'https://resize.metaplex.com/nft_resize';
const NEXT_ACTION_ID = '759ecd4a1cce4aa129ebcf598819afd80408c863';

const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
const REQUEST_TIMEOUT_MS = 20_000;

export interface ProofEntry {
  mint: string;
  /** Fixed payout in lamports (wSOL), as a string in the wire response. */
  amountLamports: string;
  /** Leaf index in the distribution tree. */
  index: number;
  /** 25 base58 32-byte merkle-proof nodes. */
  proof: string[];
}

interface RawProofEntry {
  mint?: unknown;
  amount?: unknown;
  index?: unknown;
  proof?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isValidBase58Pubkey(s: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Parse one RSC line ("1:[…]") into ProofEntry[]. Tolerates the leading
 *  "0:" flight-metadata line and any framing lines. */
function parseRscBody(body: string): ProofEntry[] {
  const out: ProofEntry[] = [];
  for (const line of body.split('\n')) {
    const m = /^\d+:(\[.*\])\s*$/.exec(line.trim());
    if (!m) continue;
    let arr: unknown;
    try {
      arr = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const looksLikeEntries = arr.every(
      (e) => e && typeof e === 'object' && 'proof' in (e as object) && 'mint' in (e as object),
    );
    if (!looksLikeEntries) continue;
    for (const raw of arr as RawProofEntry[]) {
      if (
        typeof raw.mint === 'string' &&
        Array.isArray(raw.proof) &&
        raw.proof.every((p): p is string => typeof p === 'string')
      ) {
        out.push({
          mint: raw.mint,
          amountLamports: String(raw.amount ?? ''),
          index: typeof raw.index === 'number' ? raw.index : -1,
          proof: raw.proof,
        });
      }
    }
    if (out.length) return out;
  }
  return out;
}

async function fetchProofBatch(mints: string[]): Promise<ProofEntry[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(PROOF_ENDPOINT, {
        method: 'POST',
        headers: {
          'Next-Action': NEXT_ACTION_ID,
          Accept: 'text/x-component',
          'Content-Type': 'text/plain;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (resize-claim-tool)',
          Origin: 'https://resize.metaplex.com',
          Referer: 'https://resize.metaplex.com/nft_resize',
        },
        body: JSON.stringify([mints]),
        signal: ctl.signal,
      });
      clearTimeout(tid);
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        lastErr = new Error(`proof endpoint http ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`proof endpoint http ${res.status}`);
      const text = await res.text();
      return parseRscBody(text);
    } catch (e) {
      clearTimeout(tid);
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('proof endpoint failed');
}

export interface FetchProofsResult {
  /** mint → proof entry, only for mints that are leaves in the tree. */
  byMint: Map<string, ProofEntry>;
  /** Batches that never returned after retries — treat these mints as
   *  "unknown", not "ineligible". */
  failedMints: string[];
}

/**
 * Batch-resolve proofs for a set of mints. Invalid pubkeys are dropped up
 * front. Batches are sequential (be a polite client to a third-party
 * endpoint); a permanently-failing batch is recorded in `failedMints`.
 */
export async function fetchProofs(mints: string[]): Promise<FetchProofsResult> {
  const clean = [...new Set(mints)].filter(isValidBase58Pubkey);
  const byMint = new Map<string, ProofEntry>();
  const failedMints: string[] = [];

  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE);
    try {
      const entries = await fetchProofBatch(batch);
      for (const e of entries) {
        // Only trust an entry whose proof nodes are all valid pubkeys.
        if (e.proof.length > 0 && e.proof.every(isValidBase58Pubkey)) {
          byMint.set(e.mint, e);
        }
      }
    } catch {
      failedMints.push(...batch);
    }
  }

  return { byMint, failedMints };
}
