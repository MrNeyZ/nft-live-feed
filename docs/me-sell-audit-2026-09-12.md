# ME Sell (ME Offer Accept) Production-Safety Audit — 2026-09-12

Scope: `https://victorylabs.app/tools/me-sell`. Read-only adversarial audit.
No code changed, no commit, no PM2 restart, no signing, no broadcast, no
real listing/cancel/reprice/accept/sale. On-chain interaction in this audit
was `getSignaturesForAddress`/`getTransaction` (real historical, read-only)
and public Magic Eden GET APIs (collection activity feeds). No
`simulateTransaction` was run against a real, currently-live offer because
doing so requires a real (mint, buyer, auctionHouse) tuple this audit did
not construct in order to avoid touching real marketplace state.

## 0 / 1. Correcting the premise: ME Sell is NOT a listing tool

**This is the single most important architectural finding, and it
invalidates a large fraction of the audit spec's assumed action set.**
`tools-me-sell.ts`'s own header is unambiguous: *"Magic Eden item-level
offer ACCEPT tool... given an existing personal offer someone else placed
on an NFT we hold... builds+submits the SELL/ExecuteSaleV2 transaction
that accepts it."* This is the seller-side counterpart to a **bid
acceptance**, not a create-listing/cancel-listing/reprice-listing tool.
Confirmed independently by reading the frontend page (`MeSellPage`, titled
"ME Offer Accept" in the UI itself) and every backend route — there is no
`create-listing`, `cancel-listing`, `update-listing`, or bulk-listing
endpoint anywhere in this file or its router. Sections of the spec premised
on those actions (8's "existing listing state" in the create-a-new-listing
sense, 18's cancel/reprice, 19's bulk listing) are **NOT APPLICABLE by
design**, not omissions — marked so explicitly below with the code
evidence, not padded.

The real, narrower, and in some ways *higher-stakes* surface: given a
`(mint, buyer, auctionHouse)` tuple for an offer already placed on an NFT
the operator holds, resolve its price, ensure the buyer's escrow can cover
price+royalty, then build, simulate, sign, and submit a real two-signature
`Sell`+`ExecuteSaleV2` M2 bundle that **sells the operator's real NFT for
real SOL**. That is a genuine live financial transaction with a real NFT
leaving the wallet — this audit treats it with the seriousness the spec
asks for, independent of the "listing" framing being wrong.

## 1 (continued). Repo / branch / HEAD / git status

- Repo `/root/nft-live-feed`, branch `rollback-aug3`, HEAD `5a600a6b6181786be61e00beca14af78f22b169b`
  ("feat(resize-claim): ship hardened claim and resize flow").
