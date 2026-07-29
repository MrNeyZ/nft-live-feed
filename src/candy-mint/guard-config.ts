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
import { publicKey as umiPublicKey, type Context } from '@metaplex-foundation/umi';
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
import type { CandyMintFamily } from './decode';

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
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
  mintLimit: MintLimitStatus | null;
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

function summarizeGuardSet(
  label: string | null,
  guards: CoreDefaultGuardSet | LegacyDefaultGuardSet,
): GuardGroupSummary {
  const enabled: string[] = [];
  const unsupported: string[] = [];
  let solPaymentLamports: string | null = null;
  let mintLimit: MintLimitStatus | null = null;
  for (const [name, wrapped] of Object.entries(guards)) {
    const opt = wrapped as { __option: 'Some' | 'None'; value?: unknown } | undefined;
    if (!opt || opt.__option !== 'Some') continue;
    enabled.push(name);
    if (!SUPPORTED_GUARDS.has(name)) unsupported.push(name);
    if (name === 'solPayment') {
      const v = opt.value as { lamports?: { basisPoints?: bigint } } | undefined;
      if (v?.lamports?.basisPoints != null) solPaymentLamports = v.lamports.basisPoints.toString();
    }
    if (name === 'mintLimit') {
      const v = opt.value as { id: number; limit: number };
      mintLimit = { id: v.id, limit: v.limit, used: null, remaining: null };
    }
  }
  return {
    label,
    enabledGuards: enabled,
    unsupportedGuards: unsupported,
    supported: unsupported.length === 0,
    solPaymentLamports,
    mintLimit,
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
  } catch {
    alive = false;
  }

  const groups: GuardGroupSummary[] = [];
  const guard = await safeFetchCoreCandyGuard(umi, umiPublicKey(candyGuardAddr));
  if (guard) {
    if (guard.groups.length === 0) groups.push(summarizeGuardSet(null, guard.guards));
    else for (const g of guard.groups) groups.push(summarizeGuardSet(g.label, g.guards));
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
  } catch {
    alive = false;
  }

  const groups: GuardGroupSummary[] = [];
  const guard = await safeFetchLegacyCandyGuard(umi, umiPublicKey(candyGuardAddr));
  if (guard) {
    if (guard.groups.length === 0) groups.push(summarizeGuardSet(null, guard.guards));
    else for (const g of guard.groups) groups.push(summarizeGuardSet(g.label, g.guards));
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
