/**
 * Collection Analyzer — Stage 2 CSV export.
 *
 * Pure, deterministic. Column order: fixed identity fields first
 * (mint/name/image/jsonUri/collectionAddress/compressed), then one column
 * per discovered trait category sorted alphabetically — same ordering the
 * trait-category summary already uses, so the CSV and the JSON summary
 * agree on category order.
 */
import type { NormalizedAsset } from './types';

const IDENTITY_COLUMNS = ['mint', 'name', 'image', 'jsonUri', 'collectionAddress', 'compressed'] as const;

/** RFC-4180-style escaping: wrap in quotes when the value contains a comma,
 *  quote, CR, or LF; double any internal quote. Never returns unquoted
 *  content that could merge with an adjacent column. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Deterministic column set: fixed identity fields, then every distinct
 *  trait_type observed across `assets`, sorted alphabetically. */
export function buildCsvColumns(assets: NormalizedAsset[]): string[] {
  const traitTypes = new Set<string>();
  for (const a of assets) for (const attr of a.attributes) traitTypes.add(attr.trait_type);
  return [...IDENTITY_COLUMNS, ...[...traitTypes].sort((a, b) => a.localeCompare(b))];
}

/** Builds the full CSV text (header + one row per asset). Trait columns a
 *  given asset lacks are emitted as an empty cell, never omitted/shifted. */
export function buildAssetsCsv(assets: NormalizedAsset[]): string {
  const columns = buildCsvColumns(assets);
  const traitColumns = columns.slice(IDENTITY_COLUMNS.length);

  const lines: string[] = [columns.map(csvEscape).join(',')];
  for (const a of assets) {
    const byTrait = new Map(a.attributes.map((attr) => [attr.trait_type, attr.value]));
    const row = [
      a.mint,
      a.name ?? '',
      a.image ?? '',
      a.jsonUri ?? '',
      a.collectionAddress ?? '',
      String(a.compressed),
      ...traitColumns.map((t) => byTrait.get(t) ?? ''),
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}
