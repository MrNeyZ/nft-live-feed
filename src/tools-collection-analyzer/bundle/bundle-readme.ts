/**
 * Collection Analyzer - Stage 3 README.txt generator. Pure, deterministic.
 */
import type { BundleOptions } from './bundle-types';

export interface ReadmeInputs {
  collectionAddress: string;
  scanCompletedAt: string;
  exactAssetCount: number;
  bundleGeneratedAt: string;
  options: BundleOptions;
  successfulImages: number;
  failedImages: number;
  successfulOriginalMetadata: number;
  failedOriginalMetadata: number;
}

const OPTION_LABEL: Record<keyof BundleOptions, string> = {
  images: 'Images',
  normalizedMetadata: 'Per-NFT normalized metadata JSON',
  originalMetadata: 'Original off-chain metadata JSON',
  collectionSummary: 'Collection summary',
  assetsJson: 'Assets JSON',
  assetsCsv: 'Assets CSV',
  traitCounts: 'Trait counts',
  failureReport: 'Failure report',
};

export function buildReadmeText(inputs: ReadmeInputs): string {
  const selected = (Object.keys(inputs.options) as Array<keyof BundleOptions>)
    .filter((k) => inputs.options[k])
    .map((k) => `  - ${OPTION_LABEL[k]}`)
    .join('\n');

  const lines: string[] = [
    'VictoryLabs Collection Analyzer - Collection Bundle',
    '=====================================================',
    '',
    `Collection address:     ${inputs.collectionAddress}`,
    `Scan completed:          ${inputs.scanCompletedAt}`,
    `Exact asset count:       ${inputs.exactAssetCount}`,
    `Bundle generated:        ${inputs.bundleGeneratedAt}`,
    '',
    'Selected bundle contents:',
    selected || '  (none)',
    '',
  ];

  if (inputs.options.images) {
    lines.push(`Images:     ${inputs.successfulImages} succeeded, ${inputs.failedImages} failed.`);
  }
  if (inputs.options.originalMetadata) {
    lines.push(`Original metadata: ${inputs.successfulOriginalMetadata} succeeded, ${inputs.failedOriginalMetadata} failed.`);
  }
  if (inputs.options.failureReport) {
    lines.push('See failed-downloads.json for per-asset failure details.');
  }

  lines.push(
    '',
    'Notes:',
    '  - Attributes/traits are based on PUBLIC NFT metadata as indexed by',
    '    Helius DAS at scan time - they are not independently verified.',
    '  - This bundle does NOT include the original layered/source artwork',
    '    (PSD/trait-layer files) used to generate the collection - only the',
    '    final rendered per-NFT image and its associated metadata.',
    '  - Images and original metadata are fetched read-only from their',
    '    public off-chain hosts (Arweave/IPFS/etc.) at bundle-generation',
    '    time; a host being slow, down, or gone can cause individual',
    '    failures without failing the whole bundle.',
    '',
  );

  return lines.join('\n');
}
