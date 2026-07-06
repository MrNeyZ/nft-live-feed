/**
 * Trait-artist agent — Claude only ever expands a permanent trait library;
 * it never generates the final collection (that's a future, AI-free
 * compositor reading the stored JSON grids directly). Two entry points
 * share one refine+evaluate core so a revision is a cheap seed-and-edit,
 * not a from-scratch redraw:
 *
 *   runDrawingJob   — brand-new trait. Phase A (draft, forced tool call,
 *                     Claude states the whole initial grid — no vision
 *                     needed yet) seeds a blank canvas, then the shared
 *                     core runs.
 *   runRevisionJob  — existing trait. Seeds the canvas directly from the
 *                     trait's already-stored pixels (phase "seed", no
 *                     draft call at all) and runs the same shared core
 *                     against the user's revision instructions.
 *
 * Shared core (phase B "refine" + phase C "evaluate"):
 *   B. Each turn Claude emits tool calls → driver executes them against
 *      the in-memory Canvas → driver renders ONCE and folds the image into
 *      the matching tool_result (one render per turn regardless of batch
 *      size, to bound vision cost). Ends when a turn produces no tool
 *      calls or `maxTurns` is hit.
 *   C. One forced `submit_evaluation` call: Claude self-assesses the
 *      finished render against clean silhouette / readable at native size
 *      / no stray pixels / transparent bg preserved / matches layer type.
 *      Stored with the trait, shown as a checklist — never trusted
 *      blindly, since it's the model grading its own work.
 *
 * Proof-of-quality framing holds: this is how the library gets *built*,
 * not a production loop to run over hundreds of traits unattended.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam, ToolResultBlockParam, ToolUseBlock, TextBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { Canvas } from './canvas';
import {
  buildSubmitDraftTool, REFINE_TOOLS, REPAIR_TOOLS, SUBMIT_EVALUATION_TOOL, executeTool,
  Evaluation, EVALUATION_SCHEMA_VERSION, parseEvaluation,
} from './tools';
import { RepairPlan, StoredRepairItem } from './repair-plan';

export const DEFAULT_PALETTE: readonly string[] = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57',
  '#ffcd75', '#a7f070', '#38b764', '#257179',
  '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
  '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
];
export const DEFAULT_CANVAS_SIZE = 32;
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TURNS = 8;
// Tightened from 20 — this is a $5-budget proof-of-quality tool, not a
// production generator; a runaway refine loop should not be able to burn
// much more than the "premium" preset's own default.
export const HARD_MAX_TURNS = 15;
const PREVIEW_UPSCALE = 8;
// Refine-call max_tokens — split fresh vs. revision since 2026-07-05_015/_017
// (see the zero-tool-call-stall investigation): both real Sonnet revision
// refine turns returned output_tokens exactly at the old shared 2048 ceiling
// with zero surviving tool_use, independent of how large the seed repair
// plan was (413 tok vs. 1,329 tok seeds, same exact ceiling) — consistent
// with truncation before the model reached a tool call, not a deliberate
// short "done". No fresh-draft refine turn in any real run has shown this
// pattern, so only revision's ceiling moves. Not a prompt change — the
// model still gets the same instructions, just more room to finish them
// before being cut off.
const REFINE_MAX_TOKENS_FRESH = 2048;
const REFINE_MAX_TOKENS_REVISION = 4096;

export type LayerType = 'background' | 'body' | 'eyes' | 'mouth' | 'accessory' | 'icon' | 'other';
export const LAYER_TYPES: readonly LayerType[] = ['background', 'body', 'eyes', 'mouth', 'accessory', 'icon', 'other'];

/** Frontend never sends a raw model string — only one of these three preset
 *  ids, mapped server-side. Keeps Opus a deliberate, gated override rather
 *  than something a stray request param could select. */
export type ModelPreset = 'fast' | 'normal' | 'premium';
export const MODEL_PRESETS: Record<ModelPreset, string> = {
  fast: 'claude-haiku-4-5',
  normal: 'claude-sonnet-5',
  premium: 'claude-opus-4-8',
};
export const PRESET_DEFAULT_MAX_TURNS: Record<ModelPreset, number> = {
  fast: 4,
  normal: 8,
  premium: 12,
};

/** Opus is a manual, explicitly-enabled override — never the default, and
 *  disabled by default at the environment level regardless of what a
 *  request asks for. */
export function allowOpus(): boolean {
  return process.env.PIXEL_FORGE_ALLOW_OPUS === 'true';
}

export function anthropicApiKey(): string | null {
  const v = process.env.ANTHROPIC_API_KEY;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// USD per 1M tokens. Sonnet reflects the introductory rate in effect through
// 2026-08-31 ($2/$10); reverts to $3/$15 after — revisit this table then.
// Estimates only, used for operator-facing cost logs/storage — not billing.
const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-5': { input: 2.00, output: 10.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
};

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const pricing = PRICING_USD_PER_MTOK[model];
  if (!pricing) return null;
  return (usage.inputTokens / 1_000_000) * pricing.input
       + (usage.outputTokens / 1_000_000) * pricing.output;
}

