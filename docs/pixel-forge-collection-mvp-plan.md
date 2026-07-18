# Pixel Forge — Collection + Layered Trait Workflow: True MVP

Status: **design/planning only. No code, no API calls, no deploy.** This
is a deliberate *simplification* of `pixel-forge-collection-dna-
architecture.md` (the six independently-versioned-layer, pointer-manifest
design meant to still make sense in two years) down to the smallest thing
that makes Pixel Forge actually collection-aware and layer-aware *today*,
reusing everything already shipped: the pure `composeCollectionPromptSection`
composer, the `smbAnimalCollectionDNA` fixture, and the hidden
`collectionPreset` job field. Nothing here contradicts that architecture
— it's the same shape, collapsed to one stored JSON blob per collection
instead of six versioned layer stores, because there is exactly one
fixture and one user right now, not many collections needing independent
sharing/inheritance.

---

## 1. MVP architecture, in one paragraph

A **Collection** is one small stored record: an id, a name, and a
pointer to which built-in DNA preset it uses (today, only `"smb-animal"`
is a valid value — the same allow-list already enforced on the hidden
`collectionPreset` job field). Generating a trait against a collection
resolves that preset to a `CollectionPromptInput` (today: literally
`smbAnimalCollectionDNA`), composes it exactly as already happens today,
and — new — tags the resulting `TraitAsset` with which collection it
belongs to. A collection's traits, once a few exist across different
layer slots, can be stacked client-side by `zIndex` into a preview — no
new backend work, since every trait's `pngBase64`/`zIndex` is already
fetched by the existing gallery. No layer versioning, no manifest
pointers, no inheritance, no auto-extraction — all of that stays exactly
where the bigger architecture doc already deferred it.

---

## 2. Data model

```ts
// NEW — src/pixel-agent/collections-store.ts (mirrors store.ts's exact
// atomic-write/normalize conventions)
interface Collection {
  id: string;
  name: string;
  /** Which built-in fixture this collection uses — the same allow-listed
   *  value already validated for the hidden `collectionPreset` job field.
   *  Not a pointer into a real versioned-layer store (none exists yet) —
   *  just a key into a small hardcoded map, e.g. { 'smb-animal':
   *  smbAnimalCollectionDNA }. Real DNA storage/versioning is
   *  pixel-forge-collection-dna-architecture.md's job, not this MVP's. */
  presetId: string;
  /** Convenience override, rarely needed for MVP — null means "use
   *  whatever palette the resolved preset's DNA specifies." */
  paletteOverride: string[] | null;
  createdAt: number;
  updatedAt: number;
}
```

`TraitAsset` gains exactly **one** new field, same pattern as every prior
addition (`referenceGuidanceNote`, `collectionPresetId`):

```ts
collectionId: string | null;   // which Collection record this trait belongs to; null = today's status quo
```

