# Resize Claim Production-Safety Audit — 2026-09-12

Scope: `https://victorylabs.app/tools/resize-claim`. Read-only adversarial
audit. No code changed, no commit, no deploy action taken *by this audit*
(a prior, unrelated GhostBid deploy in this same session already built and
shipped this code — see §2), no signing, no broadcast, no real claim, no
real resize. All on-chain interaction in this audit was `getAccountInfo` /
`getTransaction` / `simulateTransaction` (`sigVerify: false`) — reads and
one dry-run simulation, never a signed or broadcast transaction.

## 1. Repo / branch / HEAD / git status

- Repo: `/root/nft-live-feed`. Branch: `rollback-aug3`. HEAD:
  `97f523e428c68e054380fd8ca5f9fd9a2ea2fd59` ("fix(ghostbid): harden
  refresh correctness and snapshot disclosure").
- `git status --short` scoped to this feature:
  ```
  ?? frontend/src/app/tools/resize-claim/
  ?? src/resize-claim/
  ?? src/server/tools-resize-claim.ts
  ```
  All three are **untracked (`??`)** — not modified-tracked, **untracked
  from scratch**. `git ls-tree -r HEAD --name-only | grep resize-claim`
  returns nothing: this feature has **never been committed**, not even in
  an earlier form. There is no git history, no diff, nothing to `git show`.
- The route is mounted via a change to `src/server/app.ts` (tracked,
  **dirty**, not committed) and the tools-index/prefetch entry lives in
  `frontend/src/soloist/shared.tsx` (also tracked + dirty). Both diffs were
  read (not touched) — `app.ts`'s dirty diff adds `createResizeClaimRouter`
  import + `app.use('/api', createResizeClaimRouter())`; `shared.tsx`'s
  adds a `RESIZE CLAIM` nav entry and a `/tools/resize-claim` prefetch URL.
- 69 other dirty/untracked entries exist repo-wide (pre-existing, unrelated
  WIP — HAR captures, scratch scripts, other in-progress tools). **None
  were touched, staged, or read beyond what was necessary to establish this
  section.**

## 2. Production parity — Resize Claim is 100% uncommitted, and it is LIVE

This is the headline structural finding, stated plainly per the spec's
§31 instruction:

**Production is currently serving Resize Claim entirely from uncommitted
source.** Concretely, in the immediately preceding session on this same
VPS, an unrelated GhostBid hardening deploy ran `npm run build` (backend,
plain `tsc` — compiles the *whole* `src/` tree regardless of git status)
and `./deploy-frontend.sh` (frontend build-and-swap). Both picked up every
dirty/untracked file, resize-claim included, as a side effect:

| | source mtime | dist/.next mtime |
|---|---|---|
| `src/server/tools-resize-claim.ts` | 2026-09-11 20:09:29 | `dist/server/tools-resize-claim.js` → 2026-09-12 19:03:32 |
| `src/resize-claim/{build,program,proof,scan}.ts` | 2026-09-09 | matching `dist/resize-claim/*.js` → 2026-09-12 19:03:32 |
| `frontend/.../resize-claim/page.tsx` | 2026-09-11 20:10:31 | `.next/server/app/tools/resize-claim.html` → 2026-09-12 19:04:31, BUILD_ID `vtiNGOuFoJ-FZihLKXRNZ` |

Live confirmation performed in this audit: `GET /api/tools/resize-claim/scan`
(no token) → **401** (route mounted, auth enforced — not 404); `GET
/tools/resize-claim` → **200**. The feature is also **discoverable**, not
hidden staging: `frontend/src/soloist/shared.tsx` (dirty, uncommitted)
lists it in the TOOLS nav as `RESIZE CLAIM` and in the route-prefetch list.

**This is not a security vulnerability by itself** (per the spec's own
framing) — the code that's running is exactly the code in this audit's
scope, so the audit's findings apply directly to production. But it is a
**serious reproducibility/ops risk**: there is no commit to roll back to,
no code review trail, no diff anyone could `git blame`, and a `git stash`,
`git clean -fd`, or an unrelated `git checkout <path>` touching any of
these three untracked paths would silently delete a live, in-nav,
fund-adjacent production feature with no recovery path except this
audit's file listing. Flagged for the operator's awareness, not treated as
a CVE-style finding.

## 3. Architecture map

```
Browser (frontend/src/app/tools/resize-claim/page.tsx, 'use client')
  │  GET  /api/tools/resize-claim/scan?wallet=<w>        (Bearer, authHeaders())
  │  POST /api/tools/resize-claim/build   {wallet,claims,resizes}
  │  [Phantom: sol.signAllTransactions(all txs, ONE approval)]
  │  POST /api/tools/resize-claim/send-tx {tx}  × N  (sequential, per signed tx)
  ▼
Express router (src/server/tools-resize-claim.ts, mounted in app.ts)
  │  requireAuth (shared-secret HMAC bearer, same as every other /tools/* route)
  │  rateLimit: scan 20/min, build 60/min, send-tx 200/min (per IP)
  ▼
  scan  → src/resize-claim/scan.ts
            ├─ Helius DAS getAssetsByOwner (enumerate held legacy/pNFT mints)
            ├─ src/resize-claim/proof.ts → POST resize.metaplex.com/nft_resize
            │    (third-party Next.js Server Action — proxied, not ours)
            └─ conn.getMultipleAccountsInfo (ClaimReceipt PDA existence,
               Metadata account `space` for the not-in-tree tail)
  build → src/resize-claim/build.ts + program.ts
            ├─ conn.getLatestBlockhash
            ├─ conn.getAddressLookupTable (shared Metaplex ALT, cached)
            └─ compiles unsigned VersionedTransaction(s) — NO signing,
               NO private key, ever, anywhere in this process
  send-tx → thin broadcast proxy: rpcPost('sendTransaction', [tx,
            {skipPreflight:true, maxRetries:3}]) — forwards an ALREADY
            wallet-signed tx to the RPC, returns the signature. No signing
            here either.
```

- Solana SDK: `@solana/web3.js` + `@solana/spl-token` (ATA derivation only,
  no Token-2022 import anywhere in this feature).
- On-chain programs touched (read-only account derivation + unsigned ix
  construction, never invoked directly by this backend):
  - `mpl-token-metadata` (`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`) —
    the `Resize` fallback path.
  - `mplDistro` (`RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4`) — the
    primary `DistributeToLegacyNft` claim path.
- RPC: Helius (`HELIUS_API_KEY`), fallback public mainnet-beta if unset;
  `scan.ts` additionally *requires* `HELIUS_API_KEY` for DAS (`getAssetsByOwner`
  has no public-RPC equivalent) — the route explicitly 502s with
  `helius_api_key_not_configured` rather than silently degrading.
- Third-party dependency: `resize.metaplex.com`'s own Next.js Server Action
  (`proof.ts`) — an unauthenticated, undocumented, `Next-Action`-hash-keyed
  endpoint with no SLA. This is the single largest *fragility* surface in
  the whole feature (see §18, §25) but, per the design, a failure here
  degrades to "proof lookup failed, rescan" — never to a wrong claim.
- No backend signer, no backend keypair, no `Keypair` import anywhere in
  `src/resize-claim/*` or `src/server/tools-resize-claim.ts` — confirmed by
  reading every line of all 5 files. §11's "aggressive backend-signer
  inspection" concludes: **there is no backend signer to inspect.** The
  file headers' own claim ("No key ever touches this process") is
  code-verified true, not merely asserted.

## 4. Supported actions (from code, not the tool's name)

| Action | Supported? | Evidence |
|---|---|---|
| Detect oversized Solana accounts | Yes | `scan.ts` `metadataSpaces()` + `RESIZED_METADATA_MAX_SPACE` threshold |
| Realloc/resize (shrink) | Yes | `program.ts` `buildResizeIx` — mpl-token-metadata `Resize` (disc 56) |
| Rent refund via resize | Yes (delegated) | freed rent → `payer` per the real program's own logic; **we pass zero size/amount parameters** — see §9 |
| Merkle-drop claim (fixed reward, not rent-difference) | Yes | `buildDistributeToLegacyNftIx` — mplDistro `DistributeToLegacyNft` (disc 5) |
| Closing accounts directly | No | no `close`/`CloseAccount` instruction anywhere in this feature |
| Claim creation/redemption | Yes (claim only, no separate "creation") | one-shot: build → sign → send |
| NFT/SPL/Token-2022 resizing | Legacy Token Program ATA derivation only | `getAssociatedTokenAddressSync` from `@solana/spl-token`; **no Token-2022 program ID anywhere in this feature** — see §21 |
| Backend-signed or backend-broadcast transactions | No | `/build` returns unsigned bytes; `/send-tx` forwards an already-signed tx; neither touches a key |
| Third-party-built transactions | No | both instruction builders are ours (`program.ts`), reverse-engineered, now empirically verified (§27) |
| One-time claim IDs/nonces | Yes, on-chain only | ClaimReceipt PDA is the sole uniqueness mechanism — see §11 |
| Batch/multi-item actions | Yes | one Phantom approval covers N claim txs + M resize-packed txs (8 resizes/tx) |

Two **materially different** on-chain paths exist and are traced
separately throughout this report: **Claim** (`DistributeToLegacyNft`,
merkle-gated, fixed wSOL reward, ALT-compressed, no ComputeBudget ix) and
**Resize** (`Resize`, no proof needed, packed 8-per-tx with
ComputeBudget). They are never collapsed into one flow in this audit.

### Per-action lifecycle trace

**Claim:**
UI intent (click "Claim") → *no fresh eligibility check* (uses the
already-fetched `scan.claimable` verbatim, see §12) → `POST /build` with
`{mint, amountLamports, proof}` per item, straight from the stale scan →
backend re-validates *shape* only (valid pubkey, numeric string, proof
array 1-32 entries — **not** the proof's cryptographic validity, deferred
to the on-chain program by design, see file header) → unsigned
`VersionedTransaction` per claim, fresh blockhash, ALT-compressed → no
backend simulation step at all → one Phantom `signAllTransactions`
approval for the whole batch → sequential `POST /send-tx` per signed tx
(`skipPreflight:true`) → **no confirmation step anywhere** → UI jumps
straight to `done` the instant every `sendTransaction` call *returns a
signature* (§14/§15/§16 — this is the single most important finding in
this report).

**Resize:**
Same shape, packed 8-per-tx with `ComputeBudgetProgram.setComputeUnitLimit`
+ `setComputeUnitPrice` (default 20 000 µLamports, client-bounded 0-5M —
see §22), same no-confirmation ending.

## 5. State machine

```
idle → (connect) → scanning → scanned
                                 │  (canAct: scanned OR error, with claimable>0 or resizable>0)
                                 ▼
                              building → signing → sending → done
                                 │                              
                                 └──(any throw)──────────────→ error{scan}  ──(user re-clicks Claim)──→ building (SAME stale scan)
```

Unsafe transitions found, both **PROVEN** by reading `page.tsx`:

1. **`error → building` reuses the original, never-narrowed `scan` object.**
   `canAct` (`page.tsx:119-120`) is `true` for `ui.kind === 'scanned' ||
   ui.kind === 'error'`. `handleClaimAll` (`page.tsx:83-111`) always reads
   `scan.claimable` / `scan.resizable` from whatever `ScanResult` is
   attached to the current `ui` state — after an error mid-batch, that's
   still the **original, full, un-rescanned** list, not narrowed to
   whatever didn't complete. See §16 for the concrete consequence (wasted
   fees, not double-payment — the on-chain program's own idempotency
   contains the worse outcome).
