/**
 * Pixel Forge — Validation Runner CLI (Stage 1).
 *
 * Infrastructure only — this script does not change Pixel Forge behavior.
 * It calls the exact same exported job functions the HTTP routes call
 * (`runDrawingJob` / `runRevisionJob` / `buildRepairPlan`), sequentially,
 * over a fixed prompt set, and records objective metrics. It never
 * touches `data/pixel-forge/traits/`, the HTTP layer, or `requireAuth` —
 * validation runs are completely isolated from the real trait gallery.
 *
 * See docs/pixel-forge-validation-batch.md and
 * docs/pixel-forge-quality-targets.md for the design this implements.
 *
 * Usage:
 *   npm run pixel-forge:validate -- [--model fast|normal|premium]
 *     [--max-prompts N] [--max-revisions N] [--max-turns N] [--cost-limit USD]
 *     [--prompt-file PATH] [--dry-run]
 *   --max-turns overrides PRESET_DEFAULT_MAX_TURNS[model] (1..HARD_MAX_TURNS);
 *   omit it to keep today's per-preset default unchanged.
 *
 * Smoke-test-tier convention (see docs/pixel-forge-token-cost-audit.md §5 —
 * no code enforces this, the flags above already exist; it's a standing
 * operator convention): a "smoke test" is `--model fast` + a small
 * `--max-prompts` (2-3) + a low `--max-turns` (well under the preset
 * default) + `--dry-run` first. `normal`/`premium` presets, the full prompt
 * set, or preset-default `--max-turns` are a deliberate, explicitly-approved
 * quality-benchmark run, never the default for a routine check.
 */

import 'dotenv/config'; // auto-load .env so ANTHROPIC_API_KEY is always available, matching every other src/scripts/*.ts entry point
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import {
  runDrawingJob, runRevisionJob, anthropicApiKey, DEFAULT_PALETTE,
  MODEL_PRESETS, PRESET_DEFAULT_MAX_TURNS, HARD_MAX_TURNS, ModelPreset, LayerType,
  estimateJobCostUsd, estimateJobTokenUsage, estimateCostUsd, classifyAnthropicError,
  DrawingIteration, TraitDrawResult, CallUsageRecord,
} from '../pixel-agent/agent-loop';
import { buildRepairPlan, RepairPlan, StoredRepairItem } from '../pixel-agent/repair-plan';
import { Evaluation } from '../pixel-agent/tools';

// ── Constants ───────────────────────────────────────────────────────────
const VALIDATION_RUNS_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'validation-runs');
const DEFAULT_PROMPT_FILE = path.join(VALIDATION_RUNS_DIR, 'prompt-sets', 'icons-heads-busts-v1.json');
const DEFAULT_MODEL_PRESET: ModelPreset = 'fast'; // Haiku — see validation-batch.md §4
const DEFAULT_MAX_REVISIONS = 2;
const DEFAULT_COST_LIMIT_USD = 3.0;
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = [2000, 5000];

// ── CLI args (minimal, hand-rolled — no new dependency) ────────────────
interface CliArgs {
  model: ModelPreset;
  maxPrompts: number;
  maxRevisions: number;
  costLimit: number;
  promptFile: string;
  dryRun: boolean;
  /** undefined = use the preset's own default (PRESET_DEFAULT_MAX_TURNS);
   *  set only when --max-turns is explicitly passed. */
  maxTurns: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    model: DEFAULT_MODEL_PRESET,
    maxPrompts: 20,
    maxRevisions: DEFAULT_MAX_REVISIONS,
    costLimit: DEFAULT_COST_LIMIT_USD,
    promptFile: DEFAULT_PROMPT_FILE,
    dryRun: false,
    maxTurns: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const nextValue = () => (inlineValue !== undefined ? inlineValue : argv[++i]);
    switch (flag) {
      case 'model': {
        const v = nextValue();
        if (v !== 'fast' && v !== 'normal' && v !== 'premium') {
          throw new Error(`--model must be fast|normal|premium, got "${v}"`);
        }
        out.model = v;
        break;
      }
      case 'max-prompts': out.maxPrompts = Number(nextValue()); break;
      case 'max-revisions': out.maxRevisions = Number(nextValue()); break;
      case 'cost-limit': out.costLimit = Number(nextValue()); break;
      case 'prompt-file': out.promptFile = path.resolve(nextValue()); break;
      case 'dry-run': out.dryRun = true; break;
      case 'max-turns': out.maxTurns = Number(nextValue()); break;
      default: throw new Error(`Unknown flag --${flag}`);
    }
  }
  if (!Number.isInteger(out.maxPrompts) || out.maxPrompts < 1) throw new Error('--max-prompts must be a positive integer');
  if (!Number.isInteger(out.maxRevisions) || out.maxRevisions < 0) throw new Error('--max-revisions must be a non-negative integer');
  if (!(out.costLimit > 0)) throw new Error('--cost-limit must be a positive number');
  if (out.maxTurns !== undefined && (!Number.isInteger(out.maxTurns) || out.maxTurns < 1 || out.maxTurns > HARD_MAX_TURNS)) {
    throw new Error(`--max-turns must be an integer between 1 and ${HARD_MAX_TURNS}`);
  }
  return out;
}

// ── Prompt set ──────────────────────────────────────────────────────────
interface PromptSpec {
  id: string;
  category: string;
  layerType: LayerType;
  canvasSize: number;
  prompt: string;
}
interface PromptSetFile {
  name: string;
  version: number;
  prompts: PromptSpec[];
}

function loadPromptSet(filePath: string): PromptSetFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as PromptSetFile;
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
    throw new Error(`Prompt set file has no prompts: ${filePath}`);
  }
  return parsed;
}

// ── Run id (matches the "<date>_<seq>" convention) ─────────────────────
function resolveRunId(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(VALIDATION_RUNS_DIR).filter(d => d.startsWith(`${today}_`));
  } catch {
    existing = [];
  }
  const usedSeqs = existing
    .map(d => Number(d.slice(today.length + 1)))
    .filter(n => Number.isInteger(n));
  const next = usedSeqs.length > 0 ? Math.max(...usedSeqs) + 1 : 1;
  return `${today}_${String(next).padStart(3, '0')}`;
}

