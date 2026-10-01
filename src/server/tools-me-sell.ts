/**
 * Magic Eden item-level offer ACCEPT tool — personal use only, not a public
 * feature. Counterpart to tools-me-bids.ts (which only ever places/cancels/
 * withdraws OUR OWN bids). This router does the opposite side: given an
 * existing personal offer someone else placed on an NFT we hold (or are
 * about to buy), builds+submits the SELL/ExecuteSaleV2 transaction that
 * accepts it. Discovery/scanning for such offers is a SEPARATE tool's job —
 * this router only ever consumes an already-identified (mint, buyer,
 * auctionHouse, price) tuple, exactly the shape ME's own
 * offers_received/offers_made API returns.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM tools-me-bids.ts ───────────────────────
 *
 * Every op in tools-me-bids.ts (buy/buy_change_price/buy_cancel/withdraw) is
 * confirmed to have exactly ONE required signer (the buyer), no ME cosigner
 * — see that file's header. SELL is structurally different: a real on-chain
 * ExecuteSaleV2 always carries TWO signatures (the seller AND a Magic Eden
 * hot-wallet cosigner — confirmed 2026-08-24 by decoding two real settled
 * accept-offer txs; the cosigner pubkey holds tens of thousands of SOL and
 * appears identically across unrelated trades, i.e. a fixed ME authority,
 * not a per-user PDA). tools-me-bids.ts's validateStructure/submit hard-code
 * the 1-signer contract throughout (digest cache ctx kind, signature-count
 * checks) — bolting a 2-signer case onto that would weaken checks that
 * currently hold real money-moving logic. A parallel, independently
 * reasoned validator for the 2-signer shape is safer than a shared branch.
 *
 * ── THE KEY OPEN QUESTION THIS FILE SURFACES, NOT ASSUMES ──────────────────
 *
 * Does `GET /instructions/sell` (called server-side with our own paid
 * ME_API_KEY, exactly like tools-me-bids.ts already does for buy/cancel/
 * withdraw) come back with ME's cosigner slot ALREADY signed? Confirmed only
 * that the endpoint is real and reachable this way (a live call against a
 * genuinely dead/underfunded offer returned a structured
 * `{"err":"failed to generate sell instruction"}` — past auth/rate-limit,
 * real business logic). Whether the cosign comes pre-filled has NOT been
 * confirmed against a real fundable offer yet. buildAccept() below decodes
 * whatever comes back and reports the signature state explicitly rather
 * than assuming either way — `needsBridge: true` in the response means the
 * cosigner slot came back empty and this backend-only path cannot complete
 * the trade (would need a browser-session bridge akin to the MMM
 * Tampermonkey bridge, not yet built here).
 *
 * ── SAFETY MODEL (mirrors tools-me-bids.ts) ─────────────────────────────────
 *
 *   GET  /api/tools/me-sell/resolve-offer?mint=&buyer=
 *        — resolves (price, auctionHouse) for a (mint, buyer) pair via ME's
 *          public offers_made index, so the frontend only needs 2 fields.
 *   GET  /api/tools/me-sell/order-info?mint=&buyer=&auctionHouseAddress=&priceSol=
 *        — pure reads (on-chain escrow balance + DAS royalty bp), no ME
 *          instruction call, no wallet, no signing.
 *   GET  /api/tools/me-sell/build-topup?escrowPda=&fromWallet=&lamports=
 *        — unsigned SystemProgram.transfer, single signer (the caller's own
 *          wallet), no cosign involved. Not security-sensitive beyond
 *          "wallet signs its own transfer" — Phantom is the trust boundary.
 *   POST /api/tools/me-sell/build-accept — { seller, tokenMint, priceSol,
 *          auctionHouseAddress, buyer, sellerReferral? }
 *   POST /api/tools/me-sell/simulate     — { tx: base64 }
 *   POST /api/tools/me-sell/submit       — { signedTx: base64, digest }
 *   POST /api/tools/me-sell/submit-bridge — { signedTx, seller, tokenMint,
 *        auctionHouseAddress, buyer } — for a tx obtained via the
 *        Tampermonkey bridge (real browser session) instead of build-accept;
 *        no prior digest exists, so this validates structurally + verifies
 *        signatures fresh instead of comparing against a build-time snapshot.
 *
 * Same digest-binding / blockhash-freshness / cryptographic-signature-
 * verification chain as tools-me-bids.ts (imports the shared, already-
 * reviewed primitives directly rather than re-deriving them). Gated by the
 * SAME ME_BIDS_ENABLE_LIVE env var — one "operator live trading" switch for
 * both directions, not two independent ones to keep in sync.
 *
 * Every route requires auth (site-wide SIWS + UI_ALLOWED_WALLETS gate). This
 * process never handles a private key: build-accept only ever returns an
 * UNSIGNED (seller slot) tx for the operator's own wallet to sign client-
 * side via Phantom; /submit only ever accepts already-signed bytes.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import bs58 from 'bs58';
import {
  PublicKey, Connection, Transaction, SystemProgram, type VersionedTransaction, type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { meAuthHeaders, hasMeApiKey, setMeCooldown } from '../me-api-cooldown';
import { meTradeCooldownActive, setMeTradeCooldown } from './me-trade-cooldown';
import { deriveBuyerEscrowPda, lamportsToSol } from './me-bid-escrow';

// order-info is called interactively for ONE offer at a time (never a bulk
// scan), right after the user may have just topped up the escrow — the
// shared resolveEscrowBalances() in me-bid-escrow.ts carries a 60s
// in-memory cache built for bulk scanning, which would keep reporting the
// pre-topup balance for up to a minute here. Always read this one account
// fresh instead.
async function fetchEscrowBalanceFresh(escrowPda: string): Promise<number> {
  try {
    const r = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [escrowPda, { commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return 0;
    const j = await r.json() as { result?: { value?: number } };
    return j.result?.value ?? 0;
  } catch { return 0; }
}
import {
  MeApiError, type MeHttpTransport, type MeApiKeyProvider,
  decodeLegacyTxFromBytes, decodeLegacyTxFromBase64, messageHashHex,
  checkBlockhashFreshness, type BlockhashInfo, type ChainClient,
} from './tools-me-bids';
import {
  TX_WIRE_LIMIT, decodeVersionedTxFromBytes, decodeVersionedTxFromBase64,
  versionedMessageHashHex, toAuditableTx, verifyVersionedSignatures,
} from './me-sell-vtx';
import {
  auditMeSellTransaction, SUPPORTED_STANDARDS,
  type FrozenMeSellIntent, type MeSellStandard,
} from './me-sell-auditor';
import {
  type BundleAux, buildAuxTxs, unsignedB64, checkSignedAux, combineForSim, sendJitoBundle,
  MAX_ESCROW_LEFTOVER_LAMPORTS, JITO_TIP_LAMPORTS,
} from './me-sell-bundle';
const bs58Encode = (b: Uint8Array | Buffer): string => bs58.encode(b);

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 10_000;
const ME_FEE_BP = 200; // confirmed 2026-08-11 (see project_me_ah_accept_offer_seller_covers_fee memory)

/** No response ever echoes a raw error back to the client for a genuinely
 *  UNEXPECTED failure — detail stays server-side in the log, the client
 *  gets a stable, generic string (same pattern already applied to
 *  GhostBid's tools-ghostbid.ts and Resize Claim's tools-resize-claim.ts —
 *  this is the third occurrence of this gap, per the 2026-09-12 audit's
 *  MS-9). Deliberate, typed, already-classified errors (MeApiError, the
 *  auditor's own named rejection reasons, malformed-input 400s) are NOT
 *  routed through this — only the "something we didn't anticipate threw"
 *  catch-alls are. */
function toClientError(err: unknown, tag: string): string {
  console.error(`[me-sell/${tag}]`, err);
  return 'internal_error';
}

