/**
 * Tool-use schemas for the three drawing-agent phases, plus the executor
 * that dispatches a refine-phase tool_use block to a Canvas instance.
 * Every `color` parameter is a palette index: 0 = transparent, 1..N = the
 * Nth entry of the palette hex list supplied for the job.
 *
 *   Phase A (draft):      `submit_draft`      — forced tool_choice, one shot.
 *   Phase B (refine):     `REFINE_TOOLS`      — free tool use + vision loop.
 *                          `REPAIR_TOOLS`      — same, minus `clear`, for revisions
 *                          (see docs/pixel-forge-revision-v3.md §4 — a revision
 *                          job must never be able to wipe the whole canvas).
 *   Phase C (evaluate):   `submit_evaluation` — forced tool_choice, one shot.
 *                          Output shape is `Evaluation` (schema v2) — see
 *                          docs/pixel-forge-revision-v3.md §7. This is the
 *                          call that produces the raw material a RepairPlan
 *                          (src/pixel-agent/repair-plan.ts) is assembled
 *                          from; there is no separate "repair planning" call.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { Canvas } from './canvas';

/** Forces Claude to emit the entire initial grid as one flat, row-major
 *  array in a single call — no vision needed yet, so this phase is cheap
 *  and avoids burning refine-loop turns on layout Claude can just state. */
export function buildSubmitDraftTool(size: number): Tool {
  const count = size * size;
  return {
    name: 'submit_draft',
    description: `Submit the initial full ${size}x${size} pixel grid as one flat, `
      + `row-major array of exactly ${count} palette-index integers `
      + '(0 = transparent). Index i corresponds to x = i % size, y = Math.floor(i / size).',
    input_schema: {
      type: 'object',
      properties: {
        pixels: {
          type: 'array',
          items: { type: 'integer' },
          minItems: count,
          maxItems: count,
          description: `Exactly ${count} palette-index integers, row-major.`,
        },
      },
      required: ['pixels'],
    },
  };
}

export const REFINE_TOOLS: Tool[] = [
  {
    name: 'set_pixel',
    description: 'Set a single pixel to a palette color index (0 = transparent).',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Column, 0-based from the left.' },
        y: { type: 'integer', description: 'Row, 0-based from the top.' },
        color: { type: 'integer', description: 'Palette index; 0 = transparent.' },
      },
      required: ['x', 'y', 'color'],
    },
  },
  {
    name: 'fill_rect',
    description: 'Fill an axis-aligned rectangle with a palette color index.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Left edge column.' },
        y: { type: 'integer', description: 'Top edge row.' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        color: { type: 'integer', description: 'Palette index; 0 = transparent.' },
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_line',
    description: 'Draw a 1px line between two points with a palette color index.',
    input_schema: {
      type: 'object',
      properties: {
        x1: { type: 'integer' }, y1: { type: 'integer' },
        x2: { type: 'integer' }, y2: { type: 'integer' },
        color: { type: 'integer', description: 'Palette index; 0 = transparent.' },
      },
      required: ['x1', 'y1', 'x2', 'y2', 'color'],
    },
  },
  {
    name: 'flood_fill',
    description: 'Flood-fill the region contiguous with (x, y) that shares its current color.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' },
        color: { type: 'integer', description: 'Palette index; 0 = transparent.' },
      },
      required: ['x', 'y', 'color'],
    },
  },
  {
    name: 'clear',
    description: 'Clear the whole canvas to a single color (default transparent).',
    input_schema: {
      type: 'object',
      properties: {
        color: { type: 'integer', description: 'Palette index; 0 = transparent. Defaults to 0.' },
      },
    },
  },
];

/** Identical to REFINE_TOOLS minus `clear` — a revision job must never be
 *  able to wipe the whole canvas in one call. `set_pixel`/`fill_rect`/
 *  `draw_line`/`flood_fill` remain fully sufficient for every repair;
 *  `flood_fill` already bounds itself to a contiguous same-color region,
 *  which is exactly the "fix this region, not the whole canvas" behavior
 *  repair work needs. See docs/pixel-forge-revision-v3.md §4. */
export const REPAIR_TOOLS: Tool[] = REFINE_TOOLS.filter(t => t.name !== 'clear');

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

/** Defensive parse of the model's `submit_evaluation` tool input — every
 *  field is coerced to a safe default rather than throwing, matching the
 *  existing "smaller/faster models can be off by a bit" tolerance already
 *  applied to the draft phase in agent-loop.ts. */
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

/** Forces a final structured self-assessment — this call's output IS the
 *  raw material a RepairPlan is built from (see repair-plan.ts), not a
 *  separate grading step feeding a second planning call. Display-only in
 *  the UI otherwise, never trusted blindly (it's the model grading its
 *  own work). */
