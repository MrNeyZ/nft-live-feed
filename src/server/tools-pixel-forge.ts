/**
 * Pixel-forge trait-library tool — personal use only, not a public feature.
 *
 * Historically Claude expanded this trait library at runtime by drawing
 * pixel-art layers via tool calls (src/pixel-agent/agent-loop.ts's
 * draft→refine→evaluate loop). That runtime has been removed — Pixel Forge
 * no longer depends on Anthropic to draw images. See
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md for the replacement
 * architecture: a source PNG (today: manual upload; later: an OpenAI
 * generator, not yet integrated) feeds src/server/tools-pixel-forge-raster.ts's
 * `POST /raster/normalize` → Cleanup/Repair → Split → Import Split Layers,
 * all deterministic, no AI call anywhere in that path.
 *
 * This file now holds only pure storage CRUD over the shared trait/
 * collection stores — every route below requires `requireAuth` (site-wide
 * SIWS + UI_ALLOWED_WALLETS gate), same as tools-dotland.ts, but none of
 * them make an Anthropic (or any) API call.
 *
 *   GET    /api/tools/pixel-forge/traits               — list saved traits
 *   GET    /api/tools/pixel-forge/traits/:id           — full trait record
 *   PATCH  /api/tools/pixel-forge/traits/:id           — edit tags/notes/status (no AI)
 *   DELETE /api/tools/pixel-forge/traits/:id           — discard a saved trait
 *   GET    /api/tools/pixel-forge/validation-previews  — read-only list of
 *     historical (pre-removal) Claude-drawing validation-run preview PNGs —
 *     no AI call, no write, see src/pixel-agent/validation-previews.ts;
 *     never touches the real trait store above.
 *
 *   Collection CRUD (docs/pixel-forge-collection-mvp-plan.md) — pure
 *   storage over src/pixel-agent/collections-store.ts, no AI call. Still
 *   fully live: raster imports (tools-pixel-forge-raster.ts) can file a
 *   trait under a stored Collection via `collectionId`.
 *   GET    /api/tools/pixel-forge/collections
 *   POST   /api/tools/pixel-forge/collections
 *   GET    /api/tools/pixel-forge/collections/:id
 *   PATCH  /api/tools/pixel-forge/collections/:id
 *   DELETE /api/tools/pixel-forge/collections/:id
 */

import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  getTraitAsset, patchTraitAssetMeta, listTraitAssets, deleteTraitAsset, TraitStatus,
} from '../pixel-agent/store';
import { listValidationPreviews } from '../pixel-agent/validation-previews';
import {
  createCollection, getCollection, updateCollection, listCollections, deleteCollection,
} from '../pixel-agent/collections-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_STATUSES = new Set<string>(['candidate', 'approved', 'rejected']);
// Hidden, dev-only A/B-testing knob — not a real Collection DNA system (no
// storage exists yet). Only one recognized value on purpose; never exposed
// in the frontend. See docs/pixel-forge-collection-dna-architecture.md.
const ALLOWED_COLLECTION_PRESETS = new Set<string>(['smb-animal']);
// Matches collections-store.ts's `makeCollectionId` output shape
// (`<slugified-name>-<6 hex chars>`) closely enough to reject path-unsafe
// input before it ever reaches a store function that builds a file path
// from it — collections-store.ts itself only trusts ids it generated.
const COLLECTION_ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_NOTES_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_NAME_LEN = 80;
const MIN_Z_INDEX = -1000;
const MAX_Z_INDEX = 1000;

function parseZIndex(raw: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_Z_INDEX || n > MAX_Z_INDEX) return { ok: false };
  return { ok: true, value: n };
}

function parseName(raw: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.length > MAX_NAME_LEN) return { ok: false };
  return { ok: true, value: raw };
}

/** `undefined` = field absent (leave untouched on PATCH / default on
 *  create), `null` = explicit clear, array = validated hex-color list. */
function parsePaletteOverride(raw: unknown): { ok: true; value: string[] | null | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const normalized = normalizePalette(raw);
  if (normalized === null) return { ok: false };
  return { ok: true, value: normalized };
}

function normalizePalette(input: unknown): string[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') return null;
    const hex = v.startsWith('#') ? v : `#${v}`;
    if (!HEX_COLOR_RE.test(hex)) return null;
    out.push(hex);
  }
  return out;
}

function normalizeTags(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_TAGS) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TAG_LEN) return null;
    out.push(v.trim());
  }
  return out;
}

