/**
 * Candy Mint tool — live Candy Machine / Candy Guard inspection.
 *
 * Read-only. Tells the caller whether a candy machine still exists
 * on-chain (the whole reason this tool exists: candy machines get closed
 * — rent reclaimed — the moment they sell out, sometimes minutes after
 * the reference signature was minted) and, if it does, which guard
 * group(s) can actually be satisfied by a plain wallet signature alone.
 *
 * Two independent SDKs, one per family (see decode.ts's header comment for
 * why they can't share a Umi instance — both export a plugin literally
 * named `mplCandyMachine`, aliased apart here):
 *   'core'   — @metaplex-foundation/mpl-core-candy-machine (MPL Core assets)
 *   'legacy' — @metaplex-foundation/mpl-candy-machine (Token Metadata NFTs)
 *
 * "Supported" means every enabled guard in that group resolves purely
 * from on-chain guard state + the connecting wallet's own signature —
 * no merkle proof, no gatekeeper/captcha token, no backend co-signer, no
 * externally-supplied asset. Anything else (allowlist, gatekeeper,
 * tokenGate/nftGate holdings checks, burns, third-party signer, vanity
 * mint, freeze escrows) is flagged unsupported rather than silently
 * built into a transaction that's guaranteed to fail on-chain.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey as umiPublicKey, AccountNotFoundError, type Context } from '@metaplex-foundation/umi';
import {
  mplCandyMachine as mplCoreCandyMachine,
  fetchCandyMachine as fetchCoreCandyMachine,
  safeFetchCandyGuard as safeFetchCoreCandyGuard,
  findMintCounterPda as findCoreMintCounterPda,
  safeFetchMintCounter as safeFetchCoreMintCounter,
  type DefaultGuardSet as CoreDefaultGuardSet,
} from '@metaplex-foundation/mpl-core-candy-machine';
import {
  mplCandyMachine as mplLegacyCandyMachine,
  fetchCandyMachine as fetchLegacyCandyMachine,
  safeFetchCandyGuard as safeFetchLegacyCandyGuard,
  findMintCounterPda as findLegacyMintCounterPda,
  safeFetchMintCounter as safeFetchLegacyMintCounter,
  type DefaultGuardSet as LegacyDefaultGuardSet,
} from '@metaplex-foundation/mpl-candy-machine';
import { mergeGuardSets } from './guard-merge';
import type { CandyMintFamily } from './decode';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// Guard names whose on-chain data is fully self-contained: a plain wallet
// signature + the guard's own stored config (price, dates, counters,
// single hardcoded address) is enough to satisfy them at mint time. Union
// of both families' guard sets — an unrecognized name (there are none,
// both SDKs' guard lists are subsets of this) would correctly fall through
// to "unsupported".
// freezeSolPayment / freezeTokenPayment ARE included: the mint-side of
// those guards resolves purely from guard state too (same manifest-driven
// extra-account pattern as solPayment) — the only step that needs an
// explicit authority signer is the one-time escrow `route(initialize)`,
// which the guard's OWNER does before minting ever opens, not the minter.
// A public stage actively redeeming items (which is the whole point of
// this tool — check a still-live public mint) has necessarily already
// been initialized, so this is safe to treat as self-contained.
//
// nftMintLimit / assetMintLimit are deliberately NOT included: both require
// the caller to supply a specific NFT/asset the minter already holds
// (`{ id, asset }` / `{ id, mint, tokenAccount? }`) — a holder-gate, not a
// plain-wallet-signature guard. mintLimit / allocation only need their own
// `id` (self-contained — see build.ts's resolveMintArgs).
const SUPPORTED_GUARDS = new Set([
  'botTax', 'solPayment', 'tokenPayment', 'token2022Payment',
  'startDate', 'endDate', 'mintLimit',
  'redeemedAmount', 'solFixedFee', 'allocation', 'addressGate',
  'freezeSolPayment', 'freezeTokenPayment',
]);

export interface MintLimitStatus {
  id: number;
  limit: number;
  /** null until a wallet is supplied to inspectCandyMachine. */
  used: number | null;
  remaining: number | null;
}