- `src/server/tools-me-sell.ts` is **tracked and dirty** (`M`), NOT
  uncommitted-from-scratch like Resize Claim was. `git log --follow` shows
  it was introduced in commit `9b7178b` ("Add ME Offer Accept, CreateV2, ME
  Collection Refresh tools") — a real commit exists to roll back to, unlike
  Resize Claim's pre-hardening state.
- Current dirty diff (`git diff -- src/server/tools-me-sell.ts`, 12
  insertions / 2 deletions): **only** swaps the process-wide
  `meCooldownActive`/`setMeCooldown` gate for a trade-scoped
  `meTradeCooldownActive`/`setMeTradeCooldown` one (imported from the
  untracked `src/server/me-trade-cooldown.ts`) — matches this session's own
  memory note ("me-sell/me-bids cooldown isolation... deployed, not
  pushed"). **No listing/price/signature-safety logic is touched by the
  dirty diff** — read in full, confirmed line-by-line.
- The frontend page (`frontend/src/app/tools/me-sell/page.tsx`) is
  **committed and clean** (not in `git status --short` at all) — matches
  HEAD exactly, same commit `9b7178b`.
- `git diff --cached` for both files: empty (nothing staged).
- Production parity: `nft-backend`/`nft-frontend` PM2 processes are both
  online (not restarted by this audit). Given the dirty diff is a small,
  additive, already-deployed-per-memory change and the committed baseline
  is otherwise intact, **production almost certainly runs this exact dirty
  version** (same shape as the already-confirmed GhostBid/Resize Claim
  pattern in this repo of `npm run build` picking up the full working
  tree) — not independently re-verified via `dist/` byte comparison in this
  audit (stated as a limitation, §42), but the dirty diff itself is narrow
  enough that it does not change this audit's conclusions either way.
- `~18` unrelated pre-existing dirty tracked files and `~50` unrelated
  untracked scratch/HAR files exist repo-wide (confirmed via `git status
  --short`); none were read beyond confirming irrelevance. Three
  untracked scratch files (`scratch-test-me-sell.js`, `-2.js`, `-3.js`)
  exist and were **not opened** — out of this audit's scope per the
  read-only/non-destructive mandate and because the reviewed, tracked
  router file is the actual production surface.

## 2. Architecture map

```
Browser (frontend/src/app/tools/me-sell/page.tsx, 'use client')
  │
  │ GET  /api/tools/me-sell/resolve-offer?mint=&buyer=          (Bearer)
  │ GET  /api/tools/me-sell/order-info?mint=&buyer=&auctionHouseAddress=&priceSol=
  │ GET  /api/tools/me-sell/build-topup?escrowPda=&fromWallet=&lamports=
  │ POST /api/tools/me-sell/build-accept  {seller,tokenMint,priceSol,auctionHouseAddress,buyer,buyerExpiry}
  │ POST /api/tools/me-sell/simulate      {tx}
  │ POST /api/tools/me-sell/submit        {signedTx, digest}
  │ POST /api/tools/me-sell/submit-bridge {signedTx, seller, tokenMint, auctionHouseAddress, buyer}
  │
  │ [ALTERNATE PATH] window.postMessage → a real magiceden.io tab running a
  │   Tampermonkey userscript (frontend/src/lib/mmm-bridge.ts) → makes the
  │   authenticated ME instruction-batch call using the operator's REAL
  │   magiceden.io browser session (their own cookies), not our API key —
  │   routes around ME server-side quirks our own backend hits (see §9).
  ▼
Express router (src/server/tools-me-sell.ts, createMeSellRouter)
  requireAuth (site SIWS + UI_ALLOWED_WALLETS) + per-route rate limits
  │
  ├─ resolve-offer/build-accept → ME public API (api-mainnet.magiceden.dev/v2)
  │    /wallets/{buyer}/offers_made, /instructions/batch
  ├─ order-info → Helius RPC (getBalance on escrow PDA) + Helius DAS
  │    (getAsset, royalty.basis_points) — both read-only
  ├─ build-topup → plain unsigned SystemProgram.transfer (single signer:
  │    the caller's own wallet) — NOT security-sensitive beyond Phantom's
  │    own preview, since it can only ever move the connected wallet's own
  │    funds to the address it itself supplied.
  ├─ simulate → conn.simulateTransaction (real chain, sigVerify effectively
  │    false since tx is unsigned at this point)
  └─ submit / submit-bridge → conn.sendRawTransaction, gated by
       ME_BIDS_ENABLE_LIVE (shared kill switch with tools-me-bids.ts)
```

Solana SDK: `@solana/web3.js` (legacy `Transaction`, not `VersionedTransaction`
— confirmed: `decodeLegacyTxFromBytes`/`decodeLegacyTxFromBase64` both call
`Transaction.from`, and the frontend does `Transaction.from(...)` too — this
whole tool never touches a v0/ALT-compressed transaction). No backend
signer/keypair anywhere — confirmed by reading every line of
`tools-me-sell.ts`; the only "signing"-adjacent server code is
`tx.verifySignatures(true)` (a read-only cryptographic *check*, not a
signing operation) and `chain.sendRawTransaction` (broadcasts bytes the
caller already signed).

## 3. Supported actions / NFT standards

| Action | Supported? | Evidence |
|---|---|---|
| Create a new sell listing (no counterpart offer) | **No** | every code path requires a `buyer` + resolved offer; there is no "list at my own price" endpoint |
| Cancel an existing listing | **No** — N/A | no cancel endpoint/instruction anywhere in this router |
| Reprice an existing listing | **No** — N/A | no reprice endpoint; `newPrice` in the `sell_now` payload is the price the SELLER lists at to MATCH the buyer's existing offer, not a reprice of an unrelated pre-existing listing |
| Accept an existing item-level offer (the actual feature) | **Yes** | the entire file |
| Bulk/batch accept | **No** | every route takes exactly one `(mint, buyer)` pair; no array/loop anywhere |
| Top up buyer's escrow | Yes (helper) | `build-topup`, plain unsigned transfer |
| Legacy NFT (V1_NFT) | Yes | `fetchRoyaltyBp` explicitly branches `interface !== 'ProgrammableNFT' → return 0` — legacy is the assumed default |
| pNFT (ProgrammableNFT) | Yes, for royalty display | same branch: `interface === 'ProgrammableNFT'` reads real `royalty.basis_points`. **Not otherwise standard-aware** — see §24/26 |
| MPL Core | **No explicit support, no explicit rejection** | `getAssociatedTokenAddressSync`/`TOKEN_PROGRAM_ID` hard-assume an SPL token account exists for the asset; Core assets have no such account. See Finding MS-6. |
| Compressed NFT | **No** | ME's own item-offer/ExecuteSaleV2 mechanics are for non-compressed assets; no cNFT-specific proof/tree handling anywhere |
| Token-2022 NFT | **No explicit handling** | `TOKEN_PROGRAM_ID` is imported and used directly, never `TOKEN_2022_PROGRAM_ID`; see Finding MS-6 |
| SFT / editions / quantity > 1 | **No** | no `tokenSize`/quantity field ever sent or read beyond the one `MeOfferMade.tokenSize` field, which is never even used in the request |

### Per-action lifecycle (the real one: accept an offer)

UI intent (paste mint+buyer, click Load Offer) → `resolve-offer` (ME
`offers_made` index → price+auctionHouse) → `order-info` (live escrow
balance read + live DAS royalty read + gross/net math, **no wallet
required yet**) → operator reviews price/royalty/required/missing/proceeds
→ **[optional] Top up** (separate unsigned tx, own wallet only) → **Build
Accept Tx**: tries the Tampermonkey **bridge** first (real magiceden.io
session), falls back to backend **build-accept** (our own `ME_API_KEY`
against `/instructions/batch`) → structural validation (**backend path
only** — see Finding MS-1) → digest cached (**backend path only**) →
**Simulate** (real `simulateTransaction`, operator must read the result) →
**Sign & Submit**: Phantom `signTransaction` (single new signature — the
seller's; ME's cosign is already present in the bytes) → `submit` or
`submit-bridge` (server revalidates structure + blockhash freshness +
cryptographically verifies BOTH signatures) → `sendRawTransaction` → raw
signature returned, **no confirmation polling of any kind** (see Finding
MS-4).

## 4. Exact state machine

```
idle → (Load Offer) → loading-info → info-loaded
                                        │
                    (Top Up, optional)  │
                    topping-up ─────────┤ (re-loads info on success)
                                        │
                                (Build Accept Tx)
                                        │
                         ┌──────────────┴──────────────┐
                    building (bridge)              building (backend)
                         │                               │
                 [no validation]                 validated server-side
                         │                               │  (digest cached)
                         └──────────────┬────────────────┘
                                    built
                                        │ (Simulate)
                                   simulating → sim-ok / sim-failed
                                        │ (only enabled if sim-ok)
                                 (Sign & Submit)
                                        │
                                    signing (Phantom)
                                        │
                              submitting → submitted (raw sig only) → DONE (UI)
                                        │
                                   submit-error
```

No `unresolved`/`submitted-unknown`/`confirmed` state exists ANYWHERE in
this state machine — `doSubmit()` sets `submitSig` the instant the
backend's `POST /submit` HTTP call resolves with `{ok:true, signature}`,
and the backend itself sets that response the instant
`chain.sendRawTransaction()` resolves (a call that only proves the RPC
**accepted** the tx into its send queue, per this repo's own
already-established terminology from the Resize Claim audit — "submitted,
not success"). **This is the same class of bug Resize Claim's RC-1 finding
already identified and fixed, unfixed here.** See Finding MS-4 — rated
higher severity here than in Resize Claim because the worst case is not "a
wasted 5000-lamport fee" but "operator's NFT and Phantom signature are both
spent on an ExecuteSaleV2 whose real outcome (sold vs not) is unknown to
the UI, for a real-money sale."

No unsafe *automatic* transition exists (no auto-retry, no idle-after-timeout
that silently re-enables Build) — the danger here is a truthfulness gap
(UI asserts success prematurely), not a duplicate-action gap, because nothing
in this UI re-fires automatically.

## 5. Trust-boundary map

Two materially different cases, must not be conflated:

- **Backend path (`build-accept`):** Case **C** — Magic Eden's own API
  returns already-cosigned bytes; our backend independently structurally
  validates them (`validateSellStructure`) before ever handing them to the
  frontend. This is the well-defended path.
- **Bridge path:** Case **C, via a different transport** — the same kind
  of ME-returned bytes, but relayed through `window.postMessage` from a
  real `magiceden.io` tab running a Tampermonkey userscript, with **zero
  structural validation anywhere before Phantom signs** (see Finding MS-1).
  `submit-bridge` DOES validate structurally server-side, but only
  **after** the seller's signature has already been obtained.

Both paths converge on the same weakness at a deeper layer: **price is
never part of what gets structurally validated, in either path, at any
point** — see Finding MS-2, the audit's highest-severity finding.

## 6. Frozen-intent model

Fields the user reviews on the `order-info` screen: mint, buyer, auction
house, `priceSol`, royalty%, required SOL, missing SOL, seller proceeds.
**Required invariant `REVIEWED INTENT == FINAL BUILD INPUT == FINAL BYTES
== PRE-SIGN AUTHORIZATION` holds for asset identity (mint/buyer/auctionHouse
are pinned in `validateSellStructure`, backend path only) but does NOT hold
for price** (Finding MS-2) and **does not hold for EITHER field on the
bridge path pre-sign** (Finding MS-1).

TOCTOU window: `resolve-offer`/`order-info` are called once at "Load
Offer" time; `priceSol` is then carried unchanged (React state,
`info.priceSol`) into `doBuild()`, which can fire an arbitrary amount of
wall-clock time later (operator reads the numbers, decides whether to top
up, tops up — itself a full sign+confirm round trip — then clicks Build).
**If the buyer's real on-chain offer price changed in that window** (raised,
lowered, or the offer replaced with a fresh PDA at a different price via
ME's own "buy_change_price" flow — a real, supported operation per this
same codebase's sibling `tools-me-bids.ts`), the tool still requests
`newPrice: info.priceSol` (the STALE value) from ME's batch endpoint. This
is analyzed in depth in §9 as **Finding MS-3 (fail-closed, not
fail-dangerous, but the exact mechanism was not empirically re-verified
this session)**.

## 7. Asset identity model

Pinned by pubkey, not label, on the **backend** path only:
`validateSellStructure` requires the mint pubkey and the auction-house
pubkey to each appear literally among the account keys of **both** M2
instructions, and the buyer pubkey to appear in at least one. This
correctly prevents ME's response from silently substituting a different
mint or a different auction house than what was requested. **It does not
independently derive/verify the token-account (ATA) or metadata/edition
PDAs** — those are trusted to be correctly derived by ME's own API from the
mint we supplied, which is itself pinned. Given the mint IS pinned and ATA
derivation for a given (mint, owner) is a deterministic, standardized
function, a wrong-ATA substitution would require ME's own backend to be
compromised in a way this audit has no way to test without live-broadcasting
— noted as an accepted trust boundary onto Magic Eden's own infrastructure,
consistent with the spec's own framing that Phantom's preview is not itself
the security boundary but a third party's server-side integrity is a
different, lower-tier risk than our own code's bugs.

**On the bridge path, NONE of this — mint, auction house, or buyer — is
checked before signing** (Finding MS-1).

## 8. Existing-listing semantics — NOT APPLICABLE (by design)

This tool never creates a listing independent of an existing buyer offer;
"already listed at another price" / "duplicate live sell order" scenarios
the spec worries about for a *listing* tool don't have a direct analog
here. The nearest real equivalent — **is the SAME offer accepted twice, or
by two tabs concurrently?** — is covered under §17 (Finding MS-4/MS-5),
not this section.

## 9. ME protocol / program semantics

Program: Magic Eden **M2** auction house program,
`M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K` — confirmed live on mainnet
this session (`getSignaturesForAddress` returned real, recent, successful
signatures against this exact program ID). This is the **only** ME
protocol this tool touches — no MMM, no Tensor, no legacy pre-M2 auction
house, confirmed via `ALLOWED_PROGRAM_IDS = {ComputeBudget, M2}` being the
router's own exhaustive allowlist.

**The accept-offer bundle is TWO separate M2 instructions**, per this
file's own documented 2026-08-24 finding (re-verified this session only at
the "M2 program is live and real" level, not by re-decoding a fresh
accept-offer-specific historical tx — item-level `acceptBid` events were
searched for across 5 high-volume collections' recent activity feeds this
session and none were found in the sampled window; rarer event type,
stated as an audit limitation, §42):
1. **Sell** (the listing half) — the seller lists at `newPrice`, matching
   the buyer's already-existing on-chain bid.
2. **ExecuteSaleV2** (the execute half) — settles the trade against that
   specific buyer's escrow, referencing the buyer directly.

Calling `/instructions/sell_now` directly returns **only** instruction #1
— empirically confirmed the hard way per the file's own comment (a real
submitted tx delegated the NFT with no SOL movement). The `/instructions/batch`
wrapper (payload: `[{type:'sell_now', ins:{...}}]`) is the one ME's own
frontend actually uses and the one this code correctly uses too.

