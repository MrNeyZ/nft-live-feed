/**
 * Deterministic repair-plan assembly — turns a fresh `Evaluation` (this
 * round's self-grade) plus the trait's previous `RepairPlan` (if any) into
 * the next `RepairPlan`: tiered, prioritized, resolved issues dropped,
 * regressions escalated, active set bounded by turn budget.
 *
 * Pure functions only — no model calls, no I/O. Sequencing (which tier a
 * category belongs to) is a fixed lookup table computed here in code, not
 * re-derived by the model on every evaluation — see
 * docs/pixel-forge-revision-v3.md §2/§5 for why that split matters.
 *
 * Called once per job, after the evaluate step resolves, by the route
 * handler in src/server/tools-pixel-forge.ts — never from inside the
 * model loop itself.
 */

import { Evaluation, PreserveItem, RepairCategory, RepairItem, RepairSeverity } from './tools';

export type RepairTierLabel = 'Structural' | 'Features' | 'Rendering' | 'Composition/Background' | 'Polish';

export interface RepairTier {
  tier: number;
  label: RepairTierLabel;
  issueIds: string[];
}

export interface StoredRepairItem extends RepairItem {
  /** How many revision rounds this issue has survived unresolved. 0 on
   *  first appearance. */
  attempts: number;
  /** Revision number (TraitAsset.revision) this issue was first seen at. */
  firstSeenRevision: number;
  /** True if this round's evaluation found this issue's region overlapping
   *  something the previous plan explicitly said was good/locked — forces
   *  front-of-tier-1 processing regardless of category. See §6.3. */
  regressed: boolean;
}

export type OverallSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface RepairPlan {
  schemaVersion: number;
  /** TraitAsset.revision this plan was computed against/for. */
  sourceRevision: number;
  /** The original prompt/intent — carried forward so a revision job never
   *  has to re-derive what the subject is supposed to be. */
  subject: string;
  /** = this round's Evaluation.blindDescription — "what a stranger sees
   *  right now." */
  currentDescription: string;
  /** Active repair set for this round — bounded by MAX_ACTIVE_ISSUES. */
  issues: StoredRepairItem[];
  preserve: PreserveItem[];
  doNotModify: string[];
  intentionalChoices: string[];
  /** Known but not actively worked this round (turn-budget overflow) —
   *  fully specified, carried forward verbatim, promoted once room opens
   *  up. Never silently dropped. */
  deferred: StoredRepairItem[];
  /** Computed processing order — references `issues[].id` only, never
   *  repeats problem/strategy text. */
  sequence: RepairTier[];
  /** = issues[].expectedResult, plus a fixed preserve/doNotModify line —
   *  a flat projection for convenience, not independently authored. */
  successCriteria: string[];
  /** Computed from `issues` (max severity present, or 'none') — never
   *  authored by the model, so it can never disagree with its own data. */
  overallSeverity: OverallSeverity;
  createdAt: number;
}

export const REPAIR_PLAN_SCHEMA_VERSION = 1;

/** Roughly six — see docs/pixel-forge-revision-v3.md §6.5. Turn budgets
 *  are finite ($5-budget tool, HARD_MAX_TURNS=15); beyond this many open
 *  issues, the lowest-severity tail waits in `deferred` instead of
 *  overloading one round. */
const MAX_ACTIVE_ISSUES = 6;

/** After this many unresolved attempts, severity escalates one notch —
 *  see §6.4. The companion rule ("propose a different repairStrategy, not
 *  a re-phrasing of what already failed") is an instruction to the model
 *  in agent-loop.ts's evaluate prompt, not something this module can
 *  enforce structurally. */
const ESCALATE_AFTER_ATTEMPTS = 2;

