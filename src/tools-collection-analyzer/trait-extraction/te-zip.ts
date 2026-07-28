/**
 * Trait Extraction - deterministic ZIP archive builder (spec section 11).
 * Streams directly to disk via yazl - never buffers the whole archive in
 * memory. Same library/pattern as bundle-zip.ts, independent module.
 */
import * as fs from 'fs';
import { ZipFile } from 'yazl';
import { sanitizeTraitName, shortHash } from './te-filenames';

export interface TraitZipValueFiles {
  traitType: string;
  outputDirKey: string;
  candidate: Buffer | null;
  candidateExpanded: Buffer | null;
  changeMask: Buffer | null;
  uncertaintyMask: Buffer | null;
  preview: Buffer | null;
  evidenceJson: string;
}

export interface TraitZipInputs {
  readmeText: string;
  eligibilityJson: string;
  extractionSummaryJson: string;
  unresolvedTraitsJson: string;
  generatorSchemaJson: string;
  values: TraitZipValueFiles[];
  contactSheets: Array<{ category: string; png: Buffer }>;
}

function categoryFolderNames(traitTypes: string[]): Map<string, string> {
  const used = new Map<string, string>();
  const out = new Map<string, string>();
  for (const t of [...new Set(traitTypes)].sort()) {
    let name = sanitizeTraitName(t);
    if (used.has(name)) name = `${name}-${shortHash(t)}`;
    used.set(name, t);
    out.set(t, name);
  }
  return out;
}

export interface TraitZipResult { bytesWritten: number }

export function buildTraitZip(inputs: TraitZipInputs, outputZipPath: string, signal: AbortSignal): Promise<TraitZipResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }

    const zip = new ZipFile();
    const root = 'trait-collection';
    const folderFor = categoryFolderNames(inputs.values.map((v) => v.traitType));

    zip.addBuffer(Buffer.from(inputs.readmeText, 'utf8'), `${root}/README.txt`);
    zip.addBuffer(Buffer.from(inputs.eligibilityJson, 'utf8'), `${root}/eligibility.json`);
    zip.addBuffer(Buffer.from(inputs.extractionSummaryJson, 'utf8'), `${root}/extraction-summary.json`);
    zip.addBuffer(Buffer.from(inputs.unresolvedTraitsJson, 'utf8'), `${root}/unresolved-traits.json`);
    zip.addBuffer(Buffer.from(inputs.generatorSchemaJson, 'utf8'), `${root}/generator-schema.json`);

    const sortedValues = [...inputs.values].sort((a, b) => (a.traitType === b.traitType ? a.outputDirKey.localeCompare(b.outputDirKey) : a.traitType.localeCompare(b.traitType)));
    for (const v of sortedValues) {
      const base = `${root}/categories/${folderFor.get(v.traitType)}/${v.outputDirKey}`;
      if (v.candidate) zip.addBuffer(v.candidate, `${base}/candidate.png`);
      if (v.candidateExpanded) zip.addBuffer(v.candidateExpanded, `${base}/candidate-expanded.png`);
      if (v.changeMask) zip.addBuffer(v.changeMask, `${base}/change-mask.png`);
      if (v.uncertaintyMask) zip.addBuffer(v.uncertaintyMask, `${base}/uncertainty-mask.png`);
      if (v.preview) zip.addBuffer(v.preview, `${base}/preview.png`);
      zip.addBuffer(Buffer.from(v.evidenceJson, 'utf8'), `${base}/evidence.json`);
    }

    for (const sheet of [...inputs.contactSheets].sort((a, b) => a.category.localeCompare(b.category))) {
      const name = folderFor.get(sheet.category) ?? sanitizeTraitName(sheet.category);
      zip.addBuffer(sheet.png, `${root}/contact-sheets/${name}.png`);
    }

    zip.end();

    const writeStream = fs.createWriteStream(outputZipPath);
    let bytesWritten = 0;
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      writeStream.destroy();
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    zip.outputStream.on('data', (chunk: Buffer) => { bytesWritten += chunk.length; });
    zip.outputStream.on('error', (err) => { if (settled) return; settled = true; cleanup(); reject(err); });
    writeStream.on('error', (err) => { if (settled) return; settled = true; cleanup(); reject(err); });
    writeStream.on('finish', () => { if (settled) return; settled = true; cleanup(); resolve({ bytesWritten }); });

    zip.outputStream.pipe(writeStream);
  });
}
