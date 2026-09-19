# GhostBid Production-Safety Audit — 2026-09-12

Scope: `https://victorylabs.app/tools/ghostbid`. Read-only adversarial audit.
No code changed, no commit, no deploy, no PM2 restart, no signing, no
broadcast, no real bid/cancel/fill. All RPC calls made during this audit
were reads (`getAccountInfo`) against public/derived accounts.

## 1. Repository / branch / HEAD / production parity

- Repo: `/root/nft-live-feed` (origin `github.com/MrNeyZ/nft-live-feed`, plus
  a `vps` remote over SSH).
- Branch: `rollback-aug3`. HEAD: `c9763600352ecf093a9028636643777ea7e99862`
  ("Fix ART/Gravemint mint misclassification + ME link on ART rows",
  2026-09-12 12:28:37 +0000).
- Working tree is dirty (18 modified files, ~30 untracked scratch
  files/HARs). **None of the modified files touch GhostBid's runtime
  logic.** The two dirty files that mention `ghostbid` at all:
  - `src/server/app.ts` — diff only adds an unrelated new import
    (`createResizeClaimRouter`); the `createGhostBidRouter` line is
    untouched context.
  - `frontend/src/soloist/shared.tsx` — diff only appends
    `/tools/resize-claim` to the route-prefetch array; `/tools/ghostbid`'s
    entry is untouched context.
  Verified via `git diff <file> | grep -i ghostbid`. No dirty file was
  read, edited, or touched during this audit.
- Production parity: `nft-backend` (PM2, `online`, running
  `/root/nft-live-feed/dist/index.js`) is the process serving this route.
  `dist/server/tools-ghostbid.js` mtime (2026-09-12 ~20:32 UTC, epoch
  1789216352) is **newer** than `src/server/tools-ghostbid.ts` (epoch
  1788989188, i.e. 2026-09-10), and `src/server/tools-ghostbid.ts` is
  clean (not in the dirty-file list) — so the running dist was built from
  the currently-checked-out committed source. A token-level diff of
  string literals between source and dist shows only compiler-comment
  stripping (`'LISTED_SOLANART_STUCK'` appears solely inside a JSDoc
  comment in source, never in executable code) — **no behavioral
  divergence found**. Production parity: **established**, not merely
  assumed.
- `rollback-aug3` is a local branch; not verified against what
  `origin/main` or the `vps` remote currently hosts (out of scope — the
  running process on this box is what matters for a production-safety
  audit of the live tool, and that was verified directly).

## 2. Architecture map

```
Browser (frontend/src/app/tools/ghostbid/page.tsx, 'use client')
  │  fetch GET  /api/tools/ghostbid?list=N        (Bearer token, authHeaders())
  │  fetch POST /api/tools/ghostbid/refresh?list=N
  │  fetch GET  /api/tools/ghostbid/escrow-check?buyer=X
  ▼
Express router (src/server/tools-ghostbid.ts, mounted in src/server/app.ts)
  │  requireAuth (src/server/runtime.ts) — shared-secret HMAC bearer token
  │  rateLimit (src/server/rate-limit.ts) — per-IP fixed window
  ▼
Static JSON snapshots (data/ghostbid.json, data/ghostbid-list[2-8].json)
  — 8 hand-built offline datasets, last touched 2026-09-01, not in git.
  │
  ├─ ME rows  → src/server/me-bid-escrow.ts → Helius getMultipleAccounts
  │             (M2 program escrow PDA balance, shared across a buyer's
  │             every ME offer)
  ├─ Solanart rows → local getMultipleAccounts on each offer's own PDA
  └─ owner activity → getSignaturesForAddress + getTransaction (Helius)
```

- Solana SDK: `@solana/web3.js` (`PublicKey`, `findProgramAddressSync`)
  only — no `@solana/wallet-adapter-*`, no transaction/instruction
  builders, no `Connection.sendTransaction`/`simulateTransaction`
  anywhere in this tool's code path.
- Protocols touched (read-only): Magic Eden v2 (M2 program
  `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K`), Solanart (offer-account
  PDAs, program not re-derived — addresses come pre-resolved from the
  static dataset).
- RPC provider: Helius (`HELIUS_API_KEY` env var), fallback to public
  `api.mainnet-beta.solana.com` if unset. No third-party marketplace API
  is called for price/target data at request time except ME's
  `escrow_balance` semantics, which are replicated on-chain (not called
  as a REST endpoint — see `me-bid-escrow.ts` header comment: this
  deliberately replaced an earlier version that hit ME's own
  `/wallets/{buyer}/escrow_balance` REST endpoint, due to a 34% failure
  rate).
- Auth boundary: `requireAuth` — single-operator shared-secret HMAC
  bearer token (12h TTL, `timingSafeEqual` comparison), same mechanism
  gating every other `/tools/*` route in this app. Not wallet-bound (no
  Solana wallet signature is ever checked) — consistent with this being
  a single-operator internal tool (`UI_ALLOWED_WALLETS` gates the whole
  app at the Gate/login layer, not per-route).
