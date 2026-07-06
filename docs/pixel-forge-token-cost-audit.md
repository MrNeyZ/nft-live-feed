# Pixel Forge — Token/Cost Audit

Status: **audit and design only, no code, no API calls.** Grounded in the
actual source (`src/pixel-agent/agent-loop.ts`, `src/scripts/pixel-forge-
validation.ts`) and the 16 real job records already collected across
validation runs `2026-07-05_003`, `_004`, `_006`, `_007` — every number
below is either measured directly from source text or pulled from those
runs' `results.jsonl`, not assumed.

**Headline correction to the working theory:** the brief's hypothesis was
"the refine loop resends too much image/message history." That's half
right in an important way — **message history absolutely does get
resent in full on every turn**, confirmed below — but the *dominant*
resent content is not images. Per Anthropic's own image-token
approximation, a 256×256 pixel-art render costs roughly **87 tokens**.
That's cheap. The real cost driver is **text**: the system prompt
(~800–925 tokens, sent on *every* call), tool schemas (112–942 tokens
depending on call type, sent on every call of that type), and — for
fresh drafts specifically — the model's own raw 1024-integer pixel array
sitting in history for the rest of the job. Getting this distinction
right matters, because it changes which fixes are worth doing.

---

## 1. Message construction audit

### What's sent on each call type, exactly

**Draft call** (`runDrawingJob`, fresh trait only) — no image, no tools
beyond `submit_draft`:
- System prompt: `buildSystemPrompt()` — **measured at ~775 tokens**
  (3,101 characters across its literal text, excluding the interpolated
  palette legend, which adds another ~40 tokens for a 16-color palette) →
  **~800–820 tokens total**.
- One user message: `"Draw: {prompt}"` — trivial (~20–40 tokens).
- `submit_draft` tool schema — **measured at ~112 tokens** (449 bytes of
  JSON).
- **Total floor for this one call: ~950 tokens**, before the model has
  written anything.

**Each refine-loop call** (`refineAndEvaluate`, both fresh and revision
jobs) — this is where "what gets resent" matters:
- The **same system prompt** as above, resent whole, unchanged, every
  single turn (`buildSystemPrompt` ~800 tokens for fresh, or
  `buildRevisionSystemPrompt` — **measured at ~886 tokens** of literal
  text, ~925 with the palette legend, for revision — both confirmed by
  direct measurement of the source, not estimated).
- `REFINE_TOOLS` (5 tools: set_pixel, fill_rect, draw_line, flood_fill,
  clear) — **measured at ~432 tokens**, or `REPAIR_TOOLS` (4 tools, no
  `clear`) — **measured at ~373 tokens** — resent every refine call.
- The **entire `messages` array accumulated so far** — and this is the
  part that grows: for a fresh-draft job, turn 1's call already includes
  the original prompt, the assistant's draft `tool_use` block (**the full
  1024-integer pixel array**, not a summary of it), and the tool_result +
  rendered draft image. Turn 2's call includes all of that *plus* turn
  1's own assistant response (tool calls + any reasoning text it wrote)
  and turn 1's tool_result + rendered image. This repeats every turn —
  **every prior turn's images, tool calls, and free-text commentary are
  resent in full on every subsequent call**, confirmed directly by
  reading the code: `messages` is a single array, pushed to every turn,
  never trimmed, and passed as-is to every `client.messages.create()`
  call in the loop.

**Evaluate call** — same accumulated `messages` array (everything from
every prior turn, still un-trimmed) plus one more image, the harsh-
grading instruction text (~230 tokens), and `SUBMIT_EVALUATION_TOOL` —
**measured at ~942 tokens**, the single largest fixed schema cost in the
whole pipeline, paid once per job.

### Does this confirm images are resent repeatedly?