2. **`sending → done` requires only that `sendTransaction` returned a
   signature, never that the transaction landed/succeeded.** `handleClaimAll`
   (`page.tsx:100-107`) calls `signAllVersionedAndSend` and on its Promise
   *resolving* (not on any confirmation) sets `{ kind: 'done', scan, sigs }`
   unconditionally. `signAllVersionedAndSend` itself
   (`frontend/src/wallet/phantom.ts:298-325`) contains **no confirmation
   logic whatsoever** — it signs, calls `backendSendRaw` (→ `/send-tx` →
   `sendTransaction` with `skipPreflight:true`), and returns the signature
   the instant the RPC accepts the tx into its queue. This is `unknown →
   done`, not `confirmed-success → done`. **HIGH finding, §16/§20.**

No `idle → idle` double-claim path exists (the button is genuinely gated
on `scan` being present), and no partial-batch item-level retry exists
(§17's "batch" concerns collapse to: *the whole set is retried, or
nothing is* — see §16).

## 6. Trust boundary

**Case A** throughout: the frontend (`build.ts`, running server-side but
producing bytes the client never independently re-derives) constructs the
unsigned transaction; the **connecting wallet is the only signer and only
fee payer** for every instruction this feature ever builds
(`nftOwner: payer` in `build.ts:118`, `holder: payer` in `build.ts:140` —
`payer` is *always* `new PublicKey(opts.wallet)`, the caller's own
requested wallet, never a distinct field). There is no backend co-signer,
no third-party-returned transaction bytes signed blind (the *proof* comes
from a third party, but the *instruction* is built entirely by our own
`program.ts`, using that proof only as opaque instruction data whose
validity the on-chain program alone adjudicates).

