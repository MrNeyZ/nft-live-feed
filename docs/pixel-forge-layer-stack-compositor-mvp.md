# Pixel Forge — Layer Stack / Compositor MVP

Status: **design/planning only. No code, no API calls, no deploy, no PM2
restart.** Grounded directly in the current working tree — the Collection
storage/API/generation-wiring stages of
`pixel-forge-collection-mvp-plan.md` (§5 steps 1, 2 and 5) are **already
implemented** (`collections-store.ts`, `TraitAsset.collectionId`, the
`/collections` CRUD routes, and `/jobs` accepting `collectionId` all exist
in the repo today, not just on paper), and Stage 3 UI is **partially**
built (a Collections selector/create panel already exists on
`/tools/pixel-forge`). What does **not** exist yet is that plan's Stage 4:
**the client-side compositor preview.** This doc is that stage's detailed
design — it doesn't restate or contradict the bigger plan, it finishes
the one piece it left as a bullet point ("§4 point 6 — new, but
backend-free").

---

## 0. Grounding — what's actually true in the repo right now

| Claim | Confirmed at |
|---|---|
| `TraitAssetSummary` already carries `zIndex`, `layerType`, `size`, `status`, `collectionId`, and a full `pngBase64` for every trait | `src/pixel-agent/store.ts:125-147` |
| `GET /tools/pixel-forge/traits` returns that full summary array, PNG included, in one call | `src/server/tools-pixel-forge.ts:586-594`, `store.ts:458-501` |
| The frontend already fetches all traits into one `traits` state array on mount, no pagination, no per-layer/per-collection server filter | `frontend/.../page.tsx:715,731,770` |
| The gallery's existing client-side filter (`visibleTraits`) filters by `layerType`/`status`/`approvedOnly` **but not by `collectionId`** | `page.tsx:1024-1028` |
| Every generated trait's stored PNG is rendered at a fixed `PREVIEW_UPSCALE = 8`× its logical grid `size` — this constant is never parameterized per job | `src/pixel-agent/agent-loop.ts:58, 1053, 1210, 1287` |
| Real `LayerType` values today: `background \| body \| eyes \| mouth \| accessory \| icon \| other` — **no `head`, no `headwear`** | `agent-loop.ts:72-73` |
| `icon` means "standalone symbol/badge" (heart, star, skull) — explicitly *not* a body part, and explicitly not meant to be wearable | `agent-loop.ts:521-527` |
| `accessory` means "worn/attached to a character" | `agent-loop.ts:528-534` |
| `DEFAULT_Z_INDEX`: background 0, body 10, eyes 20, mouth 30, **accessory 40, icon 40** (tied), other 50 — but every trait's real `zIndex` is a per-record override, not a fixed constant | `store.ts:46-54`, `TraitAsset.zIndex` |
| The `smb-animal` Collection DNA fixture already models `head`, `ears`, `headwear` as geometry anchors — names that **do not correspond to any real `LayerType`** | `src/pixel-agent/__fixtures__/collection-dna-smb-animal.ts:20-43` |
| `Collection` (the stored record) has no `canvasSize` field at all — nothing pins every trait generated under one collection to the same grid size | `src/pixel-agent/collections-store.ts:28-35` |
| Frontend `canvasSize` choices are `[16, 24, 32, 48]`, freely re-picked on every generation, with no lock per collection | `page.tsx:24`, `src/server/tools-pixel-forge.ts:100` |
| Validation-run previews are a structurally separate object with no `id`/`layerType`/`zIndex`/`collectionId`/`status` at all, and the code already comments that they're deliberately never merged into the trait list | `tools-pixel-forge.ts:759-771`, `page.tsx:355-375` |
| `layerSlot` was already decided to **not** be a new field — reuse `layerType` once extended | `docs/pixel-forge-collection-mvp-plan.md:68` |
| `PixelImg` already does crisp nearest-neighbor `<img>` scaling (`imageRendering: pixelated`) independent of the PNG's actual decoded pixel size | `page.tsx:407-420` |

---

## 1. Direct answers to the ten questions

**Can this be done fully frontend-side using existing trait `pngBase64`
from `listTraitAssets`?**
Yes, with zero new backend calls. The `traits` array the page already
loads on mount (`page.tsx:715-770`) already contains everything a
compositor needs per trait: `pngBase64`, `layerType`, `zIndex`, `size`,
`status`, `collectionId`. This is a pure derived view, the same way
`visibleTraits` already is (`page.tsx:1024`) — no new route, no new
server-side filter param.

**What metadata is missing?**
Nothing in the *data model* — every field the compositor needs already
exists on `TraitAssetSummary`. What's missing is real `head`/`headwear`
`LayerType` values (already twice-recommended and still not done — see
§2 below) and a `collectionId` filter in the *existing UI's* filter
logic (a frontend-only gap, not a schema gap).

**Do we need `layerSlot` separate from `layerType`?**
No — already decided in `pixel-forge-collection-mvp-plan.md:68` and
consistent with this repo's "one source of truth per concept" rule
(CLAUDE.md). Introducing a second field that means almost the same thing
as `layerType` would be exactly the parallel-store problem that rule
exists to prevent. Reuse `layerType`, once extended (§2).

**How to handle current `LayerType` limitations?** — see §2, it's the
single most important finding here.

**How to handle zIndex ordering?**
Sort the selected slot traits ascending by their own persisted `zIndex`
(not the `DEFAULT_Z_INDEX` constant — a trait's stored value already
overrides that default, and is user-editable via `patchTraitAssetMeta`).
Render lowest first, highest last, in plain DOM order — see §5.

**How to prevent incompatible canvas sizes?**
Compare `trait.size` (not the rendered PNG's decoded pixel dimensions —
those are a deterministic function of `size × 8`, see §0, so comparing
`size` is sufficient and cheaper). First slot picked establishes the
stack's reference size; every other slot's picker excludes/disables
traits whose `size` differs, with an inline reason, rather than silently
CSS-scaling a mismatched layer to "fit" — a silhouette misalignment is a
correctness bug, not a display nit, since two different `size` grids are
two different coordinate systems even if the DNA anchors describing them
use the same percentage bounding boxes.

**How to show `collectionId` filtering?**
The compositor gets its own local `collectionId` selector (reusing the
already-built Collections panel's `collections` list and selection
pattern at `page.tsx:591-1100`), independent of the main gallery's
filter bar. It filters the same in-memory `traits` array by
`t.collectionId === selectedCollectionId`. This does **not** require
adding a `collectionId` option to the existing gallery filter row —
that would be a reasonable, small follow-up but is out of this task's
scope creep-wise; the compositor doesn't need it to work.

**How should approved/candidate traits behave?**
`rejected` traits are never selectable — that status exists specifically
to mean "not eligible for reuse." Each slot's picker defaults to
`status === 'approved'` traits only, with an explicit toggle ("include
candidates") that reveals `candidate` traits too, visually distinguished
by the same `STATUS_META` badge the gallery already renders
(`page.tsx:318-322`) — no new status vocabulary. This mirrors, rather
than silently automates, the "approved, or latest candidate if none
approved" default the bigger plan already named
(`collection-mvp-plan.md:139`): use it only to pre-highlight a sensible
initial pick per slot, never to auto-fill the stack without the user
looking at it — the task explicitly asks for user picks, not auto-pick.

**Should validation previews be excluded?**
Yes, structurally, not just by convention: `ValidationPreviewItem` has no
`layerType`, `zIndex`, `collectionId`, or `status` field at all
(`page.tsx:362-375`) — there is nothing to slot or stack them by. The
existing code already keeps them in a fully separate array/section with
a comment stating they're deliberately never merged into `traits`
(`page.tsx:355-361`); the compositor simply never reads that array.

**What exact files would be touched?** — see §7 (implementation-time
answer; this task makes no changes today).

---

## 2. The `LayerType` problem — needs a real decision, not just a note

The task's five desired slots are:

```
body/base · head/icon · eyes · mouth · headwear/accessory
```

Mapped against the *real* `LayerType` enum today:

| Desired slot | Real `LayerType` today | Fit |
|---|---|---|
| body/base | `body` | exact |
| eyes | `eyes` | exact |
| mouth | `mouth` | exact |
| head/icon | *(none)* | **no fit — see below** |
| headwear/accessory | `accessory` | partial — see below |

`icon` is not a stand-in for "head." It's a real, already-shipped,
semantically distinct concept — "a standalone symbol/icon (e.g. a heart,
star, skull, logo) — it does NOT need to look wearable or attached to
anything" (`agent-loop.ts:521-527`). Putting a literal head/bust trait
into an "icon" slot would misuse a concept that already means something
else, and would collide with any future real emblem/badge trait a
collection might want, in the very same slot.

There is genuinely no dedicated "head" `LayerType` yet — only a DNA-level
anchor *name* (`'head'`, `'ears'` in the `smb-animal` fixture,
`__fixtures__/collection-dna-smb-animal.ts:24-27`) that isn't a valid
value for the job's actual `layerType` field. Concretely: a job drawing
"the head" today has to be tagged `layerType: 'body'` (or `'other'`)
because `'head'` isn't selectable — which also means the DNA composer's
`targetLayerType === anchor.layerType` match (used to mark "(this
trait)" in the composed prompt — see `collection-dna-architecture.md`
§3A/E) can never actually fire for the `'head'` anchor today, since no
real job ever sets `layerType` to the string `'head'`. That's a live,
already-existing gap this design surfaces, not something the compositor
introduces.