- PM2: `nft-backend` (3001, serves `/api/tools/ghostbid*`), `nft-frontend`
  (3000, serves the page). Both `online`.
- Deployment paths: nginx routes `/api/` → 3001, `/` → 3000 (per
  `CLAUDE.md`, not re-verified by re-reading nginx config in this audit —
  no ghostbid-specific nginx behavior exists to check).

## 3. Supported action/protocol matrix

GhostBid supports exactly **one action: read-only display and
recomputation of a static bid list.** There is no bid creation,
modification, cancellation, acceptance, escrow deposit/withdrawal, or any
transaction/order construction of any kind, for any protocol.

| Capability asked about in spec | Present? | Evidence |
|---|---|---|
| Collection / token / trait / pool offers (creation) | No | no builder code exists |
| Bid creation / modification / cancellation / acceptance | No | no builder, no signer, no `sendTransaction` |
| Escrow deposit / withdrawal | No | escrow is only ever *read* (`getMultipleAccounts`) |
| Marketplace-specific bid formats | Display-only | ME + Solanart rows are pre-classified in the static JSON, not derived from a live format decode |
| ME / Tensor / Solanart / MMM / M2 interaction | Read-only | M2 escrow PDA balance reads (ME), self-funded PDA balance reads (Solanart) |
| Legacy marketplace programs | Solanart only, read-only | offer-account PDA is opaque data supplied by the static dataset, not derived by this code |
| Off-chain signed orders | No | none |
| On-chain escrow | Read-only | see above |
| Direct SOL transfer | No | never constructed |
| SPL / Token-2022 flows | No | all amounts are SOL/lamports only |

Three endpoints total: `GET /tools/ghostbid`, `POST
/tools/ghostbid/refresh`, `GET /tools/ghostbid/escrow-check`. Each is a
plain data read/recompute; none touches the frontend wallet adapter, and
the frontend page imports no wallet library at all.

**This collapses the majority of the requested audit sections (3, 4, 6,
7, 9, 11, 12, 13, 14, 15, 16, 17, 21, 22, 23) to NOT APPLICABLE by direct
code evidence, not by assumption** — see §37 for the explicit
present/partial/absent/N-A table. The remaining sections (2, 5 partial,
10, 18, 19, 20, 24, 25, 26, 27, 28, 29, 30, 31) are answered below against
GhostBid's actual (much narrower) risk surface: **display correctness of
a profit ranking that a human may act on manually, elsewhere, using data
this tool shows them.**

## 4. State machine (per the two mutating-ish actions: Load, Refresh)

Both `GET /tools/ghostbid` and `POST /tools/ghostbid/refresh` are
idempotent reads from GhostBid's own perspective (they mutate only an
in-process display cache, never on-chain or marketplace state). The
state machine that matters is the frontend request lifecycle:

`idle → loading (busy/refreshing=true) → { success: rows painted, error:
message painted } → idle`

There is no `signing`, `submitted`, `confirmed`, or `unknown-outcome`
state because nothing is ever signed or broadcast. The one real defect in
this state machine is a **stale-response race**, detailed as Finding
GB-1 below: switching `activeList` (or double-firing Refresh) does not
cancel or fence the in-flight request, so an older list's response can
overwrite a newer list's already-painted rows.

## 5. Trust boundary

Case **A only** in the spec's taxonomy (frontend/backend both read-only;
no transaction bytes of any kind ever exist). There is nothing for
Phantom to review or sign — no wallet connect call exists on this page.
Sections 3/4/6/7/9/11/12/13/16/17 of the spec (all premised on a
transaction or signed order existing) are **NOT APPLICABLE**, confirmed
by: (a) no `@solana/wallet-adapter*` import in `page.tsx` or any GhostBid
backend file, (b) no `Transaction`/`VersionedTransaction`/`Keypair`
construction anywhere in `tools-ghostbid.ts` or `me-bid-escrow.ts`, (c)
the file's own header comment states this explicitly and the code matches
the comment.

## 6. Frozen-intent analysis

Not applicable in the classical sense (no authorization is ever
requested from a wallet). The only "intent" a user forms here is *which
list to view* (`activeList`) and *when to trust the profit number*. See
Finding GB-1 (list-switch race) and GB-2 (frozen floor price) — both are
about the displayed number silently drifting from what the user thinks
they're looking at, not about any signed authorization.

## 7. Instruction/program/account matrix

Not applicable — no instructions are ever built. The only "account" work
GhostBid does is **read** two kinds of accounts:

| Row type | Account read | Derivation | Verified? |
|---|---|---|---|
| ME | Buyer's M2 escrow PDA | `findProgramAddressSync(['m2', auctionHouse, buyer], M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K)` | **Yes — live mainnet cross-check performed (§26/32)** |
| Solanart | `offerAccount` (pre-resolved in static dataset) | Not derived by this code; taken as-is from the JSON | Not independently re-derivable from GhostBid's own code (the Solanart program/seed scheme lives in whatever offline script built the dataset, not in this repo's live path) |