Because the sole authorizer is always the tx's own fee payer/signer, the
classic "attacker redirects someone else's refund" trust-boundary attack
is **structurally foreclosed by construction**, independent of anything
the backend or a malicious client could do to the `/build` request body:
even if a caller submitted a `claims[].mint` for an NFT they don't
actually hold, `nftOwner` in the resulting instruction is still pinned to
`wallet` (= the signer), so the wSOL reward's destination ATA
(`ATA(wSOL, nftOwner)`) is always the signer's own account — there is no
field anywhere in the request body that lets a caller name a *different*
recipient. See §12 for the on-chain enforcement that makes this hold even
adversarially (not just "our code doesn't expose the field").

## 7. Eligibility model

Authoritative source: **live on-chain reads at scan time only** — Helius
DAS for current holdership (`ownership.owner === wallet`, excludes
`burnt`/`compressed`), `getMultipleAccountsInfo` for ClaimReceipt PDA
existence, `getMultipleAccounts` (raw, for the `space` field) for the
not-in-tree Metadata-size fallback. **Not** a backend cache, **not** an
offline snapshot (contrast GhostBid's audit, where eligibility genuinely
is a stale offline dataset — this tool has no such artifact at all).

Eligibility is **not re-verified between scan and build/sign** — `/build`
takes the client-supplied `claims`/`resizes` arrays at face value (shape-
validated only). This is a real TOCTOU window (§13) but, per the spec's
own instruction to distinguish "stale UI" from "unsafe final tx": the
final authority is the on-chain program, which **fails closed** on every
adversarial mutation of the eligibility-relevant state:
- NFT sold/transferred away between scan and send → `nftTokenAccount`
  (derived from `wallet`, not looked up fresh) will not hold the mint at
  execution time → program rejects (insufficient balance / owner
  mismatch).
- Claimed elsewhere (another tab, or via resize.metaplex.com directly)
  between scan and send → ClaimReceipt PDA now exists → program error 18
  `AlreadyClaimed`.
- Metadata already resized by someone else → program error 201
  `AccountAlreadyResized`.

**Verdict: eligibility staleness is a real, provable gap, but it degrades
to a failed (fee-wasting) transaction, never to an incorrect claim.**
Rated MEDIUM in §29, not HIGH/CRITICAL — see reasoning there.

## 8. Instruction/program/account matrix

### `DistributeToLegacyNft` (disc 5, program `RSZE1Ng...`)