export interface GuardGroupSummary {
  /** null for the root (groupless) guard set. */
  label: string | null;
  enabledGuards: string[];
  unsupportedGuards: string[];
  supported: boolean;
  solPaymentLamports: string | null;
  /** `solPayment` destination (SOL recipient of the mint price). Null when
   *  the guard isn't set for this group. Surfaced so the frontend structural
   *  auditor can pin the payment account in the built transaction against the
   *  reviewed guard config, not just the amount. */
  solPaymentDestination: string | null;
  /** `solFixedFee` lamports + destination (a flat fee on top of any price).
   *  Both null when the guard isn't set. */
  solFixedFeeLamports: string | null;
  solFixedFeeDestination: string | null;
  /** `addressGate.address` — the single wallet allowed to mint this group.
   *  Null when the guard isn't set. The mint hard-fails on-chain (bot-tax /
   *  revert) for any other wallet, so the frontend disables Mint early when
   *  the connected wallet != this. */
  addressGateAddress: string | null;
  mintLimit: MintLimitStatus | null;
  /** Unix seconds, as decimal strings (guard dates are on-chain i64/u64 —
   *  stringified the same way solPaymentLamports is to survive JSON without
   *  precision loss). Null when the guard isn't set for this group. */
  startDateUnix: string | null;
  endDateUnix:   string | null;
  /** From `tokenPayment` (classic SPL Token) or `token2022Payment` — same
   *  {amount, mint, destinationAta} shape on-chain for both, distinguished
   *  by `kind`. `amount` is the raw on-chain integer; `decimals` is resolved
   *  separately (see token-decimals.ts) and filled in by the inspect router
   *  — it is `null` here as produced by summarizeGuardSet, and `null` again
   *  if that lookup fails (caller then shows the raw integer). Null (the
   *  whole field) when neither guard is set for this group. */
  tokenPayment: {
    mint: string;
    amount: string;
    destinationAta: string;
    decimals: number | null;
    kind: 'spl' | 'token2022';
  } | null;
  /** The COMPLETE user-authorized payment for this group — every payment-
   *  affecting guard's amounts + destinations (incl. freezeSolPayment /
   *  freezeTokenPayment). The frontend freezes THIS verbatim into its mint
   *  intent and re-checks it EXACTLY against the FINAL build's fresh guard
   *  read before signing. The individual fields above are kept only for the
   *  price-label display code. */
  payment: PaymentGuardConfig;
}

export interface CandyMachineInspection {
  alive: boolean;
  candyMachine: string;
  candyGuard: string;
  collection: string | null;
  itemsRedeemed: string | null;
  itemsAvailable: string | null;
  groups: GuardGroupSummary[];
}

// The exact user-authorized MINT PAYMENT a guard set imposes — amounts +
// destinations for every payment-affecting guard. Distinct from transaction
// fee / rent / priority (protocol overhead). This is what the frontend
// freezes at review time and re-checks EXACTLY against the FINAL build's
// re-read of live guard state before signing (a changed mint price must
// return the user to review, not slide under a tolerance).
interface TokenPay { mint: string; amount: string; destinationAta: string; kind: 'spl' | 'token2022' }

export interface PaymentGuardConfig {
  solPaymentLamports: string | null;
  solPaymentDestination: string | null;
  solFixedFeeLamports: string | null;
  solFixedFeeDestination: string | null;
  // freezeSolPayment / freezeTokenPayment are also in SUPPORTED_GUARDS — a
  // freeze drop routes the SAME { lamports, destination } / { amount, mint,
  // destinationAta } to a per-drop escrow PDA, so its price + destination are
  // authorized exactly like the non-freeze variants.
  freezeSolPaymentLamports: string | null;
  freezeSolPaymentDestination: string | null;
  tokenPayment: TokenPay | null;
  freezeTokenPayment: TokenPay | null;
  addressGateAddress: string | null;
}

type GuardOption = { __option: 'Some' | 'None'; value?: unknown };

// The canonical set of ENABLED guard names in a guard set (base∪group
// merged). Sorted + de-duped so two builds of the same on-chain config
// compare equal regardless of key iteration order. Single source of truth
// for both the inspect summary's `enabledGuards` and the builder's
// `resolvedEnabledGuards` echo-back — a guard is "enabled" iff its option is
// `Some`, exactly the predicate `resolveMintArgs` uses to decide what to
// forward to the mint instruction.
export function canonicalGuardNames(guards: Record<string, GuardOption>): string[] {
  const names = new Set<string>();
  for (const [name, wrapped] of Object.entries(guards)) {
    if (wrapped?.__option === 'Some') names.add(name);
  }
  return [...names].sort();
}

function readSolLike(v: unknown): { lamports: string | null; destination: string | null } {
  const o = v as { lamports?: { basisPoints?: bigint }; destination?: unknown } | undefined;
  return {
    lamports: o?.lamports?.basisPoints != null ? o.lamports.basisPoints.toString() : null,
    destination: o?.destination != null ? String(o.destination) : null,
  };
}
function readTokenLike(v: unknown, kind: 'spl' | 'token2022'): TokenPay | null {
  const o = v as { mint?: unknown; amount?: bigint; destinationAta?: unknown } | undefined;
  if (o?.mint == null || o.amount == null || o.destinationAta == null) return null;
  return { mint: String(o.mint), amount: o.amount.toString(), destinationAta: String(o.destinationAta), kind };
}

