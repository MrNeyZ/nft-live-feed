/**
 * trait-extractor-cli - leveled structured logger (Stage 5.4 section 6).
 *
 * Replaces Stage 5.3's `ProgressReporter` entirely - same stderr-only,
 * TTY-aware single-line-overwrite progress rendering (verbatim behavior,
 * `--json` still reserves stdout for the final machine-readable summary),
 * plus real levels (`--quiet/--normal/--verbose/--debug`) and an in-memory
 * event log that `execution-report.ts` turns into the structured JSON
 * report - every call is logged exactly once, nothing needs logging twice
 * for the report vs. the terminal.
 */
import type { LogLevel } from './args';
import type { TraitExtractionProgressSnapshot } from 'trait-extraction-core';

const LEVEL_ORDER: Record<LogLevel, number> = { quiet: 0, normal: 1, verbose: 2, debug: 3 };

export interface LogEvent {
  ts: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  data?: unknown;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export class Logger {
  private lastLineLength = 0;
  private readonly isTty = process.stderr.isTTY === true;
  private readonly events: LogEvent[] = [];

  constructor(private readonly level: LogLevel = 'normal') {}

  getEvents(): readonly LogEvent[] { return this.events; }

  private allowed(min: LogLevel): boolean { return LEVEL_ORDER[this.level] >= LEVEL_ORDER[min]; }

  private record(level: LogEvent['level'], message: string, data?: unknown): void {
    this.events.push({ ts: new Date().toISOString(), level, message, data });
  }

  private breakLineIfNeeded(): void {
    if (this.isTty && this.lastLineLength > 0) process.stderr.write('\n');
    this.lastLineLength = 0;
  }

  /** Errors always print, even under --quiet - quiet means "don't narrate
   *  progress," not "hide failures." */
  error(message: string, data?: unknown): void {
    this.record('error', message, data);
    this.breakLineIfNeeded();
    process.stderr.write(`Error: ${message}\n`);
  }

  warn(message: string, data?: unknown): void {
    this.record('warn', message, data);
    if (!this.allowed('normal')) return;
    this.breakLineIfNeeded();
    process.stderr.write(`Warning: ${message}\n`);
  }

  info(message: string, data?: unknown): void {
    this.record('info', message, data);
    if (!this.allowed('normal')) return;
    this.breakLineIfNeeded();
    process.stderr.write(`${message}\n`);
  }

  /** Only surfaces at --verbose and above (timings/cache-hits/retries/
   *  resume events - spec section 6's explicit list) - always recorded in
   *  the event log regardless of level, so the JSON report has it even
   *  when the terminal doesn't. */
  verbose(message: string, data?: unknown): void {
    this.record('info', message, data);
    if (!this.allowed('verbose')) return;
    this.breakLineIfNeeded();
    process.stderr.write(`${message}\n`);
  }

  debug(message: string, data?: unknown): void {
    this.record('debug', message, data);
    if (!this.allowed('debug')) return;
    this.breakLineIfNeeded();
    process.stderr.write(`[debug] ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}\n`);
  }

  /** Verbatim port of ProgressReporter.onProgress: TTY-aware single-line
   *  overwrite (one line per tick when piped), extended with an ETA field
   *  computed from processedValues/totalValues/elapsedMs. Suppressed
   *  entirely under --quiet. */
  progress(p: TraitExtractionProgressSnapshot): void {
    if (!this.allowed('normal')) return;
    const pct = p.totalValues > 0 ? Math.round((p.processedValues / p.totalValues) * 100) : 0;
    const current = p.currentTraitValue ? ` | ${p.currentCategory} = ${p.currentTraitValue}` : '';
    const etaMs = p.processedValues > 0 && p.processedValues < p.totalValues
      ? Math.round((p.elapsedMs / p.processedValues) * (p.totalValues - p.processedValues))
      : null;
    const eta = etaMs !== null ? ` | ETA ${Math.round(etaMs / 1000)}s` : '';
    const text = `[${p.phase}] ${p.processedValues}/${p.totalValues} (${pct}%)${current} | `
      + `images ${p.uniqueImagesDownloaded} (${fmtBytes(p.bytesDownloaded)}) | `
      + `high ${p.resolvedHigh} med ${p.resolvedMedium} low ${p.resolvedLow} unresolved ${p.resolvedUnresolved} | `
      + `${Math.round(p.elapsedMs / 1000)}s${eta}`;
    if (this.isTty) {
      process.stderr.write(`\r${' '.repeat(this.lastLineLength)}\r${text}`);
      this.lastLineLength = text.length;
    } else {
      process.stderr.write(`${text}\n`);
    }
  }

  /** Ends a run of progress() overwrites with a trailing newline - call
   *  once a phase's ticking is done, mirroring ProgressReporter.done(). */
  endProgress(): void {
    if (this.isTty && this.lastLineLength > 0) process.stderr.write('\n');
    this.lastLineLength = 0;
  }
}
