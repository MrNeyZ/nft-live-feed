/**
 * Persisted pixel-forge Collection records — Stage 1 storage only, see
 * docs/pixel-forge-collection-mvp-plan.md. A Collection is a thin pointer:
 * which built-in DNA preset it uses, plus an optional palette override.
 * No versioned layers, no manifest, no compatibility metadata — those stay
 * exactly where the plan defers them.
 *
 * File layout: data/pixel-forge/collections/<id>.json, atomic write via
 * temp-file rename — same convention as src/pixel-agent/store.ts.
 *
 * `id` is a safe slug derived from `name` at creation time (never
 * caller-supplied), so every on-disk filename this module ever writes is
 * already path-safe; `listCollections`/`getCollection` only ever read ids
 * that came from this module's own `readdir`/create calls.
 *
 * `presetId` is stored as an opaque non-empty string here. Validating it
 * against the real allow-listed preset set (today just `'smb-animal'`) is
 * the backend API route's job (Stage 2) — this storage layer doesn't need
 * to know the fixture set to persist a pointer to it.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const COLLECTIONS_DIR = path.join(process.cwd(), 'data', 'pixel-forge', 'collections');

export interface Collection {
  id: string;
  name: string;
  presetId: string;
  paletteOverride: string[] | null;
  createdAt: number;
  updatedAt: number;
}

function slugifyId(s: string): string {
  const base = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'collection';
}

/** Always `<slugified-name>-<random suffix>` — path-safe, unique without a
 *  directory scan, and never caller-supplied. */
function makeCollectionId(name: string): string {
  return `${slugifyId(name)}-${randomUUID().slice(0, 6)}`;
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

function jsonPath(id: string): string {
  return path.join(COLLECTIONS_DIR, `${id}.json`);
}

// ── Storage-boundary normalization ──────────────────────────────────────
// `normalizeCollection` is the ONLY place raw on-disk JSON is trusted as a
// Collection — same discipline as `normalizeTraitAsset` in store.ts.

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/** Normalizes an already-`JSON.parse`d value into a safe `Collection`, or
 *  `null` if it's unrecoverable. `name`/`presetId` have no sensible
 *  invented default, so a record missing either returns `null` — callers
 *  already treat that identically to "file not found" (skipped entry in
 *  `listCollections`, `null` from `getCollection`). `id` always comes from
 *  the caller (the filename the record was read from), never from the
 *  JSON body itself. */
export function normalizeCollection(raw: unknown, id: string): Collection | null {
  if (!isNonNullObject(raw)) return null;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  if (!name) return null;

  const presetId = typeof raw.presetId === 'string' && raw.presetId.trim() ? raw.presetId.trim() : null;
  if (!presetId) return null;

  return {
    id,
    name,
    presetId,
    paletteOverride: isStringArray(raw.paletteOverride) ? raw.paletteOverride : null,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

async function readRecord(id: string): Promise<Collection | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(jsonPath(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt/truncated JSON on disk — treat like "not found" rather than
    // crashing the caller. Genuinely unrecoverable; nothing to normalize.
    console.warn(`[pixel-agent/collections-store] corrupt JSON for collection ${id}, treating as not found`);
    return null;
  }
  return normalizeCollection(parsed, id);
}

export async function createCollection(input: {
  name: string;
  presetId: string;
  paletteOverride?: string[] | null;
}): Promise<Collection> {
  const name = input.name.trim();
  if (!name) throw new Error('collection_name_required');
  const presetId = input.presetId.trim();
  if (!presetId) throw new Error('collection_preset_id_required');

  const now = Date.now();
  const id = makeCollectionId(name);
  const record: Collection = {
    id,
    name,
    presetId,
    paletteOverride: input.paletteOverride ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await atomicWrite(jsonPath(id), JSON.stringify(record));
  return record;
}

export async function getCollection(id: string): Promise<Collection | null> {
  return readRecord(id);
}

export async function updateCollection(id: string, patch: {
  name?: string;
  presetId?: string;
  paletteOverride?: string[] | null;
}): Promise<Collection> {
  const existing = await readRecord(id);
  if (!existing) throw new Error('collection_not_found');

  const name = patch.name !== undefined && patch.name.trim() ? patch.name.trim() : existing.name;
  const presetId = patch.presetId !== undefined && patch.presetId.trim() ? patch.presetId.trim() : existing.presetId;
  const record: Collection = {
    ...existing,
    name,
    presetId,
    paletteOverride: patch.paletteOverride !== undefined ? patch.paletteOverride : existing.paletteOverride,
    updatedAt: Date.now(),
  };
  await atomicWrite(jsonPath(id), JSON.stringify(record));
  return record;
}

export async function listCollections(): Promise<Collection[]> {
  let files: string[];
  try {
    files = await fsp.readdir(COLLECTIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids = files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length));
  const records: Collection[] = [];
  for (const id of ids) {
    try {
      const record = await readRecord(id);
      if (record) records.push(record);
    } catch {
      // Skip a corrupt/partial entry rather than failing the whole list.
    }
  }
  records.sort((a, b) => b.createdAt - a.createdAt);
  return records;
}

/** Deletes the Collection record only — does NOT cascade to any
 *  TraitAsset whose `collectionId` still points at it. There is no
 *  cross-store referential integrity in this MVP (no manifest, no
 *  validation gate); a trait referencing a since-deleted collection id is
 *  the same harmless-dangling shape a trait with a never-valid
 *  `collectionId` already is. */
export async function deleteCollection(id: string): Promise<boolean> {
  try {
    await fsp.unlink(jsonPath(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
