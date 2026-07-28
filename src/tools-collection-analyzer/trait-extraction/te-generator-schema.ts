/**
 * Trait Extraction - generator-schema.json builder. Pure, deterministic.
 *
 * "Mandatory" vs "optional" is estimated purely from coverage: a category
 * present on every scanned asset is "mandatory"; anything less is
 * "optional". No layer order is claimed or invented (spec section 12).
 */
import type { NormalizedAsset } from '../types';
import type { GeneratorSchema, GeneratorSchemaCategory, TraitValueEvidence, TraitExtractionJobRecord } from './te-types';

export function buildGeneratorSchema(args: {
  collectionAddress: string;
  exactScannedAssetCount: number;
  assets: NormalizedAsset[];
  selectedCategories: string[];
  evidence: TraitValueEvidence[];
  unresolvedValues: TraitExtractionJobRecord['unresolvedValues'];
  generatedAt: string;
}): GeneratorSchema {
  const { assets, selectedCategories, evidence, unresolvedValues } = args;

  const categoryAssetCount = new Map<string, number>();
  const categoryValueCounts = new Map<string, Map<string, number>>();
  for (const asset of assets) {
    const seenCategories = new Set<string>();
    for (const attr of asset.attributes) {
      seenCategories.add(attr.trait_type);
      let values = categoryValueCounts.get(attr.trait_type);
      if (!values) { values = new Map(); categoryValueCounts.set(attr.trait_type, values); }
      values.set(attr.value, (values.get(attr.value) ?? 0) + 1);
    }
    for (const cat of seenCategories) categoryAssetCount.set(cat, (categoryAssetCount.get(cat) ?? 0) + 1);
  }

  const evidenceByKey = new Map(evidence.map((e) => [`${e.traitType} ${e.traitValue}`, e]));

  const categories: GeneratorSchemaCategory[] = [...categoryValueCounts.entries()]
    .filter(([traitType]) => selectedCategories.includes(traitType))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([traitType, values]) => {
      const total = args.exactScannedAssetCount;
      const coverage = categoryAssetCount.get(traitType) ?? 0;
      return {
        traitType,
        mandatoryEstimate: (total > 0 && coverage === total ? 'mandatory' : total > 0 ? 'optional' : 'unknown') as 'mandatory' | 'optional' | 'unknown',
        values: [...values.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([value, occurrenceCount]) => {
            const ev = evidenceByKey.get(`${traitType} ${value}`);
            return {
              value,
              occurrenceCount,
              percent: total > 0 ? Math.round((occurrenceCount / total) * 10000) / 100 : 0,
              extracted: !!ev,
              confidence: ev?.confidence.status,
              score: ev?.confidence.score,
              outputDirKey: ev?.outputDirKey,
            };
          }),
      };
    });

  return {
    collectionAddress: args.collectionAddress,
    exactScannedAssetCount: args.exactScannedAssetCount,
    categories,
    selectedCategories,
    extractedFileCount: evidence.reduce((s, e) => s + [e.outputFiles.candidate, e.outputFiles.candidateExpanded, e.outputFiles.changeMask, e.outputFiles.uncertaintyMask, e.outputFiles.preview].filter(Boolean).length, 0),
    unresolvedValues,
    generatedAt: args.generatedAt,
    note: 'mandatoryEstimate is derived purely from per-asset coverage in the scanned collection. No original layer/compositing order is known or claimed by this tool.',
  };
}