// Pull the payment-affecting fields out of an (already base∪group-merged)
// guard set. Single source of truth for both the inspect summary and the
// builder's echo-back.
export function extractPaymentGuards(guards: Record<string, GuardOption>): PaymentGuardConfig {
  const out: PaymentGuardConfig = {
    solPaymentLamports: null, solPaymentDestination: null,
    solFixedFeeLamports: null, solFixedFeeDestination: null,
    freezeSolPaymentLamports: null, freezeSolPaymentDestination: null,
    tokenPayment: null, freezeTokenPayment: null, addressGateAddress: null,
  };
  for (const [name, wrapped] of Object.entries(guards)) {
    if (!wrapped || wrapped.__option !== 'Some') continue;
    if (name === 'solPayment') {
      const s = readSolLike(wrapped.value);
      out.solPaymentLamports = s.lamports; out.solPaymentDestination = s.destination;
    } else if (name === 'solFixedFee') {
      const s = readSolLike(wrapped.value);
      out.solFixedFeeLamports = s.lamports; out.solFixedFeeDestination = s.destination;
    } else if (name === 'freezeSolPayment') {
      const s = readSolLike(wrapped.value);
      out.freezeSolPaymentLamports = s.lamports; out.freezeSolPaymentDestination = s.destination;
    } else if (name === 'tokenPayment') {
      out.tokenPayment = readTokenLike(wrapped.value, 'spl');
    } else if (name === 'token2022Payment') {
      out.tokenPayment = readTokenLike(wrapped.value, 'token2022');
    } else if (name === 'freezeTokenPayment') {
      out.freezeTokenPayment = readTokenLike(wrapped.value, 'spl');
    } else if (name === 'addressGate') {
      const v = wrapped.value as { address?: unknown } | undefined;
      if (v?.address != null) out.addressGateAddress = String(v.address);
    }
  }
  return out;
}

function summarizeGuardSet(
  label: string | null,
  guards: CoreDefaultGuardSet | LegacyDefaultGuardSet,
): GuardGroupSummary {
  const unsupported: string[] = [];
  let mintLimit: MintLimitStatus | null = null;
  let startDateUnix: string | null = null;
  let endDateUnix: string | null = null;
  // Payment / addressGate fields + the canonical enabled-guard set come from
  // the shared extractors so the inspect summary and the builder's echo-back
  // can never disagree.
  const pay = extractPaymentGuards(guards as unknown as Record<string, GuardOption>);
  const enabled = canonicalGuardNames(guards as unknown as Record<string, GuardOption>);
  const tokenPayment: GuardGroupSummary['tokenPayment'] = pay.tokenPayment
    ? { ...pay.tokenPayment, decimals: null }
    : null;
  for (const [name, wrapped] of Object.entries(guards)) {
    const opt = wrapped as { __option: 'Some' | 'None'; value?: unknown } | undefined;
    if (!opt || opt.__option !== 'Some') continue;
    if (!SUPPORTED_GUARDS.has(name)) unsupported.push(name);
    if (name === 'mintLimit') {
      const v = opt.value as { id: number; limit: number };
      mintLimit = { id: v.id, limit: v.limit, used: null, remaining: null };
    }
    if (name === 'startDate') {
      const v = opt.value as { date?: bigint } | undefined;
      if (v?.date != null) startDateUnix = v.date.toString();
    }
    if (name === 'endDate') {
      const v = opt.value as { date?: bigint } | undefined;
      if (v?.date != null) endDateUnix = v.date.toString();
    }
  }
  const solPaymentLamports = pay.solPaymentLamports;
  const solPaymentDestination = pay.solPaymentDestination;
  const solFixedFeeLamports = pay.solFixedFeeLamports;
  const solFixedFeeDestination = pay.solFixedFeeDestination;
  const addressGateAddress = pay.addressGateAddress;
  return {
    label,
    enabledGuards: enabled,
    unsupportedGuards: unsupported,
    supported: unsupported.length === 0,
    solPaymentLamports,
    solPaymentDestination,
    solFixedFeeLamports,
    solFixedFeeDestination,
    addressGateAddress,
    mintLimit,
    startDateUnix,
    endDateUnix,
    tokenPayment,
    payment: pay,
  };
}

