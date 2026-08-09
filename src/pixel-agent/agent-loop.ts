/**
 * Shared Pixel Forge types/constants — trait-store schema pieces used by
 * BOTH the (removed) Claude drawing runtime's storage format and the
 * deterministic raster pipeline (Normalize → Cleanup → Repair → Split →
 * Import Split Layers).
 *
 * This file used to be the Claude drawing-agent loop itself
 * (`runDrawingJob`/`runRevisionJob`, the draft→refine→evaluate turn loop,
 * system-prompt builders, token/cost estimators, Anthropic error
 * classification, Reference Mode redaction). That runtime has been removed
 * — Pixel Forge no longer depends on Anthropic to draw images; see
 * docs/pixel-forge-image-to-traits-pipeline-mvp.md for the replacement
 * architecture (upload/generate a PNG → Normalize → Cleanup/Repair →
 * Split → Import Split Layers → Trait Library). What remains here is only
 * the handful of exports the surviving code still needs: `TraitAsset`'s
 * schema fields (store.ts) and the raster pipeline's `LayerType` (raster-
 * split.ts, tools-pixel-forge-raster.ts) and the offline CLI prototype's
 * `DEFAULT_PALETTE` (src/scripts/pixel-forge-raster-to-pixel.ts).
 */

export const DEFAULT_PALETTE: readonly string[] = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57',
  '#ffcd75', '#a7f070', '#38b764', '#257179',
  '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
  '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
];
export const DEFAULT_CANVAS_SIZE = 32;

export type LayerType = 'background' | 'body' | 'eyes' | 'mouth' | 'accessory' | 'icon' | 'other';
export const LAYER_TYPES: readonly LayerType[] = ['background', 'body', 'eyes', 'mouth', 'accessory', 'icon', 'other'];

/** Historically "frontend never sends a raw model string, only a preset id,
 *  mapped server-side" — no route resolves this to an actual Anthropic
 *  model anymore, but the type/values are still stored on every existing
 *  and new `TraitAsset` record (store.ts), including raster imports, which
 *  store a placeholder preset. */
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
