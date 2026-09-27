/**
 * Phygitals (tokenized graded trading cards) runs its peer-to-peer market on
 * Tensor's TComp program — listings/buys in USDC with Phygitals as broker —
 * so these sales parse as plain `tensor`. They never show on tensor.trade, so
 * the feed badges them as `phygitals` instead. Every Phygitals card is an MPL
 * Core asset in this one collection, and a TComp Core buy always passes the
 * collection account, so its presence in the tx identifies the sale.
 */
import type { HeliusEnhancedTransaction } from '../helius/types';
import type { RawSolanaTx } from './types';

export const PHYGITALS_COLLECTION = 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC';

export function isPhygitalsRawTx(tx: RawSolanaTx): boolean {
  const staticKeys = tx.transaction.message.accountKeys as unknown as Array<string | { pubkey: string }>;
  if (staticKeys.some((k) => (typeof k === 'string' ? k : k.pubkey) === PHYGITALS_COLLECTION)) return true;
  const loaded = tx.meta?.loadedAddresses;
  return !!loaded && [...(loaded.writable ?? []), ...(loaded.readonly ?? [])].includes(PHYGITALS_COLLECTION);
}

export function isPhygitalsHeliusTx(tx: HeliusEnhancedTransaction): boolean {
  return tx.instructions.some((ix) =>
    ix.accounts?.includes(PHYGITALS_COLLECTION)
    || ix.innerInstructions?.some((inner) => inner.accounts?.includes(PHYGITALS_COLLECTION)));
}
