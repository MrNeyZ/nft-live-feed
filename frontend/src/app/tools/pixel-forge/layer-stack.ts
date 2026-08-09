/**
 * Pure, framework-free helpers for the Pixel Forge Layer Stack /
 * Compositor MVP — see docs/pixel-forge-layer-stack-compositor-mvp.md.
 * No React state, no DOM, no image decoding, no API calls. Safe to unit
 * test standalone (layer-stack.test.ts) and safe to call directly from
 * the Assemble panel once it's built (Stage 4.2).
 */

/** Minimal shape this module needs from a trait — structurally
 *  compatible with page.tsx's local `TraitAssetSummary` (that wider
 *  object satisfies this interface as-is, no adapter needed). `layerType`
 *  is a plain `string` here, not page.tsx's stricter `LayerType` union,
 *  so a legacy/unrecognized on-disk value doesn't fail typechecking at
 *  this layer — `KNOWN_LAYER_TYPES` below is what flags it at runtime
 *  instead (see `detectStackWarnings`'s `unknown-layer-type` warning). */
export interface LayerStackTrait {
  id: string;
  name: string;
  layerType: string;
  zIndex: number;
  size: number;
  status: 'candidate' | 'approved' | 'rejected';
  collectionId: string | null;
}

/** The real, backend-enforced `LayerType` values (`agent-loop.ts`'s
 *  `LAYER_TYPES`) — used only to flag an unrecognized value, never to
 *  drop/reject a trait. See docs §2 for why `head`/`headwear` aren't
 *  real values yet. */
export const KNOWN_LAYER_TYPES = ['background', 'body', 'eyes', 'mouth', 'accessory', 'icon', 'other'] as const;

/** The layer types docs §2 Option A treats as the unambiguous MVP-core
 *  slots — used only for the "missing core layer" warning below, never
 *  to filter or exclude anything from `groupTraitsForStack`. */
export const CORE_LAYER_TYPES = ['body', 'eyes', 'mouth'] as const;

function knownLayerTypeIndex(layerType: string): number {
  const i = (KNOWN_LAYER_TYPES as readonly string[]).indexOf(layerType);
  return i === -1 ? KNOWN_LAYER_TYPES.length : i; // unrecognized types sort after every known one
}

/** Structural guard — true only for values that actually carry every
 *  field this module reads, with the right type. This is what makes
 *  "exclude validation previews" (docs §1) a real, testable behavior
 *  rather than a comment: a `ValidationPreviewItem` (no `layerType`,
 *  `status`, or `collectionId` at all — page.tsx's separate,
 *  never-merged preview array) simply fails this check and is dropped,
 *  even if a caller ever passes a mixed array by mistake. */
function isGroupableTrait(v: unknown): v is LayerStackTrait {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === 'string'
    && typeof t.name === 'string'
    && typeof t.layerType === 'string'
    && typeof t.zIndex === 'number' && Number.isFinite(t.zIndex)
    && typeof t.size === 'number' && Number.isFinite(t.size)
    && (t.status === 'candidate' || t.status === 'approved' || t.status === 'rejected')
    && (t.collectionId === null || typeof t.collectionId === 'string');
}

/** Deterministic ordering shared by the per-slot option lists and the
 *  final stacked preview (docs §5's render strategy): `zIndex` ascending,
 *  then a fixed layer-type priority (`KNOWN_LAYER_TYPES` order, unknown
 *  types last), then `name`, then `id` — the last two only ever break a
 *  tie a human hasn't resolved with a distinct `zIndex`. */
function compareForStack(a: LayerStackTrait, b: LayerStackTrait): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  const layerDiff = knownLayerTypeIndex(a.layerType) - knownLayerTypeIndex(b.layerType);
  if (layerDiff !== 0) return layerDiff;
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;
  return a.id.localeCompare(b.id);
}

export interface LayerStackGroup {
  layerType: string;
  options: LayerStackTrait[];
}

/**
 * Builds the per-slot option lists for the Assemble panel: only
 * `approved` traits (candidates/rejected are never in this default list
 * — docs §1 "how should approved/candidate traits behave"; a picker
 * that wants to widen to candidates does so as a separate, explicit
 * concern, not by changing this function), optionally scoped to one
 * `collectionId`, grouped by `layerType`. Each group's options are
 * sorted by `zIndex` then name/id; groups themselves are ordered by the
 * known-layer-type priority first, then any unrecognized `layerType`
 * alphabetically — never by fetch/array order, so re-running this on the
 * same data always produces the same panel layout.
 *
 * `traits` is intentionally `unknown[]`, not `LayerStackTrait[]` — see
 * `isGroupableTrait`; anything not shaped like a real trait summary
 * (e.g. a validation-preview item) is silently excluded, never thrown.
 *
 * `collectionId`: omit or pass `null`/`undefined` for "every collection";
 * pass a real id to scope to just that collection.
 */
