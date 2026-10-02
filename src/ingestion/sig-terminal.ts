/**
 * Cross-path memory of TERMINAL ingest outcomes (inserted / duplicate /
 * confirmed_irrelevant) per signature, written by ingestMeRaw /
 * ingestTensorRaw on every path (WS, poller, backlog).
 *
 * Why: the amm-poller trails the WS by minutes under backlog. When it reached a
 * sig the WS had already ingested, fetchRawTx's 3-min dedup returned null →
 * 'retryable_error' → requeue → once the dedup expired the poller paid a second
 * getTransaction for a sale already in the DB (measured 2026-10-02: 29 of 31
 * poller "recoveries" were WS duplicates). A terminal outcome is a real
 * fetch+parse verdict, so reusing it is cursor-safe; retryable_error is never
 * stored, so genuinely failed sigs still get retried.
 */
import type { IngestOutcome } from './ingest-outcome';

const TTL_MS = 30 * 60_000;
const MAX    = 100_000;
const terminal = new Map<string, { o: IngestOutcome; exp: number }>();
export const sigTerminalStats = { stored: 0, used: 0 };

export function noteIngestOutcome(sig: string, o: IngestOutcome): void {
  if (o === 'retryable_error') return;
  if (terminal.size >= MAX) {
    const now = Date.now();
    for (const [s, e] of terminal) { if (e.exp < now) terminal.delete(s); }
    if (terminal.size >= MAX) terminal.delete(terminal.keys().next().value!);
  }
  terminal.set(sig, { o, exp: Date.now() + TTL_MS });
  sigTerminalStats.stored++;
}

export function terminalOutcome(sig: string): IngestOutcome | null {
  const e = terminal.get(sig);
  if (!e) return null;
  if (Date.now() > e.exp) { terminal.delete(sig); return null; }
  return e.o;
}

setInterval(() => {
  console.log(`[sig-terminal] stored=${sigTerminalStats.stored} used=${sigTerminalStats.used} live=${terminal.size}`);
  sigTerminalStats.stored = sigTerminalStats.used = 0;
}, 5 * 60_000).unref();