**`buyerExpiry` unit/semantics bug, already found and fixed by this
codebase (documented, not a new finding):** ME's batch backend treats an
omitted or `0` `buyerExpiry` as "expired at Unix epoch" for offers whose
own recorded expiry is `0` ("no expiry"), causing every such offer to be
rejected as "bidding too old to be accepted." Fixed by sending a
far-future sentinel (`4102444800000` ms = 2100-01-01) whenever the real
offer's expiry is `0`. This is good, empirically-derived defensive
engineering already in place — flagged in §39 as an existing mitigation
that must not be reverted.

**Cosigner model:** every real ExecuteSaleV2 requires TWO signatures — the
seller and a fixed ME hot-wallet cosigner (documented as independently
confirmed by decoding 2 real settled txs, holding tens of thousands of
SOL, identical across unrelated trades — i.e. a real, shared ME
authority, not a per-trade PDA). This process has no way to produce that
signature itself; `build-accept` explicitly checks `cosignPrefilled` and
refuses (`needsBridge: true`) rather than caching a digest for a
permanently unsignable tx if ME's response ever comes back with that slot
empty. **This is a well-designed fail-closed check** — flagged in §39 as a
mitigation that must not be weakened.

## 10. Instruction/account/data matrix

Both M2 instructions in the bundle, per `validateSellStructure`'s own
checks (this is what the code actually verifies, not a full independent
IDL decode — no `@metaplex-foundation` M2 SDK/IDL is imported anywhere in
this codebase; the validator works entirely off structural properties: program
ID, instruction count, presence-of-pubkey-in-account-list):

| Property | Checked? | Where |
|---|---|---|
| Exactly 2 signature slots | Yes | `tx.signatures.length !== 2` |
| Seller is one signer | Yes | `sellerEntry` lookup by pubkey |
| A second (cosigner) slot exists | Yes | `otherEntry` lookup |
| Seller slot signed/unsigned as expected for build vs submit | Yes | `expectSellerSignature` param |
| Fee payer == seller | Yes | `tx.feePayer` check |
| Every top-level instruction's program ∈ {ComputeBudget, M2} | Yes | allowlist loop |
| Exactly 2 M2 instructions (no more, no fewer) | Yes | `m2Instructions.length !== 2` |
| Mint present in EACH M2 instruction's account list | Yes | `.some(k => pubkey === expectedMint)` per instruction |
| Auction house present in EACH M2 instruction's account list | Yes | same pattern |
| Buyer present in AT LEAST ONE M2 instruction | Yes | `.some(...)` across both |
| **Price** (anywhere: instruction data, or an expected price-derived trade-state PDA) | **NO — never checked, anywhere** | absent from `SellValidationContext`'s very type definition |
| Exact instruction discriminator/opcode | **No** | never decoded — program-ID + rough shape only |
| Exact account POSITION (vs. mere presence) | **No** | `.some()` over the whole key list, not positional pins |
| ComputeBudget CU limit/price bound | **N/A for build-accept output** — the 2-instruction accept bundle carries **zero** ComputeBudget instructions by the code's own documented finding; the allowlist would permit one if ME ever added one, but none is expected or bounded |

This is a **materially weaker** structural auditor than Candy Mint's
(`auditCandyMintTx`) or Resize Claim's (`auditResizeClaimTx`) in this same
repo — those pin exact account **positions** and decode instruction
**data** (amount, discriminator, proof bytes); this one only checks
program-ID allowlisting, instruction **count**, and pubkey **presence**
anywhere in a flat list. See Finding MS-2.

## 11. Structural final-byte validation

Present, real, and non-trivial (`validateSellStructure`) — but scoped
narrower than every other structural auditor in this repo, and **only on
the backend path**. See Findings MS-1 and MS-2.

## 12. Delegation safety

No delegate is created by ANY code in this file — confirmed by grep: no
`Approve`, `approve`, `delegate`, `Delegate`, `AuthorizeTokenTransfer`,
or SPL `Approve`/`SetAuthority` instruction is ever constructed by our own
code (the `Sell` half of the M2 bundle, built entirely by ME's own API,
internally creates the auction-house program's own PDA-scoped sell-escrow
delegate — a standard, audited, price-and-mint-specific Auction House
mechanism, not something this codebase controls or could misconfigure).
**No broad/arbitrary-asset delegate risk exists in code we author.** The
residual question — "does ME's own Sell instruction ever create a delegate
broader than this one mint/amount" — is a question about Metaplex/ME's own
protocol, well outside this audit's ability to verify without decoding a
real Sell instruction's exact CPI trace, and is the same trust boundary
every third-party marketplace integration accepts. Not scored as a
Resize-Claim-style "zero by construction" claim (that tool never touches a
marketplace program at all) — ME Sell's exposure here is bounded by ME's
own protocol design, not eliminated by our code, and is NOT INDEPENDENTLY
VERIFIED this session (stated limitation, §42).

## 13. Final-byte simulation

**Present and correctly ordered relative to signing** — `doSimulate()`
runs against `built.txBase64` (the exact bytes that will later be signed;
`doSubmit()` re-decodes that same `built.txBase64`, not a freshly rebuilt
one, to construct what Phantom signs) — this is the same bytes-identity
discipline Resize Claim's audit required and Resize Claim's fix
implemented. **However: the Sign & Submit button is a manual, separate
click from Simulate** — nothing prevents an operator from clicking
Simulate, seeing success, walking away, coming back much later, and
clicking Sign & Submit against blockhash-stale bytes (see §14) — the UI
does not re-simulate automatically before Sign & Submit, and there is no
automatic re-simulation "one click before Phantom" the way Resize Claim's
pipeline now enforces server-side ordering. This is a UX/timing gap, not a
structural-bytes gap (rated LOW — see Finding MS-7).

## 14. Blockhash lifecycle

- `build-accept`'s blockhash comes from **ME's own API response**
  (`entry.value.blockhashData.lastValidBlockHeight`), not from our own
  `getLatestBlockhash` call — this is a real, load-bearing dependency on a
  third party's blockhash choice, but it is legitimate (ME's cosign is
  bound to that exact blockhash by their own signature, so we cannot swap
  it without invalidating the cosign — the code correctly never attempts
  to).
- **Pre-sign check: NONE.** Unlike Resize Claim's now-two-stage freshness
  gate, this tool performs zero blockhash-freshness check before handing
  bytes to Phantom for signing. An operator who reviews Order Info, tops
  up, reads Simulate's output, and only THEN clicks Sign & Submit could
  easily exceed a blockhash's ~60-90 second real-world life; the first
  freshness check anywhere in this pipeline happens **after** Phantom has
  already produced the signature, inside `submit`'s
  `checkBlockhashFreshness` call (§17 covers the consequence).
- **Post-sign check: present, but only at `submit` time, in the SAME
  server round-trip that also broadcasts** — there is no separate "check
  freshness, and if stale, refuse to even ask for re-broadcast without a
  fresh signature" step distinguishable from "broadcast." Concretely: if
  `checkBlockhashFreshness` returns `blockhash_near_expiry`/`blockhash_expired`,
  `submit` correctly refuses (`410`) and does **not** call
  `sendRawTransaction` — so the actual broadcast IS gated on freshness
  (**Finding MS-7 is a UX/timing observation, not a broadcast-safety
  hole**: the dangerous case — signing something already near-expired and
  it getting broadcast anyway — does not happen, because `submit` checks
  freshness before `sendRawTransaction`, correctly, every time,
  server-side, regardless of what the frontend UI does or doesn't nudge
  the operator to do).