const CATEGORY_TIER: Record<RepairCategory, { tier: number; label: RepairTierLabel }> = {
  // Tier 1 — Structural. trait_specific (layer-role/attachment
  // requirements, e.g. "accessory needs a strap") is grouped here rather
  // than with Polish: an attachment point is a silhouette-level addition,
  // and fixing it after features/rendering work would risk the same
  // invalidation problem tiering exists to prevent.
  silhouette:        { tier: 1, label: 'Structural' },
  recognizability:   { tier: 1, label: 'Structural' },
  trait_specific:    { tier: 1, label: 'Structural' },
  // Tier 2 — Features. Depend on the final silhouette, independent of
  // rendering.
  face:              { tier: 2, label: 'Features' },
  eye:               { tier: 2, label: 'Features' },
  // Tier 3 — Rendering. Surface treatment on a now-stable shape. Lighting
  // sits here (not its own tier) because it depends on material being
  // finalized, not on tiers 1-2.
  palette:           { tier: 3, label: 'Rendering' },
  hue_shift:         { tier: 3, label: 'Rendering' },
  material:          { tier: 3, label: 'Rendering' },
  outline:           { tier: 3, label: 'Rendering' },
  cluster:           { tier: 3, label: 'Rendering' },
  lighting:          { tier: 3, label: 'Rendering' },
  // Tier 4 — Composition/Background. Background complexity is budgeted
  // against the character's FINAL complexity, so it must come after
  // material/feature decisions are settled.
  composition:       { tier: 4, label: 'Composition/Background' },
  background:        { tier: 4, label: 'Composition/Background' },
  // Tier 5 — Polish. Cheap, non-invalidating, always safe last.
  technical_hygiene: { tier: 5, label: 'Polish' },
  other:             { tier: 5, label: 'Polish' },
};

const SEVERITY_RANK: Record<RepairSeverity, number> = { critical: 0, major: 1, minor: 2 };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Token-overlap ratio (shared words / smaller token set size) — a cheap,
 *  dependency-free stand-in for "do these two descriptions point at the
 *  same region." Not exact; see matchPrevious for the fallback when it's
 *  ambiguous. */
function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const LOCATION_MATCH_THRESHOLD = 0.34;

/** Matches a freshly-reported issue against the previous plan's still-open
 *  issues by (category, location-text similarity). The evaluator has no
 *  stable identity for a visual problem across two separate calls, so
 *  this is a pragmatic heuristic, not an id lookup — see
 *  pixel-forge-revision-v3.md §6.2. When ambiguous, the safer default is
 *  treating it as a continuation of the highest-severity open issue in
 *  the same category (losing escalation pressure on a stuck problem is
 *  worse than occasionally conflating two same-category issues). */