## 8. Monetary-authorization matrix

Not applicable — GhostBid authorizes nothing. It *computes and displays*
a number (`profitSol`) that a human may use to decide whether to go
manually place/accept a bid on Magic Eden or Solanart's own UI. The
correctness of that displayed number is audited in §16 below as the
closest analog to "monetary authorization" this tool has.

## 9. Bid/order target identity

N/A — no order is placed by this tool. Target-identity risk is limited to
"is the row I'm looking at actually about the mint/owner it claims,"
which is a data-integrity property of the static JSON, not something
GhostBid's live code computes (see data validation checks in §16).

## 10. Escrow model and safety

GhostBid **never writes to escrow** — it only reads balances to display
"is this bid still fundable." Two escrow models are read:

- **ME v2 (per-buyer, shared across ALL of that buyer's offers).**
  `me-bid-escrow.ts`'s PDA derivation was independently verified in this
  audit (see §26) against live mainnet state — the derived escrow account
  for a real buyer in `data/ghostbid.json` (`2uYad2a2gYWR3HnPWfMpcQgcA9vgyi7Xw3KFaGJm3eYK`)
  holds exactly 250,000,000,000 lamports (250.000000000 SOL), matching
  that row's `bidSol: 250` field exactly, and the account is System
  Program-owned with zero data — exactly as the module's own doc comment
  describes ("system-owned for SOL purposes"). This is real, on-chain,
  independently-reproduced confirmation that the escrow-PDA logic shared
  by GhostBid/`tools-me-bids.ts`/`tools-me-sell.ts`/`tools-retardio-offers.ts`
  is byte-correct, not merely "looks plausible."
- **Solanart (self-funded per-offer).** The `offerAccount` PDA is taken
  as an opaque address from the static dataset and its balance is read
  via one batched `getMultipleAccounts` call — correct as far as GhostBid
  is concerned, since it never derives the address itself.

`toGhostRows()`'s clamp `liveBidSol = min(bidSol, liveEscrowBalance)` and
its `drained` flag are the correct model for "shared escrow, first
accepter wins, everyone else's row silently goes to zero" — confirmed by
reading `computeSharedGroups()`, which correctly groups only ME rows by
buyer (Solanart rows are self-funded per-offer, so no cross-row draining
applies there, and the code correctly excludes them from grouping).

No withdrawal path exists in this tool at all, so §9's "withdrawal
recipient exact" concern is N/A.

## 11. Blockhash lifecycle / 12. Simulation-preflight / 13. Confirmation
semantics / 14. Retry/duplicate-action / 15. Cancellation safety / 16.
Accept/fill safety (spec numbering)

All **NOT APPLICABLE**. No blockhash is ever fetched, no transaction is
ever simulated, signed, or broadcast, so there is no "confirmed / unknown
/ expired" state to reconcile, no retry-after-unknown-outcome hazard, and
no cancel or accept/fill flow exists in this tool. (GhostBid is a finder
tool — the actual accept/cancel action, if the operator chooses to act on
a row, happens entirely off-tool in Magic Eden's or Solanart's own UI,
outside this audit's scope.)

## 12. Monetary correctness (the real analog — spec §6/§10)

`toGhostRows()` (`tools-ghostbid.ts:133-181`) computes:

```
net = liveBidSol * (1 - royaltyBp/10000 - feeBp/10000)
profitSol = round(net - floorSol, 1e-6)
```

Checked across all 704 rows in the 8 static datasets:
- `royaltyBp + feeBp < 10000` for every row (no negative-multiplier
  underflow possible) — verified by script, 0 violations.
- `bidSol > 0` for every row — verified, 0 violations.
- All arithmetic is plain JS `number` (float) on values already in SOL
  (not raw lamports), rounded to 1e-6 with `Math.round(x * 1e6) / 1e6`.
  Because these are display-only numbers (never fed into a lamport
  transfer amount), IEEE-754 float error here has no reachable
  consequence — there is no `.01 SOL → 10_000_000 lamports` conversion
  anywhere in this tool to get wrong (§10 of the spec assumes a
  transaction-construction step that doesn't exist here).
- **Finding GB-2 (below): `floorSol` is frozen at whatever the offline
  dataset recorded on 2026-09-01 and is never revalidated by "Refresh."**
  One row (`7WFK4dH6MuZPj5BCgrvyibGEtEkGcVj1WYfsLN38gajy`, "Shadowy Super
  Coder #9984") shows a bid/floor ratio of 10,000× (190 SOL bid vs. 0.019
  SOL recorded floor) — almost certainly a stale/bad floor snapshot for a
  collection that has never traded near 0.019 SOL. This row is correctly
  visually de-emphasized because its `listingStatus` is
  `STUCK_OTHER:...` (owner resolved to a program-owned vault, not a real
  wallet) — an existing mitigation that happens to catch this particular
  bad row, but not because the code detected the bad floor; it's
  coincidental.

## 13. Concurrency / race conditions

**Finding GB-1 (PROVEN BUG).** `frontend/src/app/tools/ghostbid/page.tsx`,
`load()` (lines 284-295) and `refresh()` (lines 297-308):

```ts
const load = useCallback(() => {
  ...
  fetch(`${API_BASE}/api/tools/ghostbid?list=${activeList}`, ...)
    .then(r => r.json())
    .then((data) => { if (!data.ok) {...} setResult(data); })
    ...
}, [activeList]);
```

Neither callback checks, on resolution, whether `activeList` is still
the list the request was made for, and neither uses an `AbortController`
to cancel a superseded request. `ApiResult` even carries a `list` field
(`res.json({ ok: true, list, ... })` in the backend) that would make this
check trivial, but the frontend never reads it back for comparison.

**Concrete failure scenario:** operator is on List 1 (slow response,
e.g. mid-refresh with ~90 sequential `getSignaturesForAddress` calls in
flight), clicks List 2 in the dropdown before List 1's request resolves.
List 2's (faster, cache-hit) response paints first; List 1's response
then arrives and overwrites `result` wholesale via `setResult(data)` —
the table now silently shows List 1's rows while the "List 2" button
still shows selected/highlighted. The same race exists for two rapid
`Refresh` clicks on the same list (the disabled-while-`refreshing`
button reduces but does not eliminate this — a click right at the
boundary of the state update, or a second tab, can still overlap two
in-flight refreshes whose responses can land out of order).

**Consequence class:** correctness/trust, not fund-loss — the operator
could act (elsewhere, manually) on a row believing it's from a
different, currently-selected list than the one actually displayed.
Given GhostBid's stated purpose (rank real forgotten bids for manual
outreach/action), a target-mismatch here has a plausible but narrow
practical impact: acting on a stale-but-still-real row from the wrong
list is not itself fund-unsafe (nothing is authorized by this tool), but
it undermines the "which list am I looking at" invariant the UI implies.
**Severity: MEDIUM** (real, but requires a user-timing condition and is
self-correcting on the next successful load/refresh).

**Why existing protections don't contain it:** the `refreshing`/`busy`
booleans gate the *button*, not the *request*; they don't fence which
response is allowed to win. `autoRefreshedListRef` (the once-per-list
auto-refresh gate, lines 322-330) is unrelated and does not help here.

**Smallest safe fix:** capture `activeList` in the closure at fetch time
and compare against the `list` field of the resolved response (or
current `activeList` via a ref) before calling `setResult`/`setError`;
discard the response if it no longer matches. No backend change needed.

**Existing test coverage:** none — there is no test file for
`frontend/src/app/tools/ghostbid/page.tsx` or `tools-ghostbid.ts` (see
§20 below).

No other concurrency hazard was found: double-clicking the Escrow-check
tooltip is deliberately cached/cheap (§ design comment,
`escrowHoverCache`, 20s TTL) and idempotent; there is no create/cancel
race to analyze since neither action exists.

## 14. Timeout / RPC-cost analysis

- `findLastSignedActivity` (owner activity scan) is **sequential per
  owner**: up to `OWNER_ACTIVITY_SIG_WINDOW = 8` signature lookups, each
  gated by its own 8s (`OWNER_ACTIVITY_TIMEOUT_MS`) timeout, run against
  `getSignaturesForAddress` then `getTransaction` per candidate signature
  until a real signer match is found. Fan-out is bounded to
  `OWNER_ACTIVITY_CONCURRENCY = 8` concurrent workers pulling from a
  shared queue (`fetchOwnerLastActiveAt`). For a ~95-row list with ~90
  unique owners, worst case (every owner needs all 8 signature checks and
  every RPC call times out) is `ceil(90/8) * 8 * 8s ≈ 720s` of backend
  time for a single `/refresh` call. This is bounded (not unbounded — the
  spec explicitly says not to call a client timeout an unproven backend
  max; this one **is** a real backend-side bound, since every fetch has
  an explicit `AbortSignal.timeout`), but it is a real worst-case latency
  the frontend's `refresh()` call has no client-side timeout for at all
  (a plain `fetch` with no `AbortSignal` on the frontend side) — if the
  backend genuinely takes 10+ minutes, the browser will simply wait.
  **Severity: LOW** (self-inflicted operational slowness behind an
  authenticated, rate-limited, single-operator endpoint — not an
  externally triggerable resource-exhaustion vector, since
  `requireAuth` gates it and `refreshLimit` caps it at 4/min/IP).
- `resolveEscrowBalances` (ME) and `fetchSolanartEscrowBalances` batch
  correctly (single `getMultipleAccounts` call per ≤100 keys), so ME/
  Solanart balance checks are cheap and bounded regardless of list size.
- `escrow-check` (hover tooltip) is a single-buyer lookup, capped at
  60/min/IP, and client-side de-duplicated via a 20s TTL cache — no
  amplification risk from repeated hovering.

## 15. UI truthfulness

- The "Refresh" button's own label change ("Checking escrows…") and the
  code comment above `refresh()` both accurately describe what it does
  (re-check escrow funding + owner activity) — it does **not** claim to
  refresh floor prices, so there's no outright false label. However nowhere
  in the UI is it disclosed that `floorSol` — half of the primary
  `PROFIT` number — is a static, un-refreshable snapshot from
  2026-09-01. An operator who clicks "Refresh" and sees the profit number
  update (because `liveBidSol` moved) has no way to know the *floor* side
  of that same number never moved and may be many days stale. This is
  Finding **GB-2**.

  - **Severity: LOW-MEDIUM.** No fund-loss path (nothing is authorized by
    this tool), but it is a genuine "the number you're trusting is
    partially frozen and the UI doesn't say so" issue, and the one
    concrete data point checked in this audit (Shadowy Super Coder
    #9984) shows the staleness can be extreme (10,000×) for at least one
    row, though that row happens to already be flagged `stuck`/red for
    an unrelated reason.
  - **PROVEN, via code+data inspection:** `floorSol` only ever comes from
    `BaseRow` (the static JSON); grep of `tools-ghostbid.ts` confirms no
    code path ever assigns to it besides `loadBase()`'s `JSON.parse`.
  - **Smallest safe fix:** either (a) add a visible "floor data as of
    <dataset date>" caption near the PROFIT column header, or (b) have
    `/refresh` also pull each row's current floor (e.g. from an
    already-used internal floor cache/source, if one is cheaply
    available elsewhere in this codebase) and only clamp/flag rows whose
    live floor diverges materially from the snapshot. (a) is the
    "smallest" fix; (b) is the more correct one but is a scope decision,
    not something to guess at here.
- "PROFIT" cell coloring (gold if >0, red if ≤0, gray if null) is
  consistent with the underlying `profitSol` value — no mismatch found.
- `drained` badge (▼) correctly reflects `liveBidSol < bidSol` — verified
  against the `toGhostRows` logic.
- Stuck-row red wash + tooltip (`stuckReason`) accurately reflects
  `listingStatus` per the documented semantics in both frontend and
  backend comments — consistent.
- No "Success" claimed before any async operation completes (there is no
  transaction, so this class of falsehood is structurally impossible
  here); errors are shown verbatim from `data.error` (see §17, minor
  info-exposure note).

## 16. Recovery after reload/navigation

N/A in the fund-safety sense (no in-flight fund-moving operation ever
exists to lose track of). Reloading simply refetches List 1's cached
snapshot from scratch, which is the correct/expected behavior for a
pure display tool. No persistence gap has any concrete consequence here.

## 17. Backend/API abuse boundary

Three endpoints, all behind `requireAuth` (shared-secret HMAC bearer,
12h TTL) + per-endpoint rate limits (30/min read, 4/min refresh, 60/min
escrow-check, keyed by `clientIp()` which correctly prefers
`CF-Connecting-IP` per the documented Cloudflare-only-ingress topology).

- `list` query param: validated against a fixed `DATA_LIST_IDS` enum
  (`isListId`) — rejects anything else with 400. No path traversal risk
  even though `dataPathForList` does string interpolation into a file
  path, because the input is constrained to the numeric enum before it
  ever reaches that function — **verified safe by construction**, not
  merely "looks fine."
- `buyer` query param (`/escrow-check`): validated via `new PublicKey(buyer)`
  try/catch — rejects malformed input with 400 before any RPC call.
- No endpoint accepts arbitrary transaction bytes, RPC methods, or
  program IDs from the client — the only RPC surface is server-selected
  (`rpcUrl()`, env-configured Helius key, never client-influenced).
- No secrets are returned to the client: responses are rows + counts
  only. `String(err)` is returned verbatim on the 500 path
  (`res.status(500).json({ ok: false, error: String(err) })`) in all
  three handlers — for a Node `Error`, `String(err)` yields `"Error:
  <message>"` with no stack trace, so this is a minor info-exposure
  concern at most (could theoretically leak an internal file path or
  RPC error string to an *already-authenticated* caller) — **Severity:
  LOW**, since it requires the caller to already hold a valid auth token,
  and it's read-only, single-operator scope. Not the pattern to flag as
  a real vulnerability; noting only for completeness per spec §30.
- No caller-controlled backend cost blow-up beyond the bounded worst
  case already analyzed in §14.

## 18. Third-party API trust

GhostBid at request time trusts exactly one external input class: Helius
RPC responses (`getMultipleAccounts`, `getSignaturesForAddress`,
`getTransaction`). None of these can influence a price, target,
recipient, or transaction, because none of those things are ever
constructed here — they only influence **displayed numbers**
(`liveBidSol`, `lastActiveAt`). A malicious/compromised RPC response
could at most make GhostBid **display** a wrong balance or wrong
activity timestamp for a row — it cannot cause GhostBid to move funds,
because GhostBid never moves funds. (Contrast explicitly with Candy
Mint/Burner, where a compromised RPC response feeding a transaction
builder would be a live trust-boundary issue — that class of risk is
structurally absent here.)

No REST call is made to Magic Eden's or Solanart's own APIs at request
time (deliberately removed for ME, per the file's own header comment,
due to reliability problems) — the marketplace-hosted price/state that
*is* trusted is whatever the offline dataset baked in on 2026-09-01
(§ Finding GB-2).

## 19. Existing tests

No test file exists for any part of GhostBid: no
`tools-ghostbid.test.ts`, no `me-bid-escrow.test.ts`, and no frontend
test for `page.tsx`. Confirmed via `find`/`grep` across the repo. The
pure, easily-unit-testable `toGhostRows()` function (profit math, drain
detection, shared-group computation, sort) has zero regression coverage
despite being the one place a silent arithmetic regression would
directly mislead an operator's manual trading decision.

**Missing regression tests (recommended, not applied):**
1. `toGhostRows()`: royalty+fee formula, `drained` flag threshold
   (`1e-6` epsilon), post-live-check profit≤0 row-dropping, shared-group
   computation excluding Solanart.
2. `deriveBuyerEscrowPda` — a fixed-vector test pinning the exact PDA for
   a known (auctionHouse, buyer) pair (this audit independently produced
   one real, live-verified vector — see §12/§26 — that would make an
   excellent fixture).
3. Frontend list-switch race (Finding GB-1) — a test asserting that a
   response for a stale `list` is discarded once `activeList` has since
   changed.

## 20. Real-builder / historical verification evidence

Performed one concrete, non-destructive, on-chain verification:

1. Took a real row from the live dataset (`data/ghostbid.json`): mint
   `3VZ5tYgwFawGvNDNP8wPRgzYhKtScqFfFG8K6NQoQFts` ("Okay Bear #2226"),
   buyer `2uYad2a2gYWR3HnPWfMpcQgcA9vgyi7Xw3KFaGJm3eYK`, `bidSol: 250`.
2. Independently derived the M2 escrow PDA using the exact seeds/program
   documented in `me-bid-escrow.ts` (`['m2', auctionHouse, buyer]` under
   `M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K`) via a standalone
   `@solana/web3.js` call, independent of GhostBid's own runtime code.
   Result: `CESRjCq2WuWMrFAyjfDg6HMQk7hNmwFD3uvZVZ6jcV5y`.
3. Called `getAccountInfo` (read-only, mainnet, via the same Helius
   endpoint the backend uses) against that PDA. Result: `lamports:
   250000000000` (exactly 250.000000000 SOL), `owner:
   11111111111111111111111111111111` (System Program), `space: 0` — an
   exact match to the dataset's `bidSol: 250` and to the module's own
   documented account model (system-owned, no account data).

This is real evidence, not inference: the shared escrow-balance
mechanism used by GhostBid (and by `tools-me-bids.ts`,
`tools-me-sell.ts`, `tools-retardio-offers.ts` via the same module) is
**byte-correct against live mainnet state**, independently reproduced in
this audit.

Solanart's offer-account derivation could not be independently
re-derived the same way, because GhostBid's code never derives it — the
address is opaque input from the offline dataset. This is stated
explicitly as an **audit limitation**, not glossed over: this audit can
confirm GhostBid reads whatever `offerAccount` the dataset gives it
correctly (the batched `getMultipleAccounts` call is straightforward),
but cannot independently prove the offline dataset's Solanart PDA
addresses are themselves correct, since that derivation lives outside
this repo's live code path.

## 21. Cross-tool/shared-code impact map

`src/server/me-bid-escrow.ts` is shared by **four** tools:
`tools-ghostbid.ts`, `tools-me-bids.ts`, `tools-me-sell.ts`,
`tools-retardio-offers.ts`. Two module-level caches
(`balanceCache`/`balanceMissCache`, 60s/15s TTL) are **shared across all
four callers' requests** — a balance fetched by, e.g., `/tools/me-sell`
populates the same cache GhostBid reads. This is a correct and
deliberate optimization (comment explains it plainly), not a bug, but it
means: **any future fix to this module's TTL, error handling, or PDA
derivation affects all four tools simultaneously** — flagged per the
spec's requirement to name blast radius for future fixes, not to
recommend one now.

`rpcUrl()` in `tools-ghostbid.ts` itself (not `me-bid-escrow.ts`) points
at `mainnet.helius-rpc.com`, while `me-bid-escrow.ts` and the vast
majority (~50+) of other files in this codebase use
`beta.helius-rpc.com`. Both are live, working Helius endpoints requiring
the same API key (confirmed: the `mainnet.` variant was used
successfully for the live verification in §20). This is a **cosmetic
inconsistency, not a bug** — noted only because the spec asks for
exact-endpoint tracing; no consequence was found or is expected (both
subdomains are documented-equivalent Helius mainnet RPC front doors used
interchangeably elsewhere in this same codebase, e.g.
`tools-cnft-revoke-delegate.ts`, `tools-me-sell.ts` lines 223/246 use
`mainnet.` too).

## 22. Ranked findings

| # | Severity | Summary |
|---|---|---|
| GB-1 | **MEDIUM** | Frontend list/refresh fetches have no stale-response guard — switching lists or double-refreshing can let an older response overwrite a newer one, silently showing the wrong list's rows under the currently-selected list button. `frontend/src/app/tools/ghostbid/page.tsx:284-308`. **PROVEN BUG** (via static code reading; not reproduced in a live browser — no browser tool available this session, see limitations). |
| GB-2 | **LOW-MEDIUM** | `floorSol`, half of the primary "PROFIT" metric, is frozen at the 2026-09-01 static-dataset snapshot and is never revalidated by "Refresh" (which only re-checks escrow balance + owner activity) — with no UI disclosure of this. Confirmed one row with a 10,000× bid/floor ratio consistent with stale/bad floor data. `src/server/tools-ghostbid.ts:133-181` (never assigns `floorSol`), `frontend/.../page.tsx` (no staleness caption). **PROVEN** (data) / **HARDENING OPPORTUNITY** (fix). |
| GB-3 | LOW | `/tools/ghostbid/refresh`'s worst-case backend latency (~12 min, bounded but slow) has no client-side fetch timeout on the frontend — the browser will simply wait indefinitely if the backend is that slow. Behind auth + 4/min rate limit, so not an abuse vector, only an operator UX rough edge. `tools-ghostbid.ts:338-358` (backend), `page.tsx:297-308` (frontend fetch, no `AbortSignal`). HARDENING OPPORTUNITY. |
| GB-4 | LOW | Zero regression tests for `toGhostRows()` (the one place a silent profit-math regression would mislead a manual trading decision) or for `deriveBuyerEscrowPda`. HARDENING OPPORTUNITY / test-coverage gap. |
| GB-5 | LOW | 500-path handlers return `String(err)` verbatim to an authenticated caller (no stack trace, but could leak an internal error string). `tools-ghostbid.ts:378,423,448`. Not a real vulnerability given the auth gate; noted for completeness. |
| — | INFO | `rpcUrl()` in this file uses `mainnet.helius-rpc.com` while the shared `me-bid-escrow.ts` and most of the codebase use `beta.helius-rpc.com`. Both work; cosmetic only, not a finding requiring action. |

No CRITICAL or HIGH findings. This reflects GhostBid's actual design,
independently confirmed: it is a read-only research/ranking display with
no wallet connection, no transaction construction, and no signing or
broadcast surface anywhere in its code path — the entire class of risk
the spec is built around (trust-boundary tampering between backend/
third-party transaction bytes and what Phantom signs) is structurally
absent, not merely well-defended.

## 23. Proven bugs vs. hypotheses

- **Proven (code-level, deterministic):** GB-1 (no stale-response guard —
  the missing check is directly visible in the source; the failure mode
  follows necessarily from ordinary async timing and requires no
  speculation), GB-2 (floor is provably never reassigned after
  `loadBase()`), GB-5 (verbatim error string is directly visible).
- **Proven (on-chain, empirically reproduced this session):** the M2
  escrow PDA derivation and balance semantics (§20) — this is a positive
  finding (correctness confirmed), included because the spec explicitly
  asks for real-builder verification evidence either way.
- **Hypothesis/inference:** the 10,000× bid/floor row being *caused* by
  stale/bad floor data (as opposed to some other explanation) is a
  reasonable but not 100%-certain inference — this audit did not
  independently re-fetch Shadowy Super Coder's real current floor price
  from a floor-price source to triple-confirm 0.019 SOL is wrong (would
  require adding a new external call outside this audit's scope); the
  inference is strong (SSC is a well-known collection that has not
  traded near 0.019 SOL in its history) but is flagged as inference, not
  proof.
- GB-1's real-browser reproduction is **not proven empirically** this
  session — no browser automation tool was available (see §24). The bug
  is proven at the code level (the guard is absent, and absent-guard +
  async-race is a deterministic consequence, not a probabilistic one),
  but "does it visibly happen in a real browser" was not click-tested.

## 24. Existing mitigations that MUST NOT be weakened

- `requireAuth` + per-endpoint rate limits on all three routes — keep as
  is.
- `isListId`/`PublicKey` validation gating both query params before any
  file-path interpolation or RPC call — keep as is; this is what makes
  `dataPathForList`'s string interpolation safe.
- The live-check "drop unprofitable-once-clamped rows" behavior
  (`kept = liveBalances ? priced.filter(...) : priced`) — correct
  behavior, don't change to "clamp but keep" without deliberate product
  decision.
- The stuck-listing red-wash / non-actionable flagging — an effective
  (if partly coincidental, per GB-2) safety net that already visually
  suppresses at least one bad-data row; don't remove without addressing
  GB-2 first.
- `clientIp()`'s `CF-Connecting-IP`-first precedence — matches the
  documented Cloudflare-only-ingress topology; don't reorder without
  re-verifying that topology still holds.

## 25. Minimal safe fixes (for proven findings only)

- **GB-1:** in both `load()` and `refresh()`, capture the list the
  request was made for and compare it (or compare `data.list` from the
  response, which the backend already sends) against the current
  `activeList` before calling `setResult`; no-op if they no longer match.
  No backend change required. Roughly a 4-6 line diff per function.
- **GB-2:** smallest fix is a UI-only caption near the PROFIT column
  header showing the dataset's snapshot date (already knowable — the
  file mtimes are fixed at build time; could be baked into the JSON
  itself as a `snapshotAt` field read once). Does not require touching
  the refresh logic.
- **GB-5:** replace `String(err)` with a fixed generic message in the
  JSON response (keep the detailed error in `console.error` server-side
  only) — a one-line change per handler, 3 occurrences.
- GB-3 and GB-4 are hardening/test-coverage items, not defects requiring
  a "fix" — see §22 for what each would look like.

## 26. Audit limitations

- **No browser tool was available this session** — GB-1 (the async race)
  is proven by static code reading, not by clicking through a live
  browser and observing the mis-painted table. Per this project's own
  stated verification-discipline rule (HTTP/bundle/pm2 checks are not
  visual verification), this finding should be treated as high-confidence
  but not visually confirmed.
- Solanart's `offerAccount` PDA derivation could not be independently
  re-derived from this repo's code (see §20) — this audit can only
  confirm GhostBid reads whatever address the dataset supplies correctly,
  not that the dataset's Solanart addresses are themselves correct.
- The `origin`/`vps` remotes were not diffed against `rollback-aug3` —
  parity was established against the actually-running PM2 process on
  this box (the thing that matters for a live production-safety audit),
  not against any particular git remote's HEAD.
- The "stale floor" inference (GB-2's concrete example) was not
  triple-confirmed against a live third-party floor-price source, per
  scope (adding a new external call to verify a data-quality question
  about an already out-of-scope offline dataset was judged not worth the
  added RPC/API surface for this audit).

## 27. Recommended implementation order

1. GB-1 (list-switch race) — small, isolated, frontend-only, no
   cross-tool blast radius.
2. GB-5 (verbatim error strings) — trivial, isolated.
3. GB-2 (floor staleness disclosure) — UI-only caption is small; a real
   live-floor revalidation is a larger, separate product decision (not
   recommended to bundle with the caption fix).
4. GB-4 (regression tests) — write once GB-1/GB-2's fixes land, so the
   new tests cover the fixed behavior rather than needing a rewrite.
5. GB-3 (client fetch timeout on refresh) — lowest priority; genuinely
   cosmetic given the auth+rate-limit gate already bounds abuse.

## 28. Final verdict

**HARDENING RECOMMENDED.**

GhostBid is a read-only research/ranking tool with no wallet connection,
no transaction construction, and no signing or broadcast surface — the
entire class of money-safety risk this audit's methodology is built
around (trust-boundary tampering, frozen-intent violation, stale-signed-
tx replay, double-spend-via-retry, wrong-target cancellation/acceptance)
is **structurally absent by design**, independently confirmed by code
reading and one live on-chain verification, not merely asserted. The
findings that do exist (GB-1 stale-response race, GB-2 undisclosed
frozen floor price) are real correctness/trust issues worth fixing, but
neither has a fund-loss path, because this tool never authorizes
anything — it only helps a human decide where to look next.

## 29. Comparison against general safety properties (spec §37)

| Property | Status | Basis |
|---|---|---|
| Frozen reviewed intent | N/A | no authorization is ever requested from a wallet |
| Exact final authorization | N/A | nothing is ever authorized |
| Structural validation of backend/3rd-party tx bytes | N/A | no tx bytes ever exist |
| Final-byte simulation | N/A | nothing is ever simulated/signed |
| Wallet identity immediately before signing | N/A | no signing occurs |
| Fresh blockhash lifecycle | N/A | no blockhash is ever fetched |
| Exact-signature confirmation | N/A | no signature is ever produced |
| Unknown ≠ failure | N/A | no submission outcome ever exists to be unknown |
| Unknown cannot blindly retry | N/A | same |
| Deterministic expiry/reconciliation | N/A | same |
| Idempotent success accounting | PARTIAL | GhostBid's own GET/POST are idempotent recomputation; the frontend response race (GB-1) is the one place "idempotent" breaks down at the display layer |
| Fail-closed unsupported protocol/guard/action | PRESENT | invalid `list`/`buyer` params are rejected with 400 before any file/RPC access |
| Bounded concurrency | PRESENT | `OWNER_ACTIVITY_CONCURRENCY = 8`, chunked `getMultipleAccounts` (≤100/call), rate limits on all 3 routes |
| Truthful UI state | PARTIAL | accurate everywhere checked except GB-2 (floor staleness not disclosed) |