- `submit-bridge` has **no blockhash-freshness check at all** — confirmed
  by reading the route top-to-bottom: it validates structure, checks
  cosign, cryptographically verifies signatures, then calls
  `sendRawTransaction` directly. **A stale-blockhash bridge-path tx would
  simply fail to land (the cluster itself rejects an expired blockhash) —
  fails closed by Solana's own protocol, not by this code's design.**
  Rated LOW (operational annoyance — a spurious send attempt — not a
  fund-safety gap) since Solana's runtime itself is the backstop.

## 15. Submission / confirmation matrix

| State | Distinguished? |
|---|---|
| Not sent | Yes — pre-send throws land in `buildError`/`submitError` |
| Signed but not sent | N/A — sign and send happen in the same `doSubmit()` call with no gap a user action could interrupt |
| Submitted unknown | **No** — `sendRawTransaction`'s resolution IS the reported outcome |
| Confirmed success | **No — never checked** | no `getSignatureStatuses`/`getTransaction`/confirmation polling anywhere in this file |
| Confirmed failure | **No — never checked** | same |
| Expired without landing | Only pre-broadcast (§14); once broadcast, no post-broadcast reconciliation exists at all |

**Finding MS-4.** Directly analogous to Resize Claim's now-fixed RC-1, but
for a live-money NFT sale rather than a fee-wasting retry. `sendRawTransaction`
resolving with a signature is treated as terminal by both the backend
(`res.json({ok:true, signature})`) and the frontend (`setSubmitSig(j.signature)`,
rendered as a plain green "Submitted:" line with a Solscan link — see §31).

## 16. Chain-confirmed vs ME-indexed semantics

**Not applicable in the usual "did the marketplace UI catch up" sense**,
because this tool's "listing" IS the sale itself (ExecuteSaleV2), not a
separate indexed listing record a marketplace UI needs to display before
it's "real." There is no ME-indexer-lag risk analogous to a fresh listing
not yet showing up in search — the transaction, once it lands, has already
transferred the NFT and moved the SOL; ME's own site catching up on
displaying that historical sale has no bearing on whether the trade
happened. (This section IS a real concern for a create-listing tool; ME
Sell simply isn't one — see §1.)

## 17. Unknown/retry behavior

**Finding MS-5 (compounds MS-4).** There is no retry-narrowing, no
exact-signature reconciliation, and — critically — **no guard against
building and submitting a SECOND accept for the same offer** if the first
attempt's outcome is unknown to the operator (RPC send timeout/error,
browser hiccup, tab confusion). Trace:

1. Operator clicks Sign & Submit. `chain.sendRawTransaction` either (a)
   resolves with a signature (treated as MS-4's false "done"), or (b)
   throws/times out — caught by `submit`'s own try/catch, which returns
   `res.status(200).json({ok:false, error:...})` (**note: HTTP 200 with
   `ok:false`** — a deliberate, correct pattern elsewhere in this file for
   "the request itself was fine, but the downstream RPC call failed," not
   a bug).
2. On failure, the frontend shows `submitError` and the **same `built`
   tx/digest remains in React state** — nothing clears it, and the Sign &
   Submit button is still clickable.
3. **The digest was already `consume()`d** the moment `submit`'s handler
   reached that line (`digestCache.consume(digest)` happens BEFORE
   `sendRawTransaction` is attempted, specifically so a slow/failed
   broadcast can't be replayed against a still-valid cached digest — a
   real, deliberate one-shot-per-digest design). **This means: if the
   operator clicks Sign & Submit again after a failure, `submit` will
   correctly reject with `digest_not_found_expired_or_already_used` (410)
   — the SAME already-signed bytes cannot be resubmitted through this
   endpoint a second time.** This is actually a **correct, fail-closed
   design for the exact "unknown, so don't blindly retry the same bytes"
   hazard** — confirmed by re-reading the consume-then-send ordering
   carefully; initially looked like a double-submission risk, is not one.
4. **The real remaining risk: recovering from that state requires a full
   NEW `doBuild()` → NEW ME `/instructions/batch` call → a NEW `Sell`+`ExecuteSaleV2`
   pair.** If the FIRST attempt's `sendRawTransaction` actually landed
   on-chain (the RPC accepted it, the client-visible error was a timeout
   waiting for the RPC's OWN response, not proof of non-landing — exactly
   the "submitted unknown" scenario MS-4 already established this code
   cannot distinguish), the operator has no way to know that from the UI
   and may reasonably build a fresh accept. **Does a second, independently-negotiated
   accept-offer bundle for the SAME (mint, buyer) fail closed on-chain if
   the first one already landed?** Very likely yes — the underlying M2
   `Sell` instruction requires the seller to still hold the token in their
   ATA, and a landed ExecuteSaleV2 has already moved it out; a second
   attempt's `Sell` half would fail (seller no longer holds the token) and
   the bundle would not execute. **This is inferred from general Auction
   House/SPL token-ownership mechanics, not empirically re-verified this
   session** (would require broadcasting a real duplicate accept against a
   real settled trade, explicitly forbidden by this audit's constraints) —
   stated as a reasoned HYPOTHESIS, not a proven bug, and the reasoning
   points toward "fails closed," not toward a double-sale risk.

**Net assessment:** MS-5 is real (no reconciliation exists, so the
operator genuinely cannot tell submitted-unknown from failed), but the
worst concrete consequence is bounded by on-chain token-ownership
semantics to "confusion about what happened," not "double sale" or "sold
twice for two different prices" — those would require a second `Sell` to
succeed after the NFT already left the wallet, which SPL token ownership
mechanics make structurally impossible. Rated **MEDIUM**, not HIGH/CRITICAL,
specifically because of that natural on-chain backstop — but the complete
absence of UI truthfulness about "unknown" remains a real, user-facing
defect worth fixing on its own terms (an operator could, in the confused
window, e.g. tell the buyer the trade failed and refund/renegotiate off-chain
when it actually landed — a real-world, non-technical consequence).

## 18. Cancel/reprice behavior — NOT APPLICABLE

No cancel or reprice endpoint exists in this tool at all (§3/§8). N/A per
spec's own instruction to mark it so when genuinely absent.

## 19. Batch/partial behavior — NOT APPLICABLE

Every endpoint takes exactly one `(mint, buyer)` pair; no array, no loop,
no `signAllTransactions` anywhere in this file (confirmed: the frontend
uses `sol.signTransaction`, singular, never `signAllTransactions`). No
batch semantics exist to audit.

## 20. Wallet-switch behavior

**Finding MS-8 (LOW-MEDIUM).** Unlike every other tool audited in this
repo (Candy Mint, Resize Claim), **`doSubmit()` never calls
`assertPhantomWallet` or any equivalent check** that the currently-active
Phantom account still matches the `wallet` the offer/tx was built and
reviewed against. It reads `getPhantom()` and calls `sol.signTransaction(tx)`
directly. Concrete scenario: operator loads an offer and builds an accept
for wallet A (the actual NFT holder), then — before clicking Sign & Submit
— switches the active account in the Phantom extension to wallet B (e.g.
to check something else), then returns to this tab and clicks Sign &
Submit. **`validateSellStructure`'s server-side `fee_payer_mismatch` /
`seller_not_in_signer_set` checks (both `build-accept`'s pre-check and
`submit`'s revalidation) require the tx's signer to be the ORIGINALLY
reviewed seller pubkey — not whichever wallet Phantom happens to be
connected to.** If wallet B attempts to sign a tx whose `feePayer`/only
signer slot is wallet A's pubkey, **Phantom itself will refuse the
signature request** (a wallet cannot produce a valid signature for a
pubkey it doesn't hold the key for) — this is a hard cryptographic
impossibility, not merely a UI nicety. **So this finding is UX-severity
only: the operator gets a cryptic Phantom-level rejection instead of this
app's own clear "wallet changed, reconnect and retry" message** — rated
**LOW**, not higher, because the underlying fund-safety property (can't
sign with the wrong key) is enforced by Phantom/cryptography regardless of
whether our own code checks it first. Contrast with Resize Claim/Candy
Mint, where `assertPhantomWallet` exists purely for a NICER failure
message at the exact same safety level — this tool simply lacks that
UX-only convenience, not a real gap.

## 21. Marketplace/API trust boundary

Two ME endpoints consumed, both public/documented-shape (`api-mainnet.magiceden.dev/v2`):
`/wallets/{buyer}/offers_made` (read) and `/instructions/batch` (the
authorization-bytes source). Both called server-side with our own paid
`ME_API_KEY` (`meAuthHeaders`) — never a client-supplied URL/path (the
`path` string in `defaultMeHttpTransport` is always backend-constructed
from validated pubkeys, never user-supplied raw text) — **no open-proxy /
arbitrary-URL risk**. ME's `/instructions/batch` response IS treated as
"untrusted authorization input" and independently structurally re-checked
— correctly, per the spec's own framing — **but only for asset identity,
never for price** (MS-2), and **only on the backend path, never on the
Tampermonkey-bridge path before signing** (MS-1).

## 22. Backend auth/broadcast/signing boundary

All 7 routes require `requireAuth` (site-wide SIWS + `UI_ALLOWED_WALLETS`)
— confirmed present on every single route including `/status`. Schema
validation is real and specific (`parsePubkey`/`parsePriceSol`/`parseLamports`
each reject malformed input with a 400 before any downstream call — no
`Number(garbage)` silently coercing to `NaN` and slipping through, since
`parsePriceSol`/`parseLamports` both explicitly check `Number.isFinite`).
Rate limits are per-route and sensible (`read` 30/min, `build`/`simulate`
15/min, `submit` 10/min). `submit`/`submit-bridge` both hard-gate on
`ME_BIDS_ENABLE_LIVE` — a real, server-side, non-bypassable kill switch
(checked FIRST in each handler, before any other logic). **No backend
signer exists — confirmed by reading every line; the process never
constructs a `Keypair`, never imports one from env, and `sendRawTransaction`
only ever broadcasts bytes the caller supplied.** Error responses:
`err instanceof Error ? err.message : String(err)` is returned verbatim on
several paths (e.g. line 476, 605, 728, 757, 784) — the same GB-5/RC-5-class
raw-error-detail pattern already found and fixed in GhostBid and Resize
Claim, **not fixed here**. Rated LOW (same reasoning as those two: auth-gated,
no stack trace, single-operator scope) but noted since this is now the
THIRD tool in this repo found with this exact unaddressed pattern (Finding
MS-9).

## 23. Backend signer / secrets

**No private key exists in this process.** `ME_API_KEY` (env, server-side
only, never returned to the client) and `HELIUS_API_KEY` (same) are the
only secrets touched by this file; neither is ever echoed in a response
body (spot-checked every `res.json`/`res.status().json()` call — none
includes a raw API key or auth header value). Logging: no `console.log`
of a signed transaction, raw signature bytes, or auth header exists in
this file.

## 24. NFT standard coverage

**Finding MS-6 (LOW-MEDIUM).** No explicit standard detection/gating
exists anywhere in this router or page — `fetchRoyaltyBp` reads
`interface` from DAS but only to decide "is royalty enforced" (0 for
anything not `ProgrammableNFT`), never to decide "is this NFT even a
standard we support." `getAssociatedTokenAddressSync(mint, seller, false,
TOKEN_PROGRAM_ID)` is called unconditionally, hard-coding the LEGACY SPL
Token program — an MPL Core asset (no SPL token account at all) or a
Token-2022 NFT (a different program ID entirely) would each produce a
**wrong or meaningless ATA address**, sent to ME's `/instructions/batch`
as `tokenATA`. The most likely real-world consequence is that ME's own
backend rejects the mismatched/nonexistent ATA and the batch call fails
loudly (`me_batch_entry_not_fulfilled` or similar) — i.e. **this probably
fails closed in practice, but by ACCIDENT (ME's own validation), not by
DESIGN (no standard check exists in our code to fail closed on purpose)**.
Per the spec's own instruction ("Unknown/unsupported standards should fail
closed... do not route by display metadata alone"), the absence of an
intentional guard is itself the finding, independent of whether the actual
outcome today happens to be safe.

## 25. pNFT-specific safety

Royalty-awareness only (§9's `fetchRoyaltyBp`) — **no tokenRecord PDA,
ruleSet, or authorizationRules handling of any kind exists in this file**.
This is consistent with §9's finding that ME's own `/instructions/batch`
constructs the actual M2 instructions (including whatever pNFT-specific
accounts a `Mip1Sell`/`Mip1ExecuteSaleV2` variant needs) — this codebase
never builds those instructions itself, so there is nothing here to get
wrong about tokenRecord/ruleSet account derivation specifically. The
residual pNFT risk is entirely captured by §7's already-noted "royalty can
change between review and settlement" staleness window (rated LOW —
requires a collection authority action, narrow TTL, and Auction House
sale execution itself reads live royalty at settlement time regardless of
what our UI displayed earlier, so the SELLER's actual proceeds/royalty
outcome is whatever's true on-chain at execution — our number can be
STALE-DISPLAYED, never STALE-ENFORCED).

## 26. MPL Core-specific safety — NOT APPLICABLE (unsupported, see MS-6)

No Core-specific account/plugin handling exists; see Finding MS-6 above
for the associated hardening gap (no explicit rejection).

## 27. Token-2022 / extensions — NOT APPLICABLE (unsupported, see MS-6)

`TOKEN_PROGRAM_ID` is hardcoded; no `TOKEN_2022_PROGRAM_ID` import
anywhere in this file. Same MS-6 finding covers the lack of an explicit
guard.

## 28. Numeric / serialization safety

- `parsePriceSol`: `Number(v)`, rejects non-finite and `<= 0`. **Does not
  reject scientific notation** (`Number("1e-3")` = `0.001`, passes) —
  this is not a bug per se (`1e-3` SOL is a legitimate, if unusual, price
  a `Number()` correctly parses), but it means a price typed/pasted as
  `"1e2"` (100) would silently be accepted as 100 SOL, not rejected as
  malformed input the way the spec's adversarial list implies it should
  be flagged for review — **low practical risk since `priceSol` in the
  real flow is never operator-typed, it's always machine-read from
  `resolve-offer`'s ME API response**, not a free-text field in the UI at
  all (the UI has no price input box — only mint/buyer text fields). This
  materially changes the risk calculus versus the spec's assumption of a
  user-typed price: **there is no user-facing price-typing surface in
  this tool to attack**.
- `priceLamports = Math.round(priceSol * 1e9)` — floating-point
  SOL→lamports conversion, same pattern used throughout this codebase
  (GhostBid, Resize Claim's `lamportsToSol`, both already reviewed and
  accepted as safe at realistic magnitudes in prior audits). At NFT sale
  prices (well under 2^53 lamports = ~9M SOL), no precision-loss path is
  reachable. This value is **display-only** (`order-info`'s response) —
  the actual on-chain price the ExecuteSaleV2 encodes comes from ME's own
  API/instruction builder, not from this arithmetic, so a display
  rounding artifact here could show a very slightly wrong "Required"/"You'd
  receive" figure but cannot desync the actual trade's on-chain economics
  from what ME independently computed.
- `parseLamports` (topup): `Number.isInteger` + `>= 0` — correctly
  rejects fractional/negative/non-finite lamport amounts before building
  the topup transfer.
- No `BN`/`BigInt` u64 encoding is performed by this code at all (unlike
  Resize Claim, which hand-builds instruction data) — every instruction
  byte here comes from Magic Eden's own API response, decoded via
  `Transaction.from` (a mature, widely-used `@solana/web3.js` primitive),
  not hand-rolled.

## 29. Compute budget / priority fee

The accept-offer bundle returned by ME's `/instructions/batch` carries
**zero** ComputeBudget instructions in the 2-M2-instruction shape this
code expects and validates (`m2Instructions.length !== 2` — this is an
exact-count check on the M2-filtered subset, and the earlier allowlist
loop would already reject any OTHER unexpected program, but a
ComputeBudget instruction IS in the allowlist and would silently pass if
ME's API ever started including one). **No cap on ComputeBudget CU
price exists anywhere in this file** (contrast Candy Mint's
`MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS` / Resize Claim's
`MAX_RESIZE_COMPUTE_UNIT_PRICE_MICROLAMPORTS`) — if ME's API ever started
returning a bundle with an absurd priority fee, nothing in
`validateSellStructure` would catch it before the operator signs (the
allowlist only checks program ID, not price-bounding data within a
ComputeBudget instruction). **Currently unreachable in practice** (ME's
real response has no such instruction, confirmed by the exact-count check
passing only when there are exactly 2 M2 instructions and no others —
meaning a ComputeBudget instruction sneaking in would actually be
caught... **only if it changes the M2-instruction count check indirectly
via the earlier top-level allowlist loop's silent acceptance** — re-reading
carefully: the top-level allowlist loop accepts ComputeBudget OR M2
instructions; a 3rd, ComputeBudget instruction added by ME would pass that
loop silently, then the SEPARATE `m2Instructions.length !== 2` check would
still pass (since it filters to M2 only, ignoring the extra ComputeBudget
instruction) — **so an added ComputeBudget instruction with an arbitrary,
unbounded CU price WOULD pass validation today.** This is a real,
narrow gap: rated **LOW** given it requires ME's own API output to change
shape (not attacker-controlled from where this audit sits), but flagged
per spec §29's explicit instruction not to let "a compromised builder hide
an absurd priority fee."

## 30. Concurrency / race analysis

- **Two tabs, same offer:** each independently calls `build-accept`,
  independently gets a digest bound to that build's own blockhash/message
  hash, independently caches it server-side (keyed by message hash, not by
  mint — two builds for the same offer at the same price with the same
  blockhash would actually collide on the SAME digest key, harmlessly,
  since the entry would just be overwritten/reused; two builds a moment
  apart would get different blockhashes → different digests → independent
  entries). Whichever tab's `submit` reaches the RPC first and lands wins
  (normal SPL/M2 ownership semantics as reasoned in §17); the second tab's
  `submit` would either fail the `checkBlockhashFreshness`/on-chain
  ownership check, or (if for some reason it also lands) at worst throw an
  program-level error since the seller no longer holds the token — **no
  double-payout path exists** given the seller's own token, not a shared
  resource, is what's being consumed.
- **Double-click Sign & Submit:** `submitBusy` disables the button while a
  request is in flight (checked in JSX: `disabled={submitBusy}`) —
  prevents the most common double-click case at the UI layer; the
  digest-consume-before-send ordering (§17) is the real, server-side
  backstop regardless.
- **Build A slow / Build B fast (re-clicking Build Accept Tx while a prior
  build is still in flight):** `buildBusy` similarly disables the Build
  button — `disabled={buildBusy || info.missingLamports > 0}`. No
  stale-response arbiter (GhostBid-style generation counter) exists for
  `doBuild()`/`doSubmit()` specifically, but because the button is disabled
  for the ENTIRE duration of the in-flight call (not just until the first
  chunk resolves), a second call cannot actually be initiated while the
  first is pending through the UI — the race the spec worries about
  (`build A` resolving after `build B`) requires bypassing the disabled
  button (e.g. by firing the underlying function directly, not a realistic
  UI-only user action). Rated **not a practical finding** given this,
  though it is structurally different from (weaker than) GhostBid's
  explicit generation-counter pattern — noted as a stylistic gap, not a
  scored finding.

## 31. Error classification

Distinguishes, via distinct response shapes/status codes: invalid
input (400), ME API key not configured (503 via `MeApiError`), ME rate
limited (429), ME API unreachable (504), offer not found (404),
structural-validation failure at build (422) vs at submit (409, worded
`revalidation_failed`), cosign not prefilled (409, `needsBridge:true`),
digest not found/expired/reused (410), blockhash mismatch/expired/near-expiry
(410, with a specific `code`), invalid cryptographic signature (400),
live-mode disabled (403). **This is a genuinely rich, well-differentiated
error taxonomy** — noticeably better than several other tools already
audited in this repo. The one classification NOT made: **"submitted, RPC
accepted it, but I don't know if it landed" is never a distinct code —
it's indistinguishable from every other post-send success at the type
level** (MS-4).

## 32. UI truthfulness

- **"Submitted: <sig>"** — accurate to what actually happened
  (`sendRawTransaction` returned this signature) but **does not mean
  confirmed, and the UI wording doesn't say so** — an operator could
  reasonably read "Submitted" + a Solscan link as "sold," when the tx may
  yet fail or never land (MS-4).
- Price/royalty/required/missing/proceeds figures are labeled honestly as
  computed values ("You'd receive... after X% ME fee") and match the
  request/response fields they're derived from — no gross-vs-net
  mislabeling found.
- "unknown (treated as 0 — verify manually)" for `royaltyBpUnknown` is an
  honest, non-overclaiming label — good practice, consistent with this
  file's own documented Golem #4904 incident (§9/backend header) that
  motivated it.
- No "Listed"/"Failed" mislabeling exists (N/A per §1 — nothing is ever
  labeled "Listed").

## 33. Recovery after reload/navigation

No signature/digest is persisted to `localStorage` or anywhere else — a
reload after `doSubmit()` resolves loses the `submitSig` display, but the
on-chain outcome (landed or not) is unaffected and independently
recoverable by the operator pasting the mint into Solscan or Solana
Explorer. Given §17's finding that a genuine double-sale is structurally
prevented by SPL token-ownership semantics rather than by this app's own
bookkeeping, the lack of persistence here has a **bounded, non-fund-loss
consequence** (the operator might not immediately know if a reload-interrupted
submit landed, but cannot be tricked into re-selling something already
sold) — not scored as a standalone finding per the spec's own "do not
automatically call no-persistence a bug" guidance.

## 34. Existing tests

**Zero.** `find . -iname "*me-sell*test*"` (repo-wide) returns nothing;
`package.json` has no `test:me-sell*` script. This is a genuine gap made
more notable by the fact that `createMeSellRouter(deps: MeSellDeps = {})`
is **explicitly built for dependency injection** — `meTransport`,
`meApiKeyProvider`, `chain`, `now`, `authMiddleware`, `liveEnabled`,
`blockhashMarginBlocks`, `rateLimitsDisabled` are all injectable,
mirroring `tools-me-bids.ts`'s own proven pattern (which DOES have a real
test suite, `src/server/__tests__/tools-me-bids.test.ts`, using the exact
same `MeHttpTransport`/`ChainClient` injection shapes this file imports
directly from that module). **The scaffolding for a rigorous,
network-free test suite exercising the REAL `validateSellStructure` and
the REAL router logic already exists and is unused** — this is not "no
tests were possible," it's "the same proven harness one file over was
never pointed at this file." Classified per spec §34's own taxonomy: if
written, such tests would be **real production-logic tests with injected
mock transport/chain** (same tier as `tools-me-bids.test.ts`'s own,
correctly NOT "live E2E" and NOT "just a pure unit test" either) —
currently, that tier of test simply doesn't exist for this file at all.

## 35. Real historical / live-read evidence

Performed this session, read-only:
1. Confirmed the M2 program (`M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K`)
   is live on mainnet — fetched 5 real recent signatures via
   `getSignaturesForAddress`, decoded 2 via `getTransaction`
   (`jsonParsed`, real Helius RPC call) — both were single-M2-instruction
   bundles (list/buy/cancel-shaped, prefixed by 2 ComputeBudget
   instructions), i.e. NOT the 2-M2-instruction accept-offer shape this
   tool specifically builds — this confirms the program is real and active
   but does **not** independently re-derive the specific accept-offer
   instruction/account shape.
2. Queried Magic Eden's public collection-activity API
   (`/v2/collections/{slug}/activities`) across 5 high-volume collections
   (y00ts, degods, okay_bears, mad_lads, solana_monkey_business) searching
   for a recent `acceptBid` event to decode; none were found in the
   sampled 100-row windows (dominant activity types were `bid`, `list`,
   `buyNow`, `poolUpdate` — item-level offer acceptance is evidently a
   rarer event than these three). **Stated limitation:** this session did
   NOT independently re-decode a fresh real accept-offer transaction; the
   audit instead relies on this file's own documented 2026-08-24 findings
   (two real settled accept-offer txs decoded then, cited by file/line in
   this report's §9) as prior evidence, clearly labeled as prior, not
   re-derived here.
3. No `simulateTransaction` was run against a real live offer this
   session (would require constructing a real `(mint, buyer, auctionHouse)`
   tuple against a currently-fundable offer, which risks nudging toward
   live interaction the audit's constraints intentionally avoid without a
   concrete, already-identified, safe target).

## 36. Production parity

Source (dirty, narrow cooldown-isolation diff on top of committed
`9b7178b`) → build (not independently re-verified against `dist/` this
session — limitation) → running `nft-backend`/`nft-frontend` (both online,
not restarted by this audit). Given the dirty diff's small, well-understood,
non-safety-relevant scope, this audit's conclusions hold regardless of
whether `dist/` has already picked it up.

## 37. Shared-code impact

- `tools-me-bids.ts` — source of `decodeLegacyTxFromBytes`,
  `decodeLegacyTxFromBase64`, `messageHashHex`, `checkBlockhashFreshness`,
  `MeApiError`, `ChainClient`/`MeHttpTransport`/`MeApiKeyProvider` types.
  **Any future fix to ME Sell's price-validation gap (MS-2) should extend
  `SellValidationContext`/`validateSellStructure` locally in
  `tools-me-sell.ts`, not modify these shared primitives** — they are
  correctly generic (hash/freshness/decode) and don't encode
  sell-specific business logic; touching them would affect
  `tools-me-bids.ts`'s own (buy-side) validation too.
- `me-bid-escrow.ts` — `deriveBuyerEscrowPda`/`lamportsToSol`, read-only,
  shared with GhostBid and `tools-me-bids.ts`. Not modified by anything
  this audit would recommend.
- `me-api-cooldown.ts` / `me-trade-cooldown.ts` — shared cooldown gating,
  currently mid-migration (the dirty diff, §1). Out of this audit's
  findings scope; noted only for completeness.
- `frontend/src/wallet/phantom.ts` — `signSendAndConfirm` (used for the
  topup tx only, NOT for the accept tx — accept uses `getPhantom().signTransaction`
  directly, bypassing whatever confirmation logic `signSendAndConfirm`
  itself has). This asymmetry is itself informative: the codebase HAS a
  shared "sign, send, and confirm" helper, and this tool's most
  money-critical action deliberately does not use it, instead calling
  `sol.signTransaction` raw and posting bytes to the backend. Any future
  MS-4 fix should add confirmation polling analogous to Resize Claim's
  own bespoke (not `phantom.ts`-shared) confirmation logic, for the same
  "don't touch a function 3 other tools depend on" reason established in
  that audit.
- `frontend/src/lib/mmm-bridge.ts` — shared Tampermonkey-bridge transport,
  also used by other MMM tooling in this repo (out of this audit's scope
  to re-verify); MS-1's fix (structural pre-sign validation of bridge
  output) belongs in `me-sell/page.tsx` itself, not in the shared bridge
  module, which is correctly generic (origin-checked postMessage
  transport, not sell-specific).

## 38. Safety-property scorecard

| Property | Status | Basis |
|---|---|---|
| Frozen reviewed intent (identity) | PARTIAL | pinned for mint/auctionHouse/buyer on backend path; ABSENT pre-sign on bridge path |
| Frozen reviewed intent (price) | **ABSENT** | never checked anywhere, either path (MS-2) |
| Exact asset identity | PRESENT (backend) / ABSENT (bridge, pre-sign) | §7 |
| Exact price authorization | **ABSENT** | §6/MS-2 |
| Exact fee/royalty authorization | PARTIAL | ME fee is a hardcoded constant (200bp), correct per prior verification; royalty can be display-stale but is always enforced correctly on-chain at settlement (§25) |
| Structural final-byte validation | PARTIAL | present, real, but narrower (presence-only, no positional/price pins) than this repo's other auditors; ABSENT on bridge path pre-sign |
| Final-byte simulation | PRESENT | §13, correctly ordered |
| Wallet identity immediately before signing | ABSENT (own check) / PRESENT (via Phantom's own cryptographic impossibility) | §20, MS-8, LOW only |
| Pre-sign blockhash freshness | **ABSENT** | §14 |
| Post-sign blockhash freshness (before broadcast) | PRESENT | §14 — `submit` checks before `sendRawTransaction` |
| Exact-signature confirmation | **ABSENT** | §15, MS-4 |
| Unknown != failure | ABSENT (as a UI/API concept) though bounded by chain semantics | §17 |
| Unknown cannot blindly retry | PRESENT (accidentally robust) | digest consumed-before-send; a second submit attempt is structurally rejected |
| Deterministic expiry | PRESENT | `checkBlockhashFreshness` + digest TTL, shared proven logic from tools-me-bids.ts |
| Truthful indexing-vs-chain state | NOT APPLICABLE | §16 |
| Partial batch preservation | NOT APPLICABLE | §19 |
| Fail-closed unsupported standards | ABSENT (by omission, not by design) | §24/MS-6 |
| Bounded priority fee | ABSENT | §29 |
| No broad delegate authority | PRESENT (no delegate created by our own code) | §12 |

## 39. Ranked findings

| # | Severity | Summary |
|---|---|---|
| MS-2 | **HIGH** | `validateSellStructure`/`SellValidationContext` never validates PRICE — no field for it exists in the validation context's type, and no code path checks the instruction data or a price-derived trade-state PDA against the reviewed/requested price. A wrong price returned by ME's API (bug, race, or any future behavior change) would pass structural validation and be signed. The digest-binding protects build→submit consistency (a stale/tampered price can't be swapped in AFTER build), but nothing verifies the price INSIDE the build response actually matches what the operator reviewed/what was requested. **PROVEN** (read the full type + validator; no price check exists anywhere in either). `src/server/tools-me-sell.ts:300-320` (type), `:322-380` (validator). |
| MS-1 | **HIGH** | The Tampermonkey-bridge build path (`doBuild()`'s bridge branch, `page.tsx:163-184`) performs **zero** structural validation — not even mint/buyer/auctionHouse presence — on the tx bytes before setting `built` and enabling Simulate → Sign & Submit. The only checks before Phantom signs are Phantom's own preview and (if the operator reads and understands it) the Simulate step's logs. Backend `submit-bridge` DOES validate structurally, but only **after** the seller's signature already exists. **PROVEN** (code reading — the bridge success branch, lines 173-177, does no validation at all before `setBuilt`). |
| MS-4 | **MEDIUM-HIGH** | No confirmation step exists anywhere — `sendRawTransaction` resolving is treated as terminal success by both backend (`res.json({ok:true,signature})`) and frontend (green "Submitted:" line). Same class as Resize Claim's fixed RC-1, but for a real NFT sale rather than a wasted fee. **PROVEN.** `src/server/tools-me-sell.ts:780-785`, `frontend/.../page.tsx:241-243`. |
| MS-5 | MEDIUM | No exact-signature reconciliation/retry-safety UI exists for an unknown submit outcome — bounded from being a double-sale by SPL token-ownership semantics (reasoned, not empirically re-verified this session) but leaves the operator genuinely unable to tell "unknown" from "failed." **PROVEN** (absence of any reconciliation code) with a **HYPOTHESIS**-tier claim about the exact on-chain backstop mechanism. |
| MS-3 | MEDIUM | TOCTOU: `priceSol` frozen at "Load Offer" time is reused unchanged at "Build Accept Tx" time, an operator-paced gap of arbitrary length (including a full top-up round trip). Reasoned to fail closed (mismatched price ⇒ mismatched/stale on-chain trade-state reference ⇒ ME's own batch build or the ExecuteSaleV2 itself fails) but **not empirically re-verified this session** (would require live-broadcasting against a real price-changed offer). **HYPOTHESIS**, not proven either way. |
| MS-6 | LOW-MEDIUM | No explicit NFT-standard detection/rejection (MPL Core, Token-2022, cNFT) — the code hardcodes legacy SPL `TOKEN_PROGRAM_ID` ATA derivation unconditionally; an unsupported standard most likely fails via ME's own downstream validation, not via an intentional guard in this codebase. **PROVEN** (no standard-check code exists) as an omission; the "fails closed anyway" claim is inference, not tested. |
| MS-9 | LOW | Raw `err.message`/`String(err)` returned verbatim to the (already-authenticated) client on several error paths — same already-fixed-elsewhere-twice pattern (GhostBid GB-5, Resize Claim RC-5), not fixed here. `tools-me-sell.ts:476,605,728,757,784` (representative lines). |
| MS-7 | LOW | No pre-sign blockhash-freshness check and no auto-re-simulate immediately before Sign & Submit — mitigated by `submit`'s own post-sign, pre-broadcast freshness check, so the actual fund-safety outcome (never broadcasting a stale-signed tx) already holds; this is a wasted-approval/UX gap, not a broadcast-safety gap. |
| MS-8 | LOW | No `assertPhantomWallet`-style explicit wallet-identity check before `signTransaction` — mitigated to a UX-only gap by Phantom's own cryptographic inability to sign for a pubkey it doesn't hold. |
| — | LOW (test gap) | Zero tests exist despite `MeSellDeps`' injectable design mirroring `tools-me-bids.ts`'s already-tested pattern exactly. |
| — | LOW (hardening) | No ComputeBudget CU-price cap in `validateSellStructure` — currently unreachable given ME's real response shape, but would silently pass if that shape ever changed. |

**No CRITICAL finding.** No path exists for arbitrary/unauthorized NFT
transfer, backend-signer compromise, or broad-delegate theft — this
codebase never creates a delegate, never holds a private key, and every
signature this process ever broadcasts must have been produced by the
seller's own wallet for the seller's own pubkey (a cryptographic
guarantee, not merely a code-review one). The two HIGH findings (MS-1,
MS-2) are real, provable gaps in the "final authorization matches reviewed
intent" invariant this repo's methodology treats as paramount — but their
exploitability requires either a compromised/buggy Magic Eden API response
(for MS-2) or a compromised/buggy Tampermonkey bridge script (for MS-1),
not an attacker reachable from this audit's own trust model (an
unauthenticated network attacker, or another user of this single-operator
tool) — both are correctly scoped as HIGH ("wrong NFT listed, wrong
materially lower price authorized" per the spec's own severity
calibration) rather than CRITICAL, since CRITICAL requires "credible
UNAUTHORIZED... path," and both findings describe a THIRD PARTY's output
not being independently re-verified, not this codebase authorizing
something on its own.

## 40. Proven bugs vs. hypotheses

- **Proven (code-level, deterministic):** MS-1, MS-2, MS-4, MS-6 (as an
  omission), MS-9, MS-7, MS-8, the test-coverage gap.
- **Hypothesis (reasoned from general Solana/SPL/Auction-House mechanics,
  not empirically re-verified this session because doing so would require
  live-broadcasting a real trade):** MS-3 (stale-price TOCTOU fails
  closed), MS-5's specific "double-sale is impossible" backstop claim, and
  MS-6's "ME's own API rejects unsupported standards" claim. All three are
  stated as inference with the reasoning shown, not asserted as fact.

## 41. Existing mitigations that MUST NOT be weakened

- The seller/cosigner 2-signature structural checks, program-ID allowlist,
  and mint/auctionHouse/buyer presence checks in `validateSellStructure`
  — real, load-bearing, and should be **extended** (add price) not
  replaced.
- The digest-cache consume-before-send ordering in `/submit` — this is
  what makes a failed-then-retried submit fail closed rather than
  double-broadcasting the same bytes; do not reorder this.
- `checkBlockhashFreshness`'s call position in `/submit` (before
  `sendRawTransaction`, after digest consumption) — keep as-is.
- The `cosignPrefilled` fail-closed check in `build-accept` (refuses to
  cache a digest for a permanently unsignable tx) and in `submit`/`submit-bridge`.
- The `buyerExpiry` far-future-sentinel fix (§9) — do not revert to
  omitting/zeroing this field.
- `ME_BIDS_ENABLE_LIVE` as the single real broadcast kill switch on both
  `submit` and `submit-bridge`.
- `requireAuth` + per-route rate limits on all 7 routes.
- The royalty `interface !== 'ProgrammableNFT' → 0` legacy-NFT fix (§9) —
  do not revert to trusting declared `royalty.basis_points` unconditionally.

## 42. Minimal safe fixes (not applied — audit only)

- **MS-2 (highest priority):** add `expectedPriceLamports` (or
  `expectedPriceSol`) to `SellValidationContext`; in `validateSellStructure`,
  decode each M2 instruction's price field (or, more robustly, independently
  derive the expected M2 trade-state PDA for the exact reviewed price and
  require it to appear among the instruction's account keys — mirrors how
  Resize Claim's auditor derives `claimReceiptPda` from frozen intent
  rather than trusting presence alone) and reject on mismatch. Apply to
  BOTH `build-accept`'s pre-cache check and `submit`'s revalidation.
- **MS-1:** add a frontend-side call to the same (or an equivalent,
  price-inclusive) structural check against `built.txBase64` for the
  BRIDGE branch specifically, before enabling Simulate/Sign & Submit —
  either by exposing a read-only structural-check endpoint the frontend
  calls with the bridge's bytes, or by porting a minimal decode+pin check
  to the frontend (this repo already has precedent for frontend-side
  structural auditors — Candy Mint, Resize Claim).
- **MS-4:** add exact-signature confirmation polling (`getSignatureStatuses`,
  bounded budget, distinguish confirmed-success/confirmed-failure/still-unresolved)
  after `sendRawTransaction`, both in `submit` and `submit-bridge`, before
  the frontend is told anything beyond "submitted."
- **MS-5:** once MS-4 lands, surface "unknown" as its own UI state with a
  re-check action (same pattern Resize Claim now uses) instead of only
  `submitSig`/`submitError`.
- **MS-6:** add an explicit standard check (DAS `interface` field, already
  fetched for royalty) before allowing Build — reject
  Core/cNFT/Token-2022 with a clear "unsupported standard" message rather
  than letting it fail downstream at ME's API.
- **MS-9:** same one-line generic-error-string pattern already applied in
  GhostBid/Resize Claim.
- **MS-7/MS-8:** optional hardening — a pre-sign blockhash-freshness
  check and an `assertPhantomWallet`-equivalent call immediately before
  `sol.signTransaction`, for a nicer failure message; not required for
  fund safety given the existing backstops (§14, §20).

## 43. Missing regression tests

None exist (§34); all would be new, using the SAME injectable
`MeSellDeps`/mock `MeHttpTransport`/`ChainClient` pattern
`tools-me-bids.test.ts` already establishes one file over. Highest-value,
in priority order:
1. `validateSellStructure`: exact 2-signer shape, fee-payer pin,
   program-ID allowlist, exactly-2-M2-instructions, mint/auctionHouse/buyer
   presence — AND (once MS-2 lands) exact price/trade-state-PDA pinning,
   with adversarial mutation cases mirroring Resize Claim's
   `audit.test.ts` style (wrong mint, wrong auctionHouse, wrong buyer,
   wrong price, extra instruction, wrong program, missing cosign).
2. `checkBlockhashFreshness`/digest-cache consume-before-send ordering —
   prove a second `/submit` call with the same digest after a failed send
   is rejected (`digest_not_found_expired_or_already_used`), locking in
   MS-5's accidental-but-correct fail-closed behavior as an intentional,
   tested invariant rather than an emergent property someone could break
   without noticing.
3. `buyerExpiry` sentinel logic — offer with recorded `expiry:0` must
   produce `buyerExpiry: 4102444800000` in the outgoing `insPayload`, not
   `0`/omitted (regression-lock the 2026-08-24 fix).
4. Royalty branch — `interface !== 'ProgrammableNFT'` must yield
   `royaltyBp: 0`, never the raw declared `basis_points` (regression-lock
   the Golem #4904 fix).

## 44. Production parity limitations

- `dist/`/`.next` were not byte-compared against this exact dirty source
  this session (unlike the GhostBid/Resize Claim audits, which did do
  this comparison) — the dirty diff is small and well-understood enough
  that this doesn't change any finding, but is stated plainly as a gap.
- No fresh real accept-offer historical transaction was decoded this
  session (rare event type; not found in the sampled activity-feed
  windows) — §9's instruction/account shape claims rely on this file's
  own already-documented 2026-08-24 findings, clearly labeled as prior
  evidence.
- MS-3 and the "double-sale is impossible" half of MS-5 are reasoned from
  general SPL/Auction-House mechanics, not empirically re-verified — doing
  so safely would require a live trade this audit's constraints correctly
  forbid.
- No browser/Tampermonkey-bridge integration test was run (no browser tool
  available this session) — MS-1's absence-of-validation finding is
  proven by static code reading (the bridge success branch genuinely
  contains no validation call), not by observing a live bridge response.

## Final verdict

**HARDENING RECOMMENDED.** No CRITICAL finding — no unauthorized-transfer,
backend-signer, or broad-delegate path exists, and several of this repo's
now-established safety patterns (digest binding, blockhash-freshness
checks, fail-closed cosign handling, an already-fixed royalty/expiry
bug history showing real empirical rigor) are present and functioning
correctly. Two HIGH findings are real and provable: **price is never
structurally validated anywhere** (MS-2) and **the Tampermonkey-bridge
path signs whatever it's given with zero pre-sign structural check**
(MS-1) — both are gaps in trusting a third party's (Magic Eden's, or a
browser userscript's) output without independent re-verification, exactly
the class of risk this repo's own established methodology treats as
paramount, and both have a small, well-scoped, already-precedented fix
available in this same codebase's other tools. The confirmation-truthfulness
gap (MS-4) mirrors Resize Claim's already-fixed RC-1 and should receive
the same treatment given this tool's higher per-transaction stakes (a real
NFT and a real sale, not a fee-sized risk). Recommend landing MS-2 and
MS-1 before continued active use for real trades of meaningful value;
current single-operator, attentive-use usage (reading Simulate's output
before every Sign & Submit, as the UI's own flow already encourages) is
reasonably safe in the interim, since Simulate against the real chain
would itself surface a materially wrong price or a wrong NFT as an
execution-time mismatch in most realistic tampering scenarios, even though
that is not the same as a structural guarantee.
