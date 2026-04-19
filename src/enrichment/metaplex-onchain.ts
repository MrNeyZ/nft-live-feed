/**
 * On-chain Metaplex token-metadata resolution.
 *
 * Pipeline:
 *   1. Derive the Metaplex metadata PDA (seeds: "metadata" + program_id + mint)
 *   2. Fetch account data via Helius RPC getAccountInfo
 *   3. Parse the borsh-encoded name + URI from the account buffer
 *   4. Fetch the off-chain URI JSON and extract name + image
 *
 * Works for standard SPL NFTs (legacy / pNFT).
 * Gracefully returns {} for Core / cNFT mints (no Metaplex PDA → account missing).
 *
 * Never throws.
 */

import { createHash } from 'crypto';
import bs58 from 'bs58';
import { NftMetadata } from './helius-das';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

// Ed25519 prime field modulus: 2^255 - 19
const P = (1n << 255n) - 19n;

// Edwards d coefficient: -121665/121666 mod P  (0x52036cee...978a3)
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

// ─── Ed25519 off-curve check ──────────────────────────────────────────────────

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) r = r * base % mod;
    base = base * base % mod;
    exp >>= 1n;
  }
  return r;
}

/**
 * Returns true if `bytes` decodes to a valid compressed point on Ed25519.
 * Used to reject hashes that are on the curve (which would be invalid PDAs).
 */
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes);
  const signX = (buf[31] >> 7) & 1;
  buf[31] &= 0x7f;

  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(buf[i]);

  if (y >= P) return false;

  const y2 = y * y % P;
  const u  = (y2 - 1n + P) % P;      // y² - 1
  const v  = (D * y2 % P + 1n) % P;  // d·y² + 1

  if (v === 0n) return u === 0n;

  const x2 = u * modPow(v, P - 2n, P) % P;

  if (x2 === 0n) return signX === 0;

  // Quadratic residue check: x² ^ ((p-1)/2) === 1 iff x² has a square root
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

/** Mirrors Solana's `create_program_address` for a single nonce. */
function createProgramAddress(seeds: Buffer[], programId: Buffer, nonce: number): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([...seeds, Buffer.from([nonce]), programId, Buffer.from('ProgramDerivedAddress')]))
    .digest();
}

/** Derives the Metaplex metadata PDA for `mint`. Tries nonce 255 → 0. */
function deriveMetadataPda(mint: string): string {
  const programIdBytes = Buffer.from(bs58.decode(TOKEN_METADATA_PROGRAM));
  const mintBytes      = Buffer.from(bs58.decode(mint));
  const seeds          = [Buffer.from('metadata'), programIdBytes, mintBytes];

  for (let nonce = 255; nonce >= 0; nonce--) {
    const hash = createProgramAddress(seeds, programIdBytes, nonce);
    if (!isOnEd25519Curve(hash)) return bs58.encode(hash);
  }
  throw new Error('Could not derive metadata PDA');
}

// ─── Borsh parsing ────────────────────────────────────────────────────────────

/**
 * Parses name and URI from a raw Metaplex MetadataV1 account buffer.
 *
 * On-chain layout uses fixed-size allocations (null-padded) per field:
 *   1  byte  key (must be 4 = MetadataV1)
 *   32 bytes update_authority
 *   32 bytes mint
 *   4 + 32   name   (u32-LE length prefix + 32-byte allocation)
 *   4 + 10   symbol (u32-LE length prefix + 10-byte allocation)
 *   4 + 200  uri    (u32-LE length prefix + 200-byte allocation)
 */
function parseMetadataAccount(data: Buffer): { name: string; uri: string } | null {
  try {
    if (data.length < 1 || data[0] !== 4) return null;  // must be MetadataV1

    let off = 1 + 32 + 32;  // key + update_authority + mint

    const nameLen = data.readUInt32LE(off); off += 4;
    const name    = data.subarray(off, off + nameLen).toString('utf8').replace(/\0/g, '').trim();
    off += 32;  // skip rest of name allocation

    off += 4 + 10;  // skip symbol (len prefix + allocation)

    const uriLen = data.readUInt32LE(off); off += 4;
    const uri    = data.subarray(off, off + uriLen).toString('utf8').replace(/\0/g, '').trim();

    if (!uri) return null;
    return { name, uri };
  } catch {
    return null;
  }
}