Everything else the brief asks a trait to "know" is **already there,
reused verbatim, no new field needed**:
- `layerSlot` → the existing `layerType` field (once extended — see §7).
- `zIndex` → the existing `zIndex` field (already defaulted per-layer-type
  in `store.ts`'s `DEFAULT_Z_INDEX`, which just needs two new entries).
- `collectionPresetId` → **already shipped** (last change) — keep it as
  a separate field from the new `collectionId`. `collectionId` says
  *which collection this trait belongs to*; `collectionPresetId` says
  *which DNA preset was actually resolved at generation time* — the same
  distinction the bigger architecture doc draws between a manifest
  pointer and a layer version, just without the versioning. They'll be
  equal in practice today (a collection's `presetId` doesn't change
  mid-life yet), but keeping them separate costs nothing and avoids a
  rename later if a collection's preset ever does change.
- `compatibility metadata` → **deliberately not stored per-trait yet.**
  Compatibility is collection-level data (already fully expressed in the
  fixture's `compatibility` array and composed into every generation's
  prompt) — there is no code that *checks* a finished trait against it
  yet (that's the Validation pipeline stage, still explicitly deferred),
  so there is nothing real to stamp on a trait. Storing a placeholder
  field with no producer would be exactly the kind of premature schema
  the bigger doc's own risk section warns against.

---

## 3. The layer-dependency question is already solved — no new logic needed

The brief lists real dependencies (eyes depend on the head anchor, mouth
depends on head/eyes, headwear depends on head, accessory avoids eyes/
mouth, body supports head) and asks how to handle them. **These are not
generation-order dependencies** — nothing requires drawing `head` before
`eyes` — because every layer in a collection is generated independently
against the *same shared, fixed* Geometry anchors and Compatibility rules
(exactly what `smbAnimalCollectionDNA.geometry.anchors` and `.compatibility`
already encode, and exactly what `composeCollectionPromptSection` already
renders into every job's prompt regardless of which specific layer is
being drawn — the `targetLayerType` param only decides which anchor gets
marked `(this trait)`, every other anchor/rule is still present as
context). The "dependency" is really just: **all layers must be generated
against one shared collection record**, so they all read the same
Geometry/Compatibility text. That's what wiring `collectionId` into
generation actually buys — nothing new to design here, just make sure
every layer of a collection routes through the same resolved DNA, which
falls out of the data model in §2 for free.

---

## 4. UI flow (MVP)

Extends the existing `/tools/pixel-forge` page, same panels/visual
language already used for Reference Mode and the validation gallery — no
new route:

1. **Collection selector** — a dropdown (blank/"none" + existing
   collections) plus a **Create** action: name + a `presetId` dropdown
   (today, exactly one option, `smb-animal` — the dropdown exists so
   adding a second fixture later is a data change, not a UI change).
   *No DNA editor* — matches "manual one collection first is okay,"
   read literally: the *collection* is manually created, its *DNA content*
   is not manually edited yet.
2. **Layer slot** — the existing `layerType` dropdown, extended with
   `head`/`headwear` (see §7). No new UI control; the existing one just
   gets two more options.
3. **Optional NFT reference** — entirely unchanged, already built,
   already composes after Collection DNA in `buildSystemPrompt` (already
   shipped, already correct precedence).
4. **Generate** — unchanged button; the only new payload field is the
   selected collection's id.
5. **Save into collection** — no new action. Traits already auto-save on
   generation; the only change is the saved record now carries
   `collectionId`.
6. **Preview stack** — new, but backend-free: filter the already-loaded
   trait list by the selected `collectionId`, take (at most) one trait
   per `layerType` (whichever the human has approved, or the latest
   candidate if none is approved yet), and render them absolutely-
   positioned by `zIndex` using the `pngBase64` the gallery already
   fetches. Pure client-side composition — the exact "cheap client-side
   composite" already flagged as a fast-follow in the bigger architecture
   doc's UI section, now pulled into this MVP because the brief asks for
   it directly.

---

## 5. Exact files likely touched

- **`src/pixel-agent/collections-store.ts`** (new) — `Collection` CRUD:
  `saveCollection`/`getCollection`/`listCollections`/`patchCollection`/
  `deleteCollection`, atomic write to `data/pixel-forge/collections/
  <id>.json`, same normalize-on-read discipline as `store.ts`.
- **`src/pixel-agent/agent-loop.ts`** — `LayerType`/`LAYER_TYPES` gain
  `'head'`, `'headwear'`. (No other change here — `buildSystemPrompt`/
  `DrawingJobParams` already accept `collectionPromptSection`, built last
  step; nothing about *how* the section reaches the model changes.)
- **`src/pixel-agent/store.ts`** — `TraitAsset`/`TraitAssetSummary` gain
  `collectionId: string | null`, normalized the same way as
  `collectionPresetId`; `DEFAULT_Z_INDEX` gains `head`/`headwear` entries.
- **`src/server/tools-pixel-forge.ts`** — new
  `POST/GET/PATCH/DELETE /api/tools/pixel-forge/collections[/:id]`
  routes (no AI call in any of them — pure CRUD, mirrors
  `patchTraitAssetMeta`'s style exactly); `/jobs` route gains a real
  `collectionId` body field that resolves a stored `Collection` →
  `presetId` → the same hardcoded preset-to-fixture map the hidden
  `collectionPreset` field already uses → same
  `composeCollectionPromptSection` call already in place. The existing
  hidden `collectionPreset` field is **left exactly as-is** (still useful
  for a quick fixture-only test with no stored Collection needed) —
  `collectionId`, when present, takes precedence; supplying both is
  simplest to just reject with `400 conflicting_collection_fields` rather
  than silently picking one.
- **`frontend/src/app/tools/pixel-forge/page.tsx`** — collection
  selector/create controls, `LAYER_TYPES` const extended, gallery
  filtering by collection, the new client-side preview-stack panel.
- **`collection-prompt-composer.ts` and `__fixtures__/collection-dna-smb-
  animal.ts` — untouched.** Worth stating plainly: the hardest, most
  architecturally-load-bearing piece of this whole feature needed zero
  changes to support real collection storage, because it was designed
  decoupled (pure function, plain data in) from day one.

---

## 6. Staged implementation order

1. **Storage** — `collections-store.ts` + the `LayerType` enum extension
   (small, mechanical, zero AI risk, unblocks everything else). Verify
   with a pure create/read/patch/delete round-trip test, no server needed.
2. **Backend APIs** — the CRUD routes, then the `/jobs` route's
   `collectionId` resolution path. Verify with an offline test that
   resolving a stored collection with `presetId: 'smb-animal'` produces
   **byte-identical** composed output to the already-tested hidden
   `collectionPreset: 'smb-animal'` path — this is the single most
   important regression check before trusting the new path at all.
3. **UI** — collection selector/create, extended layer dropdown, gallery
   filtering. No generation risk at this stage — pure CRUD + display.
4. **Compositor preview** — the client-side stacked-image panel. Also no
   generation risk — reads already-fetched data.
5. **Generation wiring** — connecting the "Generate" button to actually
   send `collectionId`. This is the first point real API calls become
   possible through the new path (previously only reachable via the
   hidden field).
6. **Validation** — still explicitly **not** part of this MVP. No code-
   level bbox/compatibility checker exists; traits are still reviewed by
   a human plus whatever the evaluate-call/RepairPlan already catches.
   Sequencing note unchanged from the bigger architecture doc: this
   comes after there's real usage data to justify it, not before.

This order is deliberately storage → APIs → UI → compositor → generation
→ validation, per the brief — every step through step 4 spends zero
Anthropic budget and can be fully verified offline; step 5 is the first
one that can.

---

## 7. What's already implemented and reused (no new work)

- `composeCollectionPromptSection` — pure function, fully tested offline,
  zero changes needed.
- `smbAnimalCollectionDNA` / `smbAnimalDNAForLayer` — the fixture, zero
  changes needed; becomes `Collection#1`'s resolved DNA content verbatim.
- `DrawingJobParams.collectionPromptSection` + its `buildSystemPrompt`
  section, placed above `referenceGuidance` — already shipped, already
  the correct precedence, zero changes needed.
- `TraitAsset.collectionPresetId` — already shipped; becomes the
  "which DNA was actually used" provenance field described in §2.
- The hidden `collectionPreset` job field + its allow-list validation —
  already shipped; stays as a permanent quick-test path, not replaced.
- Reference Mode (upload/validate/analyze/compose) — entirely untouched,
  already composes in the correct order relative to Collection DNA.
- The trait `candidate → approved` human-review gate, the gallery's
  visual language (`PANEL`, status badges, `PixelImg`) — reused, not
  rebuilt, for every new UI control in §4.

## 8. What remains genuinely missing

- Any real `Collection` storage at all (§2/§5 step 1 — the actual new
  work this plan adds).
- `head`/`headwear` as real `LayerType` values (small, but not done yet
  — recommended twice before, still outstanding).
- Any UI for any of this (§4).
- The client-side compositor preview (§4 point 6).
- A second DNA preset besides `smb-animal` (not needed for this MVP,
  but worth naming as the next natural test once this path is proven).
- Everything the bigger architecture doc already defers: layer
  versioning, manifest pointers, inheritance/cloning, auto-extraction
  from references, a code-level Validation gate, batch generation,
  rarity, a mint pipeline — none of this MVP's scope touches or requires
  any of them.

---

## 9. What to test before paid generation

All of the following are offline/free and should pass before spending
anything through the new `collectionId` path:

1. **Storage round-trip** — create/get/patch/delete a `Collection` record
   directly against `collections-store.ts`, no server — confirms atomic
   write + normalize-on-read behave like every other store in this
   codebase.
2. **`LayerType` lockstep check** — grep/assert that `LAYER_TYPES`,
   `DEFAULT_Z_INDEX`, and the frontend's separately-declared
   `LAYER_TYPES` const all agree on the same set after the enum
   extension — a partial update here is exactly the kind of bug that
   passes typecheck in one file and silently misbehaves in another.
3. **Regression check against the already-shipped hidden path** — resolve
   a stored `Collection { presetId: 'smb-animal' }` through the new
   route logic and assert the composed section is **identical** to what
   `collectionPreset: 'smb-animal'` already produces today (same
   fixture, same composer — this should be a non-event, and proving that
   is exactly the point).
4. **Dry-run / no-model preview** — a debug path that resolves
   `collectionId` + `layerType` into the exact system-prompt text and
   palette a real job would send, without calling the model — lets a
   human eyeball the composed prompt for a real stored collection before
   any money is spent, same discipline already recommended for Reference
   Mode's own cost strategy.

Only after all four pass: **one** small paid smoke test — the same
baseline-vs-`smb-animal` comparison already planned in the prior wiring
step, run once through the new `collectionId` path instead of the hidden
field, specifically to confirm the new path produces the *same* real
generation result as the already-proven hidden path (not to re-litigate
whether Collection DNA improves quality — that comparison was already the
point of the earlier smoke test plan). Cost-limited, single prompt, not a
batch, stop after reading the result.