function matchPrevious(fresh: RepairItem, previousOpen: readonly StoredRepairItem[]): StoredRepairItem | null {
  const sameCategory = previousOpen.filter(p => p.category === fresh.category);
  if (sameCategory.length === 0) return null;
  const scored = sameCategory
    .map(p => ({ p, score: tokenOverlap(p.location, fresh.location) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score >= LOCATION_MATCH_THRESHOLD) return scored[0].p;
  return [...sameCategory].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
}

/** A fresh issue counts as a regression if its location text overlaps
 *  something the previous plan explicitly said was good or locked. */
function overlapsProtected(fresh: RepairItem, previous: { preserve: readonly PreserveItem[]; doNotModify: readonly string[] }): boolean {
  const candidates: string[] = [...previous.preserve.map(p => p.description), ...previous.doNotModify];
  return candidates.some(c => tokenOverlap(c, fresh.location) >= LOCATION_MATCH_THRESHOLD);
}

function escalate(severity: RepairSeverity): RepairSeverity {
  if (severity === 'minor') return 'major';
  return 'critical';
}

export function computeOverallSeverity(issues: readonly { severity: RepairSeverity }[]): OverallSeverity {
  if (issues.some(i => i.severity === 'critical')) return 'critical';
  if (issues.some(i => i.severity === 'major')) return 'major';
  if (issues.length > 0) return 'minor';
  return 'none';
}

/** Regressions jump to the front of tier 1 regardless of their own
 *  category's natural tier; within that, ascending tier then severity. */
function buildSequence(issues: readonly StoredRepairItem[]): RepairTier[] {
  const byTier = new Map<number, { label: RepairTierLabel; ids: string[] }>();
  const ordered = [...issues].sort((a, b) => {
    if (a.regressed !== b.regressed) return a.regressed ? -1 : 1;
    const ta = a.regressed ? 1 : CATEGORY_TIER[a.category].tier;
    const tb = b.regressed ? 1 : CATEGORY_TIER[b.category].tier;
    if (ta !== tb) return ta - tb;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
  for (const issue of ordered) {
    const tier = issue.regressed ? 1 : CATEGORY_TIER[issue.category].tier;
    const label = issue.regressed ? 'Structural' : CATEGORY_TIER[issue.category].label;
    if (!byTier.has(tier)) byTier.set(tier, { label, ids: [] });
    byTier.get(tier)!.ids.push(issue.id);
  }
  return [...byTier.entries()].sort(([a], [b]) => a - b).map(([tier, v]) => ({ tier, label: v.label, issueIds: v.ids }));
}

export interface BuildRepairPlanParams {
  sourceRevision: number;
  subject: string;
  evaluation: Evaluation;
  previousPlan: RepairPlan | null;
  now: number;
}

/** id used for the synthesized recognizability issue — see the evaluator
 *  consistency invariant below. Stable across revisions of the same trait
 *  (matchPrevious/carry-forward matches it by category+location like any
 *  other issue, so `attempts`/escalation still work normally if it
 *  persists), and instantly greppable in stored data as distinct from a
 *  real evaluator-authored issue. */
const SYNTHETIC_RECOGNIZABILITY_ISSUE_ID = 'synthetic-recognizability';

/** The evaluator consistency invariant (see the evaluator-consistency
 *  audit): `recognizableAsSubject: false` with an empty `issues` array is
 *  an impossible state that must never reach the rest of this function —
 *  it would otherwise produce an empty RepairPlan, which the revision gate
 *  reads as "nothing to fix" and the validation summary reads as
 *  "converged," even though the evaluator itself just said the render
 *  doesn't match the subject. When the evaluator fails to itemize why,
 *  synthesize exactly one critical `recognizability` issue so the tiering/
 *  severity logic below — otherwise completely unchanged — has something
 *  real to act on. Logged (not silent) specifically so this is a visible
 *  evaluator-compliance signal, not a quiet workaround: the synthetic issue
 *  never appears in the stored `Evaluation` itself, only in the derived
 *  RepairPlan, so without this log line the gap could go unnoticed even
 *  though revisions start "working" again. */
function buildEffectiveIssues(evaluation: Evaluation, sourceRevision: number, subject: string): RepairItem[] {
  if (evaluation.recognizableAsSubject !== false || evaluation.issues.length > 0) {
    return evaluation.issues;
  }
  console.warn(
    `[repair-plan] evaluator consistency invariant fired for revision ${sourceRevision} `
    + `("${subject}"): recognizableAsSubject=false but issues=[] — synthesizing one critical `
    + `"${SYNTHETIC_RECOGNIZABILITY_ISSUE_ID}" issue. This means the evaluator itself failed to `
    + 'itemize why the render is not recognizable; treat repeated occurrences as a signal the '
    + 'evaluate prompt/model needs attention, not just this one trait.',
  );
  return [{
    id: SYNTHETIC_RECOGNIZABILITY_ISSUE_ID,
    category: 'recognizability',
    severity: 'critical',
    location: 'whole subject',
    problem: 'Subject is not recognizable despite no evaluator issues being itemized.',
    reason: evaluation.blindDescription
      ? `The evaluator's own blind description does not read as the intended subject: `
        + `"${evaluation.blindDescription}"`
      : 'The evaluator marked recognizableAsSubject=false but did not itemize why, and did not '
        + 'write a blindDescription either.',
    repairStrategy: 'Identify and add the specific, defining visual features that make this '
      + 'subject unmistakable — not generic properties any similar subject would share — since '
      + 'the current render does not read as the intended subject at all.',
    expectedResult: 'A cold, blind look at the render, with no reference to the original prompt, '
      + 'would unmistakably identify the intended subject.',
    dependsOn: [],
  }];
}

/** Pure — see docs/pixel-forge-revision-v3.md §6. Call once after every
 *  real evaluate step (fresh draft or revision). Do NOT call this against
 *  a stopped/ungraded evaluation (e.g. STOPPED_EVALUATION from
 *  agent-loop.ts) — its empty `issues` array would be misread as "every
 *  previous issue resolved," which is false; the caller should keep the
 *  previous plan unchanged in that case instead. This precondition also
 *  covers the evaluator consistency invariant below: STOPPED_EVALUATION
 *  happens to share the exact shape (`recognizableAsSubject: false`,
 *  `issues: []`) the invariant looks for, so calling this against a
 *  stopped run would incorrectly synthesize a "not recognizable" issue for
 *  a job that was merely interrupted, not graded as a failure. */
export function buildRepairPlan(params: BuildRepairPlanParams): RepairPlan {
  const { sourceRevision, subject, evaluation, previousPlan, now } = params;
  const previousOpen: StoredRepairItem[] = previousPlan ? [...previousPlan.issues, ...previousPlan.deferred] : [];
  const effectiveIssues = buildEffectiveIssues(evaluation, sourceRevision, subject);

  const carried: StoredRepairItem[] = [];
  const matchedIds = new Set<string>();

  for (const fresh of effectiveIssues) {
    const candidates = previousOpen.filter(p => !matchedIds.has(p.id));
    const match = matchPrevious(fresh, candidates);
    const regressed = previousPlan ? overlapsProtected(fresh, previousPlan) : false;
    if (match) {
      matchedIds.add(match.id);
      const attempts = match.attempts + 1;
      const severity = attempts >= ESCALATE_AFTER_ATTEMPTS ? escalate(fresh.severity) : fresh.severity;
      carried.push({ ...fresh, id: match.id, severity, attempts, firstSeenRevision: match.firstSeenRevision, regressed });
    } else {
      carried.push({ ...fresh, attempts: 0, firstSeenRevision: sourceRevision, regressed });
    }
  }
  // Any previousOpen item with no match above is resolved — dropped, not
  // carried forward, not re-mentioned. No value in re-stating a fixed
  // problem; doing so wastes tokens and risks re-opening something correct.

  const sorted = [...carried].sort((a, b) => {
    if (a.regressed !== b.regressed) return a.regressed ? -1 : 1;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
  const active = sorted.slice(0, MAX_ACTIVE_ISSUES);
  const deferred = sorted.slice(MAX_ACTIVE_ISSUES);

  // preserve/doNotModify/intentionalChoices are taken directly from this
  // round's fresh evaluation rather than merged with the previous plan's:
  // the evaluator looks at the current render in full every time, so its
  // fresh statement of "what's good right now" is more trustworthy than a
  // carried-forward list that could describe a region that has since
  // changed. Simpler than a merge/dedupe step, and avoids staleness.
  const successCriteria = [
    ...active.map(i => i.expectedResult),
    ...(evaluation.preserve.length > 0 || evaluation.doNotModify.length > 0
      ? ['Everything listed under Preserve/Do Not Modify remains unchanged.']
      : []),
  ];

  return {
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    sourceRevision,
    subject,
    currentDescription: evaluation.blindDescription,
    issues: active,
    preserve: evaluation.preserve,
    doNotModify: evaluation.doNotModify,
    intentionalChoices: evaluation.intentionalChoices,
    deferred,
    sequence: buildSequence(active),
    successCriteria,
    overallSeverity: computeOverallSeverity(active),
    createdAt: now,
  };
}
