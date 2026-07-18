# Pixel Forge — Direct Reference Mode Audit

Status: **audit and design only, no code, no API calls, no deploy.**
Grounded directly in the actual source
(`src/pixel-agent/agent-loop.ts`, `src/pixel-agent/tools.ts`,
`src/pixel-agent/reference-analysis.ts`) and the two existing design docs
this proposal sits on top of: `pixel-forge-reference-mode-mvp.md` (current
text-only Reference Mode) and `pixel-forge-token-cost-audit.md` (measured
token/cost model, including the real per-render image-token math reused
here). Every number below is computed from those measured constants, not
assumed.

**Important scope note, stated up front:** this is a *separate* change
from the `reference-analysis.ts` work already sitting as uncommitted WIP
(mock → real Sonnet vision call for the *analysis* step). That WIP makes
the derived **text** guidance better; it does not change who sees the
image. This audit is about a structurally different, additional
capability: letting the **drawing/refine model itself** see the uploaded
reference image's pixels, not just a text summary of it. The two are
stackable, not alternatives — see §7.

---

## 0. What "seeing the reference" currently means (baseline)

Per `pixel-forge-reference-mode-mvp.md` §4-§5 and confirmed in the live
code path (`tools-pixel-forge.ts`'s `/jobs` route): the uploaded image is
sent to exactly one forced-tool-call (`analyzeReferenceImage`), which
returns `{ inherit[], exclusions[], note }` — plain text. That text is
folded into `buildSystemPrompt` as one more optional labeled section,
structurally identical to how `anchor` is appended
(`agent-loop.ts:578-588`). **The image itself never reaches
`runDrawingJob` or `runRevisionJob`** — no variable holding the base64
survives past the analysis call. This is the current, hard architectural
guarantee, and it is the actual reason exact-copy risk is currently near
zero: the model cannot copy pixels it has never seen.

---

## 1. Quality upside of showing the image directly

Real, and plausibly large, for exactly the failure mode you hit
(raccoon → "faceless bear, mess of rectangles"):

- **Style transfer / silhouette / proportions** — the current text
  guidance is deliberately abstracted to prose rules ("eyes sit low,
  spanning ~1/3 head width"). A vision model reasoning over an actual
  reference image at draft time has direct geometric grounding instead of
  a paraphrase of geometry — this is the single most plausible fix for
  "the model doesn't see how it's supposed to look," which is exactly
  what you diagnosed.
- **Pixel-art construction cues** (outline weight, cluster size, banding)
  — easier to imitate from a real example than from a text description of
  the same thing, especially at low resolution where "a few large,
  deliberate regions over many scattered small edits" (the existing
  system prompt's own instruction, `agent-loop.ts:545-546`) is much easier
  to *show* than to *describe*.
- **Fewer abstract-guidance failures** — text guidance depends on the
  analysis call correctly verbalizing what matters; a direct image removes
  that translation step for the specific properties a vision model is
  already good at reading directly (proportion, silhouette, general
  construction), while still needing text for things that are hard to see
  in one static image (e.g. "3 stepped shading bands").

---

## 2. Risks

- **Copying exact subject/accessories/colors — the load-bearing risk.**
  `pixel-forge-reference-mode-mvp.md` §5 states this plainly: "the
  draft/refine model never receives the reference image — only text. It
  cannot copy pixels it is never shown. This is the... one that actually
  matters; everything below is reinforcement, not the load-bearing part."
  Direct Reference Mode removes exactly that guarantee. A "do not copy"
  instruction sitting next to a visible image is a soft control, not a
  hard one — vision-capable LLMs are well known to lean on visible
  reference material even against explicit negative instructions,
  especially at small canvas sizes where "trace the silhouette" is the
  path of least resistance. This is the central trade-off of the whole
  proposal, not a minor caveat.
- **IP/copyright concerns** — same root cause as above; a user uploading
  a copyrighted character reference and getting a near-copy back is a
  real exposure this project currently has zero risk of (see §0).
- **Overfitting to the reference** — a real quality risk in the other
  direction: excessive fidelity to *this one* reference image, rather than
  the requested subject/prompt, especially across a whole collection's
  worth of traits all shown the same reference.
- **Token/image cost** — real but, per the measured formula already in
  this codebase (`imageTokensPerRender = (canvasSize × 8)² / 750`,
  confirmed at ~87 tokens for a 256×256 render), individually small. See
  §4 for the actual numbers — the interesting risk here isn't the image's
  own cost, it's what happens if it's resent.
- **Repeated resend every refine turn — the real cost risk, and it is
  structural, not incidental.** `pixel-forge-token-cost-audit.md` §1
  already established that this codebase's `messages` array is never
  trimmed — every prior turn's content (including every rendered image)
  is resent in full on every later call in the same job
  (`agent-loop.ts` — confirmed directly by reading `refineAndEvaluate`,
  same array pushed to every turn, passed as-is to every
  `client.messages.create()` call). **This means "attach the reference
  image" is not naturally a one-time cost** — unless it is deliberately
  redacted from history after use, it silently becomes a per-call cost
  for the rest of the job, exactly the failure mode the draft's raw pixel
  array already had before it was redacted (§3 of the token-cost audit,
  already shipped). Any Direct Reference Mode implementation MUST reuse
  that same redaction pattern or it will quietly multiply job cost by
  something close to `maxTurns`.

---

## 3. Architecture options

| | Mechanism | Exposure window | Relative cost | Relative copy-risk |
|---|---|---|---|---|
| **A. Text-only (current)** | `analyzeReferenceImage` → text → `buildSystemPrompt` | none (image never shown to drawing model) | near-zero | near-zero |
| **B. Direct image, draft call only** | Attach `imageBlock(reference)` to the very first `"Draw: {prompt}"` user message (`agent-loop.ts:1074`); redact from history immediately after the draft call consumes it, mirroring the existing `DRAFT_PIXELS_HISTORY_PLACEHOLDER` pattern at `agent-loop.ts:1140-1147` | one call | low (one-time) | moderate, bounded to the moment the initial silhouette is laid out |
| **C. Direct image, draft + first refine** | Same as B, redaction deferred one call later — the model gets to compare its own first-pass render against the reference side by side once, then it's gone | two calls | low-moderate (one-time ×2) | moderate, slightly wider window than B |
| **D. Direct image, every turn** | Re-attach on every refine call | every call (up to `maxTurns`) | **high** — compounds with turn count, see §4 | **highest** — the model is looking at the reference continuously, the strongest pressure toward literal copying |
| **E. Direct image + text guidance together** | Not a separate mechanism — an overlay: keep the existing text guidance flowing to *every* turn (as today) regardless of whether B, C, or D is also used for the image itself | — | ~free on top of A | unchanged from whichever image option it's layered on |

**B and C are the only options that don't require solving a genuinely new
engineering problem** (repeated-redaction bookkeeping across N turns) —
they reuse a pattern this codebase has already implemented once, so the
"first implementation step" in §7 is a close cousin of a real, already-
shipped change, not new territory. D requires per-turn redaction
discipline across a variable number of turns, which is meaningfully more
code and more places for a leak (a case where the image *isn't* redacted
one turn) to quietly turn into a §2 cost blowup.

---

## 4. Cost impact (measured formula, not guessed)

Using this codebase's own image-token approximation (already validated
against real jobs in `pixel-forge-token-cost-audit.md`):
`tokens ≈ (width × height) / 750`.

Reference images are capped at 1024×1024
(`REFERENCE_IMAGE_MAX_DIMENSION`, `reference-analysis.ts:39`) and ≤2 MB
(`REFERENCE_IMAGE_MAX_BYTES`). Per-occurrence image-token cost by actual
uploaded size:

| Reference image size | Tokens/occurrence |
|---|---|
| 256×256 | ~87 |
| 512×512 | ~350 |
| 1024×1024 (max allowed) | ~1,398 |

For comparison, the render images already sent every turn today: 32px
canvas → ~87 tok/render, 48px canvas (max) → ~197 tok/render — i.e. a
worst-case (1024×1024) reference upload costs **~7-16× one render**, not
comparable-to-cheap the way the existing render images are.

**Does repeated resend matter? Yes, concretely:**

- **Option B/C (redacted after 1-2 calls):** one-time cost only. Worst
  case (1024×1024 reference): ~$0.0028 (B) to ~$0.0056 (C) added to a job
  at Sonnet's $2/MTok input rate. Negligible relative to a typical job's
  measured 13,000–40,000 total input tokens.
- **Option D, naively implemented (no per-turn redaction), worst case:**
  a `normal` preset job defaults to 8 refine turns
  (`PRESET_DEFAULT_MAX_TURNS.normal`); if the reference re-enters history
  each turn and is never redacted, it doesn't just cost 8× the per-
  occurrence figure — it compounds the same way the audit found for
  regular history growth (each occurrence also gets resent on every
  *later* call). Worst case ballpark: 8 occurrences × ~1,398 tok ≈ 11,184
  extra input tokens minimum (≈$0.022 at Sonnet rates) even *with*
  disciplined per-turn redaction (show-then-redact each turn), and
  meaningfully worse without it. That's comparable to the entire rest of
  a typical job's token floor — i.e. Option D can plausibly **double** a
  job's cost for the marginal value of continuing to show a *static,
  unchanging* image the model already incorporated on turn 1.

**Recommendation: B (draft-only) is the cheapest useful mode.** C is a
reasonable escalation if B alone underdelivers on quality (one more
look, one more redaction, still cheap). D is not recommended on cost
grounds alone, independent of the copy-risk argument in §2 — by turn 2-3
the reference has already been "seen once"; re-showing a static image
that hasn't changed adds cost without adding new information, unlike the
model's own evolving render, which *does* change turn to turn and is
worth resending.

---

## 5. Safety

- **Rights checkbox** — already exists
  (`referenceRightsConfirmed`, `tools-pixel-forge.ts`), required whenever
  `referenceImage` is present. Necessary but, per §2, no longer
  sufficient on its own once the drawing model can see the image — today
  it gates a text-only nudge; under Direct Reference Mode it would be
  gating something with real copy risk, a materially different promise
  for the user to be agreeing to.
- **Recommend: yes, require a second, explicit "direct reference allowed"
  checkbox**, separate from the existing rights checkbox, unchecked by
  default. Rationale: the existing checkbox's copy ("I have the right to
  use this image as a style reference") was written for, and only
  promises, the current text-only guarantee. Reusing it silently for a
  structurally different (image-visible) mode would mean the user's prior
  consent doesn't actually cover what the feature now does. A second,
  separately-worded checkbox ("Allow the drawing model to see this
  reference image directly — this mode may produce results visually
  closer to the reference than the default style-guidance mode.") keeps
  the two promises honest and independently revocable, and defaults
  Direct Reference Mode *off* even for users who already have style-
  reference rights confirmed.
- **Do-not-copy prompt wording** — needed at two sites, not one: (a) the
  existing `analyzeReferenceImage` exclusions text already carries this
  for the text-only path; (b) a *new* instruction must sit directly
  alongside the image block itself when attached to the draft call (e.g.
  "The image above is a construction/style reference only. Do not
  reproduce its exact subject, accessories, symbols, or literal colors —
  draw the prompt's own subject, using this image only for proportion,
  silhouette, and construction cues.") — this needs to be adjacent to the
  image in the same message, not just present once, generically, in the
  system prompt.
- **Exact color copying: keep forbidden, not optional.** The current
  design's `palette` param stays the sole source of truth for colors
  (`pixel-forge-reference-mode-mvp.md` §5.4) — this is cheap to preserve
  (the model already only has palette-index tools, `tools.ts`'s
  `REFINE_TOOLS`, so it literally cannot emit an arbitrary hex value even
  if it wanted to; it can only pick from the indices it's been given).
  This is actually a strong structural mitigation already present for
  free — worth stating explicitly as a reason color-copying risk is lower
  than subject/silhouette-copying risk.

---

## 6. Interaction with Collection DNA

**Collection DNA already outranks reference guidance in the current code,
by construction, not just convention** — `buildSystemPrompt` pushes
`collectionPromptSection` before `referenceGuidance`
(`agent-loop.ts:578-588`), and the section's own doc comment states this
explicitly: "Ranks ABOVE `referenceGuidance` ... Collection DNA outranks a
per-job reference nudge." That precedent should extend to Direct
Reference Mode, but it needs one more explicit step, because the
*mechanism* differs: Collection DNA is system-prompt text; a direct
reference image is a content block in a *user* message at draft time —
different part of the request, so "system prompt ordering" alone doesn't
enforce priority between them the way it does for two text sections.

**Recommendation:** when a job has both `collectionId` (or the hidden
`collectionPreset`) *and* Direct Reference Mode active, append one
explicit tie-breaker sentence next to the reference image itself (not
just in the system prompt): "Geometry anchors, compatibility rules, and
palette from the Collection DNA section above take precedence over
anything shown in the reference image below — treat the reference as
style/construction inspiration only, never as an override of this
collection's established proportions or palette." This keeps the
already-established precedence real even though the reference now arrives
through a different channel (image vs. text), and directly satisfies "the
reference must not override geometry/palette/compatibility."

---

## 7. Recommended MVP

**B + E, i.e.: direct reference image shown only to the draft call,
redacted from history immediately after (mirroring the existing draft-
pixel-array redaction), plus the existing text guidance
(`analyzeReferenceImage`'s `inherit`/`exclusions`/`note`) continuing to
flow into every turn exactly as it does today.** This is not "either/or"
with the current text-only mode — it's additive: keep the analysis call
exactly as designed (it's cheap, already-built, and gives *every* turn a
textual reminder of construction rules even after the image itself has
left history), and layer one extra, narrow, cheap, bounded-risk capability
on top: let the model see the actual reference once, at the single moment
it matters most (laying out the initial silhouette), then take it away
again.

If B alone doesn't move the needle enough after a real test, escalate to
**C** (draft + first refine) before ever considering **D** — D's cost and
copy-risk profile (§2, §4) aren't justified by a static image that hasn't
changed since turn 1.

- **Do not persist the image** — same hard rule as today
  (`pixel-forge-reference-mode-mvp.md` §3): request-scoped only, never
  written to `data/pixel-forge/`, never given a new store.
- **Do not store the base64** — not on the job, not on the resulting
  `TraitAsset`, not in logs. Only the derived text guidance (already
  optionally stored as `referenceGuidanceNote`) persists.
- **Do not show it to revision jobs yet** — same reasoning
  `pixel-forge-reference-mode-mvp.md` §6 already gives for why reference
  is draft-only: attaching a reference to an *existing* trait and asking
  revision to "match it better" collides with Revision V4's surgical,
  region-scoped philosophy. Direct Reference Mode doesn't change that
  argument at all — if anything it strengthens it, since a visible image
  next to a region-scoped repair instruction is an even more direct
  invitation to redraw more than the targeted region.

---

## Files likely touched (implementation, later — not this audit)

- `src/pixel-agent/agent-loop.ts` — `runDrawingJob`'s initial `messages`
  construction (`agent-loop.ts:1073-1074`) gains an optional reference
  image block on the first user message when Direct Reference Mode is
  active; a redaction step mirroring `agent-loop.ts:1140-1147`
  (`DRAFT_PIXELS_HISTORY_PLACEHOLDER`-style) strips it from history right
  after the draft call consumes it. `buildSystemPrompt`/
  `DrawingJobParams` need one more optional flag or the tie-breaker
  sentence from §6 when `collectionPromptSection` is also present.
- `src/pixel-agent/reference-analysis.ts` — no change to
  `analyzeReferenceImage` itself; the *validated, decoded* reference
  buffer (already produced by `validateReferenceImage`) needs to also
  reach `runDrawingJob` for Direct Reference Mode, which is a real change
  to this file's current hard contract ("the image variable never
  survives past `analyzeReferenceImage`," `pixel-forge-reference-mode-
  mvp.md` §12) — this line moves deliberately, not accidentally, and
  should be called out explicitly in any implementation PR/commit.
- `src/server/tools-pixel-forge.ts` — new body field (e.g.
  `directReferenceAllowed: boolean`, separate from
  `referenceRightsConfirmed`), gating whether the validated buffer is
  threaded through to `runDrawingJob` at all.
- `frontend/src/app/tools/pixel-forge/page.tsx` — second checkbox (§5),
  distinct copy from the existing rights checkbox.
- No changes needed to `collections-store.ts`, `store.ts`, or the
  Collections UI (Stage 2/3 work) — this is orthogonal to the collection
  system except for the §6 tie-breaker sentence.

## Exact first implementation step

Before any prompt/model change: **add the redaction mechanism as an
isolated, testable unit**, independent of wiring it into the real
request path yet — write a small pure function (or extend the existing
draft-redaction site at `agent-loop.ts:1140-1147`) that takes a
`messages` array containing one reference-image content block and
returns a copy with that block replaced by a short placeholder text,
verifiable with a synthetic message array and no Anthropic call at all
(same "verifiable without API calls" discipline the token-cost audit used
for its own redaction item). Only once that's proven correct in isolation
does wiring the actual image attachment + a real smoke-test generation
become the next step — and per this project's own standing convention,
that first real test should be one small, cost-capped, explicitly-
approved paid smoke test (one prompt, `fast` or `normal`, low
`maxTurns`), comparing the Direct-Reference-Mode result against a same-
prompt baseline, not a batch.