// Measured fixed-cost floors — chars/4 token approximation over the actual
// literal source text, cross-checked against real validation-run token
// counts. See docs/pixel-forge-token-cost-audit.md §1/§2. Each of these is
// resent in full on every call of the phase it applies to.
//
// SYSTEM_PROMPT_TOKENS_FRESH recalibrated from the chars/4 approximation
// (820) to 1600 using per-call evidence from validation run 2026-07-05_011
// (per-call token logging — see docs/pixel-forge-token-cost-audit.md §6):
// the draft call (972 est. vs. 1,676 actual, 1.72x) and refine turn 1 (1,449
// est. vs. 2,236 actual, 1.54x) both undercounted by a similar ~700-790
// token margin, on two calls that share nothing else structurally except
// this one constant — the simplest explanation consistent with both gaps
// at once, rather than tuning the draft/refine tool-schema constants
// separately from a single job's noise. At 1600, both calls recompute to
// ~0.96x-1.00x for that same run. This is a single-run calibration (n=1) —
// revisit if a future run's draft/turn-1 ratios drift from ~1.0x.
const SYSTEM_PROMPT_TOKENS_FRESH = 1600; // buildSystemPrompt incl. palette legend — see note above
const SYSTEM_PROMPT_TOKENS_REVISION = 925; // buildRevisionSystemPrompt incl. palette legend
const TOOL_SCHEMA_TOKENS_SUBMIT_DRAFT = 112;
const TOOL_SCHEMA_TOKENS_REFINE = 432; // REFINE_TOOLS (5 tools)
const TOOL_SCHEMA_TOKENS_REPAIR = 373; // REPAIR_TOOLS (4 tools, no `clear`)
const TOOL_SCHEMA_TOKENS_EVALUATE = 942; // SUBMIT_EVALUATION_TOOL
const EVALUATE_FRAMING_TOKENS = 230; // the fixed "grade harshly..." instruction text
// runDrawingJob redacts the draft's raw pixel array out of history right
// after it's consumed into the Canvas (see the redaction site there) — the
// array is real, one-time DRAFT-CALL OUTPUT (draftOutputTokens below, still
// paid for, unaffected by this), but from the very next call onward it no
// longer sits in history as resent input. What actually persists per fresh
// job from turn 1 onward is just: the short original-prompt user message,
// the redaction placeholder in place of the array, and the tool_result's
// own short framing text — all small and turn-count-independent, unlike
// the array they replaced. Values rounded up from the literal placeholder
// string's length (~30-35 tok) to stay conservative rather than undercount.
const FRESH_DRAFT_PROMPT_TOKENS = 40; // "Draw: {prompt}" user message
const FRESH_DRAFT_PLACEHOLDER_TOKENS = 50; // redacted submit_draft input, post-consumption
const FRESH_DRAFT_TOOL_RESULT_FRAMING_TOKENS = 20; // "ok" + "Initial draft rendered:" texts
// A revision's seed is a repair-plan/instruction text block, not a raw
// pixel array — smaller, and roughly turn-count-independent. Rough
// placeholder pending a direct measurement across real revision jobs.
const REVISION_SEED_TEXT_TOKENS = 400;
// What one completed refine turn adds to every later call's resent history:
// the assistant's own output for that turn (reused as the same estimate for
// this turn's output cost below, since that output IS what gets resent),
// plus its rendered image and a small amount of tool_result framing text.
// Split fresh vs. revision because they measure differently in practice:
// backed out from real per-job outputTokens across validation runs
// 2026-07-05_003/_004/_006/_007 (13 real jobs) — revision's V4 scaffold
// (CURRENT/PROBLEM/PRESERVE/SMALLEST EDIT/CONFIDENCE per issue) produces
// roughly 2x the free-text output per turn that fresh refinement does
// (measured averages: ~580 fresh, ~823 revision). A single shared constant
// was tried first and reproduced the audit's undercount unevenly across the
// two job types; splitting it removed that skew.
//
// ASSUMED_OUTPUT_TOKENS_PER_TURN_FRESH recalibrated 580 → 1050 from
// per-call logging in validation run 2026-07-05_011: real per-turn refine
// output was 736/1,026/1,051/1,346 across the job's 4 turns (toolCallCount
// 7/10/10/13 — more tool calls per turn costs more output tokens, and this
// run's turns used noticeably more edits per turn than the 580 figure,
// itself averaged from 6 older jobs, assumed). 1050 is that run's own
// 4-turn mean, not its max (1,346) — a deliberate choice to not fully
// overwrite the older 6-job evidence with one new job's noise, while still
// moving meaningfully toward the newer, larger real numbers rather than
// leaving a constant already known to undercount. Revision's constant is
// untouched — this run made no revision calls, nothing to recalibrate it
// from.
const ASSUMED_OUTPUT_TOKENS_PER_TURN_FRESH = 1050;
const ASSUMED_OUTPUT_TOKENS_PER_TURN_REVISION = 800;
const TOOL_RESULT_FRAMING_TOKENS = 20;
// evaluate's own output — was a flat, never-seriously-measured 150; run
// 2026-07-05_011 showed 1,493 real output tokens (a 9.95x miss, the single
// largest ratio in that job). A full structured evaluation (blindDescription
// + issues + preserve/doNotModify/intentionalChoices) is genuinely a large
// JSON payload, not a short reply. 1600 sits just above the one observed
// real value as a small safety margin, not an average — n=1 for this
// specific field, revisit with more evaluate-call data.
const EVALUATE_OUTPUT_TOKENS_ESTIMATE = 1600;

/** Rough pre-job estimate for the startup cost log — actual usage depends on
 *  how many edits the model makes each turn. Not for billing, just an
 *  operator heads-up before any credits are spent. Image-token estimate
 *  follows Anthropic's rough (width*height)/750 vision-token formula.
 *
 *  Models CUMULATIVE growth, not a flat per-turn cost: every refine/evaluate
 *  call resends the entire message history so far — system prompt and tool
 *  schema are a fixed floor paid on every call, but the history itself
 *  (every prior turn's assistant output, tool_result, and rendered image)
 *  keeps growing, so turn N's call costs more than turn 1's. The previous
 *  flat `maxTurns * perTurnCost` formula ignored that growth entirely and
 *  undercounted real jobs by 1.0x-2.9x, mean 1.81x, across the 13 real jobs
 *  in validation runs 2026-07-05_003/_004/_006/_007 (see
 *  docs/pixel-forge-token-cost-audit.md §2). Replaying this cumulative
 *  model against those same 13 jobs brought actual/estimate to 0.53x-1.50x,
 *  mean 1.10x — tighter, and erring on the side of slightly over-, not
 *  under-, estimating.
 *
 *  Fresh-job estimate updated again since: runDrawingJob now redacts the
 *  draft's raw pixel array out of history right after it's consumed (see
 *  the redaction site there), so — unlike the 13 jobs above, which all
 *  predate that change — a fresh job's refine/evaluate calls no longer
 *  resend that array on every turn. `seedTokens` below reflects that: a
 *  small placeholder-sized footprint instead of ~2 tok/pixel. This lowers
 *  fresh-job estimates by roughly 18% at the default 32px canvas (more at
 *  low turn counts, where the now-removed per-call array cost was a larger
 *  share of the total; less at high turn counts, where accumulated
 *  refine-turn history dominates regardless). Revision estimates are
 *  untouched — a revision job never has a draft call, so nothing to
 *  redact.
 *
 *  Reconfirmed and recalibrated against a real post-redaction run
 *  (2026-07-05_011, with per-call token logging — see
 *  docs/pixel-forge-token-cost-audit.md §6): draft-array redaction was
 *  CONFIRMED working at the call level (call 1's actual input sat below
 *  even the pre-redaction floor for that call), but three separate
 *  estimator constants were undercounting independent of the redaction —
 *  SYSTEM_PROMPT_TOKENS_FRESH, ASSUMED_OUTPUT_TOKENS_PER_TURN_FRESH, and
 *  EVALUATE_OUTPUT_TOKENS_ESTIMATE (see each constant's own comment for the
 *  specific evidence and correction). Replaying the recalibrated formula
 *  against that same run brings costRatio from 1.47x down to ~0.92x —
 *  slightly conservative (over-, not under-, estimating) rather than
 *  undercounting. This recalibration is based on a single run (n=1 for the
 *  fresh-job floor and evaluate-output constants); revisit if a future
 *  run's ratios drift.
 *
 *  Split from `estimateJobCostUsd` (below, a thin wrapper over this) so a
 *  caller — namely the validation runner — can record the estimated
 *  input/output token counts themselves, alongside the real ones a
 *  finished job returns, without duplicating this formula. */