Two ways forward, not mutually exclusive:

- **A (zero code, works today):** Present exactly the three unambiguous
  slots as the required MVP set — `body`, `eyes`, `mouth` — plus
  `accessory` for the "headwear/accessory" slot (the fixture's own
  compatibility rules already model `headwear overlaps head`, `headwear
  excludes eyes` in terms that map cleanly onto `accessory`'s existing
  meaning — `__fixtures__/collection-dna-smb-animal.ts:41-42`). Treat
  `icon` as a fully optional, non-required sixth layer for a standalone
  badge — never forced into the "head" role. This needs no `LayerType`
  change and can be built exactly as scoped today.
- **B (small code change, deferred — not part of this task):** Add real
  `'head'`/`'headwear'` values to `LAYER_TYPES`, exactly as already
  twice-recommended (`collection-mvp-plan.md:155-158,241`;
  `collection-dna-architecture.md:169`). This is the "real" fix and
  should happen eventually, but it's a backend enum change with
  lockstep-consistency requirements across `agent-loop.ts`, `store.ts`'s
  `DEFAULT_Z_INDEX`, and the frontend's separately-declared `LAYER_TYPES`
  const (`page.tsx:56-57`) — explicitly a code change, out of scope for
  a no-code design task.

**Recommendation: ship the compositor MVP on Option A now** (it needs
nothing this task isn't allowed to touch), and treat Option B as the
natural next `LayerType`-extension task — at which point the compositor
gains a real "head" slot for free, since its slot list is data-driven off
`LAYER_TYPES`, not hardcoded (§4).

One more concrete inconsistency worth flagging while here: `DEFAULT_Z_INDEX`
gives `accessory` and `icon` the **same** default (`40`) — a real trait
using whichever default is untouched by a human could tie. Harmless today
(ties just need a deterministic tiebreak, §5), but worth knowing before
extending the enum, since `head`/`headwear` will need their own
non-colliding defaults (the fixture's own anchors already suggest
sensible values: head 15, headwear 25, ahead of eyes 20/mouth 30 — see
`__fixtures__/collection-dna-smb-animal.ts:24-32`).

---

## 3. MVP architecture, one paragraph

A new **"Assemble" panel** on `/tools/pixel-forge`, reusing the page's
existing `traits` state and `Collection` list/selector — no new fetch,
no new route. The user picks a `Collection` (reusing the existing
selector), the panel filters the in-memory trait array to that
`collectionId`, groups the results by `layerType`, and renders one picker
per eligible slot (`body`, `eyes`, `mouth`, `accessory`, optional `icon`
— §2 Option A). Each picker defaults to that slot's most-recently-
approved trait (or nothing, if none is approved) and lets the user
explicitly change it, including to a `candidate` if they opt in. Once at
least one slot has a selection, a fixed-size square preview area stacks
each chosen trait's `pngBase64` as an absolutely-positioned, nearest-
neighbor-scaled `<img>`, ordered by ascending `zIndex`, with any
`size`-incompatible trait excluded from its slot's picker options rather
than silently rendered askew. Nothing here is a new store, a new
reducer, or new backend surface — it's a filter + a sort + a stack of
`<img>` tags.

---

## 4. UI flow

1. **Collection selector** — reuse the existing panel at
   `page.tsx:1055-1090` verbatim (same `collections`/`selectedCollectionId`
   state); the Assemble panel just reads `selectedCollectionId`, it
   doesn't need its own copy of collection CRUD.
2. **Slot rows**, one per eligible `layerType` (§2 Option A: `body`,
   `eyes`, `mouth`, `accessory`, optional `icon`), each showing:
   - a `<select>` of eligible traits for that `layerType` within the
     selected collection (approved-first, "include candidates" checkbox
     to widen the list, `rejected` never listed);
   - the trait's own small `PixelImg` thumbnail next to the dropdown, so
     the user can see what they're about to add without scrolling to the
     gallery;
   - a "none" option (slot stays empty — not every collection needs
     every slot filled, e.g. no headwear on this particular character).
3. **Incompatible-size guard** — once any slot has a selection, every
   other slot's dropdown greys out (with a tooltip, not a silent
   disappearance) any trait whose `size` doesn't match the first
   selection's `size`.
