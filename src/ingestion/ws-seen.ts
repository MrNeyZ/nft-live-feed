/**
 * Diagnostics: which sigs the sales WS actually delivered, and whether it
 * dispatched them. The ingest OK log reads this for poller-path sales so we
 * can tell "Helius never delivered" apart from "WS saw it but we filtered /
 * were slower than the poller". Pure in-memory, zero RPC.
 */
const SEEN_MAX = 50_000;
const seen = new Map<string, { t: number; fired: boolean; target: string }>();

export function noteWsSeen(sig: string, target: string): void {
  if (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value!);
  seen.set(sig, { t: Date.now(), fired: false, target });
}

export function noteWsFired(sig: string): void {
  const e = seen.get(sig);
  if (e) e.fired = true;
}

/** `no` | `filtered:<target>+<age>s` | `fired:<target>+<age>s` */
export function wsSeenInfo(sig: string): string {
  const e = seen.get(sig);
  if (!e) return 'no';
  return `${e.fired ? 'fired' : 'filtered'}:${e.target}+${Math.round((Date.now() - e.t) / 1000)}s`;
}