export interface EstimatedCallTokens {
  phase: 'draft' | 'refine' | 'evaluate';
  turn: number | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/** Per-call estimate breakdown — the actual formula lives here now;
 *  `estimateJobTokenUsage` (below) just sums it, so there is exactly one
 *  place the cumulative-history model is written. Order is always
 *  [draft? , refine turn 1..maxTurns, evaluate] — fresh jobs include the
 *  draft entry, revisions don't (they have no draft call). Callers that
 *  log real per-call usage (runDrawingJob/runRevisionJob/refineAndEvaluate)
 *  index into this positionally rather than duplicating the math. */
export function estimateJobCallBreakdown(canvasSize: number, maxTurns: number, isRevision = false): EstimatedCallTokens[] {
  const pixelCount = canvasSize * canvasSize;
  const renderSide = canvasSize * PREVIEW_UPSCALE;
  const imageTokensPerRender = (renderSide * renderSide) / 750;

  const systemPromptTokens = isRevision ? SYSTEM_PROMPT_TOKENS_REVISION : SYSTEM_PROMPT_TOKENS_FRESH;
  const refineToolSchemaTokens = isRevision ? TOOL_SCHEMA_TOKENS_REPAIR : TOOL_SCHEMA_TOKENS_REFINE;
  // The seed content already sitting in history before refine turn 1 even
  // starts. Revision: the repair-plan/instruction text + the existing
  // trait's rendered image (unchanged by the draft redaction below — a
  // revision job never has a draft call, so nothing here to redact). Fresh
  // draft: post-redaction, NOT the draft's full raw pixel array anymore —
  // just the short prompt + redaction placeholder + tool_result framing,
  // plus its rendered image (real, unaffected).
  const seedTokens = isRevision
    ? REVISION_SEED_TEXT_TOKENS + imageTokensPerRender
    : FRESH_DRAFT_PROMPT_TOKENS + FRESH_DRAFT_PLACEHOLDER_TOKENS + FRESH_DRAFT_TOOL_RESULT_FRAMING_TOKENS + imageTokensPerRender;

  const assumedOutputTokensPerTurn = isRevision ? ASSUMED_OUTPUT_TOKENS_PER_TURN_REVISION : ASSUMED_OUTPUT_TOKENS_PER_TURN_FRESH;
  const perTurnHistoryGrowthTokens = assumedOutputTokensPerTurn + imageTokensPerRender + TOOL_RESULT_FRAMING_TOKENS;
  const perCallFloor = systemPromptTokens + refineToolSchemaTokens + seedTokens;

  const calls: EstimatedCallTokens[] = [];
  if (!isRevision) {
    calls.push({
      phase: 'draft', turn: null,
      estimatedInputTokens: SYSTEM_PROMPT_TOKENS_FRESH + TOOL_SCHEMA_TOKENS_SUBMIT_DRAFT + 40,
      estimatedOutputTokens: pixelCount * 3,
    });
  }
  // Turn t's refine call carries the fixed per-call floor (system + tools +
  // seed) plus (t-1) prior turns' worth of accumulated history.
  for (let t = 1; t <= maxTurns; t++) {
    calls.push({
      phase: 'refine', turn: t,
      estimatedInputTokens: perCallFloor + perTurnHistoryGrowthTokens * (t - 1),
      estimatedOutputTokens: assumedOutputTokensPerTurn,
    });
  }
  // Evaluate call: same per-call floor shape as a refine call, but with the
  // (larger) evaluate tool schema, and the FULL history from all maxTurns
  // refine turns — every refine turn has completed by the time this runs.
  calls.push({
    phase: 'evaluate', turn: null,
    estimatedInputTokens: systemPromptTokens + TOOL_SCHEMA_TOKENS_EVALUATE + seedTokens
      + perTurnHistoryGrowthTokens * maxTurns + EVALUATE_FRAMING_TOKENS,
    estimatedOutputTokens: EVALUATE_OUTPUT_TOKENS_ESTIMATE,
  });
  return calls;
}

export function estimateJobTokenUsage(canvasSize: number, maxTurns: number, isRevision = false): TokenUsage {
  return estimateJobCallBreakdown(canvasSize, maxTurns, isRevision).reduce(
    (acc, c) => ({
      inputTokens: acc.inputTokens + c.estimatedInputTokens,
      outputTokens: acc.outputTokens + c.estimatedOutputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/** Rough pre-job cost estimate for the startup cost log — see
 *  `estimateJobTokenUsage` for the actual token-level model this applies
 *  pricing to. Not for billing, just an operator heads-up before any
 *  credits are spent. */
export function estimateJobCostUsd(
  model: string, canvasSize: number, maxTurns: number, isRevision = false,
): number | null {
  return estimateCostUsd(model, estimateJobTokenUsage(canvasSize, maxTurns, isRevision));
}

function addUsage(acc: TokenUsage, usage: { input_tokens: number; output_tokens: number }): void {
  acc.inputTokens += usage.input_tokens;
  acc.outputTokens += usage.output_tokens;
}

export type PixelForgeErrorCode =
  | 'anthropic_rate_limited' | 'anthropic_insufficient_quota' | 'anthropic_overloaded'
  | 'anthropic_auth_error' | 'anthropic_error' | 'internal_error';

/** Classifies an error thrown from an Anthropic API call into a safe code
 *  + short message for the browser. The full error (including any raw
 *  provider payload) is logged server-side by the caller — never returned
 *  to the client verbatim, and never includes the API key. */
export function classifyAnthropicError(err: unknown): { code: PixelForgeErrorCode; safeMessage: string } {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const type = err.type;
    const message = err.message ?? '';
    if (status === 429 || type === 'rate_limit_error') {
      return { code: 'anthropic_rate_limited', safeMessage: 'Anthropic rate limit hit — wait a moment and try again.' };
    }
    if (status === 529 || type === 'overloaded_error') {
      return { code: 'anthropic_overloaded', safeMessage: 'Anthropic is temporarily overloaded — retry shortly.' };
    }
    if (type === 'billing_error' || /credit balance is too low/i.test(message)) {
      return { code: 'anthropic_insufficient_quota', safeMessage: 'Anthropic account has insufficient credits — check Plans & Billing.' };
    }
    if (status === 401 || type === 'authentication_error') {
      return { code: 'anthropic_auth_error', safeMessage: 'Anthropic API key rejected — check ANTHROPIC_API_KEY.' };
    }
    return { code: 'anthropic_error', safeMessage: 'Anthropic API error — see server logs for details.' };
  }
  return { code: 'internal_error', safeMessage: err instanceof Error ? err.message : 'Unexpected error.' };
}

export interface DrawingJobParams {
  prompt: string;
  layerType: LayerType;
  canvasSize?: number;
  palette?: string[];
  model?: string;
  maxTurns?: number;
  anchor?: string;
  /** Short, text-only style-construction guidance derived from an optional
   *  uploaded reference image (see src/pixel-agent/reference-analysis.ts).
   *  The reference image itself is never seen by this function or anything
   *  it calls — only this derived text ever reaches the model. Generation
   *  only; there is no revision-job equivalent (see
   *  docs/pixel-forge-reference-mode-mvp.md §6). */
  referenceGuidance?: string;
  /** Polled between turns; true ends the refine loop early (and skips the
   *  evaluate call entirely) so a user-triggered Stop actually saves the
   *  remaining credits rather than just hiding the rest of the run. */
  shouldStop?: () => boolean;
}

export interface RevisionJobParams {
  existingPixels: number[];
  size: number;
  /** Hex-only palette (no "transparent" sentinel) — same form Canvas/tools use. */
  palette: string[];
  layerType: LayerType;
  anchor?: string;
  /** May be '' — a revision can be driven by `repairPlan` alone (see
   *  docs/pixel-forge-revision-v3.md §8.3); this is layered on top as
   *  additional, higher-authority human instruction, not a replacement. */
  revisionPrompt: string;
  /** The trait's previous repair plan, or null (no prior plan — legacy
   *  trait, or this is its first revision). Drives the revision prompt;
   *  see buildRevisionSeedText. */
  repairPlan: RepairPlan | null;
  model: string;
  maxTurns: number;
  shouldStop?: () => boolean;
}

export interface DrawingIteration {
  turn: number;
  phase: 'draft' | 'seed' | 'refine' | 'evaluate';
  note: string;
  pngBase64: string;
}

/** One entry per real Anthropic call made during a job — deliberately
 *  compact (no raw messages, no tool-call payloads) so it's cheap to
 *  persist per-call in validation records, but detailed enough to see
 *  where cost actually comes from call-by-call: does input actually drop
 *  after the draft's pixel array is redacted from history (callIndex 1 vs.
 *  what call 0 cost), do refine calls grow with turn number the way the
 *  cumulative model predicts, is a specific turn's tool-call volume (not
 *  image/history) the real confound, is evaluate unexpectedly expensive.
 *  See docs/pixel-forge-token-cost-audit.md. */
export interface CallUsageRecord {
  callIndex: number;
  phase: 'draft' | 'refine' | 'evaluate';
  turn: number | null;
  inputTokens: number;
  outputTokens: number;
  /** From `estimateJobCallBreakdown`, same job config — null only if the
   *  breakdown didn't have a matching entry (shouldn't happen in practice,
   *  since callers always size it to cover every real call). */
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  notes: {
    /** Was a rendered image attached to history as a result of this call
     *  (false for the draft call itself, and for a refine turn skipped via
     *  noOpImageSkipped; true for evaluate, which always attaches one). */
    imageAttached: boolean;
    /** This refine turn's tool calls left the canvas grid byte-identical,
     *  so the image re-render/re-attach was skipped (§3.5 of the audit). */
    noOpImageSkipped: boolean;
    toolCallCount: number;
    /** Anthropic's own reason the response ended (e.g. "end_turn",
     *  "max_tokens", "tool_use") — null only if the SDK didn't return one.
     *  Added specifically to diagnose the zero-tool-call revision stalls in
     *  2026-07-05_015/_017, where output_tokens landed exactly at the
     *  max_tokens ceiling with no surviving tool_use or text — this makes
     *  that directly observable instead of inferred from token counts. */
    stopReason: string | null;
    /** Type of each content block in this response, in order (e.g.
     *  ["text", "tool_use"]) — NOT the raw block content/text itself, just
     *  the shape, so a truncated/empty-vs-populated response is visible
     *  without storing any prompt or model output text. */
    contentBlockTypes: string[];
    /** Total character count summed across this response's text-type
     *  blocks only (0 if none) — lets a truncated-with-no-visible-text
     *  response be distinguished from one that wrote a lot before stopping,
     *  again without storing the text itself. */
    textBlockCharCount: number;
  };
}

export interface TraitDrawResult {
  size: number;
  /** Canonical form: index 0 is the literal string "transparent", 1..N are hex. */
  palette: string[];
  /** Flat, row-major palette-index array — the canonical stored artwork. */
  pixels: number[];
  layerType: LayerType;
  anchor: string | null;
  pngBase64: string;
  evaluation: Evaluation;
  /** False when the job was stopped before the evaluate step ran —
   *  `evaluation` is then the STOPPED_EVALUATION placeholder, not a real
   *  grade. Callers must not build a RepairPlan from an ungraded result;
   *  see docs/pixel-forge-revision-v3.md §11 / repair-plan.ts. */
  graded: boolean;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number | null;
  /** Per-call breakdown behind `tokenUsage`'s totals — see CallUsageRecord. */
  callUsage: CallUsageRecord[];
}

function buildSystemPrompt(
  canvasSize: number, palette: readonly string[], layerType: LayerType, anchor?: string,
  referenceGuidance?: string,
): string {
  const legend = palette.map((hex, i) => `  ${i + 1}: ${hex}`).join('\n');
  const lines = [
    'You are a pixel-art trait artist. You produce ONE reusable trait layer',
    'at a time for a layered NFT collection — this trait will later be',
    'composited with others by a separate, non-AI process, so consistency',
    'matters more than any single "nice picture." You draw by calling tools',
    `that edit a shared ${canvasSize}x${canvasSize} pixel grid — you do not`,
    'generate an image directly.',
    '',
    'Coordinates: (0, 0) is the TOP-LEFT corner. x increases to the right',
    `(column), y increases downward (row). Both range from 0 to ${canvasSize - 1}.`,
    '',
    'Colors are palette indices, not RGB. Index 0 is always transparent —',
    'leave any area that is not part of the subject transparent so this',
    'layer can be composited over other layers later. Palette:',
    legend,
    '',
    `Layer type: ${layerType}. Consistency with other traits of the same`,
    'layer type matters more than novelty — keep proportions and placement',
    `in line with what a "${layerType}" layer should look like across a`,
    'whole set.',
    ...(layerType === 'icon' ? [
      '',
      'This is a standalone symbol/icon (e.g. a heart, star, skull, logo) —',
      'it does NOT need to look wearable or attached to anything. A clean,',
      'self-contained silhouette is exactly right; do not add straps,',
      'chains, or attachment points.',
    ] : []),
    ...(layerType === 'accessory' ? [
      '',
      'This must read as something worn or attached to a character — give',
      'it a strap, chain, string, or clear attachment point. A plain',
      'floating shape with no wearable context under-delivers as an',
      'accessory; use layer type "icon" instead for standalone shapes.',
    ] : []),
    '',
    `Submitting the draft: it must contain EXACTLY ${canvasSize * canvasSize}`,
    'integers — count your array before calling submit_draft; a single',
    'extra or missing value corrupts the whole grid. Build the silhouette',
    'deliberately, not freehand: for a symmetric subject, mirror the left',
    'and right halves. Block out the overall recognizable outline first —',
    'the defining features that make the subject identifiable at a glance',
    '(e.g. a heart needs two distinct rounded lobes at the top with a dip',
    'between them, tapering to a single sharp point at the bottom — a',
    'plain rounded blob or hexagon is NOT a heart) — then fill, then add',
    'small details last. At this resolution every pixel matters; prefer a',
    'few large, deliberate regions over many scattered small edits.',
    '',
    'Refining: after your first pass, actually look at the rendered image',
    'and judge it as a stranger seeing it for the first time would — not',
    'as confirmation of what you meant to draw. If the silhouette does not',
    'immediately and unambiguously read as the intended subject, use',
    'flood_fill/clear and rebuild the wrong region; do not declare it done',
    'while merely restating your original intention. Only stop calling',
    'tools once the shape is genuinely unmistakable.',
    '',
    'Recognizability: a clean, technically tidy silhouette is not enough on',
    'its own — before finishing, identify 2-4 features that are UNIQUELY',
    'DEFINING for the specific requested subject (not generic properties',
    'every similar shape shares). If the subject is a named animal,',
    'object, or icon, it must include the particular visual cues that make',
    'it immediately recognizable as THAT subject rather than something',
    'generic in its class — e.g. a cat needs more than round ears and dot',
    'eyes (those alone read as a generic creature); it needs the specific',
    'combination that reads as "cat" (pointed ears with a notch, a small',
    'triangular nose, whiskers). A plain blob with appendages in roughly',
    'the right places is a failure even if the pixel work is clean. If',
    'those defining features are missing once you inspect the render,',
    'revise before finalizing — do not stop at "technically fine."',
    '',
    'Hair, fur, eyebrows, and beards must not be flat-edged rectangles or',
    'single solid blocks — that reads as cloth, collar, or scarf, not hair.',
    'Build hair-like material with a jagged, tapered, or stepped boundary:',
    'stack 2-3 small fill_rect regions of decreasing width, or place a few',
    'boundary pixels to break the edge. A beard should attach to the lower',
    'face/cheeks and taper or fringe downward; it should not sit as a flat',
    'horizontal bar under the head.',
  ];
  if (referenceGuidance && referenceGuidance.trim()) {
    lines.push(
      '',
      'Style reference (structure only — the source image itself is not',
      'shown to you and must not be guessed at or reconstructed):',
      referenceGuidance.trim(),
    );
  }
  if (anchor && anchor.trim()) {
    lines.push('', `Anchor / alignment requirement: ${anchor.trim()}`);
  }
  return lines.join('\n');
}

/** Revision V4 — pixel surgeon, not illustrator. Distinct from
 *  buildSystemPrompt (a fresh drawing's own turn-by-turn self-correction)
 *  and a hardening of V3's revision framing: V3 already made regions
 *  default-deny (don't touch an un-named region); V4 pushes that same
 *  default-deny down to the PIXEL level inside an allowed region (being
 *  allowed to touch it is not license to redraw it). See
 *  docs/pixel-forge-revision-v4.md, and the real regression it was
 *  written from: validation run 2026-07-05_003's icon-heart trait — a
 *  revision resolved one issue but silently deleted a clean outline
 *  nothing had asked it to touch, net-worsening severity major→critical.
 *  That specific failure is now an explicit rule below, not just an
 *  implied one. */
function buildRevisionSystemPrompt(
  canvasSize: number, palette: readonly string[], layerType: LayerType, anchor?: string,
): string {
  const legend = palette.map((hex, i) => `  ${i + 1}: ${hex}`).join('\n');
  const lines = [
    'You are a pixel surgeon repairing an existing pixel-art trait layer —',
    'not an illustrator reinterpreting it. Every existing pixel is presumed',
    'correct unless a specific listed repair item proves otherwise. The',
    'burden of proof is on changing a pixel, never on leaving one alone.',
    `You draw by calling tools that edit a shared ${canvasSize}x${canvasSize} pixel grid.`,
    '',
    'DEFAULT RULE (region): if a region is not named by an open repair item',
    'below, it is off-limits — do not restyle, "improve", or reinterpret it,',
    'even if you would have drawn it differently.',
    '',
    'DEFAULT RULE (pixel): being allowed to touch a region is not license to',
    'redraw it. Change only the specific pixels needed to resolve the named',
    'problem — nudge, trim, extend, or connect; do not recreate the region',
    'from scratch.',
    '',
    'REAL FAILURE, DO NOT REPEAT IT: a repair that improves the targeted',
    'shape but removes or redraws a clean outline is a FAILED repair, not a',
    'successful one, even if the target issue is resolved — outline is',
    'preserved by default exactly like every other untouched detail. Only',
    'touch outline pixels when an issue\'s own category or location',
    'explicitly names the outline. The same rule applies to palette,',
    'material, or background pixels an issue does not name.',
    '',
    'Coordinates: (0, 0) is the TOP-LEFT corner. x increases to the right',
    `(column), y increases downward (row). Both range from 0 to ${canvasSize - 1}.`,
    '',
    'Colors are palette indices, not RGB. Index 0 is always transparent.',
    'Palette:',
    legend,
    '',
    `Layer type: ${layerType}. Do not change what kind of layer this is.`,
    '',
    'Before working each issue, think briefly in this shape, as plain text',
    'preceding your first edit for that issue (once per issue, not once per',
    'tool call):',
    '  CURRENT: what the region actually looks like right now',
    '  PROBLEM: the specific thing that is wrong and why it matters',
    '  PRESERVE: what is immediately adjacent that must not move',
    '  SMALLEST EDIT: the minimum tool call(s) that could resolve it',
    '  CONFIDENCE: low / medium / high',
    '',
    'Prefer the smallest tool that could plausibly work: a point correction',
    '(set_pixel) over a seam repair (draw_line) over a patch (fill_rect, no',
    'larger than the broken feature itself) over a full region replacement',
    '(flood_fill — only for a genuinely isolated, entirely-wrong area with',
    'no correct detail worth keeping inside it). If your own plan for a fix',
    'would use the word "redraw", "repaint", or "redo", stop and reframe it',
    'as a nudge, trim, extension, or connection instead.',
    '',
    'Hair, fur, eyebrows, and beards must not be flat-edged rectangles or',
    'single solid blocks — that reads as cloth, collar, or scarf, not hair.',
    'Build hair-like material with a jagged, tapered, or stepped boundary:',
    'stack 2-3 small fill_rect regions of decreasing width, or place a few',
    'boundary pixels to break the edge. A beard should attach to the lower',
    'face/cheeks and taper or fringe downward; it should not sit as a flat',
    'horizontal bar under the head. This applies even when the smallest-edit',
    'rule above limits you to nudging an existing region\'s boundary rather',
    'than rebuilding it.',
    '',
    'Work one issue at a time — fully resolved or deliberately deferred —',
    'before starting the next, even two issues in the same tier. Work',
    'through tiers in order: never attempt a cosmetic-tier fix (palette,',
    'hue, material, outline, cluster, lighting, composition, background)',
    'while any structural/feature-tier issue at critical or major severity',
    'is still open.',
    '',
    'After every edit, look at the render and check specifically for',
    'damage, not just progress: did anything outside this issue\'s own',
    'region change? A regression you catch yourself is free; one the next',
    'evaluation catches costs a full extra round.',
    '',
    'At low confidence, make the smallest possible probe edit, re-render,',
    'and reassess before doing more — if still unsure, leave the issue for',
    'a future round rather than guess with a larger edit. At high',
    'confidence, resolve it fully in one focused pass.',
    '',
    'Human instructions (if present below) outrank the repair plan — if',
    'they conflict with something under Preserve or Ignore, follow the',
    'human instruction and say so in your closing note rather than silently',
    'picking one.',
    '',
    'Stop calling tools as soon as every open critical- and major-severity',
    'issue\'s "done when" condition holds. Minor issues are opportunistic',
    'only — attempt one only at high confidence and zero risk to work',
    'already done, otherwise leave it. Unused turns are a good outcome, not',
    'wasted budget — never keep editing just because turns remain.',
    '',
    'Before you stop, look at the current rendered image as a skeptical',
    'stranger who only sees the pixels. For every open critical or major',
    'repair item you attempted or skipped, compare the visible pixels to',
    'that item\'s DONE WHEN text. If the DONE WHEN condition is not visibly',
    'true, do not declare the round complete merely because you explained',
    'the intended fix. Either make the smallest safe additional edit that',
    'moves that exact item closer to DONE WHEN, or explicitly leave it',
    'unresolved in your final note. This is a verification gate, not',
    'permission to touch unrelated regions.',
  ];
  if (anchor && anchor.trim()) {
    lines.push('', `Anchor / alignment requirement: ${anchor.trim()}`);
  }
  return lines.join('\n');
}

/** Renders a RepairPlan into the plain-text block a revision job's seed
 *  message is built from — structure from docs/pixel-forge-revision-v3.md
 *  §8.1, per-issue labels (CURRENT/PROBLEM/PRESERVE/SMALLEST EDIT/
 *  CONFIDENCE) from the V4 surgical-repair scaffold, see
 *  docs/pixel-forge-revision-v4.md §3/§6 — CONFIDENCE is left as an
 *  instruction for the model to fill in, never pre-computed here.
 *  Sections with no content are omitted entirely (no "Tier 4: none") to
 *  keep token cost proportional to actual issue count. */
function renderRepairPlanForPrompt(plan: RepairPlan): string {
  const lines: string[] = [];
  if (plan.preserve.length > 0) {
    lines.push('PRESERVE (confirmed good — do not regress):');
    for (const p of plan.preserve) lines.push(`- ${p.description}${p.reason ? ` (${p.reason})` : ''}`);
    lines.push('');
  }
  if (plan.doNotModify.length > 0) {
    lines.push('DO NOT MODIFY (hard constraint, no exceptions):');
    for (const d of plan.doNotModify) lines.push(`- ${d}`);
    lines.push('');
  }
  if (plan.intentionalChoices.length > 0) {
    lines.push('IGNORE (deliberate choices — do not "fix" these):');
    for (const c of plan.intentionalChoices) lines.push(`- ${c}`);
    lines.push('');
  }
  if (plan.issues.length > 0) {
    lines.push(
      'REPAIR PLAN — work through tiers in order; do not begin a later tier',
      'until every repair in the current tier is done and its "done when"',
      'condition holds.',
      '',
    );
    const byId = new Map(plan.issues.map(i => [i.id, i]));
    for (const tier of plan.sequence) {
      const items = tier.issueIds.map(id => byId.get(id)).filter((x): x is StoredRepairItem => Boolean(x));
      if (items.length === 0) continue;
      lines.push(`Tier ${tier.tier} — ${tier.label}:`);
      for (const it of items) {
        const flag = it.regressed ? ' [REGRESSION — this broke something previously confirmed good]' : '';
        lines.push(`  [${it.id}] (${it.severity}${flag}) ${it.location}`);
        lines.push(`    CURRENT: ${it.problem}`);
        if (it.reason) lines.push(`    PROBLEM: ${it.reason}`);
        lines.push(`    PRESERVE: everything outside "${it.location}" — including this region's own outline`);
        lines.push(`      unless outline is specifically what's named above — plus everything already`);
        lines.push(`      listed under PRESERVE/DO NOT MODIFY.`);
        lines.push(`    SMALLEST EDIT: ${it.repairStrategy}`);
        lines.push('    CONFIDENCE: state low/medium/high before your first edit on this issue.');
        lines.push(`    DONE WHEN: ${it.expectedResult}`);
      }
      lines.push('');
    }
  }
  if (plan.deferred.length > 0) {
    lines.push(
      `(${plan.deferred.length} lower-priority issue(s) known but deferred to a later `
      + 'revision — not part of this round, do not spend turns on them.)',
      '',
    );
  }
  if (plan.successCriteria.length > 0) {
    lines.push('SUCCESS CRITERIA — this is exactly what the next evaluation checks:');
    for (const c of plan.successCriteria) lines.push(`- ${c}`);
  }
  return lines.join('\n').trim();
}

/** Builds the revision job's seed user-message text from a RepairPlan (or,
 *  absent one, falls back to a plain instruction — a legacy trait with no
 *  stored plan, or a plan with nothing open). Human free text is layered
 *  on afterward, always, since it's allowed even when it's the only
 *  direction given. See docs/pixel-forge-revision-v3.md §8.1/§8.3. */
function buildRevisionSeedText(plan: RepairPlan | null, humanInstructions: string): string {
  const human = humanInstructions.trim();
  const hasStructuredPlan = plan !== null && (plan.issues.length > 0 || plan.preserve.length > 0 || plan.doNotModify.length > 0);

  if (!hasStructuredPlan) {
    return human
      ? `Revise this existing layer. Instructions: ${human}`
      : 'Revise this existing layer, addressing any issues you can identify from a careful, '
        + 'skeptical look at the render — there is no prior structured repair plan for this trait.';
  }

  const planText = renderRepairPlanForPrompt(plan);
  const humanBlock = human
    ? `\n\nADDITIONAL HUMAN INSTRUCTIONS (outrank everything above — if they conflict with a `
      + `Preserve/Ignore item, follow the human instruction and say so in your closing note):\n${human}`
    : '';
  return `${planText}${humanBlock}`;
}

function isToolUse(block: { type: string }): block is ToolUseBlock {
  return block.type === 'tool_use';
}
function isText(block: { type: string }): block is TextBlock {
  return block.type === 'text';
}

/** Compact, non-content diagnostic summary of a raw API response — block
 *  TYPES and a text char count only, never the actual prompt/response text
 *  or tool-call payloads. Added to diagnose the zero-tool-call revision
 *  stalls (2026-07-05_015/_017: output_tokens landed exactly at max_tokens
 *  with no surviving tool_use or text) without storing raw content anywhere. */
function responseDiagnostics(response: { stop_reason: string | null; content: readonly { type: string }[] }): {
  stopReason: string | null; contentBlockTypes: string[]; textBlockCharCount: number;
} {
  return {
    stopReason: response.stop_reason,
    contentBlockTypes: response.content.map(b => b.type),
    textBlockCharCount: response.content.filter(isText).reduce((sum, b) => sum + b.text.length, 0),
  };
}

function imageBlock(pngBase64: string) {
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: pngBase64 } };
}

function draftMaxTokens(pixelCount: number): number {
  return Math.min(8192, 1024 + pixelCount * 4);
}

// What runDrawingJob stores in place of the draft's raw pixel array once
// it's been consumed into the Canvas — see the redaction site in
// runDrawingJob for the full rationale.
const DRAFT_PIXELS_HISTORY_PLACEHOLDER =
  'submitted — accepted and rendered as the image in the next message; full array cleared from history to save tokens';

// parseEvaluation now lives in tools.ts, next to the Evaluation type and
// the tool schema it parses — imported above.

const STOPPED_EVALUATION: Evaluation = {
  schemaVersion: EVALUATION_SCHEMA_VERSION,
  blindDescription: '',
  recognizableAsSubject: false,
  // Empty, not populated — this run was never graded, so there is nothing
  // to build a RepairPlan from. Callers must check `graded` rather than
  // infer "no issues" from an empty array here.
  issues: [],
  preserve: [],
  doNotModify: [],
  intentionalChoices: [],
  notes: 'Stopped by user before the self-evaluation step — not graded.',
};

/** Phase B (refine) + phase C (evaluate) — shared by fresh draws and
 *  revisions. `messages` already contains the seed (draft or existing-grid)
 *  turn; `lastPngBase64` is that seed's render. Mutates `canvas` and `usage`
 *  in place. `shouldStop` is checked before every model call — including the
 *  evaluate call — so a mid-run Stop actually skips remaining spend rather
 *  than just hiding it. */
async function refineAndEvaluate(opts: {
  client: Anthropic;
  system: string;
  messages: MessageParam[];
  canvas: Canvas;
  palette: readonly string[];
  model: string;
  maxTurns: number;
  lastPngBase64: string;
  usage: TokenUsage;
  /** REFINE_TOOLS for a fresh draft, REPAIR_TOOLS (no `clear`) for a
   *  revision — see docs/pixel-forge-revision-v3.md §4. */
  tools: Tool[];
  /** true for a revision job, false for a fresh draft's refine phase.
   *  Only used to pick the refine call's max_tokens (see
   *  REFINE_MAX_TOKENS_REVISION below) — does not otherwise change
   *  behavior. See the zero-tool-call-stall investigation
   *  (2026-07-05_015/_017): both stalled revision refine calls returned
   *  output_tokens exactly at the old shared 2048 ceiling with zero
   *  surviving tool_use, which is consistent with truncation before the
   *  model ever reached a tool call. Fresh-draft refine turns never showed
   *  this pattern in any real run, so only revision's ceiling is raised. */
  isRevision: boolean;
  shouldStop?: () => boolean;
  onIteration: (iter: DrawingIteration) => void;
  /** Mutated in place — one entry appended per real call this function
   *  makes (every refine turn that actually calls the API, plus evaluate).
   *  Caller owns/reads it after the call resolves. */
  callLog: CallUsageRecord[];
  /** Positional: index 0 = refine turn 1, ..., index maxTurns-1 = refine
   *  turn maxTurns, index maxTurns = evaluate. Always sized maxTurns+1 by
   *  the caller (estimateJobCallBreakdown, minus any draft entry). */
  callEstimates: EstimatedCallTokens[];
}): Promise<{ pngBase64: string; evaluation: Evaluation; graded: boolean }> {
  const { client, system, messages, canvas, palette, model, maxTurns, usage, shouldStop, onIteration, tools, callLog, callEstimates, isRevision } = opts;
  const refineMaxTokens = isRevision ? REFINE_MAX_TOKENS_REVISION : REFINE_MAX_TOKENS_FRESH;
  let lastPngBase64 = opts.lastPngBase64;
  let stopped = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (shouldStop?.()) {
      onIteration({ turn, phase: 'refine', note: 'stopped by user', pngBase64: lastPngBase64 });
      stopped = true;
      break;
    }

    const response = await client.messages.create({
      model,
      max_tokens: refineMaxTokens,
      system,
      messages,
      tools,
      // Sonnet 5 defaults to adaptive thinking when `thinking` is omitted
      // (confirmed via the Anthropic SDK/API investigation — Opus 4.7/4.8
      // default to thinking-off on omission, but Sonnet 5 does not). With
      // `tool_choice` left as `auto` here, a turn can spend its entire
      // max_tokens budget on an adaptive `thinking` block and never reach
      // a `tool_use` block — the exact zero-tool-call stall seen in
      // 2026-07-05_015/_017/_018 (stopReason: "max_tokens",
      // contentBlockTypes: ["thinking"]). Raising max_tokens didn't help
      // (_018 hit the same wall at the new 4096 ceiling) because adaptive
      // thinking shares the same budget rather than having its own —
      // disabling it removes the failure mode instead of just deferring
      // it to a higher token count.
      thinking: { type: 'disabled' },
    });
    addUsage(usage, response.usage);
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(isToolUse);
    const note = response.content.filter(isText).map(b => b.text).join(' ').trim();
    const refineEstimate = callEstimates[turn - 1];
    const diagnostics = responseDiagnostics(response);

    if (toolUses.length === 0) {
      callLog.push({
        callIndex: callLog.length, phase: 'refine', turn,
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        estimatedInputTokens: refineEstimate?.estimatedInputTokens ?? null,
        estimatedOutputTokens: refineEstimate?.estimatedOutputTokens ?? null,
        notes: { imageAttached: false, noOpImageSkipped: false, toolCallCount: 0, ...diagnostics },
      });
      onIteration({ turn, phase: 'refine', note: note || 'done', pngBase64: lastPngBase64 });
      break;
    }

    const gridBefore = canvas.snapshotGrid();
    const toolResults: ToolResultBlockParam[] = toolUses.map(tu => {
      const result = executeTool(canvas, tu.name, tu.input);
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.isError,
      };
    });
    // A turn whose tool calls left the grid byte-identical (a repeat/no-op
    // edit, or every call in the batch errored) has nothing new to render —
    // skip the re-render and don't attach a duplicate image to history,
    // since that image would just resend on every later call for no reason.
    // See docs/pixel-forge-token-cost-audit.md §3.5.
    const canvasChanged = !Canvas.gridsEqual(gridBefore, canvas.snapshotGrid());

    if (canvasChanged) {
      const pngBuf = await canvas.toPng(palette, PREVIEW_UPSCALE);
      lastPngBase64 = pngBuf.toString('base64');
    }

    callLog.push({
      callIndex: callLog.length, phase: 'refine', turn,
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
      estimatedInputTokens: refineEstimate?.estimatedInputTokens ?? null,
      estimatedOutputTokens: refineEstimate?.estimatedOutputTokens ?? null,
      notes: { imageAttached: canvasChanged, noOpImageSkipped: !canvasChanged, toolCallCount: toolUses.length, ...diagnostics },
    });

    onIteration({ turn, phase: 'refine', note: note || `${toolUses.length} edit(s) applied`, pngBase64: lastPngBase64 });

    // Render once per turn (not per tool call) and append it as a trailing
    // block in the same user message — never inside a tool_result's own
    // content. Anthropic rejects non-text content on a tool_result whose
    // is_error is true, and any call in this turn's batch could have
    // errored (e.g. an out-of-bounds pixel), so a fixed "attach to the last
    // tool_result" rule isn't safe.
    messages.push({
      role: 'user',
      content: canvasChanged
        ? [
            ...toolResults,
            { type: 'text', text: "Current canvas state after this turn's edits:" },
            imageBlock(lastPngBase64),
          ]
        : [
            ...toolResults,
            { type: 'text', text: "This turn's edits produced no visible change to the canvas — no new render; canvas state is unchanged from the image shown previously." },
          ],
    });
  }