// Fills in `used`/`remaining` on each group's mintLimit (left null by
// summarizeGuardSet, which only reads the guard's static config) — needs an
// extra RPC round-trip per group against the wallet-specific counter PDA,
// so it's opt-in and only run when a wallet is supplied.
async function fillMintLimitUsage(
  family: CandyMintFamily,
  umi: Context,
  groups: GuardGroupSummary[],
  candyMachineAddr: string,
  candyGuardAddr: string,
  wallet: string,
): Promise<void> {
  const findPda = family === 'core' ? findCoreMintCounterPda : findLegacyMintCounterPda;
  const fetchCounter = family === 'core' ? safeFetchCoreMintCounter : safeFetchLegacyMintCounter;
  await Promise.all(groups.map(async (g) => {
    if (!g.mintLimit) return;
    const pda = findPda(umi, {
      id: g.mintLimit.id,
      user: umiPublicKey(wallet),
      candyMachine: umiPublicKey(candyMachineAddr),
      candyGuard: umiPublicKey(candyGuardAddr),
    });
    const counter = await fetchCounter(umi, pda[0]);
    const used = counter ? counter.count : 0;
    g.mintLimit.used = used;
    g.mintLimit.remaining = Math.max(0, g.mintLimit.limit - used);
  }));
}

async function inspectCore(candyMachineAddr: string, candyGuardAddr: string, wallet?: string | null): Promise<CandyMachineInspection> {
  const umi = createUmi(rpcUrl()).use(mplCoreCandyMachine());
  let itemsRedeemed: string | null = null;
  let itemsAvailable: string | null = null;
  let collection: string | null = null;
  let alive = true;
  try {
    const cm = await fetchCoreCandyMachine(umi, umiPublicKey(candyMachineAddr));
    itemsRedeemed = cm.itemsRedeemed.toString();
    itemsAvailable = cm.data.itemsAvailable.toString();
    collection = cm.collectionMint.toString();
  } catch (err) {
    // Only a genuine "this account doesn't exist" means closed. A 429/
    // network blip from a burst of rapid calls (batch-mint, wallet-switch
    // background refresh) threw the same generic error here and got
    // reported as "closed" indistinguishably — a transient RPC hiccup
    // isn't the same fact as "sold out and rent-reclaimed", and battle-
    // testing a 10x batch surfaced exactly that false positive live.
    if (err instanceof AccountNotFoundError) alive = false;
    else throw err;
  }

  const groups: GuardGroupSummary[] = [];
  const guard = await safeFetchCoreCandyGuard(umi, umiPublicKey(candyGuardAddr));
  if (guard) {
    if (guard.groups.length === 0) groups.push(summarizeGuardSet(null, guard.guards));
    else for (const g of guard.groups) groups.push(summarizeGuardSet(g.label, mergeGuardSets(guard.guards, g.guards)));
    if (wallet) await fillMintLimitUsage('core', umi, groups, candyMachineAddr, candyGuardAddr, wallet);
  } else {
    alive = false;
  }

  return { alive, candyMachine: candyMachineAddr, candyGuard: candyGuardAddr, collection, itemsRedeemed, itemsAvailable, groups };
}

async function inspectLegacy(candyMachineAddr: string, candyGuardAddr: string, wallet?: string | null): Promise<CandyMachineInspection> {
  const umi = createUmi(rpcUrl()).use(mplLegacyCandyMachine());
  let itemsRedeemed: string | null = null;
  let itemsAvailable: string | null = null;
  let collection: string | null = null;
  let alive = true;
  try {
    const cm = await fetchLegacyCandyMachine(umi, umiPublicKey(candyMachineAddr));
    itemsRedeemed = cm.itemsRedeemed.toString();
    itemsAvailable = cm.data.itemsAvailable.toString();
    collection = cm.collectionMint.toString();
  } catch (err) {
    // Only a genuine "this account doesn't exist" means closed. A 429/
    // network blip from a burst of rapid calls (batch-mint, wallet-switch
    // background refresh) threw the same generic error here and got
    // reported as "closed" indistinguishably — a transient RPC hiccup
    // isn't the same fact as "sold out and rent-reclaimed", and battle-
    // testing a 10x batch surfaced exactly that false positive live.
    if (err instanceof AccountNotFoundError) alive = false;
    else throw err;
  }

  const groups: GuardGroupSummary[] = [];
  const guard = await safeFetchLegacyCandyGuard(umi, umiPublicKey(candyGuardAddr));
  if (guard) {
    if (guard.groups.length === 0) groups.push(summarizeGuardSet(null, guard.guards));
    else for (const g of guard.groups) groups.push(summarizeGuardSet(g.label, mergeGuardSets(guard.guards, g.guards)));
    if (wallet) await fillMintLimitUsage('legacy', umi, groups, candyMachineAddr, candyGuardAddr, wallet);
  } else {
    alive = false;
  }

  return { alive, candyMachine: candyMachineAddr, candyGuard: candyGuardAddr, collection, itemsRedeemed, itemsAvailable, groups };
}

export async function inspectCandyMachine(
  family: CandyMintFamily,
  candyMachineAddr: string,
  candyGuardAddr: string,
  wallet?: string | null,
): Promise<CandyMachineInspection> {
  return family === 'core'
    ? inspectCore(candyMachineAddr, candyGuardAddr, wallet)
    : inspectLegacy(candyMachineAddr, candyGuardAddr, wallet);
}