export function groupTraitsForStack(
  traits: readonly unknown[],
  collectionId?: string | null,
): LayerStackGroup[] {
  const eligible = traits
    .filter(isGroupableTrait)
    .filter(t => t.status === 'approved')
    .filter(t => collectionId == null || t.collectionId === collectionId);

  const byLayerType = new Map<string, LayerStackTrait[]>();
  for (const trait of eligible) {
    const bucket = byLayerType.get(trait.layerType);
    if (bucket) bucket.push(trait);
    else byLayerType.set(trait.layerType, [trait]);
  }

  const groups: LayerStackGroup[] = [];
  for (const [layerType, options] of byLayerType) {
    groups.push({ layerType, options: [...options].sort(compareForStack) });
  }
  groups.sort((a, b) => (
    knownLayerTypeIndex(a.layerType) - knownLayerTypeIndex(b.layerType)
    || a.layerType.localeCompare(b.layerType)
  ));
  return groups;
}

/**
 * Orders one selected trait per slot for the stacked preview render —
 * ascending `zIndex`, same deterministic tiebreak as
 * `groupTraitsForStack` (docs §5: "sort key ascending zIndex;
 * deterministic tiebreak ... by LAYER_TYPES array index").
 */
export function sortSelectedLayersForPreview(selectedTraits: readonly LayerStackTrait[]): LayerStackTrait[] {
  return [...selectedTraits].sort(compareForStack);
}

/**
 * The stack's reference canvas size: whichever trait was selected first
 * (array order — the caller/UI is responsible for passing selections in
 * the order they were picked, not in zIndex or any other derived order),
 * or `null` if nothing is selected yet. Per docs §1/§4.3, the *first*
 * pick establishes the size every other slot must match.
 */
export function getStackCanvasSize(selectedTraits: readonly LayerStackTrait[]): number | null {
  return selectedTraits.length > 0 ? selectedTraits[0].size : null;
}

/**
 * Whether a trait may be offered/kept in a slot given the stack's
 * current reference size. Always `true` while no reference size has
 * been established yet (`targetSize === null`) — see
 * `getStackCanvasSize`.
 */
export function isTraitCanvasCompatible(
  trait: Pick<LayerStackTrait, 'size'>,
  targetSize: number | null,
): boolean {
  return targetSize === null || trait.size === targetSize;
}

export interface StackWarning {
  code: 'duplicate-layer-type' | 'canvas-size-mismatch' | 'missing-core-layer' | 'unknown-layer-type';
  message: string;
  layerType?: string;
  traitIds?: string[];
}

/**
 * Every warning the Assemble panel should be able to surface about the
 * current selection — pure, no side effects, cheap enough to call on
 * every render. Order: duplicate-layer-type, canvas-size-mismatch,
 * missing-core-layer, unknown-layer-type (roughly most-actionable-first;
 * the UI is free to re-sort/filter by `code`).
 *
 * Note: `missing-core-layer` is reported honestly even when
 * `selectedTraits` is empty (all three `CORE_LAYER_TYPES` come back
 * missing) — this function doesn't special-case "nothing picked yet" as
 * "no warnings," since that's a display-timing decision (e.g. "only show
 * missing-core-layer once at least one slot is filled") that belongs in
 * the UI layer, not silently baked into this pure predicate.
 */
export function detectStackWarnings(selectedTraits: readonly LayerStackTrait[]): StackWarning[] {
  const warnings: StackWarning[] = [];

  // Duplicate layerType: more than one trait selected for the same slot.
  const byLayerType = new Map<string, string[]>();
  for (const t of selectedTraits) {
    const ids = byLayerType.get(t.layerType);
    if (ids) ids.push(t.id);
    else byLayerType.set(t.layerType, [t.id]);
  }
  for (const [layerType, ids] of byLayerType) {
    if (ids.length > 1) {
      warnings.push({
        code: 'duplicate-layer-type',
        message: `More than one trait selected for layer "${layerType}" — only one can be shown per slot.`,
        layerType,
        traitIds: ids,
      });
    }
  }

  // Canvas size mismatch, relative to the first-selected trait's size.
  const referenceSize = getStackCanvasSize(selectedTraits);
  if (referenceSize !== null) {
    const mismatched = selectedTraits.filter(t => !isTraitCanvasCompatible(t, referenceSize));
    if (mismatched.length > 0) {
      warnings.push({
        code: 'canvas-size-mismatch',
        message: `${mismatched.length} selected trait(s) don't match the stack's ${referenceSize}x${referenceSize} canvas size.`,
        traitIds: mismatched.map(t => t.id),
      });
    }
  }

  // Missing recommended core layers (docs §2 Option A: body/eyes/mouth).
  const selectedLayerTypes = new Set(selectedTraits.map(t => t.layerType));
  for (const core of CORE_LAYER_TYPES) {
    if (!selectedLayerTypes.has(core)) {
      warnings.push({
        code: 'missing-core-layer',
        message: `No trait selected for the recommended "${core}" layer.`,
        layerType: core,
      });
    }
  }

  // Unknown/unsupported layerType — a value outside KNOWN_LAYER_TYPES.
  const unknownGroups = new Map<string, string[]>();
  for (const t of selectedTraits) {
    if (!(KNOWN_LAYER_TYPES as readonly string[]).includes(t.layerType)) {
      const ids = unknownGroups.get(t.layerType);
      if (ids) ids.push(t.id);
      else unknownGroups.set(t.layerType, [t.id]);
    }
  }
  for (const [layerType, ids] of unknownGroups) {
    warnings.push({
      code: 'unknown-layer-type',
      message: `Trait layer type "${layerType}" isn't a recognized Pixel Forge layer type.`,
      layerType,
      traitIds: ids,
    });
  }

  return warnings;
}