export function createPixelForgeRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'tools/pixel-forge:rw' });

  router.get('/tools/pixel-forge/traits', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const traits = await listTraitAssets();
      return res.json({ ok: true, traits });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });
    try {
      const trait = await getTraitAsset(id);
      if (!trait) return res.status(404).json({ ok: false, error: 'trait_not_found' });
      return res.json({ ok: true, trait });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.patch('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });

    const body = req.body as {
      tags?: unknown; notes?: unknown; status?: unknown; name?: unknown; zIndex?: unknown;
    };
    let tags: string[] | undefined;
    if (body.tags !== undefined) {
      const normalized = normalizeTags(body.tags);
      if (normalized === null) return res.status(400).json({ ok: false, error: 'invalid_tags' });
      tags = normalized;
    }
    let notes: string | null | undefined;
    if (body.notes !== undefined) {
      if (body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LEN)) {
        return res.status(400).json({ ok: false, error: 'invalid_notes' });
      }
      notes = body.notes === null ? null : body.notes.trim() || null;
    }
    let status: TraitStatus | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status)) {
        return res.status(400).json({ ok: false, error: 'invalid_status' });
      }
      status = body.status as TraitStatus;
    }
    const nameResult = parseName(body.name);
    if (!nameResult.ok) return res.status(400).json({ ok: false, error: 'invalid_name' });
    const zIndexResult = parseZIndex(body.zIndex);
    if (!zIndexResult.ok) return res.status(400).json({ ok: false, error: 'invalid_z_index' });

    try {
      const trait = await patchTraitAssetMeta(id, {
        tags, notes, status, name: nameResult.value, zIndex: zIndexResult.value,
      });
      return res.json({ ok: true, trait });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'trait_not_found') return res.status(404).json({ ok: false, error: msg });
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.delete('/tools/pixel-forge/traits/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_trait_id' });
    try {
      const deleted = await deleteTraitAsset(id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'trait_not_found' });
      return res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  // Collection CRUD (docs/pixel-forge-collection-mvp-plan.md §5) — pure
  // storage over collections-store.ts, no AI call in any of these, same
  // style as patchTraitAssetMeta above.
  router.get('/tools/pixel-forge/collections', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const collections = await listCollections();
      return res.json({ ok: true, collections });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/pixel-forge/collections', limit, requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { name?: unknown; presetId?: unknown; paletteOverride?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > MAX_NAME_LEN) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }
    if (typeof body.presetId !== 'string' || !ALLOWED_COLLECTION_PRESETS.has(body.presetId)) {
      return res.status(400).json({ ok: false, error: 'invalid_preset_id' });
    }
    const paletteResult = parsePaletteOverride(body.paletteOverride);
    if (!paletteResult.ok) return res.status(400).json({ ok: false, error: 'invalid_palette_override' });

    try {
      const collection = await createCollection({
        name: body.name, presetId: body.presetId, paletteOverride: paletteResult.value ?? null,
      });
      return res.json({ ok: true, collection });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.get('/tools/pixel-forge/collections/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!COLLECTION_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_collection_id' });
    try {
      const collection = await getCollection(id);
      if (!collection) return res.status(404).json({ ok: false, error: 'collection_not_found' });
      return res.json({ ok: true, collection });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.patch('/tools/pixel-forge/collections/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!COLLECTION_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_collection_id' });

    const body = req.body as { name?: unknown; presetId?: unknown; paletteOverride?: unknown };
    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > MAX_NAME_LEN) {
        return res.status(400).json({ ok: false, error: 'invalid_name' });
      }
      name = body.name;
    }
    let presetId: string | undefined;
    if (body.presetId !== undefined) {
      if (typeof body.presetId !== 'string' || !ALLOWED_COLLECTION_PRESETS.has(body.presetId)) {
        return res.status(400).json({ ok: false, error: 'invalid_preset_id' });
      }
      presetId = body.presetId;
    }
    const paletteResult = parsePaletteOverride(body.paletteOverride);
    if (!paletteResult.ok) return res.status(400).json({ ok: false, error: 'invalid_palette_override' });

    try {
      const collection = await updateCollection(id, { name, presetId, paletteOverride: paletteResult.value });
      return res.json({ ok: true, collection });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'collection_not_found') return res.status(404).json({ ok: false, error: msg });
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.delete('/tools/pixel-forge/collections/:id', limit, requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!COLLECTION_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_collection_id' });
    try {
      const deleted = await deleteCollection(id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'collection_not_found' });
      return res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  // Read-only, no AI call — see src/pixel-agent/validation-previews.ts.
  // Deliberately no PATCH/DELETE counterpart: validation previews are not
  // editable/deletable trait records, just a display of files already on
  // disk under data/pixel-forge/validation-runs/ (historical output from
  // the now-removed Claude drawing runtime).
  router.get('/tools/pixel-forge/validation-previews', limit, requireAuth, async (_req: Request, res: Response) => {
    try {
      const previews = await listValidationPreviews();
      return res.json({ ok: true, previews });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
