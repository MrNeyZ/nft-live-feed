/**
 * Read-only view over already-generated validation-run preview PNGs
 * (`data/pixel-forge/validation-runs/<runId>/previews/*.png`) for display in
 * the Pixel Forge gallery UI, clearly separated from the real trait library.
 *
 * This module never reads from or writes to `data/pixel-forge/traits/` —
 * validation previews have no `pixels`/`palette` grid recoverable from
 * `results.jsonl` (drafts are redacted from history once consumed, see
 * agent-loop.ts, and no canvas snapshot is persisted), so they cannot be
 * represented as a real `TraitAsset` without fabricating data. Keeping them
 * a separate, non-writable source avoids that entirely: nothing here ever
 * calls `saveTraitAsset`/`updateTraitAsset`/`deleteTraitAsset`, and no
 * validation-runs file is ever modified by this module.
 *
 * Per-run inputs joined, all optional (a preview with no matching metadata
 * still surfaces, just with nulls — a missing join is not a reason to hide
 * an existing image):
 *   - `previews/<promptId>-round<N>.png` — the image itself
 *   - `prompts.json`  — `{ prompts: [{ id, prompt, ... }] }`, prompt text
 *   - `results.jsonl` — one JSON object per job, keyed here by
 *     `promptId::roundNumber`, for model/cost/evaluation fields
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

const VALIDATION_RUNS_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'validation-runs');
const PREVIEW_FILENAME_RE = /^(.+)-round(\d+)\.png$/;

export interface ValidationPreviewItem {
  /** 1-based, oldest → newest, stable within one listValidationPreviews() call. */
  seq: number;
  runId: string;
  promptId: string;
  promptText: string | null;
  roundNumber: number | null;
  jobType: 'fresh' | 'revision' | null;
  model: string | null;
  costUsd: number | null;
  recognizableAsSubject: boolean | null;
  overallSeverity: string | null;
  openIssueCount: number | null;
  pngBase64: string;
}

interface ResultsJoinRow {
  jobType: string | null;
  actualModel: string | null;
  actualCostUsd: number | null;
  recognizableAsSubject: boolean | null;
  overallSeverity: string | null;
  openIssueCount: number | null;
  startedAt: number | null;
}

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** `results.jsonl` is written by `src/scripts/pixel-forge-validation.ts` for
 *  its own reporting, not for this reader — parsed defensively (same spirit
 *  as `store.ts`'s `normalizeTraitAsset`), never thrown on a malformed line. */
async function loadResultsJoin(runDir: string): Promise<Map<string, ResultsJoinRow>> {
  const join = new Map<string, ResultsJoinRow>();
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(runDir, 'results.jsonl'), 'utf8');
  } catch {
    return join;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isNonNullObject(parsed)) continue;
    const promptId = asString(parsed.promptId);
    const roundNumber = asFiniteNumber(parsed.roundNumber);
    if (promptId === null || roundNumber === null) continue;
    join.set(`${promptId}::${roundNumber}`, {
      jobType: asString(parsed.jobType),
      actualModel: asString(parsed.actualModel),
      actualCostUsd: asFiniteNumber(parsed.actualCostUsd),
      recognizableAsSubject: asBoolean(parsed.recognizableAsSubject),
      overallSeverity: asString(parsed.overallSeverity),
      openIssueCount: asFiniteNumber(parsed.openIssueCount),
      startedAt: asFiniteNumber(parsed.startedAt),
    });
  }
  return join;
}

/** `prompts.json` — `{ prompts: [{ id, prompt }] }` — the per-run prompt
 *  subset actually used, saved by the same validation runner. */
async function loadPromptTextById(runDir: string): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(runDir, 'prompts.json'), 'utf8');
  } catch {
    return byId;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return byId;
  }
  if (!isNonNullObject(parsed) || !Array.isArray(parsed.prompts)) return byId;
  for (const p of parsed.prompts) {
    if (!isNonNullObject(p)) continue;
    const id = asString(p.id);
    const prompt = asString(p.prompt);
    if (id !== null && prompt !== null) byId.set(id, prompt);
  }
  return byId;
}

/** Scans every validation run directory's `previews/` folder and returns a
 *  flat, globally-numbered list ordered oldest → newest. Ordering key is
 *  each item's `results.jsonl` `startedAt` when a join is found (accurate
 *  even for multiple prompts/rounds within one run); falls back to the
 *  preview file's own mtime for an unmatched image so nothing is silently
 *  dropped just because its metadata is missing. Pure read — never writes,
 *  moves, or deletes anything under `validation-runs/`. */
export async function listValidationPreviews(): Promise<ValidationPreviewItem[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(VALIDATION_RUNS_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const runIds = entries.filter(e => e.isDirectory() && e.name !== 'prompt-sets').map(e => e.name).sort();

  interface Staged { item: Omit<ValidationPreviewItem, 'seq'>; orderKey: number }
  const staged: Staged[] = [];

  for (const runId of runIds) {
    const runDir = path.join(VALIDATION_RUNS_DIR, runId);
    const previewsDir = path.join(runDir, 'previews');
    let files: string[];
    try {
      files = await fsp.readdir(previewsDir);
    } catch {
      continue; // no previews/ for this run — nothing to surface
    }
    const pngFiles = files.filter(f => f.endsWith('.png')).sort();
    if (pngFiles.length === 0) continue;

    const [resultsJoin, promptText] = await Promise.all([
      loadResultsJoin(runDir),
      loadPromptTextById(runDir),
    ]);

    for (const file of pngFiles) {
      const match = PREVIEW_FILENAME_RE.exec(file);
      const promptId = match ? match[1] : file.replace(/\.png$/, '');
      const roundNumber = match ? Number(match[2]) : null;
      const joinKey = roundNumber !== null ? `${promptId}::${roundNumber}` : null;
      const joined = joinKey !== null ? resultsJoin.get(joinKey) : undefined;

      const filePath = path.join(previewsDir, file);
      let pngBase64: string;
      let mtimeMs: number;
      try {
        const [buf, stat] = await Promise.all([fsp.readFile(filePath), fsp.stat(filePath)]);
        pngBase64 = buf.toString('base64');
        mtimeMs = stat.mtimeMs;
      } catch {
        continue; // file vanished between readdir and read — skip, don't crash the list
      }

      staged.push({
        orderKey: joined?.startedAt ?? mtimeMs,
        item: {
          runId,
          promptId,
          promptText: promptText.get(promptId) ?? null,
          roundNumber,
          jobType: joined?.jobType === 'fresh' || joined?.jobType === 'revision' ? joined.jobType : null,
          model: joined?.actualModel ?? null,
          costUsd: joined?.actualCostUsd ?? null,
          recognizableAsSubject: joined?.recognizableAsSubject ?? null,
          overallSeverity: joined?.overallSeverity ?? null,
          openIssueCount: joined?.openIssueCount ?? null,
          pngBase64,
        },
      });
    }
  }

  staged.sort((a, b) => a.orderKey - b.orderKey
    || a.item.runId.localeCompare(b.item.runId)
    || (a.item.roundNumber ?? 0) - (b.item.roundNumber ?? 0)
    || a.item.promptId.localeCompare(b.item.promptId));

  return staged.map((s, i) => ({ seq: i + 1, ...s.item }));
}
