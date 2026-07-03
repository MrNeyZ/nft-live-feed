# MMM Pool Sellability Checklist

Working reference for evaluating whether a Magic Eden MMM buy-side pool is a
real, sellable candidate for a given NFT. Built empirically from real
attempts (not just heuristics) — see the confirmed cases below before
trusting a rule.

## How to check a pool (always run both layers)

1. **Raw on-chain read** — `python3 /root/mmm_scanner.py pool <poolKey>`.
   No ME calls. Gives spot/bpa/escrow/allowlist/cosigner straight from
   account bytes.
2. **ME-enriched backend read** —
   `curl https://victorylabs.app/api/tools/mmm-pools/pool?key=<poolKey>`.
   Adds `poolType`, `meKnown`, `buyOrdersAmount`, `buysideCreatorRoyaltyBp`,
   `meUpdatedAt`.
3. **NFT metadata** — Helius `getAsset` on the mint. Need `token_standard`,
   `creators`, `ownership.owner`.

Always run both 1 and 2 — checking only the raw scanner once meant we
permanently lost the ability to know TROGG's `poolType` after it sold and
ME stopped listing the (now-drained) pool.

## Go / no-go signal (validated 6-for-6 sold / 2-for-2 blocked so far)

**The decisive field is NFT `token_standard`, NOT `poolType`.**

| Field | Sellable (legacy) | Blocked (pNFT) |
|---|---|---|
| `token_standard` | `NonFungible` | `ProgrammableNonFungible` / `ProgrammableNFT` |
| `poolType` (ME) | can be `"invalid"` — irrelevant | can be `"invalid"` — irrelevant here too |

`poolType: invalid` from ME's `/mmm/pools?owner=` listing is frequently a
**frozen snapshot**, not a live rejection — see "The Feb-2025 cohort" below.
Confirmed sold pools carried it. Do not use it to reject a legacy-NFT
candidate. It's fine to still show it as an informational warning, just
never treat it as disqualifying for a legacy NFT.

### Confirmed SOLD (legacy NonFungible, despite poolType:invalid)
- TROGG — `8RSwxvSayb3JPa4MmprGS8855EE32x7dHGSjkR1MQVAp`
- PLEX SPL20 — `7vkUJigAFXXyuPsvC6ryHubEWSmjczFLNYWFCgH1fuHG`
- FRONKs — `J6PtLEo1bfbmiVDFQK9FUvw7LweoWL5zhZtWB9C5uBJa`
- Solana Codes — `3vKSBuuYcK5nrqxXgEQb9Ethm39zoX3SJUFPQkyjnFWe` (needed a real
  0.09225 SOL top-up first — bpa was genuinely only 60.9% funded)
- Ordinem — `EWn841edhWQaH3Uz7YopVJENyemMo9qSYxAcwvh9kmo1`
- OKB POG PLAYERS EDITION — `FfvGvjV9hzaftP2tcBw8HjFu1NrdZVBYx67gVxDzkv3Q`
  (2 FVCA allowlist entries, 5 creators — neither mattered, still legacy)