export const SUBMIT_EVALUATION_TOOL: Tool = {
  name: 'submit_evaluation',
  description: 'Submit a structured self-assessment of the finished pixel-art layer. '
    + 'Grade harshly and skeptically, as an outside viewer seeing it for the first time — '
    + 'not as confirmation of what you intended to draw. This gates whether a human even '
    + 'considers approving the trait, and is also the direct input to the next revision\'s '
    + 'repair plan, so be concrete and specific rather than vague.',
  input_schema: {
    type: 'object',
    properties: {
      blindDescription: {
        type: 'string',
        description: 'Write this FIRST, before any other field. Describe what the image looks '
          + 'like cold, as a stranger seeing it for the first time, with NO reference to the '
          + 'original prompt or what you intended to draw. Only after writing this, compare it '
          + 'against the intended subject to fill in the rest of this schema.',
      },
      recognizableAsSubject: {
        type: 'boolean',
        description: 'Derived by comparing blindDescription against the specific intended '
          + 'subject — false unless blindDescription would unmistakably identify THAT subject '
          + '(not just something generic in its class). A clean, technically-tidy shape that only '
          + 'gestures at the idea is false.',
      },
      issues: {
        type: 'array',
        description: 'Every specific problem, most-important first. Empty array ONLY if there is '
          + 'truly nothing wrong — a generic vague resemblance is not "nothing wrong."',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id unique in this list, e.g. "R1".' },
            category: { type: 'string', enum: [...REPAIR_CATEGORIES] },
            severity: {
              type: 'string',
              enum: [...REPAIR_SEVERITIES],
              description: 'critical = subject unrecognizable or asset fundamentally broken; '
                + 'major = clearly wrong but subject still reads; minor = polish only.',
            },
            location: { type: 'string', description: 'Plain-language region, e.g. "left ear", "whole silhouette".' },
            problem: { type: 'string', description: 'What is wrong, as an observation.' },
            reason: { type: 'string', description: 'Why it matters — what specifically reads wrong and why.' },
            repairStrategy: { type: 'string', description: 'Concrete action to take — not a restatement of the problem.' },
            expectedResult: { type: 'string', description: 'Falsifiable statement of what should be true once fixed.' },
            dependsOn: {
              type: 'array', items: { type: 'string' },
              description: 'ids of other issues in this list that must be fixed first, if any (usually empty).',
            },
          },
          required: ['id', 'category', 'severity', 'location', 'problem', 'reason', 'repairStrategy', 'expectedResult'],
        },
      },
      preserve: {
        type: 'array',
        description: 'What is already good and must NOT regress in a future revision — be '
          + 'specific (e.g. "the overall bust proportions and hat silhouette").',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            reason: { type: 'string', description: 'Optional — why it is good.' },
          },
          required: ['id', 'description'],
        },
      },
      doNotModify: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hard-locked regions/elements a revision must never touch under any '
          + 'circumstance (established palette indices in use, the overall bounding silhouette, '
          + 'background transparency, anything a previous revision already had to fix once).',
      },
      intentionalChoices: {
        type: 'array',
        items: { type: 'string' },
        description: 'Things that might look like mistakes to a fresh look but are deliberate '
          + 'style choices — so a future revision does not "fix" them.',
      },
      notes: { type: 'string', description: 'Small free-text catch-all for anything not covered above.' },
    },
    required: [
      'blindDescription', 'recognizableAsSubject', 'issues', 'preserve', 'doNotModify',
      'intentionalChoices', 'notes',
    ],
  },
};

export interface ToolExecResult {
  content: string;
  isError: boolean;
}

/** Compact factual diff between two grid snapshots — ground truth for what
 *  an edit actually changed (as opposed to what its input args implied),
 *  so it stays true for clipped fill_rects, no-op edits, and flood_fill's
 *  data-dependent spread. See docs/pixel-forge-token-cost-audit.md and the
 *  2026-07-05_022 coordinate-grounding audit: the model had no way to
 *  confirm where an edit actually landed and had to re-derive it from the
 *  next re-render, which is what turned one misplaced beard into two full
 *  guess/undo cycles. */
function diffSummary(before: Uint8Array, after: Uint8Array, width: number): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let idx = 0; idx < after.length; idx++) {
    if (before[idx] === after[idx]) continue;
    count++;
    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return count === 0
    ? 'ok; no pixels changed'
    : `ok; changed ${count} px; affected bbox x=${minX}..${maxX}, y=${minY}..${maxY}`;
}

/** Runs a mutation and reports the actual before/after diff rather than a
 *  bare "ok" — see diffSummary. */
function withDiff(canvas: Canvas, mutate: () => void): string {
  const before = canvas.snapshotGrid();
  mutate();
  return diffSummary(before, canvas.snapshotGrid(), canvas.width);
}

export function executeTool(canvas: Canvas, name: string, input: unknown): ToolExecResult {
  try {
    const i = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'set_pixel':
        return { content: withDiff(canvas, () => canvas.setPixel(Number(i.x), Number(i.y), Number(i.color))), isError: false };
      case 'fill_rect':
        return {
          content: withDiff(canvas, () => canvas.fillRect(
            Number(i.x), Number(i.y), Number(i.width), Number(i.height), Number(i.color),
          )),
          isError: false,
        };
      case 'draw_line':
        return {
          content: withDiff(canvas, () => canvas.drawLine(
            Number(i.x1), Number(i.y1), Number(i.x2), Number(i.y2), Number(i.color),
          )),
          isError: false,
        };
      case 'flood_fill':
        return { content: withDiff(canvas, () => canvas.floodFill(Number(i.x), Number(i.y), Number(i.color))), isError: false };
      case 'clear':
        return { content: withDiff(canvas, () => canvas.clear(i.color === undefined ? 0 : Number(i.color))), isError: false };
      default:
        return { content: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `error: ${msg}`, isError: true };
  }
}