4. **Stacked preview** — a square canvas-area (CSS box, not an HTML
   `<canvas>` element — see §5) showing every filled slot's image,
   absolutely positioned, `zIndex`-sorted, pixelated scaling, against the
   same checkerboard transparency background `PixelImg` already uses
   (`page.tsx:418`) so a missing/transparent region reads clearly as
   "nothing drawn here yet," not as an error.
5. **No further actions in this MVP** — no save, no export, no "promote
   to trait," no mint pipeline hookup. Purely a look-and-compare tool.

---

## 5. Client-side render strategy

**Use stacked `<img>` elements, not an HTML `<canvas>` compositor.**
Every stored trait PNG already has index-0 as transparent
(`store.ts:79`, `agent-loop.ts:512-514`), so the browser's own alpha
compositing over absolutely-positioned, same-sized images is correct and
free — no pixel loop, no `drawImage`, no manual alpha math needed for
*display*. This is the same trick `PixelImg` already uses for a single
trait (`page.tsx:413-420`), just repeated N times in one positioned
container:

```
<div style={{ position: 'relative', width: PREVIEW_PX, height: PREVIEW_PX }}>
  {slotsSortedByZIndex.map(({ trait }) => (
    <img key={trait.id}
         src={`data:image/png;base64,${trait.pngBase64}`}
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', ...PIXELATED }} />
  ))}
</div>
```

