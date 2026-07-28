/**
 * trait-extractor-cli - terminal progress reporter.
 *
 * Always writes to stderr, never stdout - `--json` reserves stdout for the
 * single final machine-readable summary line, so piping/redirecting stdout
 * (`... > result.json`) never picks up human progress noise.
 */
import type { TraitExtractionProgressSnapshot } from 'trait-extraction-core';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export class ProgressReporter {
  private lastLineLength = 0;
  private readonly isTty = process.stderr.isTTY === true;

  line(text: string): void {
    if (this.isTty) {
      process.stderr.write(`\r${' '.repeat(this.lastLineLength)}\r${text}`);
      this.lastLineLength = text.length;
    } else {
      process.stderr.write(`${text}\n`);
    }
  }

  done(): void {
    if (this.isTty && this.lastLineLength > 0) process.stderr.write('\n');
    this.lastLineLength = 0;
  }

  log(text: string): void {
    if (this.isTty && this.lastLineLength > 0) process.stderr.write('\n');
    this.lastLineLength = 0;
    process.stderr.write(`${text}\n`);
  }

  onProgress(p: TraitExtractionProgressSnapshot): void {
    const pct = p.totalValues > 0 ? Math.round((p.processedValues / p.totalValues) * 100) : 0;
    const current = p.currentTraitValue ? ` | ${p.currentCategory} = ${p.currentTraitValue}` : '';
    this.line(
      `[${p.phase}] ${p.processedValues}/${p.totalValues} (${pct}%)${current} | `
      + `images ${p.uniqueImagesDownloaded} (${fmtBytes(p.bytesDownloaded)}) | `
      + `high ${p.resolvedHigh} med ${p.resolvedMedium} low ${p.resolvedLow} unresolved ${p.resolvedUnresolved} | `
      + `${Math.round(p.elapsedMs / 1000)}s`,
    );
  }
}