/** Exact decimal SOL -> lamports, with NO floating-point multiplication
 *  (MS-2's "freeze price as integer lamports" requirement). `toFixed(9)` is
 *  a lossless string operation — SOL's own definition is exactly 9 decimal
 *  places (1 lamport) — unlike `Math.round(priceSol * 1e9)`, which performs
 *  a real floating-point multiply before rounding and was the tool's prior
 *  (display-only-safe, but never meant to be an authorization primitive)
 *  conversion. `priceSol` here is never operator-typed (this UI has no
 *  price input box — see the audit's §28 finding) — it always originates
 *  from ME's own `offers_made` response, so no free-text decimal-string
 *  parser (exponents, commas, etc.) is needed; `Number.isFinite`+`>0`
 *  (`parsePriceSol`) already guards the one real input shape (a JSON
 *  number) before this ever runs. */
export function solToExactLamports(priceSol: number): string {
  const fixed = priceSol.toFixed(9);
  const [whole, frac] = fixed.split('.');
  return BigInt(whole + frac).toString();
}

function liveEnabledFromEnv(): boolean {
  return (process.env.ME_BIDS_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}
const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.ME_BIDS_BLOCKHASH_MARGIN_BLOCKS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BLOCKHASH_MARGIN_BLOCKS;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// ── ME instructions/sell client (mirrors tools-me-bids.ts's createMeGet,
//    duplicated locally — each tools-*.ts file in this codebase owns its
//    own small transport/rpcUrl helpers rather than sharing a mega-module;
//    see tools-mmm-pools.ts for the same pattern) ──────────────────────────

function parseMeErrorBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { err?: unknown; message?: unknown };
    if (typeof b.err === 'string') return b.err;
    if (Array.isArray(b.err)) {
      return b.err.map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : JSON.stringify(e))).join('; ');
    }
    if (typeof b.message === 'string') return b.message;
  }
  return 'unknown_me_error';
}

function defaultMeHttpTransport(authHeaders: () => Record<string, string>): MeHttpTransport {
  return async (path: string) => {
    const res = await fetch(`${ME_API_BASE}${path}`, {
      headers: { ...authHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
}
function defaultMeApiKeyProvider(): MeApiKeyProvider {
  return {
    hasKey: hasMeApiKey,
    authHeaders: meAuthHeaders,
    // Trade-scoped cooldown only — see me-trade-cooldown.ts. A background
    // ME consumer (mmm-pool-type resolver, enrichment, me-stats) hitting a
    // 429 must NOT make this hand-driven accept-offer flow refuse with
    // me_api_cooldown_active before it tries its own request.
    cooldownActive: meTradeCooldownActive,
    setCooldown: (ms?: number) => { setMeTradeCooldown(ms); setMeCooldown(ms); },
  };
}
function createMeGet(transport: MeHttpTransport, keys: MeApiKeyProvider) {
  return async function meGet<T>(path: string): Promise<T> {
    if (!keys.hasKey()) throw new MeApiError(503, 'me_api_key_not_configured');
    if (keys.cooldownActive()) throw new MeApiError(429, 'me_api_cooldown_active');
    let res: { status: number; text: string };
    try { res = await transport(path); }
    catch (err) {
      // MS-9: the underlying transport failure (DNS/TLS/connection-reset/…)
      // is genuinely unexpected infra detail, not a deliberate ME-classified
      // error — log it, don't interpolate it into the client-facing message
      // the way this used to (contrast `parseMeErrorBody` below, which
      // stays untouched: that's ME's OWN structured `{err: "..."}` JSON
      // body, a deliberate upstream classification, not our own exception).
      console.error('[me-sell/me-transport]', err);
      throw new MeApiError(504, 'me_api_unreachable');
    }
    if (res.status === 429) { keys.setCooldown(); throw new MeApiError(429, 'me_api_rate_limited'); }
    let json: unknown;
    try { json = JSON.parse(res.text); } catch { json = null; }
    if (res.status < 200 || res.status >= 300) throw new MeApiError(res.status, parseMeErrorBody(json));
    if (json === null) throw new MeApiError(502, 'me_response_not_json');
    return json as T;
  };
}

/** Extends the shared `ChainClient` (tools-me-bids.ts) with exact-signature
 *  status reads — added HERE, not on the shared interface, so
 *  tools-me-bids.ts (and its own test suite) are completely untouched by
 *  this hardening pass. */
export interface MeSellSignatureStatus { confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null; err: unknown }
export interface MeSellChainClient extends ChainClient {
  getSignatureStatuses(signatures: string[]): Promise<Array<MeSellSignatureStatus | null>>;
  /** Versioned (v0) path — used only when ME's legacy tx exceeds the wire
   *  limit and its own v0 variant is taken instead. Optional so existing
   *  test doubles keep compiling; the routes answer 501 when absent. */
  simulateVersionedTransaction?(vtx: VersionedTransaction): Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null }>;
  sendRawBytes?(raw: Buffer): Promise<string>;
  getAddressLookupTable?(key: PublicKey): Promise<AddressLookupTableAccount | null>;
  /** Top-up bundle path only. Throws on RPC failure (never "0"). */
  getBalanceStrict?(key: PublicKey): Promise<number>;
  /** sigVerify:false simulation returning post-sim lamports of `addresses`. */
  simulateWithBalances?(vtx: VersionedTransaction, addresses: PublicKey[]): Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null; lamports: Array<number | null> }>;
}

function defaultChainClient(conn: Connection): MeSellChainClient {
  return {
    async simulateTransaction(tx: Transaction, includeAccounts?: PublicKey[]) {
      const sim = await conn.simulateTransaction(tx, undefined, includeAccounts);
      return {
        err: sim.value.err, logs: sim.value.logs ?? [],
        accounts: sim.value.accounts ?? null, unitsConsumed: sim.value.unitsConsumed ?? null,
      };
    },
    getBlockHeight: () => conn.getBlockHeight(),
    sendRawTransaction: (tx: Transaction) => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
    async getSignatureStatuses(signatures: string[]) {
      const res = await conn.getSignatureStatuses(signatures, { searchTransactionHistory: true });
      return res.value.map((v) => (v ? { confirmationStatus: v.confirmationStatus ?? null, err: v.err ?? null } : null));
    },
    async simulateVersionedTransaction(vtx: VersionedTransaction) {
      const sim = await conn.simulateTransaction(vtx, { sigVerify: false, commitment: 'confirmed' });
      return { err: sim.value.err, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed ?? null };
    },
    sendRawBytes: (raw: Buffer) => conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }),
    async getAddressLookupTable(key: PublicKey) { return (await conn.getAddressLookupTable(key)).value; },
    getBalanceStrict: (key: PublicKey) => conn.getBalance(key, 'confirmed'),
    async simulateWithBalances(vtx: VersionedTransaction, addresses: PublicKey[]) {
      const sim = await conn.simulateTransaction(vtx, {
        sigVerify: false, commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: addresses.map((a) => a.toBase58()) },
      });
      return {
        err: sim.value.err, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed ?? null,
        lamports: (sim.value.accounts ?? []).map((a) => (a ? a.lamports : null)),
      };
    },
  };
}

// ── Royalty lookup — Helius DAS getAsset, royalty.basis_points ─────────────
//
// `royalty.basis_points` is the CREATOR-DECLARED metadata value — it exists
// regardless of token standard. It is only actually enforced on-chain for
// pNFTs (Token Metadata's ruleset engine, `interface: "ProgrammableNFT"`).
// Legacy NFTs (`interface: "V1_NFT"`, the vast majority of older
// collections) have zero on-chain mechanism to require royalty payment —
// declaring 500bp in metadata does not make ExecuteSaleV2 charge it.
// Confirmed empirically: a legacy V1_NFT sale (Golem #4904, sig
// KP3Scy1C…CtRc) landed with `"royalty":0` in the program log despite DAS
// reporting royalty.basis_points=500 for that exact mint. Before this fix,
// order-info trusted the declared bp unconditionally, telling sellers to
// top up royalty that was never going to be charged — real SOL sent to the
// buyer's escrow, never consumed by the sale, unrecoverable by the seller.
async function fetchRoyaltyBp(mint: string): Promise<number | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j = await r.json() as {
      result?: {
        interface?: string;
        royalty?: { basis_points?: number };
        content?: { metadata?: { name?: string }; links?: { image?: string } };
      };
    };
    if (j.result?.interface !== 'ProgrammableNFT') return 0;
    return typeof j.result?.royalty?.basis_points === 'number' ? j.result.royalty.basis_points : null;
  } catch { return null; }
}