- **Sort key:** ascending `trait.zIndex`; deterministic tiebreak on a
  real tie (§2's `accessory`/`icon` default collision) by `LAYER_TYPES`
  array index, so render order never depends on object/fetch order.
- **Sizing:** display size (`PREVIEW_PX`) is a UI constant, independent
  of each trait's actual decoded PNG pixel size — exactly like
  `PixelImg` already does. The *only* thing that must match across
  layers is the logical `size` field (§1/§6), not the display box.
- **No canvas element needed for the preview.** A real `<canvas>` (with
  `drawImage` per layer + `toDataURL()`) would only become necessary for
  a future "export the composite as one flattened PNG" action — cleanly
  deferred (§6), and still fully client-side/no-AI when it happens.

---

## 6. Staged implementation plan (for when code work is authorized)

1. **Data-only groundwork:** none needed — every field already exists.
   Confirm via a quick manual check that at least one real collection
   has ≥2 traits across ≥2 layer types to test against (not a code
   step).
2. **Assemble panel shell:** collection selector (reuse existing state),
   empty slot rows, no picker logic yet. Verify: panel renders, no
   traits shown, no crash with zero collections/traits.
3. **Slot picker logic:** filter `traits` by `collectionId` + `layerType`
   + status rule (§1/§4.2); wire the "include candidates" toggle. Verify:
   picking any candidate/approved combination updates the row's thumbnail
   correctly; `rejected` never appears.
4. **Size-compatibility guard:** reference-size lock on first pick,
   disable mismatched options elsewhere. Verify: deliberately create (or
   fake in dev tools) two traits of different `size` in one collection
   and confirm the guard actually disables the mismatched one rather than
   just warning after the fact.
5. **Stacked preview render:** the `<img>` stack from §5, zIndex-sorted.
   Verify visually in a real browser (per this project's own "visual
   verification = real browser" rule) across at least two real
   collections/trait combinations, and at at least two different
   `PREVIEW_PX` display sizes to confirm the pixelated scaling holds up.
6. **Nothing past this point is in scope for this MVP** — see §7.

Every one of these steps is offline/free — no Anthropic call anywhere in
this feature, matching the task's own constraint.

---

## 7. What should be deferred (explicitly out of scope)

- Real `head`/`headwear` `LayerType` values (§2 Option B) — natural next
  step, but a backend enum change, not part of a "no code" compositor.
- Adding `collectionId` to the *existing* gallery's filter row (only the
  new Assemble panel needs its own selector for this MVP).
- Exporting the composite as a single flattened PNG (`<canvas>` +
  `toDataURL()` — cleanly additive later, no new backend needed then
  either).
- Locking a `Collection` record to one `canvasSize` at generation time
  (would catch a mismatch earlier, at generation, instead of only at
  preview time) — a reasonable `collections-store.ts` field addition
  later, not required for the compositor to work correctly today, since
  the compositor's own guard (§4.3) already prevents a bad render.
- Any AI call of any kind, any mint pipeline wiring, any rarity
  computation, any batch generation — all explicitly excluded by the
  task, and none of them are needed for a look-and-compare compositor
  anyway.
- Saving an assembled stack as anything persisted (a "character" record,
  a manifest, a favorite) — this MVP is view-only.

---

## 8. First implementation step

Before any UI work: **write the pure selection/sort/guard logic as
plain, framework-free functions**, testable the same offline way this
project already tests `collection-prompt-composer.ts` and
`collection-id-route-logic.test.ts` — e.g. `selectSlotCandidates(traits,
collectionId, layerType, { includeCandidates })`,
`sortLayersByZIndex(slots)`, and `isSizeCompatible(traits)` — against a
synthetic in-memory `TraitAssetSummary[]` fixture, no server, no browser,
no Anthropic call. Only once those three are proven correct in isolation
does wiring them into the actual Assemble panel JSX become the next step
— same "prove the mechanism in isolation before wiring the UI" discipline
already used for the draft-pixel and reference-image redaction helpers in
`agent-loop.ts`.
