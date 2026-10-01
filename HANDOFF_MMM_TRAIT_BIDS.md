# HANDOFF — MMM trait-bid arbitrage investigation (2026-09-10)

Continue from here. Read this WHOLE file before touching anything. The last
session made many wrong turns; the "DON'T REPEAT" list at the bottom is the
important part.

---

## GOAL
Find MMM (Magic Eden) buy-side pools where the bid (spot price) is above what
you can buy the NFT for, then buy + fulfill-sell for profit. Two flavours:
- **collection bids** — allowlist is FVCA/MCC/core_collection only, any NFT in
  the collection qualifies.
- **trait bids** — pool ALSO has a `metadata` (allowlist type 4) entry. Only
  NFTs with a specific trait/attribute qualify. Pay MORE (rare-trait premium).
  Our tooling and most arb bots filter these out → they sit unfilled.

## THE FILTER (user drilled this repeatedly — get it right)
Three expiry states:
1. `expiry` in the PAST = "истёк" → SKIP
2. `expiry` in the FUTURE (counting down) = actively managed, bots snipe → SKIP
3. `expiry === 0` = "no expiry" = forgotten → **THIS is the target**
So on-chain filter is exactly `expiry === 0`. Do NOT widen to `expiry <= now`.

## WHAT IS PROVEN (facts, verified on-chain this session)
1. **ME co-signs "unindexed" pools.** SOLMAP no-expiry collection pool
   `CdpJYVcmdaoDT6r6Ccpe66a9szt2mRi8TyADuU21nmGz` got a real `SolFulfillBuy`
   **2026-09-10** (sig `g78PvYtwwtgQdTBMdAni88vwhoV6ou9E5ejmmpgapK8dGx7UZY54ZP4HjZ1XgBNyY4wgw8K3Ta87b9NupFxsfqH`)
   with ME cosigner `NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd` AS A SIGNER —
   even though `/mmm/pools?owner=<bidder>` returns 0 pools for it.
   → **"not in `?owner=` listing" does NOT mean "ME won't co-sign".** ME's
   cosigner service signs any valid ME pool for a known collection. My earlier
   claim that unindexed = dead was WRONG.
   → That fulfill was a plain `sol_fulfill_buy`, 18 accounts, `allowlist_aux`
   = System (None), no merkle proof, `royalty_paid:0` (SOLMAP legacy).
2. SOLMAP has ~432 no-expiry pools via FVCA memcmp. `realEscrow == bpa` for
   all of them (bpa not drained separately — plain transfer top-up risk is
   LOWER than the checklist feared, but still verify per pool). 40 are
   executable (esc>=spot, bpa>=spot) with spot>floor. Script: `scratchpad/sm.js`.
3. **72 executable no-expiry TRAIT bids** across 60 collections. Full list with
   pool + bidder links: `/root/nft-live-feed/TRAIT_BIDS.md` (also memory).
   Scripts: `scratchpad/trait.js` (find), `scratchpad/tf.js` (+floors).
4. Trait pools decoded: allowlist = `[FVCA/MCC:<collection>, metadata:<POOL'S
   OWN KEY>]`. The `metadata` value self-references the pool; the trait spec
   (2× 32-byte merkle roots) lives in the pool account bytes ~[249..350].
   Constant `714237f70c467e0b3a7a0efebea498a134eb533c26c9d7047172e1935743f25f`
   appears in many unrelated trait pools = a sentinel/empty-tree hash, not a
   per-collection root.
5. Many trait bids target **non-existent traits**: Geometrica Microdot 2.1◎
   = "Attributes Count: 0" but every NFT has 5 attrs; SOLMAP top-2 = "3
   attributes" but SOLMAP NFTs have 10-11; Bombaclot 2.15◎ = "Bomba: Hidden"
   (pre-reveal snapshot from 2023, all revealed now). ALWAYS verify the trait
   exists on real NFTs before valuing a trait bid.
6. **The Orcs trait pool `BLTMTbmhDVCEYVQ56Krm1naS5ZQvt3GcLMsh7NaGQuxz`**:
   spot 3◎, bpa 6◎, realEscrow 6◎ (2 fills), expiry 0, standard ME cosigner,
   created 2023-08-02 / 1 tx ever. Trait wanted (per ME UI) = Special "Richie
   Rich" + Rarity "Rare"/"Epic". Candidate NFT `The Orcs #1362`
   (`3JjxwFS9ng1sQmggGgi79w8tjN9i65XKrXVvyx9LmFNp`) HAS `Rarity:Rare` +
   `Special:Richie Rich` → matches. Currently listed on ME at 1◎ (owner =
   `1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix` = ME listing escrow, so you
   buy the listing first). Economics if it works: buy 1◎ → sell into 3◎ bid →
   +1.6-1.9◎ (legacy, royalty likely unenforced but confirm).
   THIS pool is NOT the checklist's `blockedAt` Orcs pool (that was
   `AmUxeQUEXhwbQbSFHXp12nUGJtG1iA9WFwTtYkLPNWYT`).

## THE OPEN QUESTION (start here next session)
**Can a trait (metadata-allowlist) MMM pool be fulfilled?** Two parts:
(a) does ME's `sol-fulfill-buy` API return a valid tx (with `allowlist_aux_account`
    + merkle proof) for a metadata pool?
(b) will ME's cosigner sign it?