  if (stopped || shouldStop?.()) {
    onIteration({ turn: maxTurns + 1, phase: 'evaluate', note: STOPPED_EVALUATION.notes, pngBase64: lastPngBase64 });
    return { pngBase64: lastPngBase64, evaluation: STOPPED_EVALUATION, graded: false };
  }

  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Final canvas state — self-assess it now with submit_evaluation. Grade harshly: '
          + 'this gates whether a human even considers approving the trait, and directly feeds '
          + 'the next revision\'s repair plan if one is needed. First, write blindDescription: '
          + 'describe the render cold, as a stranger seeing it for the first time, with NO '
          + 'reference to the original prompt or what you intended to draw. Only after that, '
          + 'compare your blind description against the specific intended subject to decide '
          + 'recognizableAsSubject — a description that only loosely gestures at the subject is '
          + 'NOT recognizable. Then list issues: every specific problem, each with a category, '
          + 'severity (critical/major/minor), plain-language location, the problem observed, why '
          + 'it matters, a concrete repair strategy, and a falsifiable expected result. Empty '
          + 'issues array ONLY if truly nothing is wrong. Also list preserve (what is already '
          + 'good and must not regress), doNotModify (hard-locked regions/elements), and '
          + 'intentionalChoices (things that look questionable but are deliberate style, so a '
          + 'later revision does not "fix" them).',
      },
      imageBlock(lastPngBase64),
    ],
  });
  const evalResponse = await client.messages.create({
    model,
    max_tokens: 1536,
    system,
    messages,
    tools: [SUBMIT_EVALUATION_TOOL],
    tool_choice: { type: 'tool', name: 'submit_evaluation' },
  });
  addUsage(usage, evalResponse.usage);
  const evalBlock = evalResponse.content.find(isToolUse);
  const evaluation = parseEvaluation(evalBlock?.input);
  const evaluateEstimate = callEstimates[maxTurns];
  callLog.push({
    callIndex: callLog.length, phase: 'evaluate', turn: null,
    inputTokens: evalResponse.usage.input_tokens, outputTokens: evalResponse.usage.output_tokens,
    estimatedInputTokens: evaluateEstimate?.estimatedInputTokens ?? null,
    estimatedOutputTokens: evaluateEstimate?.estimatedOutputTokens ?? null,
    notes: {
      imageAttached: true, noOpImageSkipped: false,
      toolCallCount: evalResponse.content.filter(isToolUse).length, ...responseDiagnostics(evalResponse),
    },
  });
  onIteration({ turn: maxTurns + 1, phase: 'evaluate', note: evaluation.notes || evaluation.blindDescription || 'evaluated', pngBase64: lastPngBase64 });

  return { pngBase64: lastPngBase64, evaluation, graded: true };
}