/** One entry per DrawingIteration, with the (large, already-saved-to-disk-
 *  as-a-PNG-separately) pngBase64 field stripped — text only, so this
 *  stays small regardless of canvas size. */
interface TranscriptEntry {
  turn: number;
  phase: string;
  note: string;
}

// ── Per-job record. Builds on pixel-forge-validation-batch.md §3's fields
// with the observability this doc's follow-up task asked for: timing, the
// full Evaluation/RepairPlan objects (not just derived counts — the counts
// stay too, for cheap jq/grep scanning), and a lightweight text transcript.
// No raw model messages, no image data — everything here is small text. ──
interface ValidationJobRecord {
  runId: string;
  promptId: string;
  category: string;
  roundNumber: number;
  jobType: 'fresh' | 'revision';
  layerType: string;
  canvasSize: number;
  modelPreset: string;
  actualModel: string;
  maxTurnsConfigured: number;
  turnsUsed: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  stopped: boolean;
  failed: boolean;
  errorCode: string | null;
  graded: boolean;
  /** Pre-job token-level estimate from `estimateJobTokenUsage` — same model
   *  `estimatedCostUsd` below is priced from, split out so accuracy can be
   *  judged per token direction, not just blended into one $ ratio. See
   *  docs/pixel-forge-token-cost-audit.md. */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  /** actual/estimated, or null when the estimate was 0 (division undefined,
   *  not "perfect"). > 1 means the estimator undercounted. */
  inputRatio: number | null;
  outputRatio: number | null;
  costRatio: number | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  /** One entry per real Anthropic call this job made (draft?, refine
   *  turn 1..N, evaluate) — compact usage only, no raw messages or tool
   *  payloads. Lets the smoke test show whether input actually drops after
   *  draft redaction, whether refine calls grow cumulatively as modeled,
   *  and whether a specific turn's tool-call volume (not history/image
   *  growth) is the real confound. See CallUsageRecord in agent-loop.ts. */
  callUsage: CallUsageRecord[];
  recognizableAsSubject: boolean | null;
  overallSeverity: 'none' | 'minor' | 'major' | 'critical' | null;
  criticalIssues: number;
  majorIssues: number;
  minorIssues: number;
  openIssueCount: number;
  deferredIssueCount: number;
  resolvedCount: number;
  regressedCount: number;
  /** Set only for a revision round that started with open issues (from the
   *  PRIOR plan) but made zero refine-phase tool calls — meaning whatever
   *  "resolved" this round did so purely because the evaluator's own grade
   *  changed, not because anything was actually edited. Does NOT change
   *  `resolvedCount`/`converged` semantics — this is a purely additive
   *  suspicion signal surfaced alongside them. null for fresh (round 0)
   *  jobs and for any revision round that doesn't match the pattern. See
   *  the no-edit-revision audit (docs/pixel-forge-token-cost-audit.md). */
  noEditRevisionWarning: NoEditRevisionWarning | null;
  /** Full self-graded evaluation for this job, or null if ungraded
   *  (stopped before the evaluate step). */
  evaluation: Evaluation | null;
  /** Full computed repair plan for this job (active issues, deferred
   *  issues, overallSeverity, etc.), or null if ungraded. */
  repairPlan: RepairPlan | null;
  iterationCount: number;
  transcript: TranscriptEntry[];
  finalNote: string;
}

interface PromptAggregate {
  promptId: string;
  category: string;
  roundsUsed: number;
  converged: boolean;
  finalOverallSeverity: ValidationJobRecord['overallSeverity'];
  finalRecognizable: boolean | null;
  totalTokens: number;
  totalCostUsd: number;
  anyRegression: boolean;
  anyStoppedOrFailed: boolean;
}

// ── Hard-stop control flow ──────────────────────────────────────────────
class HardStopError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Diffs round K's plan against round K-1's — an issue id present in the
 *  previous plan's issues+deferred and absent from the new plan's
 *  issues+deferred is resolved. External diff over data buildRepairPlan
 *  already returns; no change to repair-plan.ts needed. See
 *  pixel-forge-validation-batch.md §3. */
function countResolved(previous: RepairPlan | null, current: RepairPlan): number {
  if (!previous) return 0;
  const previousIds = new Set([...previous.issues, ...previous.deferred].map(i => i.id));
  const currentIds = new Set([...current.issues, ...current.deferred].map(i => i.id));
  let resolved = 0;
  for (const id of previousIds) if (!currentIds.has(id)) resolved++;
  return resolved;
}

function countRegressed(plan: RepairPlan | null): number {
  if (!plan) return 0;
  return plan.issues.filter((i: StoredRepairItem) => i.regressed).length;
}

/** actual/estimated — null (not 0, not Infinity) when the estimate is 0,
 *  since that ratio is undefined, not "perfect accuracy." */
function safeRatio(actual: number, estimated: number): number | null {
  return estimated > 0 ? actual / estimated : null;
}

interface NoEditRevisionWarning {
  priorOpenIssueCount: number;
  recognizableBefore: boolean | null;
  recognizableAfter: boolean;
  severityBefore: ValidationJobRecord['overallSeverity'];
  severityAfter: ValidationJobRecord['overallSeverity'];
  recognizabilityFlipped: boolean;
}

/** Sum of `toolCallCount` across a job's refine-phase calls only (draft
 *  and evaluate excluded) — "did this revision round actually edit
 *  anything." See the no-edit-revision audit. */
function sumRefineToolCalls(callUsage: CallUsageRecord[]): number {
  return callUsage
    .filter(c => c.phase === 'refine')
    .reduce((sum, c) => sum + c.notes.toolCallCount, 0);
}

/** Detects the no-edit-revision pattern: a revision round that started
 *  with open issues (from the plan going INTO this round) but made zero
 *  refine-phase tool calls. When that happens, any issue that "resolved"
 *  did so purely because the evaluator's own grade changed between the two
 *  calls, not because anything was actually fixed — not necessarily wrong
 *  (a prior grade can simply have been incorrect), but a convergence off a
 *  round like this shouldn't be trusted the same as one backed by real
 *  edits. Returns null when the pattern doesn't apply: no prior open
 *  issues (nothing to resolve "for free"), the round wasn't graded (no
 *  "after" state to compare), or edits did happen. Deliberately does not
 *  touch `resolvedCount`/`overallSeverity`/`converged` — this is a purely
 *  additive, separate signal. */