Evidence needed — try in this order (cheapest first):
1. **On-chain search for ANY `SolFulfillBuy` on a metadata-allowlist pool,
   ever.** MMM is quiet now (only ~2 fulfills / 250 recent txs), so widen:
   pull `getSignaturesForAddress(MMM)` deep (paginate 1000s back), or better
   use Helius `getSignaturesForAddress` on a few known trait-pool escrow PDAs
   / the trait bidders. If even ONE trait fulfill exists → it's possible,
   decode it for the exact account layout + proof source.
2. Call ME's instruction API for real. `api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy`
   is Cloudflare-403 from curl/node; `.dev` host is 401 (needs auth). The
   userscript `VL-MMM-Bid-Accept-Bridge.user.js` has working headers — check
   what auth/headers it sends, replicate. Or test from a browser session.
3. Read MMM open-source Rust (`mmm-raw-instructions.ts` header cites it) for
   how `AllowlistKind::Metadata` + `allowlist_aux_account` validation works —
   is it a merkle proof of `keccak(mint)`, a name-prefix, or a metadata-hash?
   That tells us where the proof comes from and whether a now-revealed NFT
   with a 2023-snapshot proof still validates.

## OUR-SIDE FIX (user said "мы пофиксим с нашей стороны")
`src/server/tools-mmm-pools.ts` `assetMatchesAllowlist()` (~line 735) has NO
`case 'metadata'` → returns false → `fetchWalletNftsForPool` (~807) filters out
every NFT for a trait pool → `mmm-pool-lookup` shows "0 eligible NFTs" and the
accept flow never starts. Also `triage-stream`/`pool-stream` explicitly exclude
`a.type === 'metadata'` (lines ~1865, ~2024). To support trait bids we'd need:
- `assetMatchesAllowlist` metadata case: check the NFT's attributes against the
  pool's trait spec (needs the spec decoded — see open question #3)
- `fetchBidAcceptTx` to pass `allowlistAuxAccount` + merkle proof to ME's API
- stop excluding metadata pools from the scanners
DON'T build this until the OPEN QUESTION is answered — if ME won't co-sign
trait pools, the fix is wasted.

## KEY CONSTANTS
- MMM program: `mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc`
- ME standard cosigner: `NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd`
- escrow PDA: `["mmm_buyside_sol_escrow_account", poolKey]` under MMM
- Pool layout (offsets): spot@8 u64, expiry@27 i64, owner@121, cosigner@153,
  bpa@447 u64, shared_escrow@455, allowlists@249 (6× [1-byte type + 32-byte pk])
- allowlist types: 1=FVCA 2=mint 3=MCC 4=metadata 5=group 6=core_collection 255=any
- SOLMAP FVCA: `4nGoPfgRW2nkAp6ELx8bYRxLVRrNB3Si8drp4PRuDa3Q`  floor ~0.008◎
- fvca→{name,slug,tokenStandard} cache: `data/mmm-fvca-info-cache.json` (811 entries)
- profit (fully-funded): `spot*(1 - 0.02 - roy) - nftCost`. roy=0 for legacy
  (only ME's ~2% fee), = real bp for pNFT. nftCost = TRAIT floor for a trait
  bid, NOT collection floor.

## SCRATCHPAD SCRIPTS (in prior session's scratchpad, may need recreating)
- `scanF.js` — full no-expiry collection-bid scan (1 getProgramAccounts call)
- `sm.js <FVCA> <floor> <roy>` — all no-expiry pools for one collection, exec filter
- `trait.js` — all executable no-expiry trait bids market-wide
- `tf.js` — + ME floors for trait bids
- `perpool.js <me-slug> <floor> <roy>` — per-pool check via ME collectionSymbol

## DON'T REPEAT (mistakes made this session)
1. **Don't hammer Magic Eden API.** It 429s hard and stays blocked ~30 min.
   Pace >= 1.5s/call. Prefer Tensor (`api.mainnet.tensordev.io`, key in .env,
   header `x-tensor-api-key`) — no rate limits. Prefer 1 `getProgramAccounts`
   over per-collection ME calls.
2. **Don't group by collection and show 1 best pool** — user wants EVERY pool
   listed. SOLMAP looked like "1 pool" for hours because of this.
3. **Don't exclude shared-escrow OR (initially) metadata pools** without
   saying so — that hid the whole SOLMAP/trait picture.
4. **`expiry === 0` ONLY.** Not `<= now`. Past-expiry = "истёк" = not wanted.
5. **"not in ME `?owner=` index" ≠ "ME won't co-sign".** Proven false (see
   PROVEN #1). Don't declare a pool dead on that alone.
6. **Trait-bid profit is vs TRAIT floor, not collection floor.** And verify
   the trait actually exists on real NFTs (many bids target impossible traits).
7. **Don't rebuild the scanner from scratch** — `mmm-collection-scanner`
   (`/api/tools/mmm-pools/collection-scan?fvca=` or `?symbol=`) already does
   the on-chain parse + escrow hydration correctly, incl. shared escrow.
8. Auth token for our own API: mint HMAC-SHA256 over the b64url payload with
   `UI_AUTH_SECRET` from .env — see `src/server/runtime.ts` issueToken. Format
   `<b64url({w,iat,exp})>.<b64url(hmac)>`, send as `Authorization: Bearer`.
9. Don't run long node scripts inline with `timeout` + `head` — they print at
   the end and get SIGKILLed. Write to a file, `nohup ... &`, poll the file.

See also: memory `project_mmm_forgotten_collection_bids_scan`,
`docs/mmm-pool-checklist.md`, `HANDOFF*` in repo root.