// ── Explicit supported-standard gate (MS-6) ────────────────────────────────
//
// The prior code had no standard check at all — it unconditionally assumed
// legacy SPL Token-account derivation, which is meaningless for an MPL Core
// asset (no ATA exists) and incomplete for a pNFT (no ruleset/token-record
// awareness). Real evidence gathered during this hardening pass (see
// me-sell-auditor.ts's header) PROVED pNFT and MPL Core accept-offer
// bundles both work — `interface: "ProgrammableNFT"` and
// `interface: "MplCoreAsset"` (confirmed live against a real Core asset
// this session) map to the two allowed standards. Everything else
// (`V1_NFT`/legacy, cNFT, Token-2022, SFT, or an unrecognized future
// interface value) returns `null` — fails CLOSED, not routed by collection
// name/symbol, per the spec's own instruction. No real evidence of a
// working legacy accept-offer bundle was found despite scanning ~9,000
// recent M2 signatures — legacy is deliberately NOT allowed until that
// evidence exists (a real, intentional behavior change — see the
// hardening report).
/** Pure, independently testable — the actual DAS fetch below is not
 *  injectable (same pre-existing, uninjectable-`fetch` pattern this file
 *  already uses for `fetchRoyaltyBp`/`fetchNftDisplay`/`fetchEscrowBalanceFresh`;
 *  not changed here), but the mapping this decision actually rests on is. */
function isSupportedStandard(s: unknown): s is MeSellStandard {
  return SUPPORTED_STANDARDS.includes(s as MeSellStandard);
}

export function mapDasInterfaceToStandard(iface: string | undefined): MeSellStandard | null {
  if (iface === 'ProgrammableNFT') return 'pnft';
  if (iface === 'MplCoreAsset') return 'mplCore';
  if (iface === 'V1_NFT' || iface === 'Legacy_NFT') return 'legacy';
  return null;
}

async function fetchNftStandard(mint: string): Promise<MeSellStandard | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j = await r.json() as { result?: { interface?: string } };
    return mapDasInterfaceToStandard(j.result?.interface);
  } catch { return null; }
}

/** All creator addresses from the NFT's own metadata (DAS `creators`,
 *  zero-share ones included) — the pNFT ExecuteSaleV2 auditor derives the
 *  expected account count from this (27 + creators.length). null = lookup
 *  failed -> the auditor falls back to its fixed count, which fails closed
 *  for any NFT whose real count differs. */
async function fetchNftCreators(mint: string): Promise<string[] | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j = await r.json() as { result?: { creators?: Array<{ address?: string }> } };
    const list = j.result?.creators;
    if (!Array.isArray(list)) return null;
    const out = list.map((c) => c.address).filter((a): a is string => typeof a === 'string' && isValidPubkeyString(a));
    return out.length === list.length ? out : null;
  } catch { return null; }
}
function isValidPubkeyString(a: string): boolean {
  try { new PublicKey(a); return true; } catch { return false; }
}

async function fetchNftDisplay(mint: string): Promise<{ name: string | null; image: string | null }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { name: null, image: null };
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return { name: null, image: null };
    const j = await r.json() as { result?: { content?: { metadata?: { name?: string }; links?: { image?: string } } } };
    return {
      name: j.result?.content?.metadata?.name ?? null,
      image: j.result?.content?.links?.image ?? null,
    };
  } catch { return { name: null, image: null }; }
}