export async function runDrawingJob(
  params: DrawingJobParams,
  onIteration: (iter: DrawingIteration) => void,
): Promise<TraitDrawResult> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const canvasSize = params.canvasSize ?? DEFAULT_CANVAS_SIZE;
  const palette = (params.palette && params.palette.length > 0) ? params.palette : [...DEFAULT_PALETTE];
  const model = params.model ?? DEFAULT_MODEL;
  const maxTurns = Math.min(params.maxTurns ?? DEFAULT_MAX_TURNS, HARD_MAX_TURNS);
  const { layerType, anchor, referenceGuidance } = params;

  const client = new Anthropic({ apiKey });
  const system = buildSystemPrompt(canvasSize, palette, layerType, anchor, referenceGuidance);
  const messages: MessageParam[] = [
    { role: 'user', content: `Draw: ${params.prompt}` },
  ];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  // [draft, refine turn 1..maxTurns, evaluate] — see estimateJobCallBreakdown.
  const callEstimates = estimateJobCallBreakdown(canvasSize, maxTurns, false);
  const callLog: CallUsageRecord[] = [];

  // ── Phase A: draft ────────────────────────────────────────────────────
  const pixelCount = canvasSize * canvasSize;
  const draftResponse = await client.messages.create({
    model,
    max_tokens: draftMaxTokens(pixelCount),
    system,
    messages,
    tools: [buildSubmitDraftTool(canvasSize)],
    tool_choice: { type: 'tool', name: 'submit_draft' },
  });
  addUsage(usage, draftResponse.usage);
  callLog.push({
    callIndex: callLog.length, phase: 'draft', turn: null,
    inputTokens: draftResponse.usage.input_tokens, outputTokens: draftResponse.usage.output_tokens,
    estimatedInputTokens: callEstimates[0]?.estimatedInputTokens ?? null,
    estimatedOutputTokens: callEstimates[0]?.estimatedOutputTokens ?? null,
    notes: {
      imageAttached: false, noOpImageSkipped: false,
      toolCallCount: draftResponse.content.filter(isToolUse).length, ...responseDiagnostics(draftResponse),
    },
  });

  const draftBlock = draftResponse.content.find(isToolUse);
  if (!draftBlock) throw new Error('agent did not submit a draft');
  const draftInput = (draftBlock.input ?? {}) as { pixels?: unknown };
  if (!Array.isArray(draftInput.pixels) || draftInput.pixels.length === 0) {
    throw new Error('draft did not include a pixels array');
  }
  let draftPixels = draftInput.pixels.map(Number);
  // minItems/maxItems in the tool schema are a hint, not an API-enforced
  // guarantee — smaller/faster models (observed with Haiku) can be off by a
  // pixel or two. Clamp/pad rather than discard an already-paid-for draft
  // call over a harmless length slip; only a genuinely bad value throws.
  if (draftPixels.length !== pixelCount) {
    console.warn(`[pixel-agent] draft had ${draftPixels.length} pixels, expected ${pixelCount} — clamping`);
    draftPixels = draftPixels.length > pixelCount
      ? draftPixels.slice(0, pixelCount)
      : [...draftPixels, ...new Array(pixelCount - draftPixels.length).fill(0)];
  }
  if (draftPixels.some(n => !Number.isInteger(n) || n < 0 || n > palette.length)) {
    throw new Error('draft contained a pixel value outside the palette range');
  }

  const canvas = Canvas.fromFlatArray(canvasSize, draftPixels);
  const draftPngBase64 = (await canvas.toPng(palette, PREVIEW_UPSCALE)).toString('base64');

  // The draft's raw pixel array is fully consumed as of the line above (it
  // seeded `canvas`) — nothing downstream ever needs to re-read those
  // literal numbers again; the rendered image (attached to the tool_result
  // right below, and resent as part of history from here on regardless)
  // and the server-side `Canvas` object are what actually matter from this
  // point forward. Store this assistant turn with a short confirmation in
  // place of the full (up to 1024-integer) array, so it doesn't keep
  // resending unchanged on every one of this job's remaining refine +
  // evaluate calls. Only the matching tool_use block's `input` is rewritten
  // — its `id`/`name` are untouched, so tool_result linkage on the very
  // next message is unaffected, and any other content in this turn (e.g.
  // stray preamble text) passes through as-is. See
  // docs/pixel-forge-token-cost-audit.md §3 item 2.
  messages.push({
    role: 'assistant',
    content: draftResponse.content.map(block => (
      isToolUse(block) && block.id === draftBlock.id
        ? { ...block, input: { pixels: DRAFT_PIXELS_HISTORY_PLACEHOLDER } }
        : block
    )),
  });

  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: draftBlock.id,
      content: [
        { type: 'text', text: 'ok' },
        { type: 'text', text: 'Initial draft rendered:' },
        imageBlock(draftPngBase64),
      ],
    }],
  });
  onIteration({ turn: 0, phase: 'draft', note: 'draft submitted', pngBase64: draftPngBase64 });

  const { pngBase64, evaluation, graded } = await refineAndEvaluate({
    client, system, messages, canvas, palette, model, maxTurns, usage, tools: REFINE_TOOLS, isRevision: false,
    shouldStop: params.shouldStop, lastPngBase64: draftPngBase64, onIteration,
    callLog, callEstimates: callEstimates.slice(1), // drop the draft entry already logged above
  });

  const estimatedCostUsd = estimateCostUsd(model, usage);
  console.log('[pixel-agent] job usage', {
    model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd,
  });

  return {
    size: canvasSize,
    palette: ['transparent', ...palette],
    pixels: canvas.toFlatArray(),
    layerType,
    anchor: anchor ?? null,
    pngBase64,
    evaluation,
    graded,
    tokenUsage: usage,
    estimatedCostUsd,
    callUsage: callLog,
  };
}