function detectNoEditRevisionWarning(
  priorPlan: RepairPlan | null, priorRecognizable: boolean | null,
  newPlan: RepairPlan | null, result: TraitDrawResult,
): NoEditRevisionWarning | null {
  const priorOpenIssueCount = priorPlan?.issues.length ?? 0;
  if (priorOpenIssueCount === 0) return null;
  if (!result.graded) return null;
  if (sumRefineToolCalls(result.callUsage) > 0) return null;

  const recognizableAfter = result.evaluation.recognizableAsSubject;
  return {
    priorOpenIssueCount,
    recognizableBefore: priorRecognizable,
    recognizableAfter,
    severityBefore: priorPlan?.overallSeverity ?? null,
    severityAfter: newPlan?.overallSeverity ?? null,
    recognizabilityFlipped: priorRecognizable !== null && priorRecognizable !== recognizableAfter,
  };
}

function severityCounts(plan: RepairPlan | null): { critical: number; major: number; minor: number } {
  const counts = { critical: 0, major: 0, minor: 0 };
  if (!plan) return counts;
  for (const issue of plan.issues) {
    if (issue.severity === 'critical') counts.critical++;
    else if (issue.severity === 'major') counts.major++;
    else if (issue.severity === 'minor') counts.minor++;
  }
  return counts;
}

/** Strips the (already saved-to-disk-separately) pngBase64 field so the
 *  transcript stays small text — no raw model messages, no image data. */
function toTranscript(iterations: DrawingIteration[]): TranscriptEntry[] {
  return iterations.map(i => ({ turn: i.turn, phase: i.phase, note: i.note }));
}

/** Worst-case pre-flight estimate: every prompt runs a fresh draft plus
 *  the full maxRevisions rounds, ignoring conditional early-stop (an
 *  upper bound, deliberately — see validation-batch.md §7's --dry-run).
 *  Fresh and revision jobs are estimated separately (isRevision differs
 *  the system prompt / tool schema / seed-content assumptions used by
 *  estimateJobCostUsd) rather than treating every job as identical. */
function estimateBatchCostUsd(prompts: PromptSpec[], actualModel: string, maxTurns: number, maxRevisions: number): number {
  let total = 0;
  for (const p of prompts) {
    const freshJob = estimateJobCostUsd(actualModel, p.canvasSize, maxTurns, false) ?? 0;
    const revisionJob = estimateJobCostUsd(actualModel, p.canvasSize, maxTurns, true) ?? 0;
    total += freshJob + revisionJob * maxRevisions;
  }
  return total;
}

/** Runs an async job with bounded retry on transient Anthropic errors
 *  only. Any other failure — or exhausting the transient retries — is a
 *  hard stop for the whole run, per this run's explicit "never continue
 *  blindly" instruction (stricter than validation-batch.md's per-job-only
 *  failure handling, which this deliberately supersedes). */
