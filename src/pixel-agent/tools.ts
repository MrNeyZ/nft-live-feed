/**
 * Evaluation schema (v2) + parser — shared trait-grading data shape.
 *
 * Originally this file also held the Anthropic tool-use schemas
 * (`submit_draft`/`REFINE_TOOLS`/`REPAIR_TOOLS`/`submit_evaluation`) and the
 * executor that dispatched them against a `Canvas`, for the Claude
 * drawing-agent loop in agent-loop.ts. That runtime was removed (Pixel
 * Forge no longer depends on Anthropic to draw images — see
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md), so only the
 * `Evaluation` type + `parseEvaluation` remain: they're still load-bearing
 * for the shared `TraitAsset` schema (store.ts) and for the raster
 * pipeline's raster-imported traits, which populate `evaluation` with an
 * honest "not applicable" placeholder shaped like this schema (see
 * src/server/tools-pixel-forge-raster.ts's `importPlaceholderEvaluation`).
 */

// ── Evaluation schema v2 (RepairPlan raw material) ─────────────────────────
// See docs/pixel-forge-revision-v3.md §7. Supersedes the v1 shape (flat
// cleanSilhouette/readableAtNativeSize/noStrayPixels/transparentBgPreserved/
// matchesLayerType booleans + missingFeatures + notes) — those five checks
// are now ordinary `issues`, tagged with category `silhouette` /
// `technical_hygiene` / `trait_specific` respectively, present only when
// something is actually wrong instead of five always-present booleans.

export const EVALUATION_SCHEMA_VERSION = 2;

export const REPAIR_CATEGORIES = [
  'silhouette', 'recognizability', 'face', 'eye', 'palette', 'hue_shift',
  'outline', 'material', 'lighting', 'cluster', 'composition', 'background',
  'trait_specific', 'technical_hygiene', 'other',
] as const;
export type RepairCategory = typeof REPAIR_CATEGORIES[number];

export const REPAIR_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type RepairSeverity = typeof REPAIR_SEVERITIES[number];

export interface RepairItem {
  /** Short id unique within one evaluation call, e.g. "R1" — used so
   *  `dependsOn` can reference a sibling issue from the same call. Not a
   *  stable cross-call identity; repair-plan.ts matches issues across
   *  revisions by (category, location similarity), not by this id. */
  id: string;
  category: RepairCategory;
  severity: RepairSeverity;
  /** Plain-language region — "left ear", "background upper-right
   *  quadrant", "whole silhouette". Deliberately prose, not pixel
   *  coordinates — see pixel-forge-revision-v3.md §9. */
  location: string;
  problem: string;
  reason: string;
  repairStrategy: string;
  expectedResult: string;
  /** ids of other issues in this same list that must land first, if any —
   *  usually empty; tiering (repair-plan.ts) handles most ordering. */
  dependsOn: string[];
}

export interface PreserveItem {
  id: string;
  description: string;
  reason: string;
}

export interface Evaluation {
  schemaVersion: number;
  /** Written cold, before any other field — describe the render as a
   *  stranger seeing it for the first time, no reference to the intended
   *  subject. The Tier-2 recognizability mechanism, finally implemented. */
  blindDescription: string;
  /** The one deliberately-kept standalone boolean — see
   *  pixel-forge-revision-v3.md §7.3 for why this isn't folded into
   *  `issues` the way every other former boolean check was. */
  recognizableAsSubject: boolean;
  /** Empty if nothing is wrong — sparse by construction, never padded. */
  issues: RepairItem[];
  preserve: PreserveItem[];
  doNotModify: string[];
  intentionalChoices: string[];
  notes: string;
}

function isRepairCategory(v: unknown): v is RepairCategory {
  return typeof v === 'string' && (REPAIR_CATEGORIES as readonly string[]).includes(v);
}
function isRepairSeverity(v: unknown): v is RepairSeverity {
  return typeof v === 'string' && (REPAIR_SEVERITIES as readonly string[]).includes(v);
}
function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parseRepairItem(input: unknown, index: number): RepairItem {
  const i = (input ?? {}) as Record<string, unknown>;
  return {
    id: asString(i.id) || `R${index + 1}`,
    category: isRepairCategory(i.category) ? i.category : 'other',
    severity: isRepairSeverity(i.severity) ? i.severity : 'major',
    location: asString(i.location),
    problem: asString(i.problem),
    reason: asString(i.reason),
    repairStrategy: asString(i.repairStrategy),
    expectedResult: asString(i.expectedResult),
    dependsOn: asStringArray(i.dependsOn),
  };
}

function parsePreserveItem(input: unknown, index: number): PreserveItem {
  const i = (input ?? {}) as Record<string, unknown>;
  return {
    id: asString(i.id) || `P${index + 1}`,
    description: asString(i.description),
    reason: asString(i.reason),
  };
}

/** Defensive parse of a stored/incoming evaluation blob — every field is
 *  coerced to a safe default rather than throwing. */
export function parseEvaluation(input: unknown): Evaluation {
  const i = (input ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    blindDescription: asString(i.blindDescription),
    recognizableAsSubject: Boolean(i.recognizableAsSubject),
    issues: Array.isArray(i.issues) ? i.issues.map(parseRepairItem) : [],
    preserve: Array.isArray(i.preserve) ? i.preserve.map(parsePreserveItem) : [],
    doNotModify: asStringArray(i.doNotModify),
    intentionalChoices: asStringArray(i.intentionalChoices),
    notes: asString(i.notes),
  };
}