Yes, mechanically — every rendered image from every turn stays in
`messages` and gets resent on every later call in the same job. **But
each image is individually cheap** (~87 tokens at the current 256×256
render size, per Anthropic's `(width×height)/750` approximation) — so
while images do compound, they are very unlikely to be the dominant
contributor. See §2 for the real-data confirmation of what actually
dominates.

### Does the system prompt / tool schemas / full history dominate input tokens?

**All three matter, in this order of impact:**
1. **Full history (accumulated text)** — dominant, and the reason cost
   scales so strongly with turn count (§2).
2. **System prompt** — a large *fixed floor* cost (~800–925 tokens) paid
   on *every single call* in a job, refine and evaluate alike. For a
   4-refine-turn job that's 6 total calls (draft + 4 refine + evaluate) ×
   ~800–925 tokens **just for the system prompt, repeated identically six
   times** — call it ~4,800–5,500 tokens from the system prompt alone,
   before counting anything else.
3. **Tool schemas** — smaller than the system prompt but non-trivial,
   especially `SUBMIT_EVALUATION_TOOL` at ~942 tokens (once) and
   `REFINE_TOOLS`/`REPAIR_TOOLS` at ~370–430 tokens (every refine call).

**The single largest specific offender for fresh drafts**: the draft's
raw pixel array (up to 1,024 integers, roughly 1,500–2,500 tokens as
text) is emitted once as the draft's `tool_use` content, then sits
unchanged in `messages` for the rest of the job — resent on every
remaining refine turn and the evaluate call, even though **nothing
downstream ever needs to re-read those literal numbers again** — the
rendered image (already in the same messages) and the server-side
`Canvas` object are what actually matter from that point forward. This is
dead weight from turn 2 onward.

---

## 2. Cost estimator audit — why it undercounts, with real numbers

`estimateJobCostUsd()` assumes: `refineInputTokens = maxTurns × (imageTokensPerRender + 600)` —
**a flat, non-cumulative per-turn cost**, effectively claiming every
refine turn costs the same ~687 tokens of input regardless of which turn
number it is or how much history has piled up. Cross-referencing against
all 16 real job records (all at `canvasSize=32`, `maxTurns=4`, so every
job shares the identical `$0.0277` pre-job estimate) shows two distinct,
additive, both-confirmed sources of undercount:

| Job (turns used) | Real input tokens | actual/estimate ratio |
|---|---|---|
| icon-star run_004 r0 (**1** turn) | 13,273 | **1.09x** |
| icon-heart run_006 r0 (**1** turn) | 13,313 | **1.01x** |
| icon-heart run_003 r0 (4 turns) | 30,452 | 1.96x |
| icon-star run_003 r0 (4 turns) | 31,999 | 1.84x |
| icon-star run_006 r0 (4 turns) | 30,723 | 1.83x |
| icon-heart run_004 r1 revision (4 turns) | 23,933 | 1.35x |
| icon-star run_004 r1 revision (4 turns) | 23,034 | 1.29x |
| head-cat run_007 r0 (4 turns) | 38,230 | 2.43x |
| head-cat run_007 r1 revision (4 turns) | 27,249 | 1.67x |
| bust-wizard run_007 r0 (4 turns) | 41,680 | **2.84x** |
| icon-heart run_004 r0 (4 turns) | 42,645 | **2.88x** |
| bust-wizard run_007 r1 revision (4 turns) | 26,198 | 1.52x |

**Finding 1 — the per-call floor is underestimated, independent of
turn count.** Even the two jobs that stopped after a *single* refine turn
(3 total calls: draft + 1 refine + evaluate) still landed at 13,000+ real
input tokens against an estimate that assumed *four* refine turns'
worth of cost (~3,635 tokens total). The estimator's assumed per-call
text overhead (~600 tokens) is simply far below the *measured* fixed
floor of one real call — system prompt alone is 800–925 tokens, plus
100–950 tokens of tool schema, before any history exists at all. This is
why even the cheapest possible jobs still land near 1.0–1.1x rather than
well under 1.0x, despite using a quarter of the assumed turns.

**Finding 2 — real cost scales with turns used, confirmed directly.**
The 1-turn jobs sit at ~1.0x; every 4-turn job sits meaningfully higher
(1.29x–2.88x), and the highest ratios belong to the two most
content-heavy prompts (`bust-wizard`, `icon-heart` fresh draft) — jobs
where the model plausibly wrote more reasoning text and made more tool
calls per turn, which is exactly the content that then gets resent on
every subsequent call. The estimator has no way to account for this: it
multiplies one flat number by `maxTurns`, rather than summing a
genuinely growing per-turn cost.

**Conclusion:** the estimator needs two independent corrections — a
higher, measured floor (system prompt + relevant tool schema, per call
type), and a cumulative (not flat) model of refine-turn growth. Both are
computable from data already in hand; neither requires an API call to
fix or verify (see §3, item 1).

---

## 3. Top 5 cost-saving opportunities

### 1. Fix the cost estimator's formula
- **Expected reduction:** $0 in real spend — this doesn't cut cost, it
  makes the existing cost *caps* (already load-bearing in the validation
  runner) trustworthy instead of silently wrong by up to ~2.9x.
- **Risk to quality:** none — pure arithmetic/reporting, touches no
  prompt or model behavior.
- **Complexity:** low — rewrite one function (`estimateJobCostUsd`)
  using the measured floors above (~800–925 system + 112–942 tool schema
  per call type) and a cumulative-sum model instead of a flat multiply.
- **Verifiable without API calls:** yes, fully — validate the new
  formula's predictions against the 16 real job records already
  collected; no new spend needed to confirm the fix is closer to reality.
- **Requires prompt changes:** no.

### 2. Stop resending the draft's raw pixel array once it's been read
- **Expected reduction:** likely the largest lever in absolute tokens —
  up to ~1,500–2,500 tokens saved on *every* remaining call in a
  fresh-draft job (potentially 5 calls: 4 refine + evaluate), since that
  array currently sits in history unchanged and un-needed from turn 2
  onward.
- **Risk to quality:** low-to-medium. The array is genuinely
  never re-read for its literal values (the rendered image and the
  server-side `Canvas` already carry everything downstream needs), but
  editing an already-emitted assistant `tool_use` block before resending
  it is a real change to conversation history — a small, plausible risk
  that the model reacts oddly to seeing a different record of its own
  past action. Needs a live smoke-test check, not just static reasoning.
- **Complexity:** low-to-medium — a contained change in `runDrawingJob`,
  replacing the stored draft tool_use content with a short placeholder
  (e.g. `{pixels: "[submitted — see rendered image above]"}`) before it's
  pushed into `messages`, immediately after the array has been consumed
  to seed the `Canvas`.
- **Verifiable without API calls:** the code change itself, yes; the
  "does the model still behave correctly without literally re-reading
  its own array" question needs one real smoke test.
- **Requires prompt changes:** no.

### 3. Trim `SUBMIT_EVALUATION_TOOL`'s schema description verbosity
- **Expected reduction:** modest — this cost (~942 tokens) is paid
  *once* per job, not multiplied by turns, so the ceiling on savings here
  is small relative to items 2 and 4. Still free money if done carefully.
- **Risk to quality:** low, *if* the trim only removes redundant phrasing
  and keeps every instructive element that's currently load-bearing —
  specifically the "write blindDescription FIRST, before any other
  field" sequencing instruction and the severity/category guidance,
  which is exactly what the recognizability mechanism depends on.
  Cutting those specifically would be a real quality risk, not a safe
  trim.
- **Complexity:** low.
- **Verifiable without API calls:** the token reduction, yes (just
  measure the new JSON length); whether evaluation quality holds needs a
  live check.
- **Requires prompt changes:** technically yes — these are description
  strings inside a tool schema, which function as prompt content even
  though they're not the system prompt itself. Treat this with the same
  care as any other prompt change.

### 4. Instruct both system prompts to keep per-turn narration brief
- **Expected reduction:** potentially large and *compounding* — unlike
  item 3, any text the model writes per turn gets resent on every
  subsequent call in that job, so shrinking it has a multiplying effect
  across a job's remaining calls, similar in shape to item 2.
- **Risk to quality:** medium — this is the one item on this list that
  could genuinely backfire if worded carelessly. The reasoning scaffold
  V4 asks for (`CURRENT/PROBLEM/PRESERVE/SMALLEST EDIT/CONFIDENCE`) is
  exactly the content the last audit confirmed was being followed in
  spirit and was diagnostically valuable (`run_007`'s transcripts) — an
  instruction to "be brief" must target conversational filler ("Great,
  now let me...") specifically, not the structured reasoning itself.
  Getting this wrong would cut the thing V4 was just confirmed to be
  doing right.
- **Complexity:** low to word, but real care needed in wording.
- **Verifiable without API calls:** no — requires a live smoke test to
  confirm both that token usage actually drops and that the reasoning
  scaffold survives.
- **Requires prompt changes:** yes, explicitly.

### 5. Skip re-sending an image when a turn produced no pixel change
- **Expected reduction:** small in isolation — each image is only ~87
  tokens per the measured formula, so this saves little per occurrence.
  Included because it's genuinely free.
- **Risk to quality:** none — a deterministic array-equality check
  (compare the `Canvas`'s flat pixel array before and after applying a
  turn's tool calls) with no model or prompt involvement.
- **Complexity:** low.
- **Verifiable without API calls:** yes, fully — this is pure
  server-side logic, testable with synthetic canvas states.
- **Requires prompt changes:** no.

---

## 4. Considered and explicitly not recommended

- **Reducing `evaluate`'s `max_tokens` from 1536.** Anthropic bills for
  *actual* output tokens generated, not the `max_tokens` ceiling — lowering
  this parameter only saves money if the model is *currently* being
  truncated at 1536, and nothing in the real evaluation outputs read
  during the last two smoke-test reviews looked cut off. Lowering it
  further would risk truncating a real evaluation with no cost benefit
  unless truncation is first confirmed to be happening. Not a real lever
  as things stand.
- **Reducing image upscale size** (`PREVIEW_UPSCALE` from 8 to, say, 4).
  Given images are already cheap (~87 tokens at the current size, and
  Anthropic's formula is roughly quadratic in linear size, so 4x would
  only save ~65 tokens/render), the token savings are negligible relative
  to the text-dominated cost structure found in §1–2, while the risk —
  fine pixel detail (thin outlines, small notches) becoming harder for
  the vision model to perceive accurately — is real and untested. Bad
  trade as currently understood.
- **Making evaluation optional/skippable for "obviously successful"
  drafts.** This would remove the *one* mandatory, structured quality
  checkpoint the entire V2/V3/V4 design depends on, to save roughly one
  call's worth of tokens (a few thousand). Given how much of this
  project's own history (the real, stored "approved despite failing"
  trait) turns on *not* trusting appearances without a structured check,
  cutting the check itself for a modest saving is the wrong trade. If
  evaluation cost needs cutting, cut its schema verbosity (item 3), not
  the call.

---

## 5. Recommended implementation order

**No-risk — do first, no reason to wait:**
- Fix the cost estimator formula (§3.1).
- Skip re-sending unchanged images (§3.5).
- Adopt a standing convention (no code required — the flags already
  exist) that smoke tests default to `fast` + small `--max-prompts` +
  low `--max-turns`, reserving `normal`/`premium` for deliberate,
  explicitly-approved quality benchmark runs.

**Low-risk — do next, verify with one cheap smoke test each:**
- Add per-call token-usage logging (not in the original top 5, but
  falls out of this audit directly: right now only per-*job* totals are
  recorded, which is why this audit had to reconstruct per-call behavior
  indirectly from turn counts rather than measuring it. A small,
  zero-behavior-change addition to `refineAndEvaluate`'s logging would
  make the next audit exact instead of inferred).
- Stop resending the draft's raw pixel array after it's consumed (§3.2).
- Trim `SUBMIT_EVALUATION_TOOL`'s description verbosity carefully (§3.3).

**Experimental — needs real testing, meaningful upside, real risk:**
- Instruct brevity in per-turn narration without cutting the reasoning
  scaffold (§3.4).
- Broader context compaction for long jobs (collapsing turns beyond the
  most recent one or two into a short text summary instead of full
  images/tool-calls/commentary) — not one of the top 5 because of its
  complexity and risk, but the largest remaining lever once the above are
  banked and re-measured, since it directly targets the confirmed
  dominant cost driver (accumulating history) rather than its symptoms.

**Do not do yet:**
- Lower `evaluate`'s `max_tokens` (§4 — not an actual lever given how
  billing works).
- Reduce image upscale size (§4 — negligible saving, real detail-loss
  risk).
- Make evaluation optional/skippable (§4 — removes the one mandatory
  quality gate for a modest saving).

---

## 6. Implementation status (addendum)

No-risk and low-risk items shipped so far, no Anthropic calls made for any
of them (static/typecheck/dry-run verification only):

- **Estimator formula fixed** (§3.1, cumulative model) — brought
  actual/estimate from 1.0x-2.9x (mean 1.81x) to 0.53x-1.50x (mean 1.10x)
  across the same 13 real jobs.
- **Skip re-render/re-attach on a no-op refine turn** (§3.5) — shipped in
  `refineAndEvaluate`, gated on a byte-for-byte canvas-grid comparison.
- **Draft pixel array redacted from history post-consumption** (§3.2) —
  `runDrawingJob` now replaces `submit_draft`'s `input.pixels` with a short
  placeholder in the assistant turn stored in history, right after that
  array has seeded the `Canvas`. The array is still real, one-time DRAFT
  CALL output (unchanged); it simply never resends as input on any later
  refine/evaluate call in the job.
- **Estimator re-calibrated for the redaction above** — `seedTokens` for a
  fresh job no longer assumes the array persists in history; it now models
  the actual post-redaction footprint (short prompt + placeholder +
  tool_result framing). At the default 32px canvas this lowers fresh-job
  estimates ~18% (both `fast`/4-turn and `normal`/8-turn checked); more at
  larger canvases (~30% at 64px) since the removed per-call array cost was
  a bigger share of the total there, less at smaller canvases (~6% at
  16px). Revision estimates are unchanged — a revision job has no draft
  call, so nothing to redact.
- **Per-call token usage logging** — `estimateJobCallBreakdown` (agent-loop.ts)
  now exposes the per-call estimate breakdown `estimateJobTokenUsage` was
  quietly summing; `runDrawingJob`/`runRevisionJob`/`refineAndEvaluate` log
  a `CallUsageRecord` (callIndex, phase, turn, real + estimated in/out
  tokens, imageAttached/noOpImageSkipped/toolCallCount) for every real
  call, flowing into `results.jsonl`/`summary.md`'s new "Per-call usage"
  table. Compact by design — no raw messages, no tool-call payloads.
- **Draft-array redaction reconfirmed against a real post-redaction run**
  (`2026-07-05_011`, using the per-call logging above) — **CONFIRMED
  working**, not inconclusive. Call 1's actual input (2,236 tok) sat below
  the pre-redaction floor that call would have had with the array still in
  history (~3,387 tok), and the ratio pattern across calls (1.72x → 1.54x →
  ... → 1.79x, roughly flat-to-rising) is inconsistent with a fixed
  leftover payload (which would show a *shrinking* ratio as calls get
  bigger). See the per-call table in that run's `summary.md` for the full
  breakdown.
- **Estimator recalibrated a second time, from that same run's per-call
  evidence** — three constants were undercounting independent of the
  redaction question: `SYSTEM_PROMPT_TOKENS_FRESH` (820→1600, inferred from
  matching gaps on both the draft call and refine turn 1), 
  `ASSUMED_OUTPUT_TOKENS_PER_TURN_FRESH` (580→1050, from that run's own
  4-turn output mean), and a new named `EVALUATE_OUTPUT_TOKENS_ESTIMATE`
  (was a hardcoded, never-measured 150→now 1600, after evaluate's real
  output came in at 1,493 — a 9.95x miss, the worst single ratio in the
  job). Replaying the recalibrated formula against `2026-07-05_011` brings
  costRatio from 1.47x down to **~0.92x** — now slightly conservative
  (over-, not under-, estimating) instead of undercounting. All three
  corrections are single-run calibrations (n=1); revisit if a future run's
  ratios drift from ~1.0x. Revision constants are untouched — this run made
  no revision calls, so there's no evidence to recalibrate them from.

Not yet shipped: schema trimming (§3.3), turn-narration brevity (§3.4),
and everything in §4/experimental.
