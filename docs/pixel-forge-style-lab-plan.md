# Pixel Forge — Style Lab (Phase 2 design, not built)

Status: **technical plan only**. No storage, endpoints, or UI exist yet. No
API calls were made producing this document.

## Core principle

Pixel Forge does not train on or copy existing collections. A reference
pack is analyzed **once**, by a human-supervised step, into an abstracted
**style brief** — palette tendencies, silhouette/outline/shadow rules,
negative examples, reusable prompt fragments. Only that abstracted brief
is ever injected into a draw/revise job. The original reference images are
never attached to a generation call and never enter `buildSystemPrompt()`.
That separation (analysis-time vision vs. generation-time text-only rules)
is the load-bearing boundary against derivative copying, not a policy
statement alone.

## 1. Storage schema — style profiles

New dir: `data/pixel-forge/style-profiles/<id>.json` — same atomic-write /
canonical-JSON convention as `data/pixel-forge/traits/`.

```ts
interface StyleProfile {
  id: string;
  name: string;                        // human label
  description: string;                 // human-authored intent summary
  status: 'draft' | 'approved' | 'archived'; // never auto-approved
  referencePacks: ReferencePackRef[];   // pointers + provenance, not embedded images
  paletteAnalysis: PaletteAnalysis | null;
  silhouetteRules: SilhouetteRules | null;
  negativeExamples: NegativeExample[];  // explicit "do NOT do this" — text only
  promptTemplates: PromptTemplate[];    // reusable fragments derived from this profile
  createdAt: number;
  updatedAt: number;
}

interface ReferencePackRef {
  id: string;
  label: string;          // e.g. "Collection X — background samples"
  sourceNote: string;     // REQUIRED: provenance / rights statement
  imageCount: number;
  importedAt: number;
}

interface PaletteAnalysis {
  dominantHexes: string[];   // human-editable before approval
  huePersonality: string;    // e.g. "desaturated cool tones, one warm accent"
  contrastNotes: string;
}

interface SilhouetteRules {
  outlineRule: string;        // e.g. "2px dark outline, no anti-aliasing"
  shadowRule: string;         // e.g. "single hard shadow, bottom-right, no gradient"
  proportionNotes: string;    // e.g. "heads ~40% of body height"
  complexityBudget: string;   // e.g. "max ~5 distinct color regions at 32x32"
}

interface NegativeExample {
  note: string;    // text description of what to avoid — never a copied image
  reason: string;
}

interface PromptTemplate {
  id: string;
  label: string;
  layerTypeHint: LayerType | null;
  promptFragment: string;   // merged into a draw/revise job's prompt or anchor
}
```

Raw reference images live separately, in `data/pixel-forge/style-refs/<packId>/`
— a staging area the generation pipeline never reads. Only the (human
supervised) analysis step touches it.

## 2. Importing reference images/layers

- Manual upload only — no scraping, no auto-ingest.
- Every pack requires a non-empty `sourceNote` (provenance/rights) before
  it can be analyzed — mandatory field, not optional metadata.
- Packs are scoped/labeled (e.g. per layer type) so analysis stays
  targeted rather than "learn this whole collection."
- A pack sits inert until a human explicitly confirms it's fine to
  reference for art-direction purposes — a manual gate, not automatic.

## 3. How Claude would analyze a pack

- A dedicated one-off analysis job, separate from the draw/revise loop.
  Claude sees the reference images via vision, under a system prompt that
  explicitly instructs: extract abstracted rules only (palette,
  silhouette conventions, outline weight, shadow logic, complexity
  budget) — never reproduce specific shapes/characters/logos from the
  input, and flag if a reference looks like a recognizable existing
  trademarked/branded character.
- Output via a forced tool call (`submit_style_analysis`, same
  `tool_choice`-pinned pattern as `submit_draft`/`submit_evaluation`) —
  structured data, not prose the human has to transcribe by hand.
- Result is always written as `status: 'draft'` — never auto-promoted.

## 4. Injecting the style brief into Pixel Forge jobs

- Only `approved` profiles are selectable.
- Draw/revise jobs gain an optional `styleProfileId`. When set, the
  backend loads the profile and folds `silhouetteRules` /
  `paletteAnalysis` / matching `promptTemplates` / `negativeExamples`
  into `buildSystemPrompt()` as one more composable section — the same
  mechanism already used for `layerType`/`anchor`, no new architecture.
- The profile's palette can optionally pre-fill the job's `palette` param
  (still overridable per job).
- The original reference images are never attached to the job's messages
  — only the abstracted text/palette ever reaches a generation call.

## 5. What stays manual/human-reviewed

- Provenance/rights sign-off on every reference pack before analysis.
- Promoting a profile `draft` → `approved` (mirrors the trait
  `candidate` → `approved` gate already built in Phase 1).
- Editing the extracted palette/silhouette rules/negative examples before
  approval — Claude's analysis is a starting draft, not authoritative.
- Reviewing any prompt template before it's reused in a real job.

## 6. Deferred (not built now)

- The analysis endpoint/job runner, upload UI, profile CRUD.
- Non-AI palette extraction as a cheaper mechanical alternative to vision
  analysis for the palette step specifically — worth evaluating before
  spending API calls on something that may not need a model at all.
- Any "similarity to reference" scoring UI — deliberately out of scope,
  to avoid even the appearance of derivative-copying tooling.
- Bulk reference import.