// ─── URI normalisation ────────────────────────────────────────────────────────

/** Converts IPFS / Arweave shorthand URIs to fetchable HTTPS URLs. */
function normaliseUri(uri: string): string {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (uri.startsWith('ar://'))   return `https://arweave.net/${uri.slice(5)}`;
  return uri;
}

// ─── Image extraction ─────────────────────────────────────────────────────────

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i;

function isImageUri(uri: string | undefined): uri is string {
  return !!uri && IMAGE_EXTS.test(uri);
}

/** .avif images fail to render in most browsers/clients — swap to .png. */
function avifToPng(uri: string | null): string | null {
  return uri?.replace(/\.avif(\?.*)?$/i, '.png$1') ?? null;
}

/**
 * Extracts the best image URL from a Metaplex off-chain metadata JSON.
 *
 * Priority:
 *   1. `image`                           — standard field, always preferred
 *   2. `properties.files[0].uri`         — first file when image absent
 *   3. first file URI with image MIME or image extension
 *   4. `animation_url`                   — only when it is clearly an image file
 */
function extractImage(meta: {
  image?:          string;
  animation_url?:  string;
  properties?: { files?: Array<{ uri?: string; type?: string }> };
}): string | null {
  if (meta.image) return meta.image;

  const files = meta.properties?.files ?? [];

  // First file's URI regardless of type (most collections put the main image here)
  const first = files[0]?.uri;
  if (first) return first;

  // First file that is explicitly an image MIME or has an image extension
  for (const f of files) {
    if (!f.uri) continue;
    if (f.type?.startsWith('image/') || isImageUri(f.uri)) return f.uri;
  }

  // animation_url only when the extension confirms it is a static image
  if (isImageUri(meta.animation_url)) return meta.animation_url;

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolves NFT name + image via on-chain Metaplex metadata.
 *
 * Returns an empty partial `{}` on any failure (missing account, parse error,
 * unreachable URI, etc.) so callers can always treat the result as optional.
 */
export async function getMetaplexOnchainMetadata(
  mint: string,
): Promise<Partial<Pick<NftMetadata, 'nftName' | 'imageUrl'>>> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return {};

  try {
    const pda = deriveMetadataPda(mint);

    // ── 1. Fetch metadata account ───────────────────────────────────────────
    const rpcRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      'meta-pda',
        method:  'getAccountInfo',
        params:  [pda, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!rpcRes.ok) throw new Error(`getAccountInfo HTTP ${rpcRes.status}`);

    const rpcJson = await rpcRes.json() as {
      result?: { value?: { data?: [string, string] } };
    };
    const dataB64 = rpcJson.result?.value?.data?.[0];
    if (!dataB64) throw new Error('account not found');

    // ── 2. Parse borsh ──────────────────────────────────────────────────────
    const parsed = parseMetadataAccount(Buffer.from(dataB64, 'base64'));
    if (!parsed) throw new Error('failed to parse metadata account');

    const { name, uri } = parsed;
    if (!uri) throw new Error('empty URI');

    // ── 3. Fetch off-chain JSON ─────────────────────────────────────────────
    const metaRes = await fetch(normaliseUri(uri), {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!metaRes.ok) throw new Error(`URI fetch HTTP ${metaRes.status}`);

    const meta = await metaRes.json() as {
      name?:           string;
      image?:          string;
      animation_url?:  string;
      properties?: {
        files?: Array<{ uri?: string; type?: string }>;
      };
    };

    return {
      nftName:  meta.name ?? (name || null),
      imageUrl: avifToPng(extractImage(meta)),
    };
  } catch (err) {
    console.warn(`[enrich] on-chain meta failed ${mint.slice(0, 8)}...: ${(err as Error).message}`);
    return {};
  }
}