### Confirmed BLOCKED (pNFT) — pre-v0.5.2, superseded below
- BayBot — `8en1roFNE6CVEhYhHGj5bpeWW4vnSiXFKzEt49JAShwU` (5 creators)
- ProtoSol — `6SFXZESYYmLsSpAjUkWpzT2EUVc49JYDbCX7zeihxZa6` (3 creators — so
  it's not creator-count-driven for pNFT either, pNFT alone was enough)

**Correction 2026-07-02 — pNFT is NOT categorically blocked.** Copium
(pool `ycxEyuDJYBSLWquqHzyFpHYpqzPbnumCtrq8JirRr2k`, NFT
`68RXFTepC3phqPFFvkLdovysDt32e8fBkjn9xHoPLBys`, `token_standard:
ProgrammableNonFungible`, 2 creators) topped up (0.215→2.0425 SOL) and
**sold successfully** via the userscript. Userscript v0.5.2
(`0f92618`, same day as the BayBot/ProtoSol tests were likely run)
added `tokenStandard=4` on the `sol-fulfill-buy` call for pNFT, which
gets ME to return a versioned tx w/ ALTs instead of an oversized legacy
tx — this is probably what actually fixes it. BayBot/ProtoSol were
never retested post-fix. **Don't reject a pNFT pool on token_standard
alone anymore** — attempt the bridge call and read the real result.

## Other real blockers (distinct from poolType)

1. **Non-default cosigner.** All confirmed-working pools share the same ME
   cosigner `NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd`. One pool (Hasuki,
   `5nSNRoMHaX6hC4GLuUcpMDAY38GtNXf9iCKCrzM6CbwW`) had a **different**
   cosigner (`7RpRDUZBdu5hfmqWvobPazbNeVCagRk5E3Rb8Bm8qRmD`) and `poolType:
   "two_sided"` (not the usual buy-side-only `invalid`) — skipped, unverified,
   don't trust the standard bridge flow for these.

   **Confirmed real failure 2026-07-02** (Infinity Labs pool
   `6n3Sw4TgfFW78aMwJ2ms2U9xbnGw4SVZZtNMxwiFjD6K`, `poolType: "two_sided"`,
   *standard* cosigner `NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd` this
   time): the bridge still failed — ME's own `sol-fulfill-buy` API returned
   `status:200` with a tx, but one signature slot in it was never actually
   filled by ME (`[VL-phantom] ME co-signer slot(s) empty`), so Phantom threw
   `ME did not co-sign the legacy transaction — pool may be unsupported` at
   sign time. So `poolType: "two_sided"` is a real blocker **independent of
   which cosigner the pool has** — ME's instruction-builder API appears to
   just not properly co-sign two-sided pools at all, unlike the
   `invalid`/frozen-snapshot pools which sign fine.

   **Second confirmed case, same day** — Curved Cats (Core NFT collection)
   pool `6XwHppVcmtSDB9BApmcQvF2zwMYtyqTpKP6s7wk7Av3E`, `poolType:
   "two_sided"`, `meUpdatedAt: 2026-07-02T00:04` (fresh, not the Feb-2025
   frozen cohort — so it's not stale-data noise either). Standard cosigner.
   Same shape as Infinity Labs.

   **VERDICT (2-for-2): treat `poolType: "two_sided"` as a hard block for
   this bridge, full stop** — regardless of cosigner, freshness of
   `meUpdatedAt`, funding %, or NFT standard (legacy vs pNFT vs Core all
   seen). Don't spend time evaluating funding/allowlist/NFT for a
   two_sided pool; reject at the `poolType` check before going further.
2. **`blockedAt` field present in ME's raw `/mmm/pools?owner=` record.**
   Not surfaced by our own `/pool?key=` endpoint today (only raw ME query
   shows it) — check the owner-scoped ME API directly when a pool looks
   too good to be true. Confirmed 2026-07-02 on two unrelated pools:
   - SMB Gen2 `GKawDFW5sLg2s4nAjFgLbhkUFWJxkHus9hm1AEiyrsAA` — `blockedAt:
     2023-07-09`, wildly overfunded (140.63/140 SOL) at a spot price (140
     SOL) far above the collection's real floor — an obvious trap shape.
   - SMORC/The Orcs `AmUxeQUEXhwbQbSFHXp12nUGJtG1iA9WFwTtYkLPNWYT` —
     `blockedAt: 2023-08-08`, funded **exactly** 100% (no overfund
     anomaly this time), legacy NFT, normal-looking owner wallet —
     nothing else about it looked suspicious. `blockedAt` held as an
     independent signal even without the overfunding tell.
   - SOL Decoder `o7ARxZUzx1zxsVRf34He3aAv59EmwD1TECiD22ZXeMi` —
     `blockedAt: 2023-07-24`, only mildly overfunded (100.5%), pNFT,
     BUT `buysideCreatorRoyaltyBp: 9478` (~95% — near-total value would
     go to creators, not the seller) — another distinct trap tell
     riding along with `blockedAt`.

   **VERDICT (3-for-3): `blockedAt` present = hard block**, full stop,
   regardless of funding %, poolType, cosigner, or how normal everything
   else looks. ME flagged these years ago (2023) and never lifted it —
   treat as permanently dead. Always pull the raw
   `api-mainnet.magiceden.dev/v2/mmm/pools?owner=<poolOwner>` response
   for any pool that seems unusually valuable/overfunded — `blockedAt`
   won't show up anywhere else.

   **Correction 2026-07-02 — `bpa` overfunding ratio alone is NOT a red
   flag.** `bpa` (`buysidePaymentAmount`) is the pool's *aggregate*
   buy-side liquidity, not a per-NFT price. For flat-curve pools
   (`curveDelta: 0`) it's exactly `spotPrice × buyOrdersAmount` —
   confirmed exact on Saga Bust Of The Year (`8.19 × 3 = 24.57` SOL).
   For real bonding-curve pools (`curveDelta` nonzero, `curveType:
   "exp"`) it's the summed cost of `buyOrdersAmount` sequential fills
   along the curve, so it won't hit that multiple exactly but the same
   logic applies — Whal3s (7 orders) and Giraffe Tower (25 orders) both
   showed large `bpa` fully explained by their `buyOrdersAmount`, no
   `blockedAt` on either. **Don't read a big `bpa/spotPrice` ratio as
   suspicious by itself — check `buyOrdersAmount` first.** The real
   trap tells stay: `blockedAt`, wildly abnormal `buysideCreatorRoyaltyBp`,
   or spot price that's absurd relative to the collection's real floor
   *when `buyOrdersAmount` is 1* and doesn't explain the gap.
3. **Empty collection name at ME**, even with a typed FVCA/MCC allowlist.
   SOLbuddy pool (`CrGG3EHT5ufBCqAkpEiZJBhDPWQ5Jj7wXQbkZacJecQV`) had
   `collectionName:"" ` AND `collectionSymbol:""` genuinely empty in ME's
   raw data (confirmed via direct query, not a fetch hiccup — DAS shows the
   real collection "SOLbuddy" exists, ME just never attached it to this
   pool). The frontend (`page.tsx`) still legitimately skips the bridge
   attempt for `pool.meKnown && pool.collectionName === ''` — ME can't
   validate royalty/allowlist without a known collection. Unlike poolType,
   this skip was intentionally kept.
3. **Pure `any`-allowlist pools (no typed FVCA/MCC/group/core_collection
   alongside) are structurally unsellable via this bridge.** Already coded
   as a hard block in `mmm-pool-lookup/page.tsx`
   (`hasTypedAllowlist` check → `'✗ Not sellable: any-allowlist: ME won't
   co-sign'`), confirmed by an older commit note: ME's `sol-fulfill-buy`
   always returns 400 "invalid token mint" for any-allowlist pools — ME has
   no collection to check royalty/allowlist against, so it structurally
   can't co-sign, regardless of funding, price, or which NFT you try.
   Confirmed 2026-07-02: found 42 on-chain infinite `any`-pools underfunded
   with `bpa ≥ 0.01 SOL` (real money sitting in them, e.g.
   `9C9QTQ36oV4hM3ArSvpCiUJms6nZLxGzQy2bKPQupvge` at 88.7%) — **none of
   these are usable**, this isn't about funding %, it's a permanent
   protocol-level wall for this bridge. The "Full scan (+any)" toggle in
   `mmm-collection-scanner` is for *discovery/visibility* only (e.g. to see
   what a collection with no FVCA/MCC, like an SPL20-style token, looks
   like on the buy side) — it does **not** mean those pools are sellable.

   **Correction 2026-07-02 — falsified for Mutantmon.** Pool
   `9C9QTQ36oV4hM3ArSvpCiUJms6nZLxGzQy2bKPQupvge` — one of the exact 42
   "unusable" `any`-pools listed above — **sold successfully** same day,
   sig `2p3QvZzwCUroLdrJoDXfzBR2qzR6tBbd7WbCwnZbr1pED5TQfwoFHYN1CvF7JAdjU4fPsT6tUPZq3eZCgwrWyYoD`
   (`lp_fee:0, royalty_paid:0, total_price:2632299319`, seller netted ~98%).
   `collectionName` was non-empty (`"Mutantmon"`) even though the allowlist
   entry itself is `{type:"any"}` — ME apparently *can* co-sign an
   any-allowlist pool once it knows the collection by name/symbol. The 400
   "invalid token mint" failures behind the original rule may have really
   been the T22-ATA-derivation bug below (same collection, same session) —
   not the allowlist type. **Don't hard-block on `any`-allowlist alone
   anymore** — check `collectionName` is non-empty first (that part of the
   rule stands, see empty-collection-name item above), then attempt the
   bridge call for real.
3. **Unclassified NFT type.** Dumbass Donkeys NFT had `token_standard: None`
   / `interface: "Custom"` — neither confirmed-legacy nor confirmed-pNFT.
   No data either way — treat as not-safe until a real test disproves it.

   **Confirmed real loss 2026-07-02 (Dappie Gang, pool
   `Fjs8chFCJGCqoxGqHRBNdcXjzSynvQUTj5b2JLZFrYqu`, NFT
   `CsrHtihXCoVoVm3N6GzVL5G6ZDswBDnC3rADfHWaNRFP`, sig
   `as41GCKhhvQ2KsJFogpQvQTua8amDwTwcjQsu2dvqv73ZSFUDKkx1A6nuQde8zDjBtCqcYjz9sMe6h6gjcpHtxF`)
   — same `interface:"Custom"`/`token_standard:None` signature, legacy Token
   Program, but the on-chain log showed
   `{"lp_fee":0,"royalty_paid":210622641,"total_price":3721000001}` — **royalty
   WAS enforced, 5.66% of spot**, matching the claimed `basis_points:600`
   almost exactly. This directly breaks the "legacy = royalty unenforced"
   rule from the Fee-estimation section below — that rule only holds for
   NFTs with an explicit `token_standard: NonFungible`. Assumed the usual
   2%-only fee going in; real total cost was ~7.5% (royalty + ME fee) →
   flipped an expected +0.109 SOL profit into a confirmed **-0.098 SOL
   loss** (top-up 3.4977 SOL sent, only 3.4402 SOL came back, minus the
   0.04 SOL NFT cost).
   **Correction, same day — NOT predictable either way.** Magic Ticket
   (pool `9YcC7jG7hJn1CL5DDKZrv2DWN3k4aXfgAAd12jQE65dw`, NFT
   `3m6nTPaNZJAZrjv2Kyogo2eMmxikve1jX7xnmsb9BhXH`, sig
   `WXhLn4cNZLCg2C86FDXi43dczVZb9VAZU7D7mGaXCiaZo8uVpYba3ucLrW6S3EYxfnYSC7Ciwbnz1XzGKn9GdNy`)
   — same `Custom`/`None` signature, claimed `basis_points:500` (5%) — this
   time the log showed `{"lp_fee":0,"royalty_paid":0,"total_price":1900000000}`,
   **0% real royalty**, matching the original 2%-only assumption almost
   exactly (profit landed ~0.139 SOL, not the ~0.044 SOL the worst-case rule
   predicted). So enforcement for `Custom`/`None` mints is **per-collection,
   not derivable from the DAS fields at all** — Dappie Gang enforces its
   claimed royalty, Magic Ticket doesn't, both look identical on paper.
   **Rule: for `interface:"Custom"`/`token_standard:None`, there is no safe
   default (neither 0% nor claimed-bp) — profit is genuinely unknown until
   a real fulfilled tx for that specific collection is decoded. State the
   range (0% case vs claimed-bp case) rather than picking one, and prefer
   testing with a cheap/expendable NFT first if the collection is new.**
4. **`meKnown: false` is NOT the same as a confirmed-empty/invalid verdict.**
   It just means our own `/mmm/pools?owner=` fetch failed/timed out this
   time (rate limit, transient). Ordinem showed `meKnown:false` once from a
   fetch hiccup even though ME's real data had a proper collection name —
   always re-query directly before concluding "genuinely unknown."

## Funding: bpa vs realEscrow — read `bpa`, not raw balance

`executable` in the backend response is computed as `realEscrow >=
spotPrice` (raw PDA lamport balance). This can be **misleading** — the
on-chain `SolFulfillBuy` instruction appears to actually gate off `bpa`
(`buysidePaymentAmount`, the pool's own tracked field), not the raw escrow
balance. When `divergence` (`realEscrow - bpa`) is nonzero, the pool can
show `executable: true` while still failing for real — confirmed on
PASTEL PANDAS (`AP4gLrkwpMKVimG2kdJwJYDenoKqKmhC5wpgVJUbkvcW`): realEscrow
matched spotPrice exactly (100%) but bpa was only 96.8% and ME's own site
displayed the bpa-based percentage, not the balance-based one.

- If `divergence: 0` (bpa == realEscrow): the displayed percentage is
  trustworthy either way.
- If `divergence > 0` (realEscrow > bpa): don't trust `executable: true` —
  the real gate is `bpa`, and raw SOL sent directly to the escrow PDA does
  **not** appear to update `bpa` on its own (confirmed on Hermano: manual
  top-up moved `realEscrow` but `bpa` stayed frozen). How to properly
  increase `bpa` is still unresolved — a real MMM "deposit" instruction
  (e.g. via ME's own "add funds" UI) seems to be what actually worked for
  Solana Codes's successful top-up-then-sell, not a bystander system
  transfer.

## Byte-size risk (separate from all of the above)

Confirmed empirically (`tools-mmm-pools.ts:401-404` in `nft-live-feed`):
**pNFT + 5+ creators** busts the legacy on-chain tx's 1232-byte cap
(measured at exactly 1240 bytes once). **Legacy NFTs have headroom
regardless of creator count** — OKB POG PLAYERS EDITION had 5 creators and
sold fine because it's legacy, not pNFT. Don't apply the 5+-creator flag to
legacy NFTs.

## Fee estimation — use the NFT's own on-chain royalty, NOT `buysideCreatorRoyaltyBp`

Confirmed 2026-07-02 by decoding a real fulfilled tx (Secret Skellies Society,
pool `FBjFMTMDweWyRWqdMb1Le5Dm6H1XeAYRRN8ivJ1P1SfM`, sig
`4eLwWdQT89nZ1PcXq7Xipta6WtnfgiUqcSrAv7LzBbhXKSuHvdpm1FQ4cShemU1CDaRLZceLFqmT55UBytNBttG4`).
The on-chain `SolFulfillBuy` program log emits the ground truth directly:
```
Program log: {"lp_fee":0,"royalty_paid":0,"total_price":1650000000}
```
Royalty paid was 0 — matched that pool's `buysideCreatorRoyaltyBp:0`, so my
first pass concluded `buysideCreatorRoyaltyBp` was the authoritative field.
**That was wrong — it was a coincidence.** Checked a second real fulfilled tx
(Copium, pool `ycxEyuDJYBSLWquqHzyFpHYpqzPbnumCtrq8JirRr2k`, sig
`5YwfR4jeJG3u9huzwSsdU47HYYp2g5zEmhBAfDkyk7NYDcYjcHiUL3DJpBFwjZwTpqkQLVh2up3CMh1mnkLX94sC`)
which had `buysideCreatorRoyaltyBp: 10000` (100%) yet the log showed:
```
Program log: {"lp_fee":0,"royalty_paid":142500000,"total_price":2042500000}
```
`142500000 / 2042500000 = 6.98%` — nowhere near 100%. So
**`buysideCreatorRoyaltyBp` is unreliable/stale (probably part of the same
frozen Feb-2025 ME snapshot as `poolType`), not the real on-chain rate.**
I initially flagged two other pools (Copium #2 `ZEf2...`, Ancient8
`5dTXncnMCWCm5HKL3Rqf8YXhQviWVu5eK8Qyqb8fGwoP`) as "100% guaranteed loss"
purely off this field — that call was wrong, walked back same session.

**The real royalty source: the NFT's own on-chain royalty metadata**, pulled
via Helius `getAsset` → `royalty.basis_points`. In the Copium case this was
`750` (7.5%) — close to the actual 6.98% paid. ME's `collectionSellerFeeBasisPoints`
(collection-level, off-chain) also matched `750` in this case and has matched
in every pool checked so far — a reliable proxy for the DAS figure, just
don't substitute `buysideCreatorRoyaltyBp` for either of them.

**Refinement 2026-07-02 — royalty is only real for pNFT; legacy royalty is
unenforced and MMM pays 0 regardless of what the metadata claims.** Checked
Secret Skellies' own NFT royalty metadata (the one from the `royalty_paid:0`
tx): `getAsset().royalty.basis_points = 600` (6%) — claimed, same as
Copium's claimed 750. But paid was 0 for Secret Skellies vs ~698/750 for
Copium. The difference: Secret Skellies is `token_standard: NonFungible`
(legacy), Copium is `ProgrammableNonFungible` (pNFT). This lines up with how
Solana royalty enforcement actually works — **legacy NFT royalty has no
cryptographic enforcement mechanism** (any program, MMM included, can
legally ignore it and evidently does), while **pNFT royalty is enforced by
Token Auth Rules on every transfer**, so MMM has no choice but to pay it.

**Correct fee model, token_standard-aware:**
- `token_standard: NonFungible` (legacy) → real enforced royalty = **0%**.
  Don't use the claimed `royalty.basis_points` for legacy — it's unenforced
  and evidence so far says MMM doesn't pay it. Fee = ME's ~2% only.
- `token_standard: ProgrammableNonFungible` (pNFT) → real royalty = NFT's
  `getAsset().royalty.basis_points` (or `collectionSellerFeeBasisPoints` as
  proxy) — auth-rules-enforced, MMM pays it. Fee = royaltyBp/10000 + ~2%.
- `buysideCreatorRoyaltyBp` stays disqualified regardless of NFT type.
- Full profit formula: `profit = bpa_existing − nftCost − spotPrice ×
  (enforcedRoyaltyBp/10000 + 0.02)`, where `enforcedRoyaltyBp = 0` for
  legacy, `= royalty.basis_points` for pNFT.
- Only 2 real transactions confirm this pattern so far (Secret Skellies,
  Copium) — treat as a strong working hypothesis, not gospel, until more
  real fulfills are decoded.

**FALSIFIED 2026-07-03 — legacy `NonFungible` does NOT guarantee 0% royalty.**
YELLOW (pool `2fbap2TeP2LtiRgK2GCSYNYHCySupvdhQXTySficYVBB`, NFT
`rG5LhgXHNFf3ra1ebaVnFoSU5JVTqKtcABWUQvB7qJK`, confirmed `token_standard:
NonFungible` — explicit, not the `Custom/None` uncertain type — before the
sale), sig
`4e5uQHXadcj6eWe7tbCBdjFp6hMnY4Wx7WLLy4QYKh6eS1cEqexY49YxaLeYms6KcwFTaAzYtxXHfkvLYucJ6XtH`.
Log: `{"lp_fee":0,"royalty_paid":40000000,"total_price":1640000000}` —
**2.44% real royalty paid**, matching the claimed `basis_points:250` (2.5%)
almost exactly, to the verified 100%-share creator. Total real fee ≈4.4%
(2.44% royalty + ~1.95% ME), not the assumed 2%. Turned a predicted
+0.0356 SOL profit (nftCost 0.03) into a real loss.

**So the `token_standard` field itself is not a reliable royalty-enforcement
predictor either** — this is the second falsification after the any-
allowlist one (see heuristics-falsified memory). Current honest state:
- pNFT (`ProgrammableNonFungible`) → royalty reliably enforced (multiple
  confirmations: Copium, Galactix, MTC, STRATA, WASTACORP, Bozo Collective —
  though FRG showed 0% real despite pNFT, so even this isn't 100%).
- legacy `NonFungible` → **usually 0%** (Secret Skellies, Magic Ticket) but
  **not always** (YELLOW — 2.44% real; Samoyedcoin — 6.9% real, confirmed
  2026-07-03 pool `GPMKUWYT3L6T2NHTCHVHfrMADgFdBtvqi2eqaoiPWpSg`, sig
  `5Bk1gW3Dd1TaNykxxPpoCmcNwaSMaiWZzHCYjzN27N5jAd7CHRx426LHRtqTLjQxHatS63FDTGnq1ASEdXm1cMDA`,
  log `{"royalty_paid":245786695,"total_price":3564000000}` — turned a
  predicted +0.14 SOL ceiling into a real ≈-0.10 SOL loss before even
  counting NFT cost) — no known field distinguishes the two cases in
  advance.
- `Custom`/`None` → already known unpredictable (Dappie Gang paid, Magic
  Ticket didn't).
- **Bottom line: no DAS/ME field reliably predicts real royalty for ANY
  NFT type before a real fulfill.** Claimed `royalty.basis_points` is the
  right worst-case number to defend against, full stop.

**User instruction 2026-07-03 — do NOT blanket-apply this as an automatic
markup.** Keep quoting ranked lists at the plain 2%-ME-fee baseline; the
user checks per-collection risk himself (decode the last real buy/sell tx
for a specific mint on request — see the YELLOW/Samoyedcoin/Melkz-style
checks above for the pattern: `getTransaction` on a recent sig, read
`royalty_paid`/`royalty` straight from the program log). Only flag
uncertainty in prose when asked, or when a margin is thin enough that a
plausible real royalty would flip it negative.

## How to actually compute profit — don't stop at "seller receives"

Mistake made and caught 2026-07-02 (Copium `ZEf2pi7K1HLxFS4thUXB3nmwQ5SEXoPYi2ktG6USEy8`,
Ancient8 `5dTXncnMCWCm5HKL3Rqf8YXhQviWVu5eK8Qyqb8fGwoP`): I quoted "seller
receives ≈ spotPrice × (1 − fee%)" as a positive-looking number in a summary
table and stopped there — that's **gross proceeds, not profit**, and on its
own it always looks fine (spot minus a double-digit-percent fee is still
most of spot). It says nothing about whether the trade is worth doing.

**Always finish the actual formula, don't eyeball the gross figure:**
```
profit = bpa_existing − nftCost − spotPrice × (realRoyaltyBp/10000 + 0.02)
```
The top-up amount (`spotPrice − bpa_existing`) always cancels out — you get
it back as part of the payout — so it never belongs in the profit line, only
`bpa_existing` (what was already sitting in the pool for free) does.

**Fast pre-check before even asking for the NFT's cost:** compare
`bpa_existing` (SOL) against `spotPrice × feeRate` (SOL) — **in absolute
SOL, not percentages.** If `bpa_existing < spotPrice × feeRate`, the trade is
a **guaranteed loss regardless of how cheap the NFT is** (even a free NFT
doesn't save it), because the fee alone already exceeds the only real
"free money" in the deal. Do this comparison first — it's a one-line check
that immediately kills most candidates before spending time on NFT floor
price.
- Copium: bpa `0.132225` vs fee `2.20375 × 9.5% = 0.209563` → bpa smaller →
  dead on arrival, `nftCost` was never going to matter.
- Ancient8: bpa `0.105` vs fee `1.5225 × 7% = 0.106575` → also dead, just
  barely (off by ~0.0016 SOL).

## The Feb-2025 frozen cohort

Many `poolType: invalid` pools share a `meUpdatedAt` timestamp clustered in
one ~40-second window on **2025-02-03 around 21:08:14–21:08:50 UTC**
(Hermano, BayBot, ProtoSol, PLEX SPL20, Solmap, FRONKs, Bitch Lads,
Solana Codes, Ordinem, OKB POG, Mirage Launchpad all land in this window).
Working theory: ME indexed this batch once, marked whichever were
underfunded at that instant `invalid`, and has never re-scanned them since
— explains why funding state today has zero relationship to the `invalid`
label's freshness.

## PDA vault holder pattern

Many of these NFTs sit in `1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix`, an
off-curve PDA (verified via `mmm_scanner.py`'s `_is_on_curve()`) — cannot
sign directly. Must be transferred to a real signable wallet before a sale
attempt. Some pools' NFTs are already on a signable wallet (e.g.
`9oBbApTGE65kLPiU17m5mCPqmQxgegssktUjkhvJwyDL`, `3dAi9gLAaRqr4Tt8mNdJg7AbaJVyyam4nCfQfAm1jPJC`)
— check `ownership.owner` on-curve status before assuming a transfer step
is needed.

Confirmed 2026-07-02 (Rivalz Golden Boot): `1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix`
is a **Magic Eden listing escrow**, not a dead/stuck vault — buying the active ME
listing and it lands on your own wallet is the normal transfer path. Not a special
blocker, just means "buy it off ME first" if it's sitting there.

Confirmed 2026-07-02 (ATOZ EARTH #268, off-curve owner
`13ZVUSiEGywHmdU9m3myHB6fnU3QQMcTu45xAERw1der` — a **different** off-curve address than
the ME one above): this was a **Tensor listing escrow**, same pattern, different
marketplace. Off-curve owner ≠ automatically the known ME PDA — check which
marketplace's listing program it actually is (ME vs Tensor vs something else) before
assuming the standard "just buy it on ME" path applies.

## Token-2022 (T22) mints — was our own ATA-derivation bug, now fixed

Confirmed 2026-07-02 (Mutantmon, pool `9C9QTQ36oV4hM3ArSvpCiUJms6nZLxGzQy2bKPQupvge`,
NFT `3aJAfEQeCepogmAALq161oUooh3Nom9DHveSpiDtdEF3`, sig
`59t1RbYgFTRFDi9oifnjJASjP4P69PfcwhNdGNkVPQMyz8KxxmCJjhQJ94bf1aepzK2UxdhgoRgcFrPAiSYxtPid`).
This wasn't a co-signer bug (unlike `two_sided`) — ME fully co-signed and Phantom
sent the tx fine — it failed **on-chain**: `AccountNotInitialized` (Anchor
custom 3012) on `payer_asset_account` inside `SolExtFulfillBuy` (the
Token-2022/"extended" fulfill-buy variant, disc `sol_ext_fulfill_buy`).

Root cause was on **our side**: `mmm-pool-lookup/page.tsx`'s `acceptBid()`
called `getAssociatedTokenAddressSync(mint, wallet)` with no `programId`,
which silently defaults to the legacy SPL Token program. For a T22 mint that
derives a *different, never-created* ATA than the real one holding the NFT —
confirmed by deriving both by hand: legacy-program derivation gave
`HTfQziNEcT6cEQWKwNvAaWVywuwn919VRWPYkCGuZs3D` (0 balance, doesn't exist),
Token-2022-derivation gave `2AoHhk47gTGQodjn8yxAE8C8q1j6ukdpSXV9ot61ViNc`
(balance 1, real holder). We sent the wrong address to ME's `sol-fulfill-buy`
API as `assetTokenAccount`; ME took it at face value and built a tx around
the bogus account for both the legacy and v0 (ALT) variants — same bug in
both, so switching tx variant wouldn't have helped.

**Trap:** Helius DAS `interface` read as `"V1_NFT"` (looks like a plain
legacy NFT) and `content.metadata.token_standard` was absent — only
`token_info.token_program` (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)
revealed it's actually Token-2022. Neither existing detector
(`isProgrammable()`) nor `token_standard` catches this NFT shape.

**Fix applied** (same day): `WalletNft` now carries `isToken2022` (backend
`tools-mmm-pools.ts`, from `asset.token_info?.token_program`); frontend
passes `TOKEN_2022_PROGRAM_ID` into `getAssociatedTokenAddressSync` when set.
Not yet re-tested against a real Mutantmon fulfill — next attempt on this
collection should confirm the fix lands correctly.
