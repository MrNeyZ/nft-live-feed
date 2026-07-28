/**
 * trait-extraction-core - public entry point.
 *
 * Runtime-independent trait extraction: metadata indexing, diversity-aware
 * source selection, Level 0/1/2 comparison discovery, visual-impact
 * learning, weighted consensus, candidate/mask generation, confidence
 * scoring, eligibility classification, and evidence/summary generation.
 *
 * No Express/PM2/SSE/server-job-registry/frontend dependency. Consumed by
 * both the website backend (thin adapter) and the local CLI worker.
 */
export * from './asset-types';
export * from './te-types';
export * from './te-limits';
export * from './te-index';
export * from './te-diversity';
export * from './te-impact';
export * from './te-ranking';
export * from './te-comparison';
export * from './te-pixel-diff';
export * from './te-confidence';
export * from './te-eligibility';
export * from './te-png-output';
export * from './te-contact-sheet';
export * from './te-readme';
export * from './te-generator-schema';
export * from './te-filenames';
export * from './te-zip';
export * from './te-zip-read';
export * from './te-image-io';
export * from './ssrf-guard';
export * from './te-display-name';
export * from './image-acquirer';
export * from './run-extraction';