| # | Account (our builder) | Signer | Writable | Verified against 3 real live txs? |
|---|---|---|---|---|
| 0 | `TM_RESIZE_DISTRIBUTION` | N | Y | ✅ identical |
| 1 | `WSOL_MINT` | N | N | ✅ identical |
| 2 | `claimReceipt` PDA | N | Y | ✅ (varies per-mint as expected) |
| 3 | `recipientWsolAta = ATA(wSOL, nftOwner)` | N | Y | ✅ (identical across the 3 real txs — same claiming wallet) |
| 4 | `distributionVault` | N | Y | ✅ identical |
| 5 | `nftMint` | N | N | ✅ (varies per-mint as expected) |
| 6 | `nftAta = ATA(nftMint, nftOwner)` | N | N | ✅ (varies per-mint as expected) |
| 7 | `nftOwner` **(our label)** | N | N | ⚠️ **real txs carry the program's OWN pubkey (`RSZE1Ng...`) at this slot, not the wallet** — see discrepancy note below |
| 8 | `payer` | **Y** | Y | ✅ identical (= the claiming wallet, matches slot 7's semantic role in every real tx observed) |
| 9-12 | ATA program / Token program / SystemProgram / SysvarInstructions | N | N | ✅ identical |

**Discrepancy, resolved empirically (§27):** live-decoded historical
transactions (3 independent signatures, live mainnet) consistently carry
the **mplDistro program's own address** at account index 7, not the NFT
owner's wallet — contradicting this file's own doc comment ("7 nftOwner
(r)"). Read alone, this looks like a real account-order bug. **It is not
one in practice**: a from-scratch read-only `simulateTransaction`
(`sigVerify:false`, no signature, no broadcast) of our own production
builder's exact output — for a real wallet's real current claim,
end-to-end through `scanWallet()` → `buildTransactions()` — **executed
successfully against the live program** (`err: null`, full success logs,
including the nested `CreateIdempotent` ATA-creation CPI and the
System-Program account-funding CPI), proving the on-chain handler does
not actually validate whatever pubkey sits in that slot. **The
documentation comment is wrong about what that account *represents*; the
code's *behavior* is correct and empirically proven, not merely assumed.**
Recorded as a doc-only defect, not a functional one — see §32 for the
one-line comment fix.

### `Resize` (disc 56, program `metaqbxx...`)

7 accounts, matches `program.ts`'s documented shape. **Not independently
live-verified this session** — no wallet with a currently-resizable (i.e.
not-yet-shrunk AND not-in-tree) legacy NFT was found among the 3 real
candidate wallets sampled from recent on-chain activity (all had
`resizable: 0`). Stated as an audit limitation (§34), not glossed over.
The `Resize` instruction takes **zero data beyond the bare discriminator
byte** (`Buffer.from([56])`) — there is no length/target-size argument for
our code to get wrong; 100% of the resize-safety logic (§20/§21 below)
is delegated to Metaplex's own deployed program.

Both `payer` and `holder` (`buildResizeIx`, `program.ts:190-212`) are
marked `isSigner: true`; `build.ts` always sets `payer = holder = payer`
(the single connecting wallet) — this is a single real signature
satisfying two signer slots that happen to be the same key, not two
independent signers. Confirmed no code path ever supplies a different
`payer`.

**Adversarial substitution test (per spec §4/§19), both paths:** since
`nftOwner`/`holder`/`payer`/fee-payer are *all* hardcoded to the one
`wallet` string in the request body, and that same string is the *only*
signer the resulting transaction will ever accept, there is no reachable
code path — malicious request body, compromised `/build` response, or
otherwise — that changes: target account (fully determined by `mint`,
itself pinned into the ClaimReceipt PDA and the merkle proof for claims),
refund/reward recipient (always `ATA(*, wallet)`), authority, or fee
payer, without also changing what wallet must sign — at which point it is
simply a different (equally self-authorized) transaction for that wallet,
not a hijack of anyone else's.

## 9. Refund/rent math

**There is none in our code, by design, for either path:**
- **Claim:** `amountLamports` is a fixed, pre-computed payout baked into
  the merkle leaf by Metaplex when they built the 21.7M-leaf tree; our
  code never computes it, only relays whatever the proof endpoint (or the
  client, shape-validated only) supplies. The amount is **cryptographically
  pinned** — the on-chain program verifies the merkle proof against
  `(mint, amount, index)` (or equivalent), so supplying a wrong amount
  fails proof verification (error 17), it does not pay out a wrong amount.
- **Resize:** the instruction carries no amount/size argument at all;
  "freed rent → payer" is entirely mpl-token-metadata's own internal
  logic, using the account's actual pre/post size, which our code never
  reads or asserts.

**Conclusion: §9's entire risk category (integer overflow, rounding,
float/lamport conversion, stale-balance math) does not apply to this
codebase — there is no rent/refund arithmetic in it to get wrong.** The
one lamport-adjacent computation in the whole feature is purely cosmetic:
`lamportsToSol()` (`page.tsx:45-47`, `Number(lamports)/1e9`, display only,
never fed back into a transaction) and the `totalClaimLamports` sum
(`page.tsx:118`, also display-only, `Number()` on a string that is at most
~10 digits — no precision loss risk at that magnitude, and not order-
sensitive since it's a plain sum for display).

## 10. Ownership/authority model

Both instructions require the wallet to *already hold* the NFT (verified
on-chain by the program via the deterministic ATA-derivation + balance
check inferred from behavior, not from a published IDL — see §27's
empirical proof) — our own code adds no additional authority check of its
own, and needs none, because it can only ever build a transaction that
*that exact wallet* can sign for itself. `assertPhantomWallet(opts.wallet)`
inside `signAllVersionedAndSend`/`signAllAndSend`
(`frontend/src/wallet/phantom.ts:266/306`) additionally fails closed
**before** the single approval prompt if the actively-connected Phantom
account has drifted from the wallet the intent was frozen against — this
is an existing, general-purpose (shared-module) protection that
**resize-claim inherits for free** and that **must not be weakened** (§31).

## 11. Claim uniqueness / replay protection

**Enforced entirely on-chain, correctly, and is the single most important
safety property this feature has:**
- **Claim:** ClaimReceipt PDA — seeds `["claim_receipt", distribution,
  nftMint, u64le(amount), u64le(nonce=0)]` under the mplDistro program.
  Created idempotently by the program itself on first successful claim;
  any second claim attempt for the same mint (same tx resubmitted, a
  retried rebuild, two browser tabs, concurrent claim from
  resize.metaplex.com's own UI) fails on-chain with `AlreadyClaimed` —
  **the second signer never receives a second payout.**
- **Resize:** `AccountAlreadyResized` (error 201) on any second attempt
  once the Metadata account is already at its shrunk size.

Our own application layer adds **zero** duplicate-prevention of its own
(no database row, no nonce, no consumed-flag) — and, per the spec's own
"do not automatically demand X" guidance, **that is correct here, not a
gap**: the protocol itself is the authoritative source of "has this been
claimed," multiple tabs/backends/retries all converge on the same on-chain
truth, and adding an application-layer duplicate-guard on top would only
risk *diverging* from that truth (e.g. a false "already claimed" if our
own tracking got out of sync). **PRESENT, correctly delegated — flagged
as a mitigation that must not be "improved" by adding a parallel,
potentially-inconsistent application-layer claim ledger.**

## 12. Frozen-intent analysis

Fields the user is shown and relies on: which mints are `claimable` /
`resizable`, the total SOL figure, `wallet` (displayed, connected).
**None of these are re-read live between "scanned" and "signing"** — the
same `ScanResult` object flows unchanged from `handleScan` through
`handleClaimAll` into the built transactions. Per §5's REVIEWED ==
FINAL == PRE-SIGN invariant: **this holds for identity fields (mint,
wallet — pinned into the tx and enforced on-chain) but not for
liveness fields (still-eligible, still-unclaimed, still-oversized)** —
which is exactly the TOCTOU gap already covered in §7, with the same
fail-closed-on-chain conclusion. No additional finding beyond §7/§16.

Wallet-switch-mid-flow is explicitly guarded (`assertPhantomWallet`, §10)
— tested by reading the call site: it runs *before* `signAllTransactions`,
i.e. before the single Phantom approval, for both `signAllAndSend` and
`signAllVersionedAndSend`. **PRESENT.**

## 13. Structural tx validation (frontend auditing backend/self output)

There is **no** independent structural re-check of the compiled
transaction bytes before signing (no Candy-Mint-style `auditCandyMintTx`
equivalent exists for this tool) — the frontend trusts `build.ts`'s output
as-is. Assessed practical exploitability: **effectively none**, because
(a) `build.ts` runs in the *same trusted backend process* as
`tools-resize-claim.ts` (not a third-party API whose response could be
tampered with in transit by an outside attacker in a way this app doesn't
already assume HTTPS defends against), and (b) even a compromised/buggy
`build.ts` output is still bounded by §6/§8's structural argument: the
only signer is the wallet itself, so the *worst* a malformed build could
do is get the wallet to sign a transaction that fails on-chain or (in the
most adversarial hypothetical, a fully compromised backend) constructs an
UNRELATED instruction the wallet wouldn't recognize from the UI's
description — which is a generic "backend integrity" concern that applies
equally to every tool in this repo already gated behind the same
`requireAuth` + operator-only deployment model, not a resize-claim-
specific finding. Not scored as a distinct bug; noted as a structural
absence per the spec's completeness requirement.

## 14. Simulation / final-byte verification

**No simulation occurs anywhere in the production code path** — not
before signing, not before sending (`/send-tx` explicitly passes
`skipPreflight: true`). This audit performed the *only* simulation this
transaction shape has ever had, read-only, in §27/§8, and it succeeded.
In production, the first time the real program logic runs for a given
claim is at actual broadcast time. Given §16's finding (no confirmation
either), this compounds: a transaction that would have failed simulation
(e.g. already-claimed) is discovered only by the user manually opening the
Solscan link the UI hands them — the UI itself never notices.

## 15. Blockhash lifecycle

`getLatestBlockhash('confirmed')` fetched fresh on every `/build` call
(`build.ts:104-105`) — not cached, not reused across requests. No
post-sign blockheight/expiry check exists anywhere (no
`lastValidBlockHeight` comparison before `/send-tx`), and no rebuild is
forced if the wallet prompt sits open a long time — but since claims omit
ComputeBudget/priority entirely and resizes use a modest default, and
`sendTransaction` itself will simply be rejected by the cluster if the
blockhash has aged out (standard Solana behavior, not something this code
needs to special-case), a stale blockhash degrades to a **clean,
detectable-by-signature-absence failure**, not a silent bad outcome — this
is the *one* place §16's "unknown-outcome" concern is actually *less* bad
than the AlreadyClaimed race, because an expired-blockhash transaction
provably never executes program logic at all (still surfaces via §16's
missing-confirmation gap, but at least never partially runs).

## 16. Confirmation/reconciliation matrix — **the headline finding**

| State | Distinguished? |
|---|---|
| Confirmed success | **No** — `sendTransaction` returning a signature is treated as terminal success |
| Confirmed on-chain failure | **No** — no `getSignatureStatuses`/`getTransaction` call exists anywhere downstream of send |
| Submitted-but-unresolved | Not modeled — collapses into "done" |
| Never broadcast (pre-send throw) | Yes — falls into `error` state correctly |

`GhostBid` and `Candy Mint`'s audits in this same repo both centered on
exactly this class of bug; **Resize Claim has no equivalent hardening at
all** — it is closer to the *pre-hardening* baseline those tools started
from. **Rated HIGH** (per the spec's own severity rubric: "false success
causing material loss" — a user who sees "Done" for an `AlreadyClaimed`-
failed claim reasonably believes they now have wSOL they don't have, and
has no in-app signal to the contrary).

## 17. Unknown/retry safety

Traced concretely in §5/§16: retry-from-error resubmits the **entire**
original `claims`+`resizes` set (not narrowed to whatever didn't
complete), because `scan` is carried through unmutated. Consequence,
precisely bounded by §11's on-chain idempotency:
- **Claims that already landed:** resubmission fails cleanly
  (`AlreadyClaimed`) — no double-payout, but the wallet **pays a real
  ~5000-lamport base fee per stale claim tx** for a transaction guaranteed
  to fail, and (since claims carry no priority fee at all — see §22 — this
  is not amplified by priority fees, only the base fee).
- **Claims that never landed:** correctly resubmitted, functions as
  intended.
- **At scale** (the header comment's own stated design target — "a wallet
  with many claimable NFTs" — is explicitly multi-hundred): a wallet with,
  say, 50 claimable NFTs where item 30 throws mid-batch and the user
  retries **rebuilds and re-signs all 50**, of which 29 will burn a fee
  and fail. **Rated MEDIUM** — real SOL cost, but self-inflicted by the
  operator's own retry, individually fail-closed, and boundable (worst
  case ≈ batch-size × 5000 lamports, not unbounded).

## 18. Batch/partial semantics

One Phantom approval signs the *entire* batch up front
(`sol.signAllTransactions(txs)`); broadcast is then sequential, one
`/send-tx` call per signed tx, inside a plain `for` loop with **no
try/catch per item** (`phantom.ts:313-323`) — the *first* item whose
`backendSendRaw` call throws (e.g. a transient `send-tx` 502) aborts the
loop entirely, meaning every item *after* it in the batch was already
signed by the user but is **never sent at all**, silently. There is no
per-item signature tracking surfaced to `page.tsx` beyond the
`onSubmitted` callback (which only fires for items that *succeeded* their
`backendSendRaw` call) — a thrown exception mid-loop reaches
`handleClaimAll`'s catch block with **no record of which of the N items
were actually submitted** before the throw, beyond whatever partial
`sigs` array `signAllVersionedAndSend` had accumulated internally (which
is then **discarded**, since the function throws rather than returning
the partial list). **Rated MEDIUM** (compounds with §17: the user cannot
even tell the app "these 12 already sent, only retry the rest" — they can
only "Claim" again with the full stale set).

## 19. Program/layout/version safety

No layout/version dispatch exists in this code at all — `ELIGIBLE_INTERFACES
= {V1_NFT, LEGACY_NFT, ProgrammableNFT}` is the only gate, sourced from
Helius DAS's own `interface` classification (a well-maintained, widely-
used third-party classifier, not something this code re-implements). An
"unsupported layout" (e.g. a future Token-Metadata version this DAS
classification doesn't recognize) is **excluded up front** by that
allowlist — `enumerateEligibleMints` (`scan.ts:99-106`) is a strict
allowlist filter, not a denylist, so an unknown/future interface value is
silently **excluded from consideration**, which is the correct fail-closed
direction. **PRESENT.**

## 20. Close/realloc semantic hazards

As established in §8/§9: our code supplies **zero** size/target
parameters to the `Resize` instruction — it is a bare 1-byte-discriminator
call. Every hazard this section asks about (data truncation, zero-init,
rent-exemption after realloc, whether shrinking destroys a
not-yet-understood trailing field) is **entirely Metaplex's own program's
responsibility**, not this codebase's. This audit cannot verify Metaplex's
own program's internal resize-safety logic (that would require auditing
`metaqbxx...`'s deployed bytecode/source, out of scope for a Resize-Claim-
*tool* audit) — but this tool's contribution to that risk is **zero by
construction**, which is the strongest possible position a *client* of
someone else's resize primitive can be in.

## 21. Token / Token-2022 safety

**NOT APPLICABLE.** `grep -i token-2022|token2022|TOKEN_2022` across all
5 resize-claim files returns nothing; only `@solana/spl-token`'s legacy
`TOKEN_PROGRAM_ID`/`ASSOCIATED_TOKEN_PROGRAM_ID` are imported
(`program.ts:39-43`). `ELIGIBLE_INTERFACES` (§19) never includes any
Token-2022-flavored DAS interface value. There is no code path by which
this feature could ever touch an extension-bearing account.

## 22. Backend auth/signing boundary

Already covered in depth (§3, §6): **no backend signer exists.** Auth
boundary is the same `requireAuth` shared-secret bearer used everywhere
else in this app (12h TTL, `timingSafeEqual`) — not wallet-bound, but
(per §6/§10) **doesn't need to be**, since every dangerous action still
requires the *target* wallet's own Phantom signature regardless of which
authenticated operator triggered the `/build` call. Input validation on
`/build` (`parseClaims`/`parseResizes`, `tools-resize-claim.ts:52-78`):
strict pubkey validation, numeric-string-only `amountLamports` (regex
`/^\d+$/`, rejects negative/scientific-notation/decimal), proof array
bounded `1..32` entries each pubkey-shaped, `priorityMicroLamports`
bounded `[0, 5_000_000]` and floored to an integer. **All fields are
schema-validated before use; no arbitrary-shape data reaches
`buildTransactions`.**

`/send-tx`: accepts one field, `tx` (a string), forwards it verbatim to
`sendTransaction` — this is, by design, a generic authenticated
broadcaster (same category the spec explicitly says is *not* automatically
a finding: "backend accepts signed transaction bytes for broadcast" only
matters if it *also* signs or if the auth gate is missing; neither is true
here). Rate-limited 200/min — generous but bounded, and every broadcast
still requires a real Phantom-produced signature the backend cannot forge.

Error responses on all 3 routes return `(err as Error).message` verbatim
(`tools-resize-claim.ts:103,147` — no `String(err)`-to-generic-string
sanitizer of the kind GhostBid's audit flagged as GB-5; this file **does
have the equivalent, unaddressed, un-hardened issue**). Rated LOW (same
reasoning as GhostBid's GB-5: auth-gated, no stack trace, at most an
internal error string leaks to an already-authenticated caller) but noted
explicitly since it's the same defect class this repo has already fixed
once elsewhere and left unfixed here.

## 23. Concurrency/re-entrancy

Two tabs / double-click scenario is the concrete mechanism behind §16's
headline finding — traced precisely: tab A and tab B both scan the same
wallet, both see the same `claimable` mint, both build+sign+send. Whichever
lands first creates the ClaimReceipt PDA; the second's transaction is
submitted (gets a signature, UI says "Done") but fails on-chain. **Both
tabs show success. Only one actually received the payout.** This is the
single most concrete, user-triggerable reproduction of the false-success
bug — no attacker or third party needed, just an impatient user opening a
second tab while the first is mid-flow (a very ordinary real-world action
this specific tool's own UI does nothing to discourage: no
cross-tab/localStorage lock, no warning).

## 24. RPC/API timeout derivation

- DAS `getAssetsByOwner`: `AbortSignal.timeout(15_000)` per page, up to 25
  pages (`scan.ts:28-29,79`) — bounded, ~6.25 min worst case for a
  maximally-sized (25k-asset) wallet; realistic wallets are far smaller.
- Proof endpoint: `REQUEST_TIMEOUT_MS=20_000`, `MAX_RETRIES=3`, exponential
  backoff (`proof.ts:35-37`) — per 100-mint batch, worst case ~80s before
  falling into `failedMints`. Sequential across batches (deliberately
  polite to a third party with no SLA) — a 1000-NFT wallet with a fully
  down proof endpoint could take **~13 minutes** to exhaust all batches'
  retries. No client-side timeout wraps the whole `/scan` call in
  `page.tsx` — the browser simply waits. **LOW** (same class as GhostBid's
  GB-3, correctly not "fixed" there either per that audit's own
  reasoning — bounded, authenticated, rate-limited, not an abuse vector).
- `send-tx`: no explicit timeout override visible in `rpcPost` at this
  call site — inherits whatever `tools-mmm-pools.ts`'s shared `rpcPost`
  helper's default is (not re-audited here; shared module, out of this
  feature's scope per §32).

## 25. UI truthfulness

- **"Done" claimed before confirmation** — already the headline finding
  (§16/§23). This is the one UI-truthfulness defect that materially
  matters here.
- `claimable`/`resizable`/`alreadyClaimed`/`proofUnknown` counts
  (`page.tsx:143-155`) accurately reflect the `ScanResult` fields with no
  mismatch found — `proofUnknown` is correctly surfaced distinctly
  ("proof lookup failed (rescan to retry)") rather than being folded into
  "ineligible," matching `proof.ts`'s own documented "unknown ≠
  ineligible" contract.
- The claim total (`totalClaimLamports` → SOL) is computed from the
  scan's own `amountLamports` figures (merkle-tree-fixed, per §9) — an
  accurate *estimate of what the still-unclaimed set is worth*, correctly
  never claimed as "refunded" past-tense until `done`, at which point it's
  wrong for the reason already covered in §16, not from a display-math
  error.
- Explorer links (`solscan.io/tx/${sig}`) use the real, actual returned
  signature — not a fabricated or wrong one.

## 26. Existing tests

**None.** `find . -iname "*resize-claim*test*"` (repo-wide, excluding
`node_modules`) returns nothing. Confirmed via direct search — no unit
tests, no fixture-based tests, no synthetic-tx tests exist for any of the
5 files in this feature. This is the largest, most consequential test gap
of any tool audited in this repo so far, precisely because (§2) this is
also the *only* audited tool currently running from wholly uncommitted
source — there has never been a commit boundary at which tests would
normally be added.

## 27. Real-builder / live-read verification evidence

Performed in this audit, entirely read-only:

1. **Historical transaction decoding** — pulled 3 real, successful
   (`err: null`) `DistributeToLegacyNft` signatures from mainnet via
   `getSignaturesForAddress`/`getTransaction` against the live
   `RSZE1NgJy3zdmyTWPeT4yKbsUrhAwrh4mXBL1rMvHt4` program, decoded full
   account lists, cross-referenced every slot against `program.ts`'s
   builder. Found and resolved the account-#7 documentation discrepancy
   (§8).
2. **End-to-end live simulation of our OWN production code** — ran
   `scanWallet()` against a real wallet
   (`PERvL5nfNWxQnwanYTPp71GeJCXfAMoqzrYA4XZ4m3U`, discovered via the same
   on-chain signature history, not hand-picked), found one genuinely
   currently-claimable NFT (`mGDQBttsyXYcmePafmQgjzUqwGGnAMrWQ4f3651nt9B`,
   2 324 640 lamports), fed the resulting real proof+amount into
   `buildTransactions()` (our actual production builder, unmodified),
   then called `simulateTransaction` on the exact resulting base64 bytes
   with `sigVerify: false` (no key, no signature, nothing broadcast).
   **Result: `err: null`, `unitsConsumed: 46610`, full success log trace**
   including the nested `CreateIdempotent` ATA-creation CPI and the
   3-step System Program account-funding CPI
   (`Transfer`/`Allocate`/`Assign`) inside the program's own execution —
   i.e. the *entire* real on-chain claim logic ran to completion against
   our exact production bytes and succeeded. This is the strongest form
   of evidence this audit methodology allows for (§30: "use the ACTUAL
   production builder against read-only live accounts... verify exact
   target, owner, size, refund destination, instruction matrix") without
   crossing into signing/broadcasting.
3. **Constant sanity checks**: `TM_RESIZE_DISTRIBUTION` — confirmed
   on-chain, owner = `RSZE1Ng...`, **exactly 216 bytes** (matches the
   file's own doc comment exactly), 1681.46 SOL balance (plausible as the
   program's own rent-funding reserve for the tree's ~21.7M possible future
   claim-receipt/ATA creations — not something this tool's code touches or
   is responsible for). `CLAIM_ALT_ADDRESS` — confirmed a real, resolvable
   Address Lookup Table (owner = `AddressLookupTab1e...`), and its
   successful resolution was independently confirmed by the built claim
   tx's actual serialized size (1608 base64 chars ≈ 1206 raw bytes,
   matching `build.ts`'s own header-comment claim of "~1206 bytes" and
   safely under the 1232-byte wire limit).

**Limitation, stated plainly**: the `Resize` (fallback) path was **not**
live-simulated — no wallet with a currently-resizable candidate was found
among the 3 real wallets sampled from recent on-chain activity in the time
available for this audit. Its instruction shape is verified only by
reading the code and cross-referencing the documented discriminator (56)
and 7-account layout against the file's own "cross-checked against live
mainnet transactions" claim, which this audit did not independently
re-derive for that specific instruction.

## 28. Shared-code impact

- `frontend/src/wallet/phantom.ts` (`signAllAndSend`,
  `signAllVersionedAndSend`, `assertPhantomWallet`) — **shared with every
  other multi-tx-batch tool in this repo** (confirmed dirty/modified in
  the current working tree independent of resize-claim). §16's missing-
  confirmation gap is a property of *how resize-claim's `page.tsx` calls*
  this shared function (it never adds a confirmation layer on top), **not
  a defect in the shared function itself** — `signAllVersionedAndSend` was
  never designed to confirm; that's each caller's job. Any fix belongs in
  `page.tsx`, not in the shared module, and would have **zero blast
  radius** on other callers of `phantom.ts`.
- `src/server/tools-mmm-pools.ts`'s `rpcPost` — reused by `/send-tx`
  verbatim; not modified, not re-audited here (out of scope, per §32's
  instruction not to touch shared modules).
- `src/server/rate-limit.ts` / `runtime.ts` (`requireAuth`) — same
  instances used everywhere else in this app; unmodified.

## 29. Ranked findings

| # | Severity | Summary |
|---|---|---|
| RC-1 | **HIGH** | UI declares "Done" and shows Solscan links the instant `sendTransaction` returns a signature — never confirms the transaction landed or succeeded. Concrete reproduction: two tabs (or any race with resize.metaplex.com's own official UI) claiming the same NFT — the losing tab shows a green "Done" screen for a transaction that actually failed on-chain with `AlreadyClaimed`. `frontend/src/app/tools/resize-claim/page.tsx:100-107`, `frontend/src/wallet/phantom.ts:298-325` (no confirmation logic exists in either). **PROVEN** (code-level; the race itself not reproduced live in a browser this session — no browser tool available, see §34). |
| RC-2 | **MEDIUM** | Retry-after-error rebuilds and re-signs the *entire* original claim/resize set (never narrowed to the unresolved subset), because the source `ScanResult` is carried through unmutated across `scanned → building → error → building`. Each stale item fails safely on-chain (`AlreadyClaimed`/`AccountAlreadyResized` — no double-payout, protocol-level idempotency holds), but burns a real ~5000-lamport fee per stale item, unboundedly repeatable by re-clicking. `page.tsx:83-120`. **PROVEN.** |
| RC-3 | **MEDIUM** | Sequential per-item broadcast loop (`phantom.ts:313-323`) has no per-item try/catch — the first `backendSendRaw` failure aborts the loop, silently dropping every already-signed-but-not-yet-sent item with no record surfaced to the caller of which items were actually submitted before the throw. Compounds RC-2 (retry can't be scoped to "just the unsent ones" because that information is discarded). **PROVEN.** |
| RC-4 | LOW | TOCTOU: eligibility (`claimable`/`resizable`) is never re-verified between scan and build/sign. Fails closed on-chain in every case traced (§7) — correctness/fee-waste risk, not a fund-safety one. **PROVEN**, severity capped low because of the fail-closed on-chain outcome. |
| RC-5 | LOW | `/scan`, `/build`, `/send-tx` all return `(err as Error).message` verbatim on 500s — same defect class as GhostBid's already-identified-and-unfixed-here GB-5 pattern. Auth-gated, no stack trace. `tools-resize-claim.ts:103,147` (send-tx already returns a generic `'rpc_error'` + message — partially better than the other two). |
| RC-6 | LOW | Doc-comment for `DistributeToLegacyNft` account #7 says `nftOwner (r)`; live-decoded real transactions show the program's own address there instead. **Documentation defect only** — empirically proven not to affect execution (§27). `program.ts:120,167`. |
| — | INFO (ops, not security) | Resize Claim is 100% uncommitted (untracked from scratch) yet fully live, nav-linked, and mounted in production — see §2. Not a vulnerability; a real reproducibility/rollback risk. |
| — | INFO | Proof-endpoint dependency (`resize.metaplex.com`'s undocumented Server Action) is inherently fragile (Next-Action hash can change without notice) but fails safe (`proofUnknown`, never mis-claims eligibility). |

**No CRITICAL findings.** The categories the spec is most worried about
(arbitrary account substitution, backend co-signing attacker bytes, wrong
refund recipient, unsafe truncation, Token-2022 destruction) are all
**structurally foreclosed** by this feature's design: no backend signer
exists, the sole signer is always the acting wallet, the reward/refund
recipient is always derived from that same signer, and all resize-size
math is delegated entirely to Metaplex's own program. The real risk
surface that *does* exist is squarely in the client-side confirmation/
retry layer (RC-1/RC-2/RC-3), which is exactly the class of bug this
repo's Candy Mint and GhostBid audits already found and (for Candy Mint)
fixed elsewhere — Resize Claim simply never received that hardening pass.

## 30. Proven bugs vs. hypotheses

- **Proven (code-level, deterministic):** RC-1 (no confirmation logic
  exists, full stop — not probabilistic), RC-2, RC-3, RC-5, RC-6.
- **Proven (live, empirically, this session):** the `DistributeToLegacyNft`
  builder's exact production output executes successfully against live
  mainnet state end-to-end (§27) — a positive finding, included because
  the spec explicitly asks for real-builder evidence either way.
- **Hypothesis (explicitly not proven, and said so):** the `Resize` path's
  instruction shape was not independently live-simulated this session
  (§27's stated limitation) — assessed as low-risk given it carries zero
  data parameters, but not empirically confirmed the way the claim path
  was.
- RC-1's exact double-tab race was **not** reproduced in a live browser
  this session (no browser tool available) — proven at the code level
  (the confirmation step is simply absent, a deterministic fact, not a
  timing-dependent one to "catch happening"), but the concrete two-tab
  user scenario described was reasoned through, not click-tested.

## 31. Existing mitigations that MUST NOT be weakened

- On-chain ClaimReceipt PDA / `AccountAlreadyResized` idempotency (§11) —
  this is what makes RC-1/RC-2 "wasted fee" bugs instead of "double
  payout" bugs. Any future change must not introduce an application-layer
  claim-tracking mechanism that could ever *override* or race ahead of
  this on-chain truth.
- `assertPhantomWallet` wallet-drift guard before the batch approval
  (§10/§12) — keep as-is.
- Strict schema validation on `/build` (`parseClaims`/`parseResizes`,
  §22) — keep as-is; do not loosen the numeric-string/pubkey/proof-length
  checks.
- `requireAuth` + per-route rate limits on all 3 endpoints — keep as-is.
- The proof endpoint's "unknown ≠ ineligible" contract (`proofUnknown`
  surfaced distinctly, never silently dropped) — keep as-is.

## 32. Minimal safe fixes (not applied — audit only)

- **RC-1 (highest priority):** after `signAllVersionedAndSend` resolves,
  poll `getSignatureStatuses` (or `getTransaction`) for each returned
  signature before transitioning to `done`; distinguish confirmed-success,
  confirmed-failure (surface the on-chain error, e.g. `AlreadyClaimed`,
  per-signature), and still-unconfirmed-after-budget (a genuine "unknown"
  state, not silently folded into "done"). This mirrors the
  confirmation/reconciliation pattern this repo's own Candy Mint audit
  already established elsewhere — no new pattern needs to be invented,
  only applied here.
- **RC-2/RC-3:** have `signAllVersionedAndSend`-family callers return
  (not throw away) whatever partial `{index, signature}` pairs were
  already submitted before a mid-loop failure, and have `handleClaimAll`
  narrow any retry to the *not-yet-submitted* (or, after RC-1 lands,
  *not-yet-confirmed-successful*) subset of the original scan, rather than
  the full original set.
- **RC-5:** same one-line pattern GhostBid's audit already applied
  elsewhere in this repo (`toClientError`-style generic string, detail to
  `console.error` only).
- **RC-6:** one-line doc-comment correction in `program.ts` (no behavior
  change) — the account is not the recipient's wallet; update the label
  to reflect what §27 actually observed (or mark it "purpose unconfirmed;
  behaviorally inert per live simulation").

## 33. Missing regression tests

None exist (§26); all would be new. Highest-value, in priority order:
1. A synthetic/fixture test asserting `buildDistributeToLegacyNftIx`'s
   exact account order/signer/writable flags against a frozen expected
   matrix (would have caught RC-6's doc/reality mismatch immediately, and
   guards against a future accidental account-order change actually
   breaking the feature, unlike the doc comment).
2. A test for `parseClaims`/`parseResizes` boundary cases (empty proof,
   33-entry proof, negative-looking amount string, scientific notation) —
   currently only implicitly exercised by manual code reading in this
   audit.
3. A retry-narrowing test once RC-2/RC-3's fix lands (mirrors the pattern
   GhostBid's `logic.test.ts` used for its own stale-response arbiter).

## 34. Production parity limitations

- No git history exists for this feature at all (§1/§2) — "parity with
  HEAD" is not a meaningful question; parity was instead established
  directly against the *working tree* (100% match, since dist/.next were
  both built from this exact working tree state earlier in this session).
- The `Resize` path could not be live-simulated (§27) — a real
  currently-resizable candidate wallet was not found in the sampling
  window used.
- No browser tool was available this session — RC-1's two-tab race is
  reasoned/proven at the code level, not click-tested live.
- `origin`/`vps` git remotes were not checked for this feature specifically
  (moot, since nothing is committed to check).

## 35. Recommended implementation order

1. RC-1 (confirmation/reconciliation) — highest severity, and every other
   finding's real-world consequence is smaller once this lands (a
   confirmed-failure state naturally prevents the false "Done," and a
   good implementation of it naturally produces the per-item signature
   list RC-3 needs).
2. RC-3 (surface partial-batch progress) — small, and RC-1's
   implementation will likely need this data structure anyway.
3. RC-2 (narrow retry to the unresolved subset) — depends on RC-1/RC-3's
   data being available.
4. RC-5 (generic error strings) — trivial, isolated, independent of the
   above.
5. RC-6 (doc comment) — trivial, zero risk, do whenever convenient.
6. Given §2's finding: commit this feature to git as its own first
   commit (even with the above fixes still pending) purely for
   reproducibility — this is a process recommendation, not a code fix.

## 36. Final verdict

**HARDENING RECOMMENDED — no CRITICAL, no fund-loss path found, but RC-1
is a real, provable "success theater" bug with a concrete, ordinary
(non-adversarial) user-triggerable reproduction (two tabs), and the tool
is currently live, in-nav, and 100% uncommitted.** Every category the
audit spec was most worried about (fund redirection, backend co-signing,
wrong-account mutation, unsafe truncation, Token-2022 destruction) is
structurally absent by design and independently confirmed by live,
read-only, real-builder simulation — not merely asserted. The gap that
does exist is entirely in the client-side confirmation/retry layer, is
well-understood, has a known fix pattern already proven elsewhere in this
same repo (Candy Mint), and does not risk double-payment thanks to the
underlying protocol's own on-chain idempotency. Recommend landing RC-1
before actively promoting this tool for higher-volume/unattended use;
current single-operator, attentive-use-only usage is reasonably safe
as-is provided the operator manually verifies each "Done" signature on
Solscan (which the UI already conveniently links to) rather than trusting
the "Done" label at face value.