// ── Input validation ────────────────────────────────────────────────────

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}
function parsePriceSol(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
function parseLamports(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// ── Offer resolution — given (mint, buyer), find the matching offer's
//    price/auctionHouse via ME's own offers_made index (public endpoint,
//    same shape confirmed live 2026-08-24). Lets the frontend ask for just
//    two fields instead of four — the caller still has to know WHICH buyer
//    made the offer (that's the discovery tool's job, out of scope here),
//    but doesn't have to also carry price/auctionHouse by hand. ──────────

interface MeOfferMade {
  pdaAddress?: string; tokenMint?: string; auctionHouse?: string;
  buyer?: string; price?: number; tokenSize?: number; expiry?: number;
}

async function resolveOfferForMint(
  meGet: <T>(path: string) => Promise<T>, mint: string, buyer: string,
): Promise<MeOfferMade | null> {
  const offers = await meGet<MeOfferMade[]>(`/wallets/${encodeURIComponent(buyer)}/offers_made?limit=500`);
  if (!Array.isArray(offers)) return null;
  return offers.find((o) => o.tokenMint === mint) ?? null;
}

// ── canonical structural + exact-price auditor (see me-sell-auditor.ts) ──
//
// Every path that ever hands bytes to Phantom or broadcasts them —
// build-accept, the bridge pre-sign check, submit, submit-bridge — calls
// THIS one function. There is no separate, subtly-different validator per
// path (that was the old design's real gap: build-accept and submit-bridge
// each had their own hand-rolled presence-only checks, and price was never
// checked anywhere — see docs/me-sell-audit-2026-09-12.md MS-1/MS-2).

export interface ValidatedSellTx {
  tx: Transaction;
  messageHash: string;
  cosignerPubkey: string;
  cosignPrefilled: boolean;
}

/** Thin wrapper around `auditMeSellTransaction`: converts its
 *  ok/reason result into the same throw-on-failure contract every call
 *  site already expects, and additionally reports the cosigner slot's
 *  identity/fill state (which the canonical auditor itself doesn't need to
 *  know, but every caller here does). */
export function validateSellStructure(
  tx: Transaction, intent: FrozenMeSellIntent, expectSellerSignature: 'absent' | 'present',
): ValidatedSellTx {
  const audited = auditMeSellTransaction(tx, intent, expectSellerSignature);
  if (!audited.ok) throw new Error(audited.reason);

  const otherEntry = tx.signatures.find((s) => s.publicKey.toBase58() !== intent.seller)!;
  return {
    tx,
    messageHash: messageHashHex(tx),
    cosignerPubkey: otherEntry.publicKey.toBase58(),
    cosignPrefilled: otherEntry.signature != null,
  };
}

// ── Digest cache — same shape/TTL/eviction policy as tools-me-bids.ts,
//    intentionally duplicated (separate router instance, separate cache) ──

interface DigestEntry {
  intent: FrozenMeSellIntent;
  blockhashInfo: BlockhashInfo;
  expiresAt: number;
  /** 0 = ME's v0 variant (used when the legacy tx exceeds the wire limit);
   *  absent = the original legacy `Transaction` flow, unchanged. */
  txVersion?: 0;
  /** Present only for an atomic top-up + accept Jito bundle build. */
  bundle?: BundleAux;
}
const DIGEST_TTL_MS = 5 * 60_000;
const DIGEST_CACHE_MAX = 500;
const DIGEST_SWEEP_INTERVAL_MS = 60_000;

class DigestCache {
  private map = new Map<string, DigestEntry>();
  constructor(private now: () => number) {}
  set(digest: string, entry: DigestEntry): void { this.cleanup(); this.map.set(digest, entry); this.cleanup(); }
  get(digest: string): DigestEntry | undefined { return this.map.get(digest); }
  consume(digest: string): DigestEntry | undefined {
    const entry = this.map.get(digest);
    if (entry) this.map.delete(digest);
    return entry;
  }
  get size(): number { return this.map.size; }
  cleanup(): void {
    const now = this.now();
    for (const [k, v] of this.map) if (v.expiresAt < now) this.map.delete(k);
    if (this.map.size > DIGEST_CACHE_MAX) {
      let toDrop = this.map.size - DIGEST_CACHE_MAX;
      for (const k of this.map.keys()) { if (toDrop-- <= 0) break; this.map.delete(k); }
    }
  }
}

function bundleResponse(b: { aux: BundleAux; topupB64: string; tipB64: string; sim: { unitsConsumed: number | null; leftoverLamports: number } }) {
  return {
    bundle: {
      topupTxBase64: b.topupB64, tipTxBase64: b.tipB64,
      escrowPda: b.aux.escrowPda, escrowLamports: b.aux.escrowLamportsAtBuild,
      topupLamports: b.aux.topupLamports, tipLamports: b.aux.tipLamports,
      simUnitsConsumed: b.sim.unitsConsumed, simEscrowLeftoverLamports: b.sim.leftoverLamports,
    },
  };
}

// ── Router ───────────────────────────────────────────────────────────────

export interface MeSellDeps {
  meTransport?: MeHttpTransport;
  meApiKeyProvider?: MeApiKeyProvider;
  chain?: MeSellChainClient;
  now?: () => number;
  authMiddleware?: RequestHandler;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  rateLimitsDisabled?: boolean;
  /** Overrides the real Helius DAS standard lookup — injectable (unlike
   *  the pre-existing royalty/display/escrow fetch helpers, left as-is)
   *  because this is new code from the 2026-09-12 hardening pass and needs
   *  a real, network-free regression test. */
  fetchStandard?: (mint: string) => Promise<MeSellStandard | null>;
  /** Overrides the DAS creators lookup (pNFT auditor account count). */
  fetchCreators?: (mint: string) => Promise<string[] | null>;
  /** Top-up bundle path: royalty guess + Jito transport (tests stub both). */
  fetchRoyaltyBp?: (mint: string) => Promise<number | null>;
  sendBundle?: (txsB64: string[]) => Promise<{ bundleId: string; accepted: number; errors: string[] }>;
}
export interface MeSellTestHooks {
  digestCacheSize: () => number;
  sweepTimer: ReturnType<typeof setInterval>;
}

export function createMeSellRouter(deps: MeSellDeps = {}): Router & { __meSellTestHooks?: MeSellTestHooks } {
  const keys = deps.meApiKeyProvider ?? defaultMeApiKeyProvider();
  const transport = deps.meTransport ?? defaultMeHttpTransport(keys.authHeaders);
  const meGet = createMeGet(transport, keys);
  const chain = deps.chain ?? defaultChainClient(new Connection(rpcUrl(), 'confirmed'));
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();
  const resolveStandard = deps.fetchStandard ?? fetchNftStandard;
  const resolveCreators = deps.fetchCreators ?? fetchNftCreators;
  const resolveRoyaltyBp = deps.fetchRoyaltyBp ?? fetchRoyaltyBp;
  const sendBundle = deps.sendBundle ?? sendJitoBundle;
  /** pNFT + legacy; undefined when unknown (pNFT: fixed count, legacy: fails closed). */
  const creatorsFor = async (standard: MeSellStandard, mint: string): Promise<string[] | undefined> => {
    if (standard === 'mplCore') return undefined;
    const c = await resolveCreators(mint);
    return c && c.length > 0 ? c : undefined;
  };

  /** Atomic top-up bundle: size the escrow top-up from a real simulation of
   *  [top-up + ME's sale ixs] (DAS royalty is only the first guess — some
   *  pNFTs are charged 0 royalty on-chain), then build the top-up + tip txs
   *  on the sale's own blockhash. Returns an error string on any doubt. */
  const prepareBundle = async (p: {
    intent: FrozenMeSellIntent; blockhash: string; saleIxs: TransactionInstruction[]; alts: AddressLookupTableAccount[];
  }): Promise<{ ok: true; aux: BundleAux; topupB64: string; tipB64: string; sim: { unitsConsumed: number | null; leftoverLamports: number } }
    | { ok: false; status: number; error: string; detail?: string }> => {
    if (!chain.getBalanceStrict || !chain.simulateWithBalances) return { ok: false, status: 501, error: 'bundle_not_supported_by_chain_client' };
    const escrowStr = deriveBuyerEscrowPda(p.intent.auctionHouse, p.intent.buyer);
    if (!escrowStr) return { ok: false, status: 400, error: 'escrow_pda_derivation_failed' };
    const escrowPda = new PublicKey(escrowStr);
    const seller = new PublicKey(p.intent.seller);
    const royaltyBp = await resolveRoyaltyBp(p.intent.mint);
    if (royaltyBp == null) return { ok: false, status: 422, error: 'royalty_unknown', detail: 'Could not read royalty — refusing to size a top-up blind.' };
    let escrowLamports: number;
    try { escrowLamports = await chain.getBalanceStrict(escrowPda); }
    catch (err) { return { ok: false, status: 502, error: toClientError(err, 'bundle-escrow-balance') }; }
    const priceLamports = Number(p.intent.priceLamports);
    let topupLamports = priceLamports + Math.floor(priceLamports * royaltyBp / 10000) - escrowLamports;
    if (topupLamports <= 0) return { ok: false, status: 409, error: 'escrow_already_funded', detail: 'Escrow already covers the bid — use the normal accept.' };

    // Up to 2 sims: the second only when the first shows the program took
    // less than we sent (leftover = our SOL stranded in the buyer's escrow).
    let sim: Awaited<ReturnType<NonNullable<MeSellChainClient['simulateWithBalances']>>> | null = null;
    let leftover = 0;
    for (let round = 0; round < 2; round++) {
      const vtx = combineForSim({
        payer: seller, blockhash: p.blockhash, alts: p.alts, saleIxs: p.saleIxs,
        topupIx: SystemProgram.transfer({ fromPubkey: seller, toPubkey: escrowPda, lamports: topupLamports }),
      });
      try { sim = await chain.simulateWithBalances(vtx, [escrowPda]); }
      catch (err) { return { ok: false, status: 502, error: toClientError(err, 'bundle-simulate') }; }
      if (sim.err != null) {
        return { ok: false, status: 422, error: 'bundle_simulation_failed', detail: `${JSON.stringify(sim.err)} | ${sim.logs.slice(-4).join(' | ')}` };
      }
      const post = sim.lamports[0];
      if (post == null) return { ok: false, status: 502, error: 'bundle_sim_missing_escrow_balance' };
      leftover = post;
      if (leftover <= MAX_ESCROW_LEFTOVER_LAMPORTS) break;
      if (round === 1 || leftover >= topupLamports) {
        return { ok: false, status: 422, error: 'bundle_topup_not_consumed', detail: `sim leaves ${leftover} lamports in escrow` };
      }
      topupLamports -= leftover;
    }
    if (leftover > MAX_ESCROW_LEFTOVER_LAMPORTS) return { ok: false, status: 422, error: 'bundle_topup_not_consumed' };

    const { topup, tip, tipAccount } = buildAuxTxs({ seller, escrowPda, topupLamports, blockhash: p.blockhash });
    return {
      ok: true,
      aux: {
        escrowPda: escrowStr, escrowLamportsAtBuild: escrowLamports, requiredLamports: escrowLamports + topupLamports,
        topupLamports, tipLamports: JITO_TIP_LAMPORTS,
        tipAccount, topupHash: messageHashHex(topup), tipHash: messageHashHex(tip),
      },
      topupB64: unsignedB64(topup), tipB64: unsignedB64(tip),
      sim: { unitsConsumed: sim?.unitsConsumed ?? null, leftoverLamports: leftover },
    };
  };

  const router = Router() as Router & { __meSellTestHooks?: MeSellTestHooks };
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit   = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-sell/read' });
  const buildLimit  = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-sell/build' });
  const simLimit    = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-sell/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/me-sell/submit' });

  const digestCache = new DigestCache(now);
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  router.__meSellTestHooks = { digestCacheSize: () => digestCache.size, sweepTimer };

  router.get('/tools/me-sell/status', authMw, (_req: Request, res: Response) => {
    res.json({ ok: true, liveEnabled, meApiConfigured: keys.hasKey() });
  });

  // ── Resolve (price, auctionHouse) for a (mint, buyer) pair via ME's own
  //    offers_made index — lets the frontend collect just 2 fields. ─────
  router.get('/tools/me-sell/resolve-offer', readLimit, authMw, async (req: Request, res: Response) => {
    const mint = parsePubkey(req.query.mint);
    const buyer = parsePubkey(req.query.buyer);
    if (!mint || !buyer) return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: mint, buyer required' });
    try {
      const offer = await resolveOfferForMint(meGet, mint.toBase58(), buyer.toBase58());
      if (!offer || offer.price == null || !offer.auctionHouse) {
        return res.status(404).json({ ok: false, error: 'offer_not_found: this wallet has no active offer on this mint' });
      }
      return res.json({
        ok: true, mint: mint.toBase58(), buyer: buyer.toBase58(),
        auctionHouseAddress: offer.auctionHouse, priceSol: offer.price,
        pdaAddress: offer.pdaAddress ?? null, expiry: offer.expiry ?? 0,
      });
    } catch (err) {
      if (err instanceof MeApiError) return res.status(err.status).json({ ok: false, error: err.message });
      return res.status(502).json({ ok: false, error: toClientError(err, 'resolve-offer') });
    }
  });

  // ── Read-only: escrow funding status + royalty math for a known offer ──
  router.get('/tools/me-sell/order-info', readLimit, authMw, async (req: Request, res: Response) => {
    const mint = parsePubkey(req.query.mint);
    const buyer = parsePubkey(req.query.buyer);
    const auctionHouse = parsePubkey(req.query.auctionHouseAddress);
    const priceSol = parsePriceSol(req.query.priceSol);
    if (!mint || !buyer || !auctionHouse || priceSol == null) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: mint, buyer, auctionHouseAddress, priceSol required' });
    }
    const escrowPda = deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.toBase58());
    if (!escrowPda) return res.status(400).json({ ok: false, error: 'escrow_pda_derivation_failed' });

    const [escrowLamports, royaltyBp, display, standard] = await Promise.all([
      fetchEscrowBalanceFresh(escrowPda),
      fetchRoyaltyBp(mint.toBase58()),
      fetchNftDisplay(mint.toBase58()),
      resolveStandard(mint.toBase58()),
    ]);
    const priceLamports = Math.round(priceSol * 1e9);
    const royaltyLamports = royaltyBp != null ? Math.floor(priceLamports * royaltyBp / 10000) : null;
    // Fail conservative when royalty is unknown: treat as 0% for the
    // "required" figure but flag it loudly rather than silently
    // under-reporting how much top-up is actually needed (see
    // project_me_ah_accept_offer_seller_covers_fee memory — royalty is
    // pulled ADDITIONALLY from the buyer's escrow, on top of price).
    const requiredLamports = priceLamports + (royaltyLamports ?? 0);
    const missingLamports = Math.max(0, requiredLamports - escrowLamports);
    const sellerProceedsLamports = Math.floor(priceLamports * (10000 - ME_FEE_BP) / 10000);

    return res.json({
      ok: true,
      mint: mint.toBase58(), buyer: buyer.toBase58(), auctionHouseAddress: auctionHouse.toBase58(),
      priceLamports, priceSol,
      escrowPda, escrowLamports, escrowSol: lamportsToSol(escrowLamports),
      royaltyBp, royaltyBpUnknown: royaltyBp == null, royaltyLamports,
      requiredLamports, requiredSol: requiredLamports / 1e9,
      missingLamports, missingSol: missingLamports / 1e9,
      executable: missingLamports === 0,
      sellerProceedsLamports, sellerProceedsSol: sellerProceedsLamports / 1e9,
      meFeeBp: ME_FEE_BP,
      nft: display,
      standard,
      standardSupported: standard != null,
    });
  });

  // ── Unsigned top-up transfer (plain SystemProgram.transfer, no cosign) ──
  router.get('/tools/me-sell/build-topup', buildLimit, authMw, async (req: Request, res: Response) => {
    const escrowPda = parsePubkey(req.query.escrowPda);
    const fromWallet = parsePubkey(req.query.fromWallet);
    const lamports = parseLamports(req.query.lamports);
    if (!escrowPda || !fromWallet || lamports == null || lamports <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: escrowPda, fromWallet, lamports(int>0) required' });
    }
    try {
      const conn = new Connection(rpcUrl(), 'confirmed');
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: fromWallet, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: fromWallet, toPubkey: escrowPda, lamports }),
      );
      const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      return res.json({ ok: true, txBase64 });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'build-topup') });
    }
  });

  // ── Build the accept (Sell + ExecuteSaleV2) tx via ME's instruction API ──
  router.post('/tools/me-sell/build-accept', buildLimit, authMw, async (req: Request, res: Response) => {
    const { seller, tokenMint, priceSol: priceSolRaw, auctionHouseAddress, buyer, sellerReferral, buyerExpiry, bundleTopup } = req.body as {
      seller?: string; tokenMint?: string; priceSol?: number; auctionHouseAddress?: string;
      buyer?: string; sellerReferral?: string; buyerExpiry?: number; bundleTopup?: boolean;
    };
    const sellerPk = parsePubkey(seller);
    const mintPk = parsePubkey(tokenMint);
    const ahPk = parsePubkey(auctionHouseAddress);
    const buyerPk = parsePubkey(buyer);
    const priceSol = parsePriceSol(priceSolRaw);
    if (!sellerPk || !mintPk || !ahPk || !buyerPk || priceSol == null) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: seller, tokenMint, auctionHouseAddress, buyer, priceSol required' });
    }
    // MS-6: independently re-derived server-side (never trusted from the
    // client) — the canonical auditor below would also catch a mismatch via
    // its own discriminator-based variant detection, but failing here is
    // cheaper and gives a clearer reason before ever calling ME's API.
    const standard = await resolveStandard(mintPk.toBase58());
    if (!standard) {
      return res.status(422).json({ ok: false, error: 'unsupported_standard', detail: 'This NFT is not a ProgrammableNFT or MPL Core asset — the only two standards this tool has real evidence of accepting offers on correctly.' });
    }
    const priceLamports = solToExactLamports(priceSol);
    const tokenAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false, TOKEN_PROGRAM_ID);

    // The single /instructions/sell_now endpoint ONLY builds the listing
    // half (Sell/Mip1Sell) — confirmed the hard way 2026-08-24 (a real
    // submitted tx landed clean on-chain but only delegated the NFT, no SOL
    // moved). ME's own frontend never calls that endpoint directly for this
    // flow: a captured real HAR (2026-08-24) shows it calls
    // /instructions/batch with a single-element `q` array instead, and THAT
    // wrapper returns a full 4-instruction bundle (2x ComputeBudget + the
    // listing half + the execute half, the latter referencing the buyer
    // directly) — the batch wrapper has logic the single endpoint doesn't.
    // Payload shape is `ins`, not top-level query params, and notably has
    // NO `price` field at all — only `newPrice`. `buyerExpiry` (in
    // MILLISECONDS, unlike every other expiry field in this codebase which
    // is seconds) is the root cause of the "bidding too old to be accepted"
    // rejection this router used to hit on EVERY offer whose own ME-recorded
    // expiry is 0 ("no expiry"): omitting the field (or passing literal 0)
    // made ME's backend treat the buyer's authorization as expired at Unix
    // epoch — confirmed empirically 2026-08-24 by replaying an identical
    // request against a real, previously-"too old"-rejected offer with only
    // buyerExpiry changed from omitted to a large future timestamp, which
    // then returned status:"fulfilled" with a fully cosigned tx. So: never
    // send 0/omit for an infinite-expiry offer — send a far-future sentinel
    // instead. `NO_EXPIRY_SENTINEL_MS` = 2100-01-01T00:00:00Z.
    const insPayload: Record<string, unknown> = {
      sellerExpiry: 0,
      auctionHouseAddress: ahPk.toBase58(),
      buyer: buyerPk.toBase58(),
      seller: sellerPk.toBase58(),
      tokenMint: mintPk.toBase58(),
      tokenATA: tokenAta.toBase58(),
      newPrice: priceSol,
    };
    if (sellerReferral && parsePubkey(sellerReferral)) insPayload.sellerReferral = sellerReferral;
    const NO_EXPIRY_SENTINEL_MS = 4102444800000;
    insPayload.buyerExpiry = typeof buyerExpiry === 'number' && buyerExpiry > 0
      ? buyerExpiry * 1000
      : NO_EXPIRY_SENTINEL_MS;
    const q = encodeURIComponent(JSON.stringify([{ type: 'sell_now', ins: insPayload }]));
    const path = `/instructions/batch?q=${q}`;

    interface BatchResult { status: string; value?: { txSigned?: { data?: number[] }; v0?: { txSigned?: { data?: number[] } }; blockhashData?: { lastValidBlockHeight?: number } }; reason?: unknown; }
    let batch: BatchResult[];
    try {
      batch = await meGet(path);
    } catch (err) {
      if (err instanceof MeApiError) return res.status(err.status).json({ ok: false, error: err.message });
      return res.status(502).json({ ok: false, error: toClientError(err, 'build-accept') });
    }
    if (!Array.isArray(batch) || batch.length !== 1) {
      return res.status(200).json({ ok: false, error: 'me_batch_response_shape_unexpected' });
    }
    const entry = batch[0];
    if (entry.status !== 'fulfilled' || !entry.value) {
      return res.status(200).json({ ok: false, error: `me_batch_entry_not_fulfilled: ${JSON.stringify(entry.reason ?? entry.status)}` });
    }
    const src = entry.value.txSigned;
    if (!src?.data || !Array.isArray(src.data)) {
      return res.status(200).json({ ok: false, error: 'me_response_missing_tx_signed' });
    }
    const lastValidBlockHeight = entry.value.blockhashData?.lastValidBlockHeight;
    if (typeof lastValidBlockHeight !== 'number') {
      return res.status(200).json({ ok: false, error: 'me_response_missing_blockhash_data' });
    }

    const intent: FrozenMeSellIntent = {
      seller: sellerPk.toBase58(), mint: mintPk.toBase58(),
      auctionHouse: ahPk.toBase58(), buyer: buyerPk.toBase58(),
      priceLamports, standard,
      creators: await creatorsFor(standard, mintPk.toBase58()),
    };

    // ME returns TWO variants of the same bundle. The legacy one is the
    // default and is left completely untouched. Only when it exceeds the
    // 1232-byte wire limit (pNFT + several creators — e.g. 1376 bytes for
    // Trippin' Ape Tribe #3881) do we take ME's own cosigned v0+ALT variant
    // (1040 bytes for that NFT) instead; nothing is rebuilt or re-signed.
    if (src.data.length > TX_WIRE_LIMIT) {
      const v0data = entry.value.v0?.txSigned?.data;
      if (!Array.isArray(v0data) || v0data.length === 0 || v0data.length > TX_WIRE_LIMIT) {
        return res.status(422).json({
          ok: false, error: 'me_tx_too_large',
          detail: `ME's legacy tx is ${src.data.length} bytes (limit ${TX_WIRE_LIMIT}) and it returned no usable v0 variant`
            + (Array.isArray(v0data) ? ` (v0 is ${v0data.length} bytes)` : ''),
        });
      }
      if (!chain.getAddressLookupTable) return res.status(501).json({ ok: false, error: 'versioned_not_supported_by_chain_client' });
      let vtx: VersionedTransaction;
      let auditable: Awaited<ReturnType<typeof toAuditableTx>>;
      try {
        vtx = decodeVersionedTxFromBytes(Buffer.from(v0data));
        auditable = await toAuditableTx(vtx, chain.getAddressLookupTable.bind(chain));
      } catch (err) {
        return res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      const audited = auditMeSellTransaction(auditable, intent, 'absent');
      if (!audited.ok) return res.status(422).json({ ok: false, error: audited.reason });
      const cosigner = auditable.signatures.find((sg) => sg.publicKey.toBase58() !== intent.seller);
      if (!cosigner || cosigner.signature == null) {
        return res.status(409).json({
          ok: false, error: 'cosign_not_prefilled', needsBridge: true,
          detail: `ME returned an unsigned cosigner slot in its v0 variant — this backend-only path cannot complete the trade without a browser-session bridge.`,
        });
      }
      let vBundle: Awaited<ReturnType<typeof prepareBundle>> | null = null;
      if (bundleTopup === true) {
        const alts: AddressLookupTableAccount[] = [];
        for (const l of vtx.message.addressTableLookups) {
          const alt = await chain.getAddressLookupTable(l.accountKey);
          if (!alt) return res.status(502).json({ ok: false, error: 'alt_unavailable' });
          alts.push(alt);
        }
        vBundle = await prepareBundle({ intent, blockhash: vtx.message.recentBlockhash, saleIxs: auditable.instructions, alts });
        if (!vBundle.ok) return res.status(vBundle.status).json({ ok: false, error: vBundle.error, detail: vBundle.detail });
      }
      const vDigest = versionedMessageHashHex(vtx);
      digestCache.set(vDigest, {
        intent, txVersion: 0,
        blockhashInfo: { blockhash: vtx.message.recentBlockhash, lastValidBlockHeight },
        expiresAt: now() + DIGEST_TTL_MS,
        ...(vBundle?.ok ? { bundle: vBundle.aux } : {}),
      });
      return res.json({
        ok: true, digest: vDigest, txVersion: 0,
        txBase64: Buffer.from(v0data).toString('base64'),
        cosignerPubkey: cosigner.publicKey.toBase58(),
        priceSol, priceLamports, standard, lastValidBlockHeight, expiresInMs: DIGEST_TTL_MS,
        ...(vBundle?.ok ? bundleResponse(vBundle) : {}),
      });
    }

    let tx: Transaction;
    try { tx = decodeLegacyTxFromBytes(Buffer.from(src.data)); }
    catch (err) { return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    let validated: ValidatedSellTx;
    try {
      validated = validateSellStructure(tx, intent, 'absent');
    } catch (err) {
      return res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // The one thing this backend-only path cannot supply itself: if ME's
    // cosigner slot came back unsigned, there is no key on this server that
    // can fill it. Surface that plainly instead of caching a digest for a
    // tx that can never pass submit's verifySignatures(true) check.
    if (!validated.cosignPrefilled) {
      return res.status(409).json({
        ok: false, error: 'cosign_not_prefilled',
        needsBridge: true,
        detail: `ME returned an unsigned cosigner slot (${validated.cosignerPubkey}) — this backend-only path cannot complete the trade without a browser-session bridge.`,
      });
    }

    let lBundle: Awaited<ReturnType<typeof prepareBundle>> | null = null;
    if (bundleTopup === true) {
      lBundle = await prepareBundle({ intent, blockhash: tx.recentBlockhash!, saleIxs: tx.instructions, alts: [] });
      if (!lBundle.ok) return res.status(lBundle.status).json({ ok: false, error: lBundle.error, detail: lBundle.detail });
    }
    const digest = validated.messageHash;
    digestCache.set(digest, {
      intent,
      blockhashInfo: { blockhash: tx.recentBlockhash!, lastValidBlockHeight },
      expiresAt: now() + DIGEST_TTL_MS,
      ...(lBundle?.ok ? { bundle: lBundle.aux } : {}),
    });

    return res.json({
      ok: true,
      digest,
      txBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      cosignerPubkey: validated.cosignerPubkey,
      priceSol,
      priceLamports,
      standard,
      lastValidBlockHeight,
      expiresInMs: DIGEST_TTL_MS,
      ...(lBundle?.ok ? bundleResponse(lBundle) : {}),
    });
  });

  router.post('/tools/me-sell/simulate', simLimit, authMw, async (req: Request, res: Response) => {
    const { tx, txVersion } = req.body as { tx?: string; txVersion?: number };
    if (!tx || typeof tx !== 'string') return res.status(400).json({ ok: false, error: 'missing_tx' });
    if (txVersion === 0) {
      if (!chain.simulateVersionedTransaction) return res.status(501).json({ ok: false, error: 'versioned_not_supported_by_chain_client' });
      let vtx: VersionedTransaction;
      try { vtx = decodeVersionedTxFromBase64(tx); }
      catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
      try {
        const sim = await chain.simulateVersionedTransaction(vtx);
        return res.json({ ok: true, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed });
      } catch (err) {
        return res.status(200).json({ ok: false, error: toClientError(err, 'simulate') });
      }
    }
    let decoded: Transaction;
    try { decoded = decodeLegacyTxFromBase64(tx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    try {
      const sim = await chain.simulateTransaction(decoded);
      return res.json({ ok: true, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'simulate') });
    }
  });

  // ── MS-1: read-only canonical structural+price audit for the
  //    Tampermonkey-bridge path, BEFORE the seller ever signs anything.
  //    The bridge previously handed bytes straight to Simulate/Sign&Submit
  //    with zero validation — this is the SAME auditor build-accept/submit
  //    use, just called earlier, on bridge-sourced bytes, before Phantom.
  //    Never caches a digest (the bridge path doesn't use one) and never
  //    touches chain state — pure decode + audit. ──────────────────────────
  router.post('/tools/me-sell/audit-bridge', simLimit, authMw, async (req: Request, res: Response) => {
    const { tx, seller, tokenMint, auctionHouseAddress, buyer, priceLamports, standard } = req.body as {
      tx?: string; seller?: string; tokenMint?: string; auctionHouseAddress?: string;
      buyer?: string; priceLamports?: string; standard?: string;
    };
    const sellerPk = parsePubkey(seller);
    const mintPk = parsePubkey(tokenMint);
    const ahPk = parsePubkey(auctionHouseAddress);
    const buyerPk = parsePubkey(buyer);
    if (!tx || typeof tx !== 'string' || !sellerPk || !mintPk || !ahPk || !buyerPk
      || typeof priceLamports !== 'string' || !/^\d+$/.test(priceLamports)
      || !isSupportedStandard(standard)) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: tx, seller, tokenMint, auctionHouseAddress, buyer, priceLamports(digit string), standard(pnft|mplCore|legacy) required' });
    }
    let decoded: Transaction;
    try { decoded = decodeLegacyTxFromBase64(tx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    const intent: FrozenMeSellIntent = {
      seller: sellerPk.toBase58(), mint: mintPk.toBase58(), auctionHouse: ahPk.toBase58(),
      buyer: buyerPk.toBase58(), priceLamports, standard,
      creators: await creatorsFor(standard, mintPk.toBase58()),
    };
    const audited = auditMeSellTransaction(decoded, intent, 'absent');
    if (!audited.ok) return res.status(422).json({ ok: false, error: audited.reason });
    return res.json({ ok: true });
  });

  // ── MS-4/14: exact-signature confirmation status + current blockheight.
  //    Called with signatures:[] as a pure pre/post-sign freshness read, and
  //    with real signatures while polling a submitted tx's outcome. ───────
  router.post('/tools/me-sell/status', readLimit, authMw, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { signatures?: unknown };
    const sigs = body.signatures;
    if (sigs !== undefined && (!Array.isArray(sigs) || !sigs.every((s) => typeof s === 'string'))) {
      return res.status(400).json({ ok: false, error: 'invalid_signatures' });
    }
    if (Array.isArray(sigs) && sigs.length > 20) {
      return res.status(400).json({ ok: false, error: 'too_many_signatures' });
    }
    try {
      const blockHeight = await chain.getBlockHeight();
      const statuses = Array.isArray(sigs) && sigs.length > 0 ? await chain.getSignatureStatuses(sigs) : [];
      return res.json({ ok: true, blockHeight, statuses });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'status') });
    }
  });

  // ── Submit a tx obtained via the Tampermonkey bridge (real browser
  //    session → /instructions/batch), not our own build-accept ──────────
  //
  // No prior digest exists for this tx (it never passed through this
  // server's build-accept), so there's nothing to bind against — the
  // security boundary here is purely structural validation (right seller/
  // mint/auctionHouse/buyer, right signer shape) plus cryptographic
  // signature verification, exactly like the digest path's own
  // revalidation step, just without the earlier build-time snapshot to
  // compare against. Single-operator personal tool — no multi-tenant
  // digest-forgery concern this is meant to close.
  router.post('/tools/me-sell/submit-bridge', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTx, seller, tokenMint, auctionHouseAddress, buyer, priceLamports, standard, lastValidBlockHeight } = req.body as {
      signedTx?: string; seller?: string; tokenMint?: string; auctionHouseAddress?: string; buyer?: string;
      priceLamports?: string; standard?: string; lastValidBlockHeight?: number;
    };
    const sellerPk = parsePubkey(seller);
    const mintPk = parsePubkey(tokenMint);
    const ahPk = parsePubkey(auctionHouseAddress);
    const buyerPk = parsePubkey(buyer);
    if (!signedTx || typeof signedTx !== 'string' || !sellerPk || !mintPk || !ahPk || !buyerPk
      || typeof priceLamports !== 'string' || !/^\d+$/.test(priceLamports)
      || !isSupportedStandard(standard)
      || typeof lastValidBlockHeight !== 'number' || !Number.isFinite(lastValidBlockHeight)) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: signedTx, seller, tokenMint, auctionHouseAddress, buyer, priceLamports(digit string), standard(pnft|mplCore), lastValidBlockHeight(number, from the bridge\'s own blockhashData) required' });
    }
    let tx: Transaction;
    try { tx = decodeLegacyTxFromBase64(signedTx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    // POST-SIGN freshness (MS-7-adjacent) — the bridge path has no
    // build-time digest cache to read a blockhash snapshot from, but the
    // caller now supplies the SAME `blockhashData.lastValidBlockHeight` ME's
    // batch response carries (previously discarded by the frontend — see
    // page.tsx). Checked against the tx's OWN embedded blockhash for a
    // trivial tamper-check, then against a freshly-read height. Fails
    // CLOSED if the height read itself fails — matches `submit`'s own
    // established policy exactly, not a weaker variant for this path.
    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); }
    catch (err) { return res.status(200).json({ ok: false, error: toClientError(err, 'submit-bridge-blockheight') }); }
    if (!tx.recentBlockhash) return res.status(400).json({ ok: false, error: 'missing_recent_blockhash' });
    const freshness = checkBlockhashFreshness(
      tx, { blockhash: tx.recentBlockhash, lastValidBlockHeight }, currentBlockHeight, marginBlocks,
    );
    if (!freshness.ok) return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });

    let validated: ValidatedSellTx;
    try {
      validated = validateSellStructure(tx, {
        seller: sellerPk.toBase58(), mint: mintPk.toBase58(),
        auctionHouse: ahPk.toBase58(), buyer: buyerPk.toBase58(),
        priceLamports, standard,
        creators: await creatorsFor(standard, mintPk.toBase58()),
      }, 'present');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `validation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!validated.cosignPrefilled) {
      return res.status(400).json({ ok: false, error: 'cosign_missing' });
    }
    if (!tx.verifySignatures(true)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }
    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'submit-bridge-send') });
    }
  });

  // Shared signed-sale gates for /submit and /submit-bundle, same order as
  // before: digest match -> blockhash -> freshness -> [caller extras] ->
  // consume -> canonical re-audit -> cosigner present -> cryptographic
  // verification of BOTH signature slots. Returns the exact bytes to send.
  type Fail = { ok: false; status: number; error: string; detail?: string };
  type Prechecked = { ok: true; vtx?: VersionedTransaction; tx?: Transaction };
  const precheckSignedSale = async (signedTx: string, digest: string, entry: DigestEntry): Promise<Prechecked | Fail> => {
    if (entry.txVersion === 0) {
      if (!chain.sendRawBytes || !chain.getAddressLookupTable) return { ok: false, status: 501, error: 'versioned_not_supported_by_chain_client' };
      let vtx: VersionedTransaction;
      try { vtx = decodeVersionedTxFromBase64(signedTx); }
      catch (err) { return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }; }
      if (versionedMessageHashHex(vtx) !== digest) return { ok: false, status: 409, error: 'signed_tx_message_does_not_match_digest' };
      if (vtx.message.recentBlockhash !== entry.blockhashInfo.blockhash) return { ok: false, status: 409, error: 'blockhash_mismatch' };
      let height: number;
      try { height = await chain.getBlockHeight(); }
      catch (err) { return { ok: false, status: 200, error: toClientError(err, 'submit-blockheight') }; }
      const fresh = checkBlockhashFreshness({ recentBlockhash: vtx.message.recentBlockhash }, entry.blockhashInfo, height, marginBlocks);
      if (!fresh.ok) return { ok: false, status: 410, error: fresh.code, detail: fresh.detail };
      return { ok: true, vtx };
    }
    let tx: Transaction;
    try { tx = decodeLegacyTxFromBase64(signedTx); }
    catch (err) { return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }; }
    if (messageHashHex(tx) !== digest) return { ok: false, status: 409, error: 'signed_tx_message_does_not_match_digest' };
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) return { ok: false, status: 409, error: 'blockhash_mismatch' };
    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); }
    catch (err) { return { ok: false, status: 200, error: toClientError(err, 'submit-blockheight') }; }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) return { ok: false, status: 410, error: freshness.code, detail: freshness.detail };
    return { ok: true, tx };
  };
  /** Call only AFTER the digest was consumed. */
  const postcheckSignedSale = async (pre: Prechecked, entry: DigestEntry): Promise<{ ok: true; raw: Buffer } | Fail> => {
    if (pre.vtx) {
      const vtx = pre.vtx;
      let auditable: Awaited<ReturnType<typeof toAuditableTx>>;
      try { auditable = await toAuditableTx(vtx, chain.getAddressLookupTable!.bind(chain)); }
      catch (err) { return { ok: false, status: 409, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` }; }
      const reaudit = auditMeSellTransaction(auditable, entry.intent, 'present');
      if (!reaudit.ok) return { ok: false, status: 409, error: `revalidation_failed: ${reaudit.reason}` };
      const cosigned = auditable.signatures.find((sg) => sg.publicKey.toBase58() !== entry.intent.seller);
      if (!cosigned || cosigned.signature == null) return { ok: false, status: 400, error: 'cosign_missing_at_submit' };
      if (!verifyVersionedSignatures(vtx)) return { ok: false, status: 400, error: 'invalid_signature' };
      return { ok: true, raw: Buffer.from(vtx.serialize()) };
    }
    const tx = pre.tx!;
    let validated: ValidatedSellTx;
    try { validated = validateSellStructure(tx, entry.intent, 'present'); }
    catch (err) { return { ok: false, status: 409, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` }; }
    if (!validated.cosignPrefilled) return { ok: false, status: 400, error: 'cosign_missing_at_submit' };
    // The actual security boundary: cryptographically verifies BOTH
    // signature slots (seller's just-added signature AND ME's cosign)
    // against the exact message bytes.
    if (!tx.verifySignatures(true)) return { ok: false, status: 400, error: 'invalid_signature' };
    return { ok: true, raw: tx.serialize() };
  };
  const sendFail = (res: Response, f: Fail) => res.status(f.status).json({ ok: false, error: f.error, ...(f.detail ? { detail: f.detail } : {}) });

  router.post('/tools/me-sell/submit', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTx, digest } = req.body as { signedTx?: string; digest?: string };
    if (!signedTx || typeof signedTx !== 'string') return res.status(400).json({ ok: false, error: 'missing_signed_tx' });
    if (!digest || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return res.status(400).json({ ok: false, error: 'missing_or_malformed_digest' });
    }
    const entry = digestCache.get(digest);
    if (!entry) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    if (entry.expiresAt < now()) { digestCache.consume(digest); return res.status(410).json({ ok: false, error: 'digest_expired' }); }
    // A bundle build must go out as a bundle — its sale alone would just fail
    // on the underfunded escrow (or worse, succeed after someone else's top-up
    // with our intent unexamined).
    if (entry.bundle) return res.status(409).json({ ok: false, error: 'bundle_build_use_submit_bundle' });

    const pre = await precheckSignedSale(signedTx, digest, entry);
    if (!pre.ok) return sendFail(res, pre);
    if (!digestCache.consume(digest)) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    const post = await postcheckSignedSale(pre, entry);
    if (!post.ok) return sendFail(res, post);
    try {
      const signature = pre.vtx
        ? await chain.sendRawBytes!(post.raw)
        : await chain.sendRawTransaction(pre.tx!);
      return res.json({ ok: true, signature });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'submit-send') });
    }
  });

  // ── Atomic top-up + accept: [top-up, ME sale (untouched), tip] as one
  // Jito bundle — see me-sell-bundle.ts header for why never sequential. ──
  router.post('/tools/me-sell/submit-bundle', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTopupTx, signedTx, signedTipTx, digest } = req.body as {
      signedTopupTx?: string; signedTx?: string; signedTipTx?: string; digest?: string;
    };
    if (![signedTopupTx, signedTx, signedTipTx].every((t) => typeof t === 'string' && t.length > 0)) {
      return res.status(400).json({ ok: false, error: 'missing_signed_txs' });
    }
    if (!digest || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return res.status(400).json({ ok: false, error: 'missing_or_malformed_digest' });
    }
    const entry = digestCache.get(digest);
    if (!entry) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    if (entry.expiresAt < now()) { digestCache.consume(digest); return res.status(410).json({ ok: false, error: 'digest_expired' }); }
    const aux = entry.bundle;
    if (!aux) return res.status(409).json({ ok: false, error: 'not_a_bundle_build' });
    if (!chain.getBalanceStrict) return res.status(501).json({ ok: false, error: 'bundle_not_supported_by_chain_client' });

    const pre = await precheckSignedSale(signedTx!, digest, entry);
    if (!pre.ok) return sendFail(res, pre);
    const topup = checkSignedAux(signedTopupTx!, aux.topupHash);
    if (!topup.ok) return res.status(409).json({ ok: false, error: `topup_${topup.reason}` });
    const tip = checkSignedAux(signedTipTx!, aux.tipHash);
    if (!tip.ok) return res.status(409).json({ ok: false, error: `tip_${tip.reason}` });

    // Escrow must be exactly what the top-up was sized (and simulated)
    // against — any movement means another fill/withdraw/top-up happened:
    // rebuild rather than send SOL sized for a different state.
    let escrowNow: number;
    try { escrowNow = await chain.getBalanceStrict(new PublicKey(aux.escrowPda)); }
    catch (err) { return res.status(200).json({ ok: false, error: toClientError(err, 'bundle-escrow-recheck') }); }
    if (escrowNow !== aux.escrowLamportsAtBuild) {
      digestCache.consume(digest);
      return res.status(409).json({ ok: false, error: 'escrow_changed_since_build', detail: `${aux.escrowLamportsAtBuild} -> ${escrowNow} lamports — Load Offer again` });
    }

    if (!digestCache.consume(digest)) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    const post = await postcheckSignedSale(pre, entry);
    if (!post.ok) return sendFail(res, post);

    const saleSig = pre.vtx ? bs58Encode(pre.vtx.signatures[0]) : bs58Encode(pre.tx!.signature!);
    try {
      const sent = await sendBundle([
        topup.tx.serialize().toString('base64'),
        post.raw.toString('base64'),
        tip.tx.serialize().toString('base64'),
      ]);
      return res.json({
        ok: true, bundleId: sent.bundleId, signature: saleSig,
        topupSignature: bs58Encode(topup.tx.signature!), tipSignature: bs58Encode(tip.tx.signature!),
        acceptedBy: sent.accepted, jitoErrors: sent.errors,
      });
    } catch (err) {
      return res.status(200).json({ ok: false, error: toClientError(err, 'bundle-send') });
    }
  });

  return router;
}