async function runWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { code, safeMessage } = classifyAnthropicError(err);
      const transient = code === 'anthropic_rate_limited' || code === 'anthropic_overloaded';
      if (transient && attempt < MAX_TRANSIENT_RETRIES) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
        console.warn(`[validate] ${label}: ${code} — retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      throw new HardStopError(`${label} failed: ${code} — ${safeMessage}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const actualModel = MODEL_PRESETS[args.model];
  const maxTurns = args.maxTurns ?? PRESET_DEFAULT_MAX_TURNS[args.model];
  const maxTurnsIsOverride = args.maxTurns !== undefined;

  const promptSet = loadPromptSet(args.promptFile);
  const prompts = promptSet.prompts.slice(0, args.maxPrompts);

  const batchEstimate = estimateBatchCostUsd(prompts, actualModel, maxTurns, args.maxRevisions);
  console.log(`[validate] prompt set: ${promptSet.name} v${promptSet.version} (${prompts.length}/${promptSet.prompts.length} prompts used)`);
  console.log(`[validate] model preset: ${args.model} (${actualModel}), maxTurns=${maxTurns}${maxTurnsIsOverride ? ' (override via --max-turns)' : ' (preset default)'}, maxRevisions=${args.maxRevisions}`);
  console.log(`[validate] worst-case pre-flight cost estimate: ~$${batchEstimate.toFixed(4)} (cost-limit=$${args.costLimit.toFixed(2)})`);

  const wouldExceedCostLimit = batchEstimate > args.costLimit;

  // Run-directory + prompts.json creation happens for BOTH dry and real
  // runs — it's pure local file I/O (no Anthropic call), and a dry run's
  // whole point is to let the surrounding plumbing (directory layout,
  // prompt resolution, report generation) be verified end to end without
  // spending anything. Only runDrawingJob/runRevisionJob — the two calls
  // that actually reach Anthropic — are skipped when --dry-run is set.
  const runId = resolveRunId();
  const runDir = path.join(VALIDATION_RUNS_DIR, runId);
  const previewsDir = path.join(runDir, 'previews');
  await fsp.mkdir(previewsDir, { recursive: true });

  await fsp.writeFile(
    path.join(runDir, 'prompts.json'),
    JSON.stringify({ runId, promptSetName: promptSet.name, promptSetVersion: promptSet.version, promptSetFile: args.promptFile, prompts }, null, 2),
  );
  const resultsPath = path.join(runDir, 'results.jsonl');

  if (args.dryRun) {
    await fsp.writeFile(resultsPath, ''); // always exists, even empty — same shape as a real run
    console.log(`[validate] --dry-run: no API calls made. Run directory + prompts.json created at ${runDir} for plumbing verification.`);
    for (const p of prompts) console.log(`  - ${p.id} [${p.category}/${p.layerType}] "${p.prompt}"`);
    if (wouldExceedCostLimit) {
      console.log(`[validate] NOTE: a real run with this configuration would ABORT immediately — worst-case estimate ($${batchEstimate.toFixed(4)}) exceeds --cost-limit ($${args.costLimit.toFixed(2)}).`);
    }
    await writeDryRunSummary(runDir, runId, args, actualModel, maxTurns, promptSet, prompts, batchEstimate, wouldExceedCostLimit);
    console.log(`[validate] dry-run report: data/pixel-forge/validation-runs/${runId}/summary.md`);
    return;
  }

  if (wouldExceedCostLimit) {
    console.error(`[validate] ABORT: worst-case estimate ($${batchEstimate.toFixed(4)}) already exceeds --cost-limit ($${args.costLimit.toFixed(2)}) before any job runs. Raise --cost-limit, lower --max-prompts/--max-revisions, or use a cheaper --model.`);
    process.exitCode = 1;
    return;
  }

  if (!anthropicApiKey()) {
    console.error('[validate] ABORT: ANTHROPIC_API_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const jobRecords: ValidationJobRecord[] = [];
  const promptAggregates: PromptAggregate[] = [];
  let runningEstimated = 0;
  let runningActual = 0;
  let aborted = false;
  let abortReason = '';

  function appendResult(record: ValidationJobRecord): void {
    jobRecords.push(record);
    fs.appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);
  }

  function checkCostCap(nextEstimate: number): void {
    // Two independent gates, per validation-batch.md §7: the pre-job estimate
    // gate (below) and a post-job actual-cost gate — checked against the
    // *next* job's estimate too, not just the running actual alone, so this
    // trips one job earlier if real spend is already running ahead of the
    // (known-to-undercount, per the architecture review) estimator.
    if (runningActual + nextEstimate > args.costLimit) {
      throw new HardStopError(`accumulated actual cost ($${runningActual.toFixed(4)}) plus the next job's estimate would exceed --cost-limit ($${args.costLimit.toFixed(2)})`);
    }
    if (runningEstimated + nextEstimate > args.costLimit) {
      throw new HardStopError(`next job's estimated cost would push total estimate ($${(runningEstimated + nextEstimate).toFixed(4)}) past --cost-limit ($${args.costLimit.toFixed(2)})`);
    }
  }

  console.log(`[validate] run ${runId} starting — writing to ${runDir}`);

  try {
    for (const p of prompts) {
      console.log(`[validate] ${p.id}: fresh draft…`);
      const iterations0: DrawingIteration[] = [];
      // Token-level estimate first, cost derived from it — same value
      // estimateJobCostUsd would give (it's a thin wrapper over this same
      // function), but computed once so the per-token ratios below don't
      // require re-deriving the estimator's internals a second time.
      const estTokens0 = estimateJobTokenUsage(p.canvasSize, maxTurns, false);
      const preEstimate0 = estimateCostUsd(actualModel, estTokens0) ?? 0;
      checkCostCap(preEstimate0);

      const startedAt0 = Date.now();
      const result0: TraitDrawResult = await runWithRetry(`${p.id} round0`, () => runDrawingJob(
        { prompt: p.prompt, layerType: p.layerType, canvasSize: p.canvasSize, palette: [...DEFAULT_PALETTE], model: actualModel, maxTurns },
        iter => iterations0.push(iter),
      ));
      const finishedAt0 = Date.now();
      runningEstimated += preEstimate0;
      const actualCost0 = estimateCostUsd(actualModel, result0.tokenUsage);
      runningActual += actualCost0 ?? 0;

      let plan0: RepairPlan | null = null;
      if (result0.graded) {
        plan0 = buildRepairPlan({ sourceRevision: 0, subject: p.prompt, evaluation: result0.evaluation, previousPlan: null, now: Date.now() });
      }
      const sev0 = severityCounts(plan0);
      appendResult({
        runId, promptId: p.id, category: p.category, roundNumber: 0, jobType: 'fresh',
        layerType: p.layerType, canvasSize: p.canvasSize, modelPreset: args.model, actualModel, maxTurnsConfigured: maxTurns,
        turnsUsed: iterations0.filter(i => i.phase === 'refine').length,
        startedAt: startedAt0, finishedAt: finishedAt0, durationMs: finishedAt0 - startedAt0,
        stopped: !result0.graded, failed: false, errorCode: null, graded: result0.graded,
        estimatedInputTokens: estTokens0.inputTokens, estimatedOutputTokens: estTokens0.outputTokens,
        actualInputTokens: result0.tokenUsage.inputTokens, actualOutputTokens: result0.tokenUsage.outputTokens,
        inputRatio: safeRatio(result0.tokenUsage.inputTokens, estTokens0.inputTokens),
        outputRatio: safeRatio(result0.tokenUsage.outputTokens, estTokens0.outputTokens),
        costRatio: actualCost0 !== null ? safeRatio(actualCost0, preEstimate0) : null,
        estimatedCostUsd: preEstimate0, actualCostUsd: actualCost0,
        callUsage: result0.callUsage,
        recognizableAsSubject: result0.graded ? result0.evaluation.recognizableAsSubject : null,
        overallSeverity: plan0?.overallSeverity ?? null,
        criticalIssues: sev0.critical, majorIssues: sev0.major, minorIssues: sev0.minor,
        openIssueCount: plan0?.issues.length ?? 0, deferredIssueCount: plan0?.deferred.length ?? 0,
        resolvedCount: 0, regressedCount: countRegressed(plan0), noEditRevisionWarning: null,
        evaluation: result0.graded ? result0.evaluation : null, repairPlan: plan0,
        iterationCount: iterations0.length, transcript: toTranscript(iterations0),
        finalNote: iterations0.length > 0 ? iterations0[iterations0.length - 1].note : '',
      });
      await fsp.writeFile(path.join(previewsDir, `${p.id}-round0.png`), Buffer.from(result0.pngBase64, 'base64'));

      let currentPixels = result0.pixels;
      let currentSize = result0.size;
      let currentPalette = result0.palette; // canonical form: index 0 = "transparent"
      let currentPlan = plan0;
      let roundsUsed = 0;
      let anyRegression = countRegressed(plan0) > 0;
      let anyStoppedOrFailed = !result0.graded;
      let totalTokens = result0.tokenUsage.inputTokens + result0.tokenUsage.outputTokens;
      let totalCostUsd = actualCost0 ?? 0;
      let lastRecognizable: boolean | null = result0.graded ? result0.evaluation.recognizableAsSubject : null;

      for (let round = 1; round <= args.maxRevisions; round++) {
        if (!currentPlan || currentPlan.issues.length === 0) break; // conditional revision — nothing open, stop early
        console.log(`[validate] ${p.id}: revision round ${round} (${currentPlan.issues.length} open issue(s))…`);

        const iterationsN: DrawingIteration[] = [];
        const estTokensN = estimateJobTokenUsage(currentSize, maxTurns, true);
        const preEstimateN = estimateCostUsd(actualModel, estTokensN) ?? 0;
        checkCostCap(preEstimateN);

        const hexPalette = currentPalette[0] === 'transparent' ? currentPalette.slice(1) : currentPalette;
        const startedAtN = Date.now();
        const resultN: TraitDrawResult = await runWithRetry(`${p.id} round${round}`, () => runRevisionJob(
          {
            existingPixels: currentPixels, size: currentSize, palette: hexPalette, layerType: p.layerType,
            revisionPrompt: '', repairPlan: currentPlan, model: actualModel, maxTurns,
          },
          iter => iterationsN.push(iter),
        ));
        const finishedAtN = Date.now();
        runningEstimated += preEstimateN;
        const actualCostN = estimateCostUsd(actualModel, resultN.tokenUsage);
        runningActual += actualCostN ?? 0;

        let planN: RepairPlan | null = null;
        if (resultN.graded) {
          planN = buildRepairPlan({ sourceRevision: round, subject: p.prompt, evaluation: resultN.evaluation, previousPlan: currentPlan, now: Date.now() });
        }
        const sevN = severityCounts(planN);
        const resolvedN = resultN.graded ? countResolved(currentPlan, planN!) : 0;
        const regressedN = countRegressed(planN);
        const noEditWarningN = detectNoEditRevisionWarning(currentPlan, lastRecognizable, planN, resultN);
        if (noEditWarningN) {
          console.warn(
            `[validate] ${p.id} round ${round}: NO-EDIT REVISION — ${noEditWarningN.priorOpenIssueCount} `
            + `open issue(s) going in, 0 refine-phase tool calls, severity ${noEditWarningN.severityBefore} `
            + `→ ${noEditWarningN.severityAfter}${noEditWarningN.recognizabilityFlipped
              ? ` (recognizableAsSubject flipped ${noEditWarningN.recognizableBefore}→${noEditWarningN.recognizableAfter} on an unchanged render)`
              : ''}.`,
          );
        }
        appendResult({
          runId, promptId: p.id, category: p.category, roundNumber: round, jobType: 'revision',
          layerType: p.layerType, canvasSize: currentSize, modelPreset: args.model, actualModel, maxTurnsConfigured: maxTurns,
          turnsUsed: iterationsN.filter(i => i.phase === 'refine').length,
          startedAt: startedAtN, finishedAt: finishedAtN, durationMs: finishedAtN - startedAtN,
          stopped: !resultN.graded, failed: false, errorCode: null, graded: resultN.graded,
          estimatedInputTokens: estTokensN.inputTokens, estimatedOutputTokens: estTokensN.outputTokens,
          actualInputTokens: resultN.tokenUsage.inputTokens, actualOutputTokens: resultN.tokenUsage.outputTokens,
          inputRatio: safeRatio(resultN.tokenUsage.inputTokens, estTokensN.inputTokens),
          outputRatio: safeRatio(resultN.tokenUsage.outputTokens, estTokensN.outputTokens),
          costRatio: actualCostN !== null ? safeRatio(actualCostN, preEstimateN) : null,
          estimatedCostUsd: preEstimateN, actualCostUsd: actualCostN,
          callUsage: resultN.callUsage,
          recognizableAsSubject: resultN.graded ? resultN.evaluation.recognizableAsSubject : null,
          overallSeverity: planN?.overallSeverity ?? null,
          criticalIssues: sevN.critical, majorIssues: sevN.major, minorIssues: sevN.minor,
          openIssueCount: planN?.issues.length ?? 0, deferredIssueCount: planN?.deferred.length ?? 0,
          resolvedCount: resolvedN, regressedCount: regressedN, noEditRevisionWarning: noEditWarningN,
          evaluation: resultN.graded ? resultN.evaluation : null, repairPlan: planN,
          iterationCount: iterationsN.length, transcript: toTranscript(iterationsN),
          finalNote: iterationsN.length > 0 ? iterationsN[iterationsN.length - 1].note : '',
        });
        await fsp.writeFile(path.join(previewsDir, `${p.id}-round${round}.png`), Buffer.from(resultN.pngBase64, 'base64'));

        currentPixels = resultN.pixels;
        currentSize = resultN.size;
        currentPalette = resultN.palette;
        currentPlan = planN;
        roundsUsed = round;
        if (regressedN > 0) anyRegression = true;
        if (!resultN.graded) anyStoppedOrFailed = true;
        totalTokens += resultN.tokenUsage.inputTokens + resultN.tokenUsage.outputTokens;
        totalCostUsd += actualCostN ?? 0;
        lastRecognizable = resultN.graded ? resultN.evaluation.recognizableAsSubject : lastRecognizable;

        if (!resultN.graded) break; // ungraded (stopped) — nothing further to base another round on
      }

      const finalSeverity = currentPlan?.overallSeverity ?? null;
      promptAggregates.push({
        promptId: p.id, category: p.category, roundsUsed, converged: finalSeverity === 'none' || finalSeverity === 'minor',
        finalOverallSeverity: finalSeverity, finalRecognizable: lastRecognizable,
        totalTokens, totalCostUsd, anyRegression, anyStoppedOrFailed,
      });
    }
  } catch (err) {
    aborted = true;
    abortReason = err instanceof HardStopError ? err.message : `unexpected exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
    console.error(`[validate] HARD STOP: ${abortReason}`);
  }

  await writeSummary(runDir, runId, args, actualModel, maxTurns, promptSet, jobRecords, promptAggregates, aborted, abortReason);
  printTerminalSummary(runId, jobRecords, promptAggregates, aborted, abortReason);
  if (aborted) process.exitCode = 1;
}

// ── Reporting ────────────────────────────────────────────────────────────
function mean(nums: number[]): number { return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length; }
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Dry-run report — no jobs ever ran, so this is deliberately just the
 *  resolved configuration/prompt list/cost preview, not a stub of the
 *  real aggregate tables (which would be all zeros and misleading). */
async function writeDryRunSummary(
  runDir: string, runId: string, args: CliArgs, actualModel: string, maxTurns: number,
  promptSet: PromptSetFile, prompts: PromptSpec[], batchEstimate: number, wouldExceedCostLimit: boolean,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Validation Run ${runId} — DRY RUN`);
  lines.push('');
  lines.push('> No Anthropic calls were made. This report previews what a real run with');
  lines.push('> this exact configuration would do — re-run without `--dry-run` to execute it.');
  lines.push('');
  lines.push('## Configuration');
  lines.push(`- Prompt set: ${promptSet.name} v${promptSet.version} (${args.promptFile})`);
  lines.push(`- Model preset: ${args.model} (${actualModel}), maxTurns=${maxTurns}${args.maxTurns !== undefined ? ' (override via --max-turns)' : ' (preset default)'}`);
  lines.push(`- Max revisions per prompt: ${args.maxRevisions}`);
  lines.push(`- Cost limit: $${args.costLimit.toFixed(2)}`);
  lines.push(`- Prompts resolved: ${prompts.length}/${promptSet.prompts.length}`);
  lines.push('');
  lines.push('## Cost preview');
  lines.push(`- Worst-case pre-flight estimate (every prompt runs a fresh draft + all ${args.maxRevisions} revision round(s)): **$${batchEstimate.toFixed(4)}**`);
  lines.push(wouldExceedCostLimit
    ? `- ⚠ This **exceeds** the cost limit — a real run would ABORT before starting any job.`
    : `- ✓ Within the cost limit — a real run would be allowed to start.`);
  lines.push('');
  lines.push('## Prompts');
  lines.push('| id | category | layerType | canvas | prompt |');
  lines.push('|---|---|---|---|---|');
  for (const p of prompts) lines.push(`| ${p.id} | ${p.category} | ${p.layerType} | ${p.canvasSize} | ${p.prompt} |`);
  await fsp.writeFile(path.join(runDir, 'summary.md'), lines.join('\n'));
}

async function writeSummary(
  runDir: string, runId: string, args: CliArgs, actualModel: string, maxTurns: number,
  promptSet: PromptSetFile, jobRecords: ValidationJobRecord[], promptAggregates: PromptAggregate[],
  aborted: boolean, abortReason: string,
): Promise<void> {
  const totalJobs = jobRecords.length;
  const totalTokens = jobRecords.reduce((a, r) => a + r.actualInputTokens + r.actualOutputTokens, 0);
  const totalEstimated = jobRecords.reduce((a, r) => a + (r.estimatedCostUsd ?? 0), 0);
  const totalActual = jobRecords.reduce((a, r) => a + (r.actualCostUsd ?? 0), 0);
  const failedOrStopped = jobRecords.filter(r => r.failed || r.stopped).length;
  const revisionJobs = jobRecords.filter(r => r.jobType === 'revision');
  const regressionRate = revisionJobs.length === 0 ? 0 : revisionJobs.filter(r => r.regressedCount > 0).length / revisionJobs.length;
  const convergedCount = promptAggregates.filter(p => p.converged).length;
  const convergenceRate = promptAggregates.length === 0 ? 0 : convergedCount / promptAggregates.length;
  const recognizedFinal = promptAggregates.filter(p => p.finalRecognizable === true).length;
  const recognitionRate = promptAggregates.length === 0 ? 0 : recognizedFinal / promptAggregates.length;
  const costsPerPrompt = promptAggregates.map(p => p.totalCostUsd);

  const categories = [...new Set(promptSet.prompts.map(p => p.category))];

  const lines: string[] = [];
  lines.push(`# Validation Run ${runId}`);
  lines.push('');
  if (aborted) {
    lines.push(`> ⚠ **RUN ABORTED** — ${abortReason}`);
    lines.push('> Numbers below reflect only the jobs completed before the abort.');
    lines.push('');
  }
  lines.push('## Configuration');
  lines.push(`- Prompt set: ${promptSet.name} v${promptSet.version} (${args.promptFile})`);
  lines.push(`- Model preset: ${args.model} (${actualModel}), maxTurns=${maxTurns}${args.maxTurns !== undefined ? ' (override via --max-turns)' : ' (preset default)'}`);
  lines.push(`- Max revisions per prompt: ${args.maxRevisions}`);
  lines.push(`- Cost limit: $${args.costLimit.toFixed(2)}`);
  lines.push('');
  lines.push('## Batch aggregate');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Prompts run | ${promptAggregates.length} |`);
  lines.push(`| Total jobs | ${totalJobs} |`);
  lines.push(`| Total tokens | ${totalTokens.toLocaleString()} |`);
  lines.push(`| Total estimated cost | $${totalEstimated.toFixed(4)} |`);
  lines.push(`| Total actual cost | $${totalActual.toFixed(4)} |`);
  const batchRatio = totalEstimated > 0 ? totalActual / totalEstimated : null;
  lines.push(`| Actual/estimated ratio | ${batchRatio !== null ? batchRatio.toFixed(2) : 'n/a'}x${batchRatio !== null && batchRatio > 1.5 ? ' ⚠ **> 1.5x — cost estimator is undercounting real spend**' : ''} |`);
  lines.push(`| Convergence rate | ${(convergenceRate * 100).toFixed(0)}% (${convergedCount}/${promptAggregates.length}) |`);
  lines.push(`| Mean rounds used | ${mean(promptAggregates.map(p => p.roundsUsed)).toFixed(2)} |`);
  lines.push(`| Regression rate (per revision round) | ${(regressionRate * 100).toFixed(0)}% (${revisionJobs.filter(r => r.regressedCount > 0).length}/${revisionJobs.length}) |`);
  lines.push(`| Recognition rate (final round) | ${(recognitionRate * 100).toFixed(0)}% |`);
  lines.push(`| Stopped/failed job rate | ${totalJobs > 0 ? ((failedOrStopped / totalJobs) * 100).toFixed(0) : '0'}% |`);
  lines.push(`| Cost per prompt (mean/median/max) | $${mean(costsPerPrompt).toFixed(4)} / $${median(costsPerPrompt).toFixed(4)} / $${(Math.max(0, ...costsPerPrompt)).toFixed(4)} |`);
  lines.push(`| Human approval | not collected automatically — manual post-hoc step, see previews/ |`);
  lines.push('');

  lines.push('## By category');
  lines.push('| Category | Prompts | Convergence rate | Regression rate | Mean cost |');
  lines.push('|---|---|---|---|---|');
  for (const cat of categories) {
    const catAgg = promptAggregates.filter(p => p.category === cat);
    const catRevJobs = revisionJobs.filter(r => r.category === cat);
    const catConv = catAgg.length === 0 ? 0 : catAgg.filter(p => p.converged).length / catAgg.length;
    const catRegr = catRevJobs.length === 0 ? 0 : catRevJobs.filter(r => r.regressedCount > 0).length / catRevJobs.length;
    lines.push(`| ${cat} | ${catAgg.length} | ${(catConv * 100).toFixed(0)}% | ${(catRegr * 100).toFixed(0)}% | $${mean(catAgg.map(p => p.totalCostUsd)).toFixed(4)} |`);
  }
  lines.push('');

  lines.push('## Timing');
  lines.push('| Prompt | Round | Duration | Turns |');
  lines.push('|---|---|---|---|');
  for (const r of jobRecords) {
    lines.push(`| ${r.promptId} | ${r.roundNumber} (${r.jobType}) | ${(r.durationMs / 1000).toFixed(1)}s | ${r.turnsUsed}/${r.maxTurnsConfigured} |`);
  }
  const durations = jobRecords.map(r => r.durationMs);
  lines.push(`| **Total** | | **${(durations.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s** | mean ${(mean(durations) / 1000).toFixed(1)}s/job |`);
  lines.push('');

  lines.push('## Per-job cost-estimate accuracy');
  lines.push('Ratio = actual/estimated; >1 means the estimator undercounted that job. `n/a` means the estimate was 0 (division undefined).');
  lines.push('');
  lines.push('| Prompt | Round | Est. Input | Actual Input | Input Ratio | Est. Output | Actual Output | Output Ratio | Est. Cost | Actual Cost | Cost Ratio |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const accuracyWarnings: string[] = [];
  for (const r of jobRecords) {
    const inFlag = r.inputRatio !== null && r.inputRatio > 1.5 ? ' ⚠' : '';
    const costFlag = r.costRatio !== null && r.costRatio > 1.5 ? ' ⚠' : '';
    lines.push(
      `| ${r.promptId} | ${r.roundNumber} (${r.jobType}) `
      + `| ${Math.round(r.estimatedInputTokens).toLocaleString()} | ${r.actualInputTokens.toLocaleString()} | ${r.inputRatio !== null ? r.inputRatio.toFixed(2) : 'n/a'}x${inFlag} `
      + `| ${Math.round(r.estimatedOutputTokens).toLocaleString()} | ${r.actualOutputTokens.toLocaleString()} | ${r.outputRatio !== null ? r.outputRatio.toFixed(2) : 'n/a'}x `
      + `| $${(r.estimatedCostUsd ?? 0).toFixed(4)} | $${(r.actualCostUsd ?? 0).toFixed(4)} | ${r.costRatio !== null ? r.costRatio.toFixed(2) : 'n/a'}x${costFlag} |`,
    );
    const reasons: string[] = [];
    if (r.inputRatio !== null && r.inputRatio > 1.5) reasons.push(`input ${r.inputRatio.toFixed(2)}x`);
    if (r.costRatio !== null && r.costRatio > 1.5) reasons.push(`cost ${r.costRatio.toFixed(2)}x`);
    if (reasons.length > 0) accuracyWarnings.push(`${r.promptId} round ${r.roundNumber} (${reasons.join(', ')})`);
  }
  if (accuracyWarnings.length > 0) {
    lines.push('');
    lines.push(`⚠ **Jobs exceeding 1.5x on input tokens and/or cost:** ${accuracyWarnings.join('; ')}`);
  }
  lines.push('');

  lines.push('## Per-call usage');
  lines.push('One row per real Anthropic call. Read this to see: does `Act. In` actually drop at the');
  lines.push('draft→refine boundary (draft-array redaction working) or stay near pre-redaction levels');
  lines.push('(redaction not taking effect); do refine calls grow turn-over-turn the way the cumulative');
  lines.push('model predicts; is a specific turn\'s `Tools` count (not image/history growth) the real');
  lines.push('confound; is `evaluate` unexpectedly expensive relative to the last refine call.');
  lines.push('');
  lines.push('| Prompt | Round | Call | Phase | Turn | Est. In | Act. In | In Ratio | Est. Out | Act. Out | Image | No-op skip | Tools |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of jobRecords) {
    for (const c of r.callUsage) {
      const inRatio = safeRatio(c.inputTokens, c.estimatedInputTokens ?? 0);
      lines.push(
        `| ${r.promptId} | ${r.roundNumber} (${r.jobType}) | ${c.callIndex} | ${c.phase} | ${c.turn ?? '—'} `
        + `| ${c.estimatedInputTokens !== null ? Math.round(c.estimatedInputTokens).toLocaleString() : 'n/a'} | ${c.inputTokens.toLocaleString()} `
        + `| ${inRatio !== null ? inRatio.toFixed(2) + 'x' : 'n/a'} `
        + `| ${c.estimatedOutputTokens !== null ? Math.round(c.estimatedOutputTokens).toLocaleString() : 'n/a'} | ${c.outputTokens.toLocaleString()} `
        + `| ${c.notes.imageAttached ? '✓' : ''} | ${c.notes.noOpImageSkipped ? '✓' : ''} | ${c.notes.toolCallCount} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Per-prompt');
  lines.push('| Prompt | Category | Rounds | Converged | Final severity | Recognizable | Regression | Cost |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of promptAggregates) {
    lines.push(`| ${p.promptId} | ${p.category} | ${p.roundsUsed} | ${p.converged ? '✓' : '✗'} | ${p.finalOverallSeverity ?? 'n/a'} | ${p.finalRecognizable === null ? 'n/a' : p.finalRecognizable ? '✓' : '✗'} | ${p.anyRegression ? '⚠' : ''} | $${p.totalCostUsd.toFixed(4)} |`);
  }
  lines.push('');

  lines.push('## Per-prompt issue delta (round 0 → final round)');
  for (const p of promptAggregates) {
    const promptJobs = jobRecords.filter(r => r.promptId === p.promptId).sort((a, b) => a.roundNumber - b.roundNumber);
    const first = promptJobs[0];
    const last = promptJobs[promptJobs.length - 1];
    lines.push(`- **${p.promptId}**:`);
    const firstIssues = first?.repairPlan?.issues ?? [];
    const lastIssues = last?.repairPlan?.issues ?? [];
    lines.push(`  - Round 0 open (${firstIssues.length}): ${firstIssues.length === 0 ? 'none' : firstIssues.map(i => `[${i.category}/${i.severity}] ${i.location}`).join('; ')}`);
    lines.push(`  - Final open (${lastIssues.length}): ${lastIssues.length === 0 ? 'none' : lastIssues.map(i => `[${i.category}/${i.severity}] ${i.location}`).join('; ')}`);
  }
  lines.push('');

  lines.push('## Regressions (full issue text)');
  const regressedIssues = jobRecords.flatMap(r => (r.repairPlan?.issues ?? [])
    .filter(i => i.regressed)
    .map(i => ({ job: r, issue: i })));
  if (regressedIssues.length === 0) {
    lines.push('None.');
  } else {
    for (const { job, issue } of regressedIssues) {
      lines.push(`- **${job.promptId} round ${job.roundNumber}** — [${issue.category}/${issue.severity}] ${issue.location}: ${issue.problem}${issue.reason ? ` (${issue.reason})` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Recognizability/severity disagreement warnings');
  const disagreements: string[] = [];
  for (const r of jobRecords) {
    if (r.recognizableAsSubject === true && (r.overallSeverity === 'critical' || r.overallSeverity === 'major')) {
      disagreements.push(`${r.promptId} round ${r.roundNumber}: recognizable=true but severity=${r.overallSeverity}`);
    }
  }
  for (const p of promptAggregates) {
    const promptJobs = jobRecords.filter(r => r.promptId === p.promptId).sort((a, b) => a.roundNumber - b.roundNumber);
    for (let i = 1; i < promptJobs.length; i++) {
      const prev = promptJobs[i - 1];
      const curr = promptJobs[i];
      if (prev.recognizableAsSubject !== curr.recognizableAsSubject && prev.overallSeverity === curr.overallSeverity) {
        disagreements.push(`${p.promptId}: recognizable flipped ${prev.recognizableAsSubject}→${curr.recognizableAsSubject} between round ${prev.roundNumber} and ${curr.roundNumber} while severity stayed "${curr.overallSeverity}" — check whether the image actually changed`);
      }
    }
  }
  lines.push(disagreements.length === 0 ? 'None.' : disagreements.map(d => `- ⚠ ${d}`).join('\n'));
  lines.push('');

  lines.push('## No-edit revision warnings');
  lines.push('A revision round that started with open issues but made zero refine-phase tool calls —');
  lines.push('any issue that "resolved" did so purely because the evaluator\'s own grade changed, not');
  lines.push('because anything was actually edited. Not necessarily wrong (a prior grade can simply have');
  lines.push('been incorrect) — but convergence off a round like this should not be trusted the same as');
  lines.push('one backed by real edits. Does not affect `resolvedCount`/`converged` above.');
  lines.push('');
  const noEditWarnings = jobRecords.filter(r => r.noEditRevisionWarning !== null);
  if (noEditWarnings.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Prompt | Round | Prior Open Issues | Recognizable Before | Recognizable After | Severity Before | Severity After |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of noEditWarnings) {
      const w = r.noEditRevisionWarning!;
      const recBefore = w.recognizableBefore === null ? 'n/a' : (w.recognizableBefore ? '✓' : '✗');
      const recAfter = (w.recognizableAfter ? '✓' : '✗') + (w.recognizabilityFlipped ? ' ⚠ flipped' : '');
      lines.push(`| ${r.promptId} | ${r.roundNumber} | ${w.priorOpenIssueCount} | ${recBefore} | ${recAfter} | ${w.severityBefore ?? 'n/a'} | ${w.severityAfter ?? 'n/a'} |`);
    }
  }
  lines.push('');

  lines.push('Previews for each round are saved under `previews/<promptId>-round<N>.png`. Full per-job');
  lines.push('evaluation/repairPlan/transcript detail is in `results.jsonl` (one JSON object per line).');

  await fsp.writeFile(path.join(runDir, 'summary.md'), lines.join('\n'));

  const logEntry = `- ${new Date().toISOString().slice(0, 10)} — run \`${runId}\` — ${promptSet.name} v${promptSet.version}, ${args.model}, `
    + `${promptAggregates.length} prompts — convergence ${(convergenceRate * 100).toFixed(0)}%, regression ${(regressionRate * 100).toFixed(0)}%`
    + `${aborted ? ' — **ABORTED**' : ''} — see \`data/pixel-forge/validation-runs/${runId}/summary.md\`\n`;
  try {
    await fsp.appendFile(path.join(process.cwd(), 'docs', 'pixel-forge-testing-log.md'), `\n${logEntry}`);
  } catch {
    // best-effort only — never fail the run over the testing-log append
  }
}

function printTerminalSummary(
  runId: string, jobRecords: ValidationJobRecord[], promptAggregates: PromptAggregate[],
  aborted: boolean, abortReason: string,
): void {
  const totalActual = jobRecords.reduce((a, r) => a + (r.actualCostUsd ?? 0), 0);
  const convergedCount = promptAggregates.filter(p => p.converged).length;
  const revisionJobs = jobRecords.filter(r => r.jobType === 'revision');
  const regressed = revisionJobs.filter(r => r.regressedCount > 0).length;
  console.log('');
  console.log(`[validate] === run ${runId} ${aborted ? 'ABORTED' : 'complete'} ===`);
  if (aborted) console.log(`[validate] reason: ${abortReason}`);
  console.log(`[validate] prompts: ${promptAggregates.length}, jobs: ${jobRecords.length}, actual cost: $${totalActual.toFixed(4)}`);
  console.log(`[validate] converged: ${convergedCount}/${promptAggregates.length}, regressed revision rounds: ${regressed}/${revisionJobs.length}`);
  console.log(`[validate] full report: data/pixel-forge/validation-runs/${runId}/summary.md`);
}

main().catch((err) => {
  console.error('[validate] fatal error:', err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