export async function runRevisionJob(
  params: RevisionJobParams,
  onIteration: (iter: DrawingIteration) => void,
): Promise<TraitDrawResult> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { size, palette, layerType, anchor, revisionPrompt, repairPlan, model } = params;
  const maxTurns = Math.min(params.maxTurns, HARD_MAX_TURNS);

  const client = new Anthropic({ apiKey });
  const system = buildRevisionSystemPrompt(size, palette, layerType, anchor);
  const canvas = Canvas.fromFlatArray(size, params.existingPixels);
  const seedPngBase64 = (await canvas.toPng(palette, PREVIEW_UPSCALE)).toString('base64');
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  // Revision has no draft call — [refine turn 1..maxTurns, evaluate] covers
  // every real call this job makes, so the full breakdown applies as-is.
  const callEstimates = estimateJobCallBreakdown(size, maxTurns, true);
  const callLog: CallUsageRecord[] = [];

  const seedText = buildRevisionSeedText(repairPlan, revisionPrompt);
  const messages: MessageParam[] = [{
    role: 'user',
    content: [
      { type: 'text', text: seedText },
      { type: 'text', text: 'Current canvas state:' },
      imageBlock(seedPngBase64),
    ],
  }];
  onIteration({ turn: 0, phase: 'seed', note: 'existing trait loaded', pngBase64: seedPngBase64 });

  const { pngBase64, evaluation, graded } = await refineAndEvaluate({
    client, system, messages, canvas, palette, model, maxTurns, usage, tools: REPAIR_TOOLS, isRevision: true,
    shouldStop: params.shouldStop, lastPngBase64: seedPngBase64, onIteration,
    callLog, callEstimates,
  });

  const estimatedCostUsd = estimateCostUsd(model, usage);
  console.log('[pixel-agent] revision usage', {
    model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd,
  });

  return {
    size,
    palette: ['transparent', ...palette],
    pixels: canvas.toFlatArray(),
    layerType,
    anchor: anchor ?? null,
    pngBase64,
    evaluation,
    graded,
    tokenUsage: usage,
    estimatedCostUsd,
    callUsage: callLog,
  };
}
