# VictoryLabs — Protocol Research Backlog

## Purpose

Durable record of protocol/docs research findings, decisions, fixes, and deferred items for the VictoryLabs live mint parser. Updated after each research audit.

---

## Research Workflow

- One protocol/source at a time.
- Research first. Validate findings against real mainnet traffic when possible.
- Fix only Critical/High or low-risk correctness bugs with clear, confirmed impact.
- Defer theoretical/future-proofing items to this backlog.
- After each audit, update this file with status, decision, and commit if applicable.

---

## Completed Audits

| # | Protocol | Status | Date |
|---|---|---|---|
| 1 | Metaplex Token Metadata | Complete | 2026-06-28 |
| 2 | Metaplex Core | Complete | 2026-06-28 |
| 3 | Bubblegum / cNFT | Complete | 2026-06-28 |
| 4 | Candy Guard / Candy Machine V3 | Complete | 2026-06-28 |
| 5 | Token-2022 / SPL Token | Complete | 2026-06-28 |
| 6 | Solana RPC + WebSocket Architecture | Complete | 2026-07-03 |
| 7 | Helius DAS Architecture | Complete | 2026-07-03 |
| 8 | Magic Eden Protocol & API Architecture | Complete | 2026-07-03 |

---

## Audit #1 — Metaplex Token Metadata

**Sources:** `mpl-token-metadata` GitHub, Solana mainnet (380 TM transactions, June 2026)

**VL files audited:**
- `src/ingestion/mint-raw/index.ts`
- `src/ingestion/mint-raw/launchpad-detector.ts`
- `src/enrichment/helius-das.ts`

---

### Finding 1 — Direct TM `Create` / `IX: Create` / discriminator 42

**Status: Researched — Deferred**

**Audit finding:** `IX: Create` (disc 42, TM V1.3+ primary mint instruction) is absent from `TM_CREATE_INSTRUCTION_NEEDLES`. Direct TM V1.3+ mints without Candy Guard or a known launchpad fail the pre-screen and are dropped silently.

**Mainnet validation:**
- 380 TM transactions examined across June 2026 mainnet.
- 29 contained `IX: Create`.
- 27/29 already caught by VictoryLabs via existing paths (CG fast-path, or co-presence of `IX: Create Metadata Accounts v3` from a related fungible token in the same tx).
- 2/29 missed were Jupiter Perpetuals position-receipt NFTs (DeFi infrastructure), not collection drops.
- **0 missed NFT collection drops.**

**Decision:** Do not fix now. Production impact for the current Live Mint Feed target is zero. All real collection drops route through Candy Guard or known launchpads. Keep as a future-proofing item only — if a new launchpad adopts bare new-API TM without CG, revisit.

**Related:** If fixing, also update the mint slot extraction — `Create` (disc 42) places the mint at `accounts[2]`, not `accounts[1]` like `CreateMetadataAccountV3`. `extractTmMintFromInner` in `launchpad-detector.ts` already handles this correctly (disc-42 slot switch at line ~582); the `index.ts` TM extraction path (`accounts[1]`) would need a matching fix.

---

### Finding 2 — `IX: Mint` / discriminator 43

**Status: Deferred** (subsumed by Finding 1)

**Audit finding:** `TM_MINT_INSTRUCTION_REGEX = /Instruction: Mint(?:\s|$)/` does not match `IX: Mint` (new-format log for TM `Mint` instruction, disc 43). Direct new-API pNFT mints without CG would be missed.

**Decision:** Subsumed by Finding 1. The same pre-screen gap applies; the same zero-impact conclusion holds. No independent fix.

---

### Finding 3 — Wrong `VERIFY_DISCS` in `extractTmMintFromInner` ✅

**Status: Fixed — commit `665c425`**

**Audit finding:** `VERIFY_DISCS = new Set([14, 17, 21, 22, 52])` used wrong discriminators for the legacy verify-collection family. Per official mpl-token-metadata IDL:
- disc 14 = PuffMetadata (not VerifyCollection)
- disc 17 = CreateMasterEditionV3 (not VerifySizedCollectionItem)
- disc 21 = RevokeUseAuthority (not SetAndVerifyCollection)
- disc 22 = UnverifyCollection (not SetAndVerifySizedCollectionItem)

**Fix:** Replaced flat `VERIFY_DISCS` set with `VERIFY_COLLECTION_IDX` map carrying per-instruction `[metadataPdaIdx, collMintIdx, minAccountsLen]`:

| Disc | Instruction | Meta PDA idx | Collection mint idx |
|---|---|---|---|
| 18 | VerifyCollection | 0 | 3 |
| 30 | VerifySizedCollectionItem | 0 | 3 |
| 25 | SetAndVerifyCollection | 0 | 4 |
| 32 | SetAndVerifySizedCollectionItem | 0 | 4 |
| 52 | Verify (unified) | 2 | 3 |

**Real-world impact:** Legacy inline verify CPIs are absent from current mainnet TM mints across 1500+ sampled transactions. Disc 52 (`Verify`) — the only one that currently fires — was correct in the old code. The wrong legacy discs (14/17/21/22) were harmless in practice due to the metadataPDA anchor check, but disc 17 (`CreateMasterEditionV3`) appears in many mint txns and was an objective correctness risk. Fix aligns with `TM_VERIFY_COLLECTION_MINT_IDX` in `core-v2-detector.ts`.

---

### Finding 4 — Decode collection from Borsh instruction data

**Status: Backlog — Medium/High priority**

**Audit finding:** Both `CreateMetadataAccountV3` (disc 33) and `Create` (disc 42) embed `collection: Option<Collection>` in their Borsh-encoded instruction data. `Collection.key` is the 32-byte collection mint pubkey. VictoryLabs currently ignores this and waits for DAS to supply the collection address via `scheduleCollectionConfirmation`.

**Current cost:**
- Every bare TM mint starts with `groupingKey = authority:{updateAuthority}` until DAS responds.
- If two concurrent mints have different update authorities, they temporarily create separate rows.
- DAS round-trip adds 2–5 s of grouping latency.
- Burns Helius DAS credits per mint that could be avoided.

**Borsh layout sketch for `CreateMetadataAccountV3` (disc 33):**
```
[0]     disc = 33
[1..]   DataV2:
          name:     4-byte LE len + UTF-8 (≤32 chars)
          symbol:   4-byte LE len + UTF-8 (≤10 chars)
          uri:      4-byte LE len + UTF-8 (≤200 chars)
          seller_fee_basis_points: u16 (2 bytes)
          creators: Option<Vec<Creator>> (1 flag + 4 len + N×34 bytes)
          collection: Option<Collection> (1 flag; if 1: 1 verified byte + 32 key bytes)
```

**Decision:** Do not implement now. Requires a variable-length Borsh parser for the string and creator fields before reaching `collection`. Treat as a separate feature work item. If implemented, the fix would eliminate most `authority:*` transient groupings for TM mints.

---

### Finding 5 — Print editions / `NonFungibleEdition` not hard-rejected in DAS

**Status: Backlog — Low priority**

**Audit finding:** `classifyDasAsset` does not explicitly reject `interface=NonFungibleEdition` or `interface=ProgrammableNonFungibleEdition`. Both would pass through to the permissive `kind: 'legacy'` fallback (decimals=0, supply=1). Pre-screen safely drops standard print-edition txns via log-needle absence, but a custom launchpad wrapping an edition mint could slip through to DAS acceptance.

**Decision:** Edge case only. No known real-world occurrence. Consider adding `NonFungibleEdition` / `ProgrammableNonFungibleEdition` to the hard-reject block in `classifyDasAsset` as a low-effort cleanup when next touching that file.

---

### Finding 6 — pNFT without auth-rules misclassified at sync time

**Status: Skip — Low priority**

**Audit finding:** pNFTs without MPL Token Auth Rules (`rule_set = None`) produce no `mip1` log during minting. VictoryLabs classifies these as `legacy` at sync time. DAS enrichment (`tokenStandard === 'ProgrammableNonFungible'`) corrects this later.

**Decision:** Skip. DAS corrects it. Only affects sync-time internal metrics. No user-visible impact on the live feed.

---

### Finding 7 — Dead Token Metadata needles for removed instructions

**Status: Optional cleanup — Low priority**

**Audit finding:** `TM_CREATE_INSTRUCTION_NEEDLES` contains needles for `CreateMetadataAccountV2` (disc 16) and `CreateMetadataAccount` (disc 0), both of which return `Err(MetadataError::Removed)` on-chain. No transaction can successfully emit these log lines.

**Decision:** No functional impact. Remove if touching `TM_CREATE_INSTRUCTION_NEEDLES` for another reason; not worth a standalone change.

---

## Audit #2 — Metaplex Core

**Sources:** `metaplex-foundation/mpl-core` GitHub (IDL, Rust source, JS types), Solana mainnet pattern analysis (June 2026)

**VL files audited:**
- `src/ingestion/mint-raw/core-v2-detector.ts`
- `src/ingestion/mint-raw/launchpad-detector.ts`
- `src/ingestion/mint-raw/index.ts`

**Architecture facts confirmed:**
- 42 instructions (disc 0–41), u8 Shank discriminant (not Anchor 8-byte)
- CreateV1 (disc 0) and CreateV2 (disc 20) have identical account layouts: `[0]=asset, [1]=collection(optional), [2]=authority(optional), [3]=payer, [4]=owner(optional), [5]=updateAuthority(optional), [6]=systemProgram`
- Collection address on an asset is stored as `UpdateAuthority::Collection(pubkey)` at byte offset 33 of the asset account — not a direct struct field
- Compression (CompressV1 disc 17, DecompressV1 disc 18) is disabled on mainnet (`MplCoreError::NotAvailable`)
- Groups system (CreateGroupV1 disc 39) creates `GroupV1` accounts — a separate taxonomy hierarchy orthogonal to CollectionV1; does not affect Create instruction account layout
- `UpdateCollectionInfoV1` (disc 32) is gated exclusively to Bubblegum PDA signer — used by Bubblegum V2 to update collection counters

**Audit #2 finding status:**

| Finding | Status | Notes |
|---|---|---|
| C1 | ✅ Fixed — commit `2a0d617` | `CORE_COLLECTION_CREATE_LOG_REGEX` now matches `CreateCollectionV2` |
| C2 | Backlog / low priority | Optional collection account not discriminant-validated; mitigated by `hasRealCollection` + DAS safety net |
| C3 | Backlog / low priority | `parseCreateV2Args` only decodes disc 20; disc 0 (CreateV1) unsupported in V2 scorer (out of scope by design) |
| C4 | Backlog / low priority | `extractCoreCollectionCreate` not discriminant-filtered; safe via caller ordering |
| C5 | Informational / by design | V2 scorer gated behind `MINT_TRACKER_CORE_V2_SCORER`; intended conservative default |
| C6 | Informational / no action | Compression (disc 17/18) disabled on mainnet; revisit if activated |
| C7 | Informational / by design | Burn gate in `countNftMints` correct for all known patterns |
| C8 | Informational / no mint detection impact | Group system (disc 39+) orthogonal to collection attribution |
| C9 | Deferred to Audit #3 (Bubblegum / cNFT) | BubblegumV2 plugin on Core collections is a cross-protocol gap |

---

### Finding C1 — `CORE_COLLECTION_CREATE_LOG_REGEX` missing `CreateCollectionV2` ✅

**Status: Fixed — commit `2a0d617`**

**Audit finding:** `CORE_COLLECTION_CREATE_LOG_REGEX` matched only `CreateCollection` and `CreateCollectionV1`. MPL Core disc 21 (`CreateCollectionV2`) logs `Instruction: CreateCollectionV2`, which the regex rejected — silently dropping `COLLECTION_CREATE` events for any launchpad adopting V2 collection creation.

`extractCoreCollectionCreate` is discriminant-agnostic and reads `accounts[0]=collection`, `accounts[1]=updateAuthority` — identical layout between V1 and V2, so it handles V2 without changes.

**Note:** The `hasMintInstructionLog` pre-screen needle `'Instruction: CreateCollection'` already matched V2 as a substring — so the tx entered the pipeline, but the exact-match regex blocked it from being classified as a collection-deploy.

**Fix:** Added `CreateCollectionV2` as a third alternative in the regex.

```
Before: /^Program log: Instruction: (CreateCollection|CreateCollectionV1)$/
After:  /^Program log: Instruction: (CreateCollection|CreateCollectionV1|CreateCollectionV2)$/
```

**Mainnet validation:** `CreateCollectionV2` not yet observed from tracked launchpads. Fix is future-proofing for a plausible launchpad upgrade path.

---

### Finding C2 — Collection at `accounts[1]` not discriminant-validated in fallback detectors

**Status: Backlog — Low priority**

**Audit finding:** `detectCoreCandyMachineMint`, `detectMagicEdenCoreMint`, and `detectGenericCoreLaunchpadMint` all read `accounts[1]` as the collection address without checking the Create instruction discriminant. When collection is absent (optional, Umi convention substitutes the Core program ID as sentinel), `hasRealCollection` filters it via `collection !== MPL_CORE_PROGRAM`. A custom client omitting the collection account entirely would shift accounts, possibly putting payer/authority at `accounts[1]` — which would pass `hasRealCollection` but be caught by `scheduleCollectionConfirmation`.

**Decision:** Backlog. Current mitigation (Umi sentinel filter + DAS safety net) is robust for all real-world paths. If ordering guard is ever relaxed, add discriminant validation in the callers.

---

### Finding C3 — `parseCreateV2Args` only handles disc 20, not disc 0 (CreateV1)

**Status: Backlog — Low priority**

**Audit finding:** `parseCreateV2Args` in `core-v2-detector.ts` hard-rejects any instruction whose first byte is not `20` (CreateV2), so it cannot decode CreateV1 (disc 0) instruction data. This only affects `detectCoreCreateV2NftCandidate` (the feature-flagged V2 scorer). The CM, ME, and generic fallback detectors cover disc 0 mints without needing to parse instruction data.

**Decision:** Backlog / out of scope by design. The scorer is intentionally scoped to CreateV2 only. If the scorer is extended to cover disc 0 drops, update the discriminant guard and rename the function.

---

### Finding C4 — `extractCoreCollectionCreate` not discriminant-filtered

**Status: Backlog — Low priority**

**Audit finding:** `extractCoreCollectionCreate` scans all MPL Core instructions (not just CreateCollection variants) and returns the first match. Safe today because the function is only reached when no asset-mint log is present in the tx (the mint-needle branch runs first), meaning the only Core ix in a collection-deploy tx is the CreateCollection one.

**Decision:** Backlog. Safe via caller ordering. If that ordering ever changes, add a discriminant filter (`buf[0] ∈ {1, 21}`).

---

### Finding C5 — `detectCoreCreateV2NftCandidate` disabled by feature flag

**Status: Info — by design**

**Audit finding:** The V2 scorer is disabled by default (`MINT_TRACKER_CORE_V2_SCORER` env var required). Direct CreateV2 mints from unknown custom launchpads (not CM, ME Launchpad, or `detectGenericCoreLaunchpadMint`-eligible) fall through to `unknown_launchpad`. This is the intended conservative default.

**Decision:** Info. This is the coverage extension point if new launchpad patterns appear that don't use a non-primitive wrapper.

---

### Finding C6 — Compression disabled on mainnet

**Status: Info — no action**

**Audit finding:** `CompressV1` (disc 17) and `DecompressV1` (disc 18) both return `MplCoreError::NotAvailable` on every call. No valid compressed Core asset can be created today. VL has no handling for `HashedAssetV1` (compressed account type) — would need a decompression path or DAS fallback if compression is activated in a future upgrade.

**Decision:** Note for future. No action until compression is activated.

---

### Finding C7 — Burn gate in `countNftMints` can undercount in exotic patterns

**Status: Info — by design**

**Audit finding:** Any Core Burn in a tx suppresses the Core Create count in `countNftMints`. This was intentional to handle forge/merge patterns (burn 2 + create 1 = 1 NFT). Edge case: a 12-asset bulk mint tx that also contains an unrelated Core burn would report ×1 instead of ×12. No known tx type produces this combination.

**Decision:** Info. The gate is correct for all known patterns.

---

### Finding C8 — Group system (CreateGroupV1 disc 39+) not modeled

**Status: Info — mint detection unaffected**

**Audit finding:** MPL Core's `GroupV1` account type is a new hierarchical taxonomy system (collections of collections, up to 8 nesting levels). Individual asset Create instructions still use `accounts[1]=CollectionV1`. The `Groups` plugin is metadata on the asset/collection — it doesn't change the Create instruction layout. VL's collection attribution from `accounts[1]` remains correct regardless of whether the collection is also in a Group.

**Decision:** Info. No mint detection gap. Note for future if VL adds taxonomy views.

---

### Finding C9 — BubblegumV2 on Core collections: cross-protocol gap

**Status: Deferred to Bubblegum audit**

**Audit finding:** A Core `CollectionV1` with the `BubblegumV2` plugin accepts compressed NFTs minted via the Bubblegum V2 program. VL's Core pipeline (subscribed to MPL Core) doesn't see these mints; VL's Bubblegum pipeline may emit them under a Merkle tree groupingKey rather than the Core collection address.

**Decision:** Out of scope for Core audit. Flag for Bubblegum / cNFT audit (Research Target #1 below).

---

## Audit #3 — Bubblegum / cNFT

**Sources:** `metaplex-foundation/mpl-bubblegum` GitHub (IDL, Rust source, account layouts), Solana mainnet pattern analysis (June 2026)

**VL files audited:**
- `src/ingestion/mint-raw/index.ts`
- `src/ingestion/mint-raw/launchpad-detector.ts`

**Architecture facts confirmed:**
- Current LMNFT cNFT path uses `mintToCollectionV1` and works.
- No tracked launchpad currently uses Bubblegum V2 `mintV2`.
- Bubblegum V2 changes both account layout (merkleTree moves from `accounts[3]` to `accounts[6]`) and noop program (SPL Noop → MPL Noop).
- For `mintToCollectionV1`, the real TM collection is available at `accounts[8]`; currently unused in favor of Merkle tree grouping.

**Audit #3 finding status:**

| Finding | Status | Notes |
|---|---|---|
| B1 | Backlog / high when Bubblegum V2 adopted | Wrong tree index for mintV2 |
| B2 | Backlog / high when Bubblegum V2 adopted | MPL Noop not recognised |
| B3 | Backlog / medium | DAS reduction + better grouping via real collection address |
| B4 | Backlog / medium when transferV2 appears | Wrong account layout for Tensor cNFT transferV2 |
| B5 | Backlog / low | Collectionless mintV1 not tracked; high-volume risk |
| B6 | Tracked by B1+B2 | BubblegumV2/Core cross-protocol gap resolves with B1+B2 |
| B7 | Cleanup with B1+B2 | Stale mintV2 comment contradicted by official layout |
| B8 | Informational | 90k lamport mint fee; no current price extraction impact |
| B9 | Informational | Post-mint instructions out of scope for live feed |

---

### Finding B1 — mintV2 Merkle tree index

**Status: Backlog**

**Audit finding:**
- Current extraction assumes `merkleTree` at `accounts[3]`.
- Official Bubblegum V2 `mintV2` layout has `merkleTree` at `accounts[6]`.
- No current production impact because tracked launchpads are not using Bubblegum V2 `mintV2` yet.

---

### Finding B2 — MPL Noop missing

**Status: Backlog**

**Audit finding:**
- Current code only recognises SPL Noop: `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`
- Bubblegum V2 trees emit to MPL Noop: `mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3`
- Fix together with B1 as a single Bubblegum V2 compatibility pass.

---

### Finding B3 — cNFT grouping by Merkle tree instead of real collection

**Status: Backlog — Medium priority**

**Audit finding:**
- Current cNFT rows use the Merkle tree address as `collectionAddress` / grouping key.
- For `mintToCollectionV1`, the real TM collection is available at `accounts[8]`.
- For `mintV2`, the Core collection is available at `accounts[7]`.
- Extracting the real collection would reduce DAS dependency and improve grouping latency — analogous to the Borsh-decode opportunity in Audit #1 Finding 4.

---

### Finding B4 — Tensor cNFT transferV2 extraction

**Status: Backlog**

**Audit finding:**
- Current `extractCnftAssetId` assumes V1 transfer layout: `merkleTree` at `accounts[4]`, nonce at data offset 104.
- `transferV2` uses `merkleTree` at `accounts[5]`.
- No current production impact. Fix when `transferV2` appears in Tensor cNFT sales.

---

### Finding B5 — No standalone Bubblegum subscription

**Status: Backlog — Low priority**

**Audit finding:**
- `mintV1` collectionless cNFT mints do not include Token Metadata or MPL Core, so they never reach current subscriptions.
- No tracked launchpad currently uses this path.
- Adding a Bubblegum-program `logsSubscribe` may be high-volume and should not be done casually; evaluate against credit budget before adding.

---

### Finding B6 — Core + BubblegumV2 cross-protocol gap

**Status: Tracked by B1+B2**

**Audit finding:**
- A Core `CollectionV1` with the `BubblegumV2` plugin accepts compressed NFTs minted via Bubblegum V2.
- Current extraction would use the wrong Merkle tree index (B1) and miss MPL Noop (B2).
- Resolves fully with the Bubblegum V2 compatibility pass (B1+B2).

*(Originally deferred from Audit #2 Finding C9.)*

---

### Finding B7 — Stale mintV2 comment

**Status: Cleanup with B1+B2**

**Audit finding:**
- Current code comment states that `mintV2` shares `accounts[3]=merkleTree` prefix with V1.
- Official Bubblegum V2 layout disproves this (`merkleTree` at `accounts[6]`).
- Clean up comment when B1+B2 are fixed.

---

### Finding B8 — Bubblegum V2 90k lamport mint fee

**Status: Informational**

**Audit finding:**
- Bubblegum V2 charges a ~90,000 lamport protocol fee per mint.
- Could inflate signer-delta price if cNFT price extraction ever uses signer SOL delta as the pricing method.
- No current impact on VL price extraction paths.

---

### Finding B9 — Post-mint Bubblegum instructions not watched

**Status: Informational**

**Audit finding:**
- `updateMetadata`, `verifyCollection`, `setAndVerifyCollection`, `unverifyCollection` are post-mint Bubblegum operations.
- Out of scope for the current live mint / sale feed.
- No action needed.

---

## Audit #4 — Candy Guard / Candy Machine V3

**Sources:** `metaplex-foundation/mpl-candy-guard` and `mpl-candy-machine` GitHub (IDL, Rust source, account layouts), Solana mainnet pattern analysis + offline fixtures (June 2026)

**VL files audited:**
- `src/ingestion/mint-raw/index.ts` (hasMintInstructionLog, isCandyGuardMintLog, enrichCgSupply)
- `src/ingestion/mint-raw/launchpad-detector.ts` (CANDY_GUARD_PROGRAM, PRNT_CORE_CANDY_GUARD)
- `src/ingestion/listener.ts` (subscription targets, MINT_PREFILTER_TARGETS)

**Architecture facts confirmed:**
- TM Candy Guard (`Guard1Jw…`) is subscribed directly; every tx is a mint candidate (no WS prefilter).
- Core Candy Guard (`CMAGAKJ…`) has no dedicated subscription; its mints arrive via the `mpl_core` subscription but must pass `hasMintInstructionLog` prefilter.
- Core CG emits `Instruction: MintV1` (outer, Guard) + `Instruction: MintAsset` (CM) + `Instruction: Create` (bare Core) — none of which matched any MINT_LOG_NEEDLES.
- TM CG legacy path emits `Instruction: Mint` (bare); `isCandyGuardMintLog` only checked `MintV2` and the dead `MintFromCache` needle.

**Audit #4 finding status:**

| Finding | Status | Notes |
|---|---|---|
| G1 | ✅ Fixed — comment only — commit `2232744` | Candy Machine state layout comment collapsed version/token_standard/features into fake u64 |
| G2 | ✅ Cleaned up — commit `3be3083` | `MintFromCache` needle was dead (never existed on-chain); removed |
| G3 | ✅ Fixed — commit `3be3083` | Legacy CG v1 `Instruction: Mint` missing from `CG_MINT_NEEDLES` |
| G4 | ✅ Fixed — commit `3745a7b` | Core CG mints dropped by `mpl_core` WS prefilter; PRNT_CORE_CANDY_GUARD shortcut added |
| G5 | Informational | `enrichCgSupply` binary offsets verified correct; only comment was wrong (G1) |
| G6 | Backlog — medium | Core CM supply enrichment not wired for Core CG mints specifically; see below |
| G7 | Backlog / comment — low | `disc=52` delegate_record assumption in `extractTmMintFromInner`; see below |

---

### Finding G1 — Candy Machine state layout comment incorrect ✅

**Status: Fixed — comment only — commit `2232744`**

**Audit finding:** The layout comment above `enrichCgSupply` (offset table at lines ~160–170) listed `offset 8  features  (u64, 8 bytes)`, collapsing `version` (u8), `token_standard` (u8), and `features` ([u8; 6]) into a single fake u64. The binary read offsets (`readBigUInt64LE(112)` and `readBigUInt64LE(120)`) were already correct — only the comment was wrong.

**Fix:** Corrected comment to:
```
offset  8  version                (u8, 1 byte)
offset  9  token_standard         (u8, 1 byte)
offset 10  features               ([u8; 6], 6 bytes)
offset 16  authority              (Pubkey, 32 bytes)
```

---

### Finding G2 — `MintFromCache` dead needle ✅

**Status: Cleaned up — commit `3be3083`**

**Audit finding:** `CG_MINT_NEEDLES` contained `'Instruction: MintFromCache'` which has never existed as a Candy Guard log line. Removed in the G3 fix.

---

### Finding G3 — Legacy Candy Guard `Instruction: Mint` missing from `CG_MINT_NEEDLES` ✅

**Status: Fixed — commit `3be3083`**

**Audit finding:** Legacy Candy Guard v1 emits `Instruction: Mint` (bare). `isCandyGuardMintLog` (the WS prefilter for the `candy_guard` subscription) only checked `MintV2` — so any admin operation (initialize, update, withdraw) with a log matching `Instruction: Mint` would be rejected correctly, but a real legacy mint would be passed through only if it also emitted `MintV2`. In practice the poller recovers these, but the WS path missed them.

**Fix:** Replaced `'Instruction: MintFromCache'` with `'Instruction: Mint'` in `CG_MINT_NEEDLES`.

---

### Finding G4 — Core Candy Guard mints dropped by `mpl_core` WS prefilter ✅

**Status: Fixed — commit `3745a7b`**

**Audit finding:** Core Candy Guard mints (`CMAGAKJ…`) arrive via the `mpl_core` subscription (because they invoke `CoREEN…`). The `mpl_core` target is in `MINT_PREFILTER_TARGETS`, so every notification is passed through `hasMintInstructionLog` before `fetchRawTx`. Core CG mints emit:
- `Instruction: MintV1` (outer Core CG, not a MINT_LOG_NEEDLES item)
- `Instruction: MintAsset` (Core CM, not a MINT_LOG_NEEDLES item)
- `Instruction: Create` (bare Core, intentionally excluded from MINT_LOG_NEEDLES)

`hasMintInstructionLog` returned `false` for both `tx_burn_gate.json` and `tx_mintx_no.json` fixtures, confirmed by diagnostic script.

**Fix:** Added `PRNT_CORE_CANDY_GUARD` (`CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ`) to the shortcut block in `hasMintInstructionLog`, mirroring the existing TM CG (`CANDY_GUARD_PROGRAM`) shortcut. Single program-presence → admit, per-tx detector resolves downstream.

**Diagnostic confirmation:**
```
tx_burn_gate.json:  BEFORE=false  AFTER=true  ✓ G4 CONFIRMED
tx_mintx_no.json:   BEFORE=false  AFTER=true  ✓ G4 CONFIRMED
```

---

### Finding G5 — `enrichCgSupply` binary offsets verified correct

**Status: Informational**

**Audit finding:** `enrichCgSupply` reads `items_redeemed` at offset 112 and `items_available` at offset 120. Both are correct per the official `CandyMachine` Anchor struct layout: after the 8-byte discriminator, the field sequence is `version(1) + token_standard(1) + features(6) + authority(32) + mint_authority(32) + collection_mint(32)` = 112 bytes, then `items_redeemed(u64)` at 112, then `data.items_available(u64)` at 120. No code change needed.

---

### Finding G6 — Core CM supply enrichment not wired for Core CG mints

**Status: Backlog — Medium priority**

**Audit finding:** `enrichCgSupply` is called when a detected mint has `lp.candyMachineState` set. The Core CG detector (`detectCoreCandyMachineMint` in `core-v2-detector.ts`) does populate `candyMachineState` from the CM account. However, there is no supply-refresh path specifically validated for Core CG's account schema differences from the TM CM V3 schema. The offsets were verified above (G5) to be byte-identical, so supply enrichment should work if `candyMachineState` is populated correctly. Investigation item: confirm that `detectCoreCandyMachineMint` correctly sets `candyMachineState` from a Core CG tx and that the offset reads produce reasonable numbers on a real Core CM account.

**Decision:** Backlog. Do not implement until confirmed on real Core CG mainnet data. Low risk of data corruption (enrichment is additive); risk is silent wrong supply counts.

---

### Finding G7 — `disc=52` delegate_record assumption in `extractTmMintFromInner`

**Status: Backlog / comment — Low priority**

**Audit finding:** The disc 52 (`Verify`) handler in `extractTmMintFromInner` includes a comment noting that the `delegate_record` field at `accounts[6]` is an assumption (not confirmed from the IDL). Per Audit #1 Finding 3, disc 52 is the only verify path currently firing on mainnet. The account layout for the unified Verify instruction places metadata at `accounts[2]` and collection_mint at `accounts[3]` — confirmed correct. The delegate_record field is not read for collection extraction, so even if the index is wrong, there's no functional impact.

**Decision:** Low priority. If touching `extractTmMintFromInner` for another reason, add a layout comment referencing the official TM unified-metaplex-program IDL entry for disc 52.

---

## Audit #5 — Token-2022 / SPL Token

**Sources:** Solana RPC docs (`getTransaction` `meta.pre/postTokenBalances[*].programId`); Helius DAS API (`getAsset`, `interface` field); `spl-token-2022` crate canonical program ID; VL source files (9 files audited, June 2026)

**VL files audited:**
- `src/ingestion/mint-raw/index.ts`
- `src/ingestion/mint-raw/launchpad-detector.ts`
- `src/ingestion/mint-raw/core-v2-detector.ts`
- `src/ingestion/me-raw/parser.ts`
- `src/ingestion/me-raw/price.ts`
- `src/ingestion/me-raw/programs.ts`
- `src/ingestion/tensor-raw/parser.ts`
- `src/ingestion/tensor-raw/programs.ts`
- `src/ingestion/tensor-raw/decoder.ts`
- `src/enrichment/helius-das.ts`
- `src/mints/detector.ts`

**Main verdict:** Mint pipeline correctly and completely rejects Token-2022. No Token-2022 WS subscription is intentional. No confirmed production bug. Remaining risk is sale-path hardening if Token-2022 NFTs ever match supported sale parsers and DAS admits them.

---

**Audit #5 status:**

| Finding | Status | Notes |
|---|---|---|
| T1 | Informational | Current mint-shape hard reject works |
| T2 | Informational | MINT_ADDRESS_BLACKLIST defense works |
| T3 | Backlog / low | Sale path `programId` guard missing in `extractNftMint` |
| T4 | Backlog / blocked on live DAS validation | `FungibleAsset` path could admit T22 NFT-shaped tokens |
| T5 | Backlog / low | Tensor T22 discriminators unverified; null buyer/seller |
| T6 | Backlog / low | MMM T22 discriminators unverified; null buyer/seller |
| T7 | Informational | Benign scoped substring match in `CG_MINT_NEEDLES` |
| T8 | Informational | No Token-2022 WS subscription — by design |
| T9 | Backlog with T4 | Permissive DAS fallback hardening |

---

### Finding T1 — Token-2022 hard reject in mint shape check

**Status: Informational**

**Audit finding:** `checkTokenMetadataNftShape` (`mint-raw/index.ts:2048`) iterates `postTokenBalances` for the extracted mint address. Returns `{ ok: false, reason: 'token_2022' }` if any entry has `programId === TOKEN_2022_PROGRAM`. This runs for every non-Core mint path. `RawTokenBalance.programId?: string` is typed in `me-raw/types.ts:45` with the explicit comment "Used by the mint parser to distinguish standard SPL Token NFTs (Tokenkeg…) from Token-2022 mints (Tokenz…)".

**Production impact:** Zero. No Token-2022 token can pass the mint shape check.

---

### Finding T2 — Token-2022 program in `MINT_ADDRESS_BLACKLIST`

**Status: Informational**

**Audit finding:** `MINT_ADDRESS_BLACKLIST` at `mint-raw/index.ts:316` contains both `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (SPL Token) and `TokenzQdBNbLqP5VEUNnHNEoA1YtbRuVvYr7fXMxHEy` (Token-2022). Prevents either program address from ever being emitted as a mint address if instruction account extraction glitches.

**Production impact:** Zero. Defense-in-depth layer only.

---

### Finding T3 — Sale path `extractNftMint` lacks `programId` guard

**Status: Backlog / low**

**Audit finding:** `extractNftMint` in `me-raw/price.ts:133` filters `postTokenBalances` by `amount='1', decimals=0` but does not check `postBal.programId`. Token-2022 token balances appear in `pre/postTokenBalances` with the same format as SPL Token. A Token-2022 mint with supply=1, decimals=0 (e.g. WNS NFT sold via a supported ME or Tensor instruction discriminator) would pass the filter and return the T22 mint address.

The `programId` field exists in the type (`me-raw/types.ts:45`). The mint pipeline uses it (`mint-raw/index.ts:2048`). The sale parser does not.

**Current mitigation:** DAS `verifyAndFetchAsset` — if DAS returns a non-NFT verdict for the T22 mint, the event is rejected. DAS is the sole backstop.

**Possible future fix:**
```typescript
// me-raw/price.ts — inside extractNftMint postBal loop:
if (postBal.programId === TOKEN_2022_PROGRAM) continue;
```
Requires exporting `TOKEN_2022_PROGRAM` from `me-raw/programs.ts` first.

**Decision:** Backlog. No T22 sale txs observed in production. DAS backstop sufficient today.

---

### Finding T4 — DAS `FungibleAsset` path admits Token-2022 NFT-shaped tokens

**Status: Backlog / blocked on live DAS validation**

**Audit finding:** `classifyDasAsset` in `helius-das.ts:270`:
```typescript
if (iface === 'FungibleAsset') {
  if (decimals === 0 && fSupply === 1) return { ok: true, kind: 'sft' };
  return { ok: false, reason: `interface=${iface}` };
}
```
WNS (Wen New Standard) Token-2022 NFTs have decimals=0 and supply=1. If Helius DAS returns `interface=FungibleAsset` for them, `classifyDasAsset` accepts them as kind='sft' and they enter the sale feed. The `DasAsset` type in VL does not currently model `token_info.token_program`, so there is no access path to filter by T22 program inside `classifyDasAsset` without first confirming that field exists in the live DAS response.

**Production impact:** If WNS NFTs are sold on Tensor (`buyT22`) and DAS returns the vulnerable combination, they could appear in the sale feed as nftType='legacy' (incorrect). Unconfirmed in VL production.

**Current mitigation:** None if DAS returns FungibleAsset + decimals=0 + supply=1.

**Possible future fix:** (1) Query Helius DAS `getAsset` for a known WNS mint address and inspect raw response. (2) If `token_info.token_program` is present: extend `DasAsset` type, add early-exit in `classifyDasAsset` when `tokenProgram === TOKEN_2022_PROGRAM`. Single-line change if field is confirmed.

**Decision:** Backlog. Blocked on live DAS query to confirm field presence. See Validation needed below.

---

### Finding T5 — Tensor `buyT22`/`takeBidT22` discriminators unverified

**Status: Backlog / low**

**Audit finding:** `tensor-raw/programs.ts` includes `buyT22` and `takeBidT22` in `TCOMP_SALE_INSTRUCTIONS` with all account indices null and marked unverified. `classifyNftType` in `tensor-raw/decoder.ts` has no Token-2022 branch — returns 'legacy' for anything that's not Bubblegum/Core. If these discriminators fire:
1. `findTcompSaleIx` matches → instruction returned
2. `classifyNftType` returns 'legacy'
3. `extractNftMint` reads T22 token balances → correct T22 mint address
4. Buyer/seller null (account indices unset)
5. DAS backstop validates

**Production impact:** Currently zero — discriminators never observed in VL logs. If T22 Tensor sales become significant: buyer/seller would be null, nftType 'legacy'.

**Decision:** Backlog. Verify Tensor TComp IDL and fill account indices, or remove entries until confirmed real.

---

### Finding T6 — MMM extended-token sale discriminators unverified

**Status: Backlog / low**

**Audit finding:** `me-raw/programs.ts` contains `solExtFulfillBuy`/`solExtFulfillSell` in `MMM_SALE_INSTRUCTIONS` with null account indices. Comment says "ext = extended token standard (e.g. Token-2022)". Same classification gap as T5: nftType='legacy', buyer/seller null, DAS backstop.

**Production impact:** Currently zero. Unconfirmed in production.

**Decision:** Backlog. Verify from ME/MMM IDL changelog or real tx before implementing.

---

### Finding T7 — `CG_MINT_NEEDLES` substring matches `MintTo`

**Status: Informational**

**Audit finding:** After the G3 fix, `CG_MINT_NEEDLES = ['Instruction: MintV2', 'Instruction: Mint']`. `line.includes('Instruction: Mint')` is a substring match and therefore also matches `Instruction: MintTo`. In a Candy Guard mint tx, SPL Token's `MintTo` fires as a CPI. So `isCandyGuardMintLog` could return true due to the `MintTo` line rather than the targeted `Mint` line.

**Production impact:** None. `isCandyGuardMintLog` is only called for the `Guard1Jw...` WS subscription. SPL Token `MintTo` txs do not fire the Guard1Jw subscription. The only time `MintTo` appears in logs processed by `isCandyGuardMintLog` is during real CG mint txs — which is the correct positive case.

**Optional future fix:** Replace `'Instruction: Mint'` entry with a regex like `TM_MINT_INSTRUCTION_REGEX = /Instruction: Mint(?:\s|$)/` to make the match precise. Not urgent.

---

### Finding T8 — No Token-2022 WS subscription (by design)

**Status: Informational / by design**

**Audit finding:** `MINT_PREFILTER_TARGETS` contains only `'mpl_core'` and `'token_metadata'`. No subscription for `TokenzQdBNbLqP5VEUNnHNEoA1YtbRuVvYr7fXMxHEy`. Token-2022 NFTs without TM metadata (WNS, embedded MetadataPointer extension) cannot enter the mint pipeline. Token-2022 NFTs WITH TM metadata fire the `token_metadata` subscription but are rejected by `checkTokenMetadataNftShape` (T1). Both paths are correct. Documented in `core-v2-detector.ts`: "Out of scope for /mints (Core / pNFT / legacy all run on the original SPL Token program)."

**Production impact:** Zero. Correct behavior.

---

### Finding T9 — Permissive DAS fallback accepts unknown interface

**Status: Backlog with T4**

**Audit finding:** `classifyDasAsset` at `helius-das.ts:297`:
```typescript
// Unknown interface but NFT-shaped (decimals 0, supply ≤ 1)
if ((decimals === 0 || decimals === undefined)
    && (fSupply == null || fSupply <= 1)) {
  return { ok: true, kind: 'legacy' };
}
```
If DAS returns a Token-2022 token with an unrecognized or empty `interface` string, `decimals=0`, and `supply=1`, it passes here as kind='legacy'. Affects T22 tokens that DAS has not fully indexed or whose interface string VL hasn't seen before.

**Production impact:** Low. Requires a T22 token to both (a) reach DAS verification via a sale parser discriminator match (T3/T5/T6) and (b) DAS return the right numeric shape with an unknown interface string. Improbable in current production.

**Decision:** Backlog with T4. If `token_info.token_program` is confirmed in the DAS response, add early-exit before the permissive fallback for T22 program.

---

### Validation needed before fixing T4/T9

- Run Helius DAS `getAsset` against a known WNS / Token-2022 NFT mint address.
- Inspect raw response: confirm presence and name of `token_info.token_program` field and value of `interface`.
- Search VL backend logs for any `buyT22`, `takeBidT22`, `solExtFulfillBuy`, `solExtFulfillSell` matches before implementing T5/T6 changes.

---

## Next Research Targets

Ordered by expected parser coverage gap / protocol complexity.

| # | Protocol / Source | Notes |
|---|---|---|
| 1 | Magic Eden API (sale ingestion parser) | Audit `src/ingestion/me-raw/*`'s ME v2 sale parser against the current ME API contract; check `sellerNetPriceSol` inflation guard behavior. Distinct scope from Audit #8, which covered the MMM pool-builder tool only. |

---

## Audit #8 — Magic Eden Protocol & API Architecture

**Sources:**
- Official docs: `docs.magiceden.io` (Solana API Overview), `docs.magiceden.io/reference/get_instructions-buy-now`, `.../get_instructions-buy`, `.../get_instructions-mmm-sol-fulfill-buy`, `.../get_mmm-pools-1`, `.../mmm-pool-pricing`.
- Live production behavior actually observed in this conversation (source priority #5): dozens of real MMM pool checks, sales, and failures worked through hands-on this session, including full captured browser console logs of the userscript/bridge round-trip and real on-chain transaction decodes.
- VL codebase: `src/server/tools-mmm-pools.ts`, `frontend/src/lib/mmm-bridge.ts`, `frontend/src/wallet/phantom.ts`, `tools/magiceden-vl-mmm-accept.user.js`, `docs/mmm-pool-checklist.md` (this project's own accumulated empirical findings — treated as VL codebase/prior-art, not an independent source).
- `docs.magiceden.io/reference/get_mmm-pools-1`'s response schema (poolType, cosigner, blockedAt, isMIP1, isOCP, buysideCreatorRoyaltyBp field definitions) could not be retrieved via static fetch — the reference page renders the example response only after an interactive "Try It!" action, which this audit's tooling cannot trigger. Findings touching these fields are marked **Validation only** (production-observed) per this audit's own rule: "If documentation is missing, explicitly state that the conclusion is based on observed production behavior."

**Architecture facts confirmed:**
- VL has **two structurally different** paths to build a `sol-fulfill-buy` transaction: (1) a backend server-to-server call to `https://api-mainnet.magiceden.dev/v2/mmm/pools/{poolKey}/instruction/sol-fulfill-buy` with `Authorization: Bearer ${ME_API_KEY}` (`tools-mmm-pools.ts` `fetchBidAcceptTx`), and (2) a Tampermonkey userscript running on `magiceden.io` itself that calls `https://api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy` with `credentials:'include'` (browser session cookies), relayed to the VL frontend over `postMessage`.
- Per this project's own `docs/mmm-pool-checklist.md` (built from repeated real attempts across this and prior sessions), path (1) reliably fails with `me_cosigner_required` for any pool with a non-default cosigner — i.e. for almost every real pool — because the on-chain-builder fallback inside that same function cannot produce ME's co-signature itself. Path (2) — the userscript — is the only one that has ever produced a real, successfully-landed sale in this project's history.
- Every transaction this pipeline submits, on both the frontend (`phantom.ts`) and backend (`tools-mmm-pools.ts` `/send-tx`) send paths, is submitted with `skipPreflight: true`. No path ever runs a preflight simulation before broadcasting.

**Audit #8 finding status (ranked by production risk, highest first):**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| M1 | Critical | ✅ Fixed — commit `6ce3ade` | Live Helius API key hardcoded in plaintext in the userscript, a client-side file distributed/readable by anyone who installs it |
| M2 | High | Validation only | The only working sell path depends on an **undocumented domain** (`api-mainnet.magiceden.io`, not the documented `.dev`) and undocumented cookie-session auth, confirmed against official docs which document only `.dev` + Bearer token |
| M4 | High | Backlog | `skipPreflight: true` on every send path means every malformed-tx failure (two of which were found and fixed this session — T22 ATA bug, two_sided cosigner-empty) costs a real on-chain fee instead of being caught for free by simulation |
| M3 | Medium-High | Validation only | `tokenStandard=4` sent to `sol-fulfill-buy` for pNFT pools is confirmed absent from ME's documented parameter list |
| M5 | Medium | Validation only | `poolType`/`cosigner`/`blockedAt`/`isMIP1`/`isOCP`/`buysideCreatorRoyaltyBp` — the fields VL's entire pool-sellability logic is built on — have no accessible official schema; all semantics are production-observed |
| M8 | Medium | Backlog | In-popup signing (`trySignInPopup`) uses a duck-typed fake transaction object to bypass wallet-extension type checks — explicitly wallet-internals-dependent, acknowledged as fragile in its own code comments |
| M10 | Medium | Informational | Confirms/records this project's own prior finding that the documented Bearer-token fallback path is unreliable in practice; the undocumented userscript path is the real production path |
| M9 | Low-Medium | Backlog | No specific handling for ME's embedded blockhash expiring during the multi-step popup/approval round-trip |
| M7 | Low | Backlog | Two low-stakes bridge messages (`VL_MMM_PING`, opener-ready announcement) use wildcard `'*'` targetOrigin, inconsistent with the strict-allowlist design used everywhere else in the same files |
| M6 | Informational | Compliant | ME's own pricing docs don't publish a seller-proceeds formula; VL correctly filled the gap via real on-chain log decoding rather than guessing |
| M11 | Medium | Backlog | ME API failure logs capture status/poolKey but never the response body, request params, or latency — matches this session's own repeated need to manually re-run raw `curl` to see ME's actual rejection reason |

---

### Finding M1 — Live Helius API key hardcoded in the userscript

**Severity:** Critical

**Evidence:** VL source, `tools/magiceden-vl-mmm-accept.user.js:209`:
```javascript
const rpcResp = await fetch('https://mainnet.helius-rpc.com/?api-key=5baf4ccb-82fd-4d44-87b1-fb71dfac926c',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
```
This is the project's real, currently-active Helius API key (confirmed identical to the key configured in `/root/nft-live-feed/.env` and used throughout this entire session's own RPC calls).

**Root cause:** The userscript's `trySignInPopup` fallback path needs to submit a signed transaction directly from within the `magiceden.io` popup context (to avoid a wallet ALT-resolution failure on the VL origin — see the surrounding comment), and the key was pasted inline rather than proxied through the VL backend.

**Impact:** A Tampermonkey userscript's source is plaintext and fully readable by anyone who installs it, views it in the Tampermonkey dashboard, or finds it via its distribution URL/repo. This key is Helius **plan-tier** credentials, not a public/rate-limited demo key — exposure means anyone can spend the project's Helius credit balance, and Helius has no way to distinguish that traffic from VL's own. This is not a theoretical risk: this exact key has been visible in this very conversation's own pasted browser console logs multiple times.

**Minimal production-safe fix:** The userscript's `signTransaction`-only fallback loop no longer sends anything itself — it returns the signed tx as base64 (`{ signedTxBase64 }`) over the existing `postMessage` bridge instead of POSTing to Helius directly. The VL frontend (`mmm-pool-lookup/page.tsx`) now handles a new `presignedUnsent` response shape: it submits the signed bytes through the **existing** `/api/tools/mmm-pools/send-tx` backend proxy (same endpoint `phantom.ts`'s `backendSendRaw` already uses for every other signed-but-unsent path — no new endpoint, no new secret, no CORS change needed since the actual `fetch` to `send-tx` now happens from the VL frontend's own origin, not from a `magiceden.io`-hosted script) and reuses the same tx-status confirmation-poll loop already used by the `presigned` (self-submitted) branch. `signAndSendTransaction` paths (which never touched the key) are unchanged. Bumped userscript to v0.5.6.

**Note — key rotation:** the fix removes the *code path* that exposed the key. The specific key value that was hardcoded (and has been visible in this session's own pasted logs) should still be rotated in Helius's dashboard and `.env` as a separate operational step; that is outside this repo's source control and was not done as part of this commit.

**Status:** ✅ Fixed — commit `6ce3ade`. `npm run build` (backend) and frontend `tsc --noEmit` + `next build` both clean.

---

### Finding M2 — Core sell path depends on an undocumented domain + undocumented auth method

**Severity:** High

**Evidence:** Official docs (`docs.magiceden.io/reference/get_instructions-mmm-sol-fulfill-buy`) — documented full request URL: `https://api-mainnet.magiceden.dev/v2/instructions/mmm/sol-fulfill-buy`, credential type "Bearer" (API key). VL source, `tools/magiceden-vl-mmm-accept.user.js:16`:
```javascript
const ME_IXS = 'https://api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy';
```
— note `.io`, not `.dev`. The fetch call (line 76-80) uses `credentials: 'include'` and no `Authorization` header at all — it relies entirely on the browser's existing `magiceden.io` session cookies, because the userscript executes in a real `magiceden.io` tab.

**Root cause:** `.io` is Magic Eden's own website's first-party API surface (same origin as the site itself), separate from `.dev`, the documented public developer API. Nothing in the official docs reviewed for this audit documents `.io` as a supported integration surface, its parameter contract, its stability guarantees, or its auth model.

**Impact:** VL's entire *working* sell path (per this project's own `docs/mmm-pool-checklist.md` history — the `.dev` Bearer-token path reliably fails with `me_cosigner_required` for real pools) runs through an API surface Magic Eden has made no public commitment to keep stable, versioned, or even available to third parties — it could change shape, require a new header, add bot detection, or be removed outright with zero notice, because from ME's perspective it is not a product, it is their own frontend's implementation detail.

**Minimal production-safe fix:** None proposed — there is no documented alternative that has been shown to actually work for cosigned pools (per M10). This is recorded as an accepted architectural risk, not a bug to patch.

**Status:** Validation only — conclusion is based on documented `.dev` behavior contrasted with this project's own extensive production observation of `.io`, not on any official statement that `.io` is unsupported (Magic Eden has published nothing about `.io` either way).

---

### Finding M3 — `tokenStandard=4` is not a documented `sol-fulfill-buy` parameter

**Severity:** Medium-High

**Evidence:** Official docs (`docs.magiceden.io/reference/get_instructions-mmm-sol-fulfill-buy`) list the full parameter set — required: `pool`, `assetAmount`, `minPaymentAmount`, `seller`, `assetMint`, `assetTokenAccount`; optional: `allowlistAuxAccount`, `skipDelist`, `priorityFee`. **No `tokenStandard` parameter appears anywhere in the documented set.** VL source, `tools/magiceden-vl-mmm-accept.user.js:68`:
```javascript
+ (isMip1 ? '&tokenStandard=4' : '');
```

**Root cause:** Per this project's own checklist doc, this parameter was added in userscript v0.5.2 after observing that pNFT pools otherwise return an oversized legacy transaction that fails the 1232-byte network cap for any pool with several creators; adding `tokenStandard=4` was found (empirically, not from any changelog) to make ME return a versioned transaction with Address Lookup Tables instead.

**Impact:** This works today and is corroborated by this session's own repeated pNFT sales, but it is entirely reverse-engineered — the value `4` (matching Metaplex's own `TokenStandard::ProgrammableNonFungible` enum discriminant) is an inference, not a confirmed contract. If ME ever validates/rejects unrecognized query parameters, or changes what triggers the versioned-tx code path, this would silently regress pNFT sells back to the byte-cap failure with no warning.

**Minimal production-safe fix:** None proposed — no documented alternative exists to replace the empirical param.

**Status:** Validation only — production-observed, not documented; explicitly called out as such per this audit's rules.

---

### Finding M4 — Every transaction is submitted with `skipPreflight: true`, forgoing free simulation

**Severity:** High

**Evidence:** VL source. Frontend, `frontend/src/wallet/phantom.ts:180`:
```typescript
const result = await sol.signAndSendTransaction(ltx, { skipPreflight: true });
```
Backend, `src/server/tools-mmm-pools.ts:1506` (`/tools/mmm-pools/send-tx`, used by every `backendSendRaw` call from `phantom.ts`):
```typescript
const result = await rpcPost('sendTransaction', [
  tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' },
]) as string;
```
Userscript in-popup fallback (`tools/magiceden-vl-mmm-accept.user.js:185,208`) also passes `skipPreflight: true` on both its `signAndSendTransaction` and raw `sendTransaction` calls.

**Root cause:** `phantom.ts`'s own docstring explains the *confirmation*-skipping rationale (avoiding a hanging WebSocket subscription) but that reasoning does not extend to *preflight*, which is a separate, one-shot, free simulation the RPC node performs before accepting a transaction for broadcast — `skipPreflight` was set on every path, not just the confirmation step.

**Impact:** A Solana transaction that fails on-chain still charges the fee payer the network fee — preflight simulation exists specifically to catch a guaranteed-fail transaction *before* that cost is incurred, for free. This session directly produced two real, confirmed cases of exactly this failure class reaching the chain: the Token-2022 ATA-derivation bug (`AccountNotInitialized`, custom program error 3012, real signature `59t1RbY...`) and the `two_sided` pool co-signer-empty case. Both cost a real transaction fee that a client-side simulation would have caught instantly and for free, with a much clearer error message than a raw on-chain program error.

**Minimal production-safe fix (not applied — no code changes without approval):** Change `skipPreflight` to `false` (or omit it — `false` is the RPC default) on at least the primary send paths, and surface the simulation error message directly to the user before offering to actually submit. `maxRetries: 3` and `preflightCommitment: 'confirmed'` on the backend path can stay as-is.

**Status:** Backlog — real, concretely-evidenced production cost (two confirmed incidents this session alone); not fixed as part of this audit per the "no code changes" rule.

---

### Finding M5 — Pool-classification fields (`poolType`, `cosigner`, `blockedAt`, `isMIP1`, `isOCP`, `buysideCreatorRoyaltyBp`) have no accessible official schema

**Severity:** Medium

**Evidence:** `docs.magiceden.io/reference/get_mmm-pools-1` documents the request (URL, query params, pagination/sort options) but its response schema is rendered only via an interactive "Try It!" action this audit's tooling could not trigger — none of these six fields could be confirmed as officially documented or given documented semantics. VL's entire pool-sellability heuristic (`docs/mmm-pool-checklist.md`, and this session's own extensive pool-by-pool analysis) is built by treating these fields' meanings as facts derived from repeated real transactions — e.g. `poolType: "invalid"` being a stale ME-registry snapshot rather than a live rejection signal (confirmed 6-for-6 sold / 2-for-2 blocked in the project's own tracking), `poolType: "two_sided"` being a hard co-sign failure (2-for-2 confirmed), `blockedAt` presence being a permanent block (3-for-3 confirmed).

**Root cause:** No official schema was locatable for this audit via the source-priority chain (static doc fetch failed to surface the response body).

**Impact:** None beyond the inherent risk already accepted by this project's whole empirical-methodology approach to MMM pools — this finding does not identify a new problem, it records that the *entire* foundation of that methodology is unverifiable against an official spec today.

**Fix:** None applicable — this is a documentation-accessibility gap on Magic Eden's side, not a VL defect.

**Status:** Validation only — every semantic claim about these fields in VL's own docs is (and is already labeled in those docs as) production-observed, not spec-derived.

---

### Finding M6 — ME's own pricing docs don't publish a seller-proceeds formula; VL's empirical approach was the only option

**Severity:** Informational

**Evidence:** `docs.magiceden.io/reference/mmm-pool-pricing` defines the pool-pricing variables (spot price, delta, royalty, maker/taker fee, LP fee, "effective price") and the linear/exponential curve formulas, but explicitly does **not** provide a worked formula for what a seller actually nets after fees and royalty on a real fulfillment. VL source: this project's own `docs/mmm-pool-checklist.md` records deriving the real fee model by decoding actual `SolFulfillBuy` program logs (`{"lp_fee":...,"royalty_paid":...,"total_price":...}`) from confirmed real sales, and explicitly documents having been wrong twice before landing on the current (still only "strong working hypothesis, not gospel") model.

**Root cause / behavior:** N/A — this is the audit confirming that a documentation gap VL already knew about is real on Magic Eden's side too, not something VL missed.

**Impact:** None — VL's methodology (decode real transactions rather than trust either the docs' incomplete formula or the unreliable `buysideCreatorRoyaltyBp` field) is the objectively correct response to this specific documentation gap.

**Fix:** None needed.

**Status:** Compliant — no action; recorded because the audit rules require citing evidence, and this is the evidence that VL's already-known empirical approach here is justified, not just expedient.

---

### Finding M7 — Two low-stakes bridge messages use wildcard `'*'` targetOrigin

**Severity:** Low

**Evidence:** VL source, `frontend/src/lib/mmm-bridge.ts:105`:
```typescript
w.postMessage({ type: 'VL_MMM_PING' }, '*');
```
`tools/magiceden-vl-mmm-accept.user.js:297`:
```javascript
window.opener.postMessage({ type: 'VL_MMM_READY' }, '*');
```
Contrast with every other `postMessage` call in both files, which scope to `ME_ORIGIN` / `event.origin` explicitly, and the strict `VL_ORIGINS` allowlist (`vl.nikki.gg`, `victorylabs.app`) checked on every *incoming* message in the userscript.

**Root cause:** Both messages exist purely to establish that a window reference is alive and pointed at the expected origin (the PING/READY handshake) — at the moment they're sent, the sender doesn't yet have positive confirmation of the receiving origin, which is arguably why `'*'` was used pragmatically for just this bootstrap step.

**Impact:** Low — neither message carries any sensitive payload (`{type: 'VL_MMM_PING'}` / `{type: 'VL_MMM_READY'}`, no pool/seller/mint data). If the popup had navigated to an attacker-controlled page between opening and the ping firing, that page would only learn that a VL bridge exists and is probing it — not any transaction data, which is only ever sent with `targetOrigin: ME_ORIGIN` after the handshake. All real data exchange in both files is correctly origin-scoped.

**Minimal production-safe fix:** Scope both calls to `ME_ORIGIN` (`mmm-bridge.ts`'s ping already knows it opened/is talking to `magiceden.io` — `ME_ORIGIN` is already a module constant there) and to the known VL origin the userscript is actually running under an opener from, respectively.

**Status:** Backlog — real but low-impact inconsistency; no sensitive data ever traverses either wildcard-scoped message.

---

### Finding M8 — In-popup signing uses a duck-typed fake transaction object, dependent on undocumented wallet-extension behavior

**Severity:** Medium

**Evidence:** VL source, `tools/magiceden-vl-mmm-accept.user.js:168-174`:
```javascript
const bytes = new Uint8Array(txData);
// Duck-typed vtx — wallets that call .serialize() without instanceof check will work
const fakeTx = {
  serialize: () => bytes,
  version: 0,
  signatures: [],
};
```
The code's own comment continues: *"Solflare (present on ME) accepts duck-typed objects; Phantom may vary."*

**Root cause:** Wallet-adapter APIs (`signAndSendTransaction`/`signTransaction`) are typically documented to accept real `VersionedTransaction`/`Transaction` class instances, not arbitrary objects — VL is relying specifically on whichever wallet extensions happen to implement a duck-typed accept (checking only for a `.serialize()` method) rather than a strict `instanceof` check, and has already observed that this doesn't hold uniformly across wallets (the code's own comment flags Phantom as uncertain).

**Impact:** Low in practice today because of the fallback design — every provider in the `trySignInPopup` loop is tried in sequence, and if all fail, the code explicitly falls through to the original VL-frontend-side signing flow (`console.warn(TAG, 'in-popup signing failed — falling back to tx-bytes response')`, confirmed firing in this session's own captured logs). A wallet tightening its type check would silently downgrade this optimization path to "always falls through," not break the sale.

**Minimal production-safe fix:** None proposed — the existing fallback already handles the failure mode correctly; this is recorded as a documented dependency on undocumented behavior per the audit's explicit ask, not a defect requiring a fix.

**Status:** Backlog — informational-leaning but kept at Medium because it is a direct, explicit "depends on undocumented behavior" instance the audit specifically asked to identify (Section 2/7).

---

### Finding M9 — No specific handling for ME's embedded blockhash expiring mid-flow

**Severity:** Low-Medium

**Evidence:** VL source, `frontend/src/wallet/phantom.ts` docstring: *"We intentionally skip getLatestBlockhash + confirmTransaction here: The ME tx has its own embedded blockhash; a freshly-fetched one is wrong."* Confirmed structurally correct — real captured response bodies in this session's own browser logs show ME returns `"blockhashData":{"blockhash":"...","lastValidBlockHeight":...}` alongside the tx bytes. No code path in `mmm-bridge.ts`, `phantom.ts`, or the userscript checks elapsed time against this blockhash's validity window, retries with a fresh instruction fetch on expiry, or gives a specific "your session timed out, try again" message distinct from a generic send failure.

**Root cause:** The full round-trip (open/reuse popup → ready handshake up to 25s → ME instruction fetch → optional in-popup sign attempt → fallback to VL-frontend → Phantom approval, which waits indefinitely for the user) has no upper bound on the time between ME embedding a blockhash and the transaction actually reaching `sendTransaction`. A slow user (distracted before approving the Phantom popup) can exceed a blockhash's validity window, which is significantly shorter than the bridge's own 25-second connection timeout.

**Impact:** Unconfirmed in this session (no observed case of this specific failure), but structurally plausible — the failure mode would surface as a raw "Blockhash not found" / expired-blockhash error from the RPC, which is not one of the specifically-translated error messages in `phantom.ts` (only the "Transaction too large" case gets a friendly rewrite).

**Minimal production-safe fix:** None proposed. Would require either a client-side blockhash-age check before submission or a specific catch-and-retry (re-fetch the ME instruction) on a blockhash-expired RPC error.

**Status:** Backlog — plausible but unconfirmed; no production incident traced to this in this audit.

---

### Finding M10 — The documented `.dev` + Bearer-token fallback path is confirmed unreliable for real cosigned pools

**Severity:** Medium

**Evidence:** VL source, `src/server/tools-mmm-pools.ts` (`fetchBidAcceptTx`, lines ~579-630): the `.dev` Bearer-token call is attempted first; on any failure it falls through to an **on-chain builder** that explicitly refuses to proceed unless the pool has no real cosigner:
```typescript
if (pool.cosigner !== SystemProgram.programId.toBase58()) {
  console.log('[fallback] BLOCKED: pool requires a real cosigner signature, cosigner=%s', pool.cosigner);
  throw new Error('me_cosigner_required: ME API unavailable for this pool and it requires a cosigner signature (on-chain builder cannot provide one)');
}
```
Per this project's own `project_mmm_cosigner_bridge_bugs` history (referenced in this session's memory) and the fact that every real pool this session worked with used the standard non-default ME cosigner (`NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd`), this fallback path is structurally unable to complete a sale for any pool matching this project's own real-world pool population.

**Root cause:** The on-chain builder was written as a *fallback for pools with no cosigner requirement* — a narrow case — while the actual undocumented `.io`-cookie userscript path (M2) is the one that handles the common case (real ME cosigner).

**Impact:** This is not a new discovery — it directly explains and formally records why this entire project built and depends on the browser-bridge/userscript architecture (M2) in the first place, rather than the officially documented endpoint + API key. Recorded as its own finding because it is the concrete evidence *for* M2's risk assessment, not a duplicate of it.

**Fix:** None proposed — this is the reason the current (working) architecture exists.

**Status:** Informational — records an already-known, already-load-bearing architectural fact with fresh evidence, doesn't propose a change.

---

### Finding M11 — ME API failure logs omit response body, request params, and latency

**Severity:** Medium

**Evidence:** VL source, `src/server/tools-mmm-pools.ts` (`fetchBidAcceptTx`):
```typescript
console.warn(`[tools/mmm-pools] ME API ${r.status} for ${poolKey}, trying on-chain builder`);
...
console.warn(`[tools/mmm-pools] ME API error for ${poolKey}:`, e);
```
No line reads or logs `await r.text()`/`await r.json()` on the non-`ok` branch, no request latency is measured, no `seller`/`assetMint` values are included, and there is no retry-count field (there is, in fact, no retry at all on this call — single attempt).

**Root cause:** The success path (`r.ok`) parses and uses the JSON body; the failure path only inspects `r.status`, discarding the body entirely — which is exactly where Magic Eden's more informative error messages live (this session repeatedly saw meaningful JSON error bodies like `-32000 Validation Error: ...` and pool-specific rejection reasons on failure responses, none of which this code path would ever surface in production logs).

**Impact:** Directly evidenced by this session's own workflow — nearly every ME-side failure investigated this session required manually re-running the equivalent request via raw `curl` to see *why* ME rejected it, because the running application's own logs don't capture that detail. This is a real operator-facing gap, not a user-facing one.

**Minimal production-safe fix:** On the non-`r.ok` branch, read and log `(await r.text()).slice(0, 500)` alongside status/poolKey/seller/mint/elapsed-ms, matching the truncated-body logging pattern already used elsewhere in this codebase (e.g. `me-raw/ingest.ts`'s non-JSON-response handler).

**Status:** Backlog — real, evidenced operator-experience gap; not fixed as part of this audit per the "no code changes" rule.

---

## Audit #8 summary and recommendation

**Ranked by production risk (highest first):** M1 (Critical — active key exposure) → M2 (High — undocumented core dependency) → M4 (High — real fee cost from skipped preflight, two confirmed incidents) → M3 (Medium-High — undocumented param) → M5 (Medium — unverifiable schema foundation) → M8 (Medium) → M10 (Medium, informational) → M11 (Medium) → M9 (Low-Medium) → M7 (Low) → M6 (Informational, compliant).

**Recommended for immediate fix:** **M1** (rotate the exposed key and stop hardcoding it — trivial, real, currently-active exposure) and **M4** (stop skipping preflight on send — small config change, directly prevents the exact class of real-money-costing failure this session hit twice). Both are small, low-risk, isolated changes with clear evidence of real (not theoretical) impact.

**Everything else is Backlog / Validation only / Informational** — no other finding is proposed for immediate action; per this audit's rules, no code has been changed and nothing will be until explicitly approved.

## Audit #7 — Helius DAS Architecture

**Sources:**
- Official Helius docs: `helius.dev/docs/api-reference/das/getasset`, `.../getassetsbyowner`, `.../searchassets`, `.../getassetbatch`.
- Live Helius API responses from the project's configured `HELIUS_API_KEY` (source priority #4 — used only to validate/disprove specific behavior, per audit rules, never as a primary source ahead of official docs).
- VL source (7 files): `src/enrichment/helius-das.ts`, `src/server/tools-mmm-pools.ts` (DAS call sites), `src/mints/enricher.ts`, `src/mints/collection-confirm.ts`, `src/tools-holders/fetch-assets.ts`, `src/mints/payment-token-enricher.ts`, `src/mints/name-backfill.ts`.
- `helius.dev/docs/rate-limits` and `.../rpc/limits` were requested and both returned HTTP 404 — Helius's current docs site does not appear to publish a rate-limit/retry-policy page at either guessed path. Noted explicitly per the "documentation ambiguous/unavailable" rule rather than asserting unsourced retry guidance.

**Scope note:** unlike Audit #6, this audit's scope explicitly includes `src/server/tools-mmm-pools.ts` (MMM Pool Lookup NFT filtering) because that tool's DAS *reads* (not its transaction-building path, still out of scope) are asset-classification logic identical in kind to the mint-feed enrichment DAS reads. No Wallet Checker code exists inside this repo (`/root/nft-live-feed`) — grep across the full source tree found zero matches for wallet-checker-specific paths; that tool lives in the separate `/root/wallet-checker` repo and is out of scope for an audit of *this* codebase.

**Architecture facts confirmed:**
- Every DAS-consuming module in this repo makes its own direct `fetch()` call to `https://mainnet.helius-rpc.com/?api-key=...` — there is no single shared DAS client wrapper; `src/enrichment/helius-das.ts` is the closest thing (shared cache + inflight-dedup for `getAsset`), but `tools-mmm-pools.ts` and `tools-holders/fetch-assets.ts` each implement their own independent `fetch` calls with separately-typed `DasAsset`/response interfaces.
- `getAssetBatch` (documented, up to 1000 ids per call) is never called anywhere in the repo — every DAS-consuming path issues one `getAsset`/`getAssetsByOwner`/`searchAssets` call per asset or per wallet.
- Four real DAS-reliant subsystems were audited end-to-end: (1) live mint feed enrichment (`helius-das.ts` + `mints/enricher.ts` + `mints/collection-confirm.ts`), (2) MMM Pool Lookup NFT filtering (`tools-mmm-pools.ts`), (3) the Holders tool (`tools-holders/fetch-assets.ts`), (4) name-backfill (`mints/name-backfill.ts`, thin wrapper around the shared `getAsset`).

**Audit #7 finding status:**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| D1 | Medium | ✅ Fixed — commit `e9dcf26` | `classifyDasAsset`'s and `isProgrammable`'s explicit `interface` checks don't cover the full documented enum (`LEGACY_NFT`, `V2_NFT`, `MplBubblegumV2`, `MplCoreCollection`, `MplCoreGroup`) — falls through to a permissive numeric fallback, safe-direction but mislabeled |
| D2 | Informational | Compliant | `searchAssets`' undocumented `tokenType`+`ownerAddress` coupling is real (live-confirmed `-32000` error) and VL's existing workaround is correct |
| D3 | Medium | ✅ Fixed — commit `e9dcf26` | `tools-mmm-pools.ts`'s `getAllWalletAssets` silently truncates on a transient mid-scan failure with zero signal to the caller, unlike the equivalent scan in `tools-holders/fetch-assets.ts` |
| D4 | Low | Backlog | `helius-das.ts`'s single-attempt DAS fetch + 60s negative cache has no retry, but call-site design (enricher.ts / collection-confirm.ts) already compensates for almost all of the practical impact |
| D5 | Informational | Backlog | `getAssetBatch` (supports up to 1000 ids/call) is never used despite several one-mint-at-a-time DAS loops |
| D6 | Informational | No action | `mint_extensions` is unused/unmodeled — not needed, since T22 detection already works via `token_info.token_program` |
| D7 | (carried) | Backlog — unblocked | Audit #5 T4/T9 remains open: `token_info.token_program` is now proven live in real responses, but `classifyDasAsset`'s `DasAsset` type still doesn't model it, so the FungibleAsset+decimals=0+supply=1 SFT-accept branch still can't exclude Token-2022 |
| D8 | Informational | Compliant | `collection-confirm.ts`'s 30s/120s/300s multi-attempt retry queue is the correct mitigation for DAS indexing lag |
| D9 | Informational | Compliant | `tools-holders/fetch-assets.ts` is a fully compliant reference implementation: explicit error/truncation surfacing, burnt-asset stale-owner handling, proper timeout |
| D10 | Low | Backlog | No DAS caller in the repo has 429-specific handling; official Helius rate-limit docs could not be located (two guessed paths both 404), so this is evaluated only against the codebase's own established circuit-breaker precedent (Audit #6) |

---

### Finding D1 — `interface` enum coverage is incomplete against the documented set

**Severity:** Medium

**Evidence:** `helius.dev/docs/api-reference/das/getasset` — the `interface` field's documented values are: `V1_NFT`, `V1_PRINT`, `LEGACY_NFT`, `V2_NFT`, `FungibleAsset`, `FungibleToken`, `Custom`, `Identity`, `Executable`, `ProgrammableNFT`, `MplCoreAsset`, `MplBubblegumV2`, `MplCoreCollection`, `MplCoreGroup`.

VL source, `src/enrichment/helius-das.ts` (`classifyDasAsset`):
```typescript
if (iface === 'MplCoreAsset')                      return { ok: true, kind: 'core' };
if (iface === 'ProgrammableNFT')                   return { ok: true, kind: 'pnft' };
if (iface === 'V1_NFT')                            return { ok: true, kind: 'legacy' };
if (tokenStandard === 'NonFungible')               return { ok: true, kind: 'legacy' };
if (tokenStandard === 'ProgrammableNonFungible')   return { ok: true, kind: 'pnft' };
```
VL source, `src/server/tools-mmm-pools.ts` (`isProgrammable`):
```typescript
function isProgrammable(asset: DasAsset): boolean {
  const std = asset.content?.metadata?.token_standard;
  return std === 'ProgrammableNonFungible' || std === 'ProgrammableNFT' || asset.interface === 'ProgrammableNFT';
}
```
Neither explicitly checks `LEGACY_NFT`, `V2_NFT`, `MplBubblegumV2`, `MplCoreCollection`, or `MplCoreGroup`.

**Root cause:** Both classifiers were written against the `interface` values actually observed in this session's live traffic (`V1_NFT`, `ProgrammableNFT`, `MplCoreAsset`, `Custom` — all seen directly in this conversation's own DAS queries), not against the full documented enum.

**Impact:** For `classifyDasAsset` specifically, the *permissive fallback* (`decimals === 0/undefined && supply ≤ 1 → accept as 'legacy'`) means an asset with `interface: "LEGACY_NFT"` or `"V2_NFT"` would very likely still be *accepted* into the mint feed — just mislabeled `kind: 'legacy'` regardless of its true shape, and NOT independently verified as pNFT/Core-specific. `MplBubblegumV2` is the more consequential case: it's the compressed-NFT-V2 interface, directly related to the still-open Bubblegum V2 gap from Audit #3 (B1/B2) — a V2 cNFT reaching `classifyDasAsset` would also fall to the numeric fallback rather than being recognized as compressed. For `isProgrammable` in the MMM tool, a pNFT that DAS reports as `interface: "V2_NFT"` (rather than `"ProgrammableNFT"`) combined with a missing/absent `token_standard` would be misclassified as *not* programmable, which feeds directly into the byte-size-risk badge (`sizeRiskReason` in `mmm-pool-lookup/page.tsx`) that warns users about the pNFT + 5-creator transaction-size limit — a false negative here means the size-risk warning could fail to show for a real pNFT.

**No production incident confirmed** for any of these five interface values on assets VL has actually processed — this is a documented-enum-vs-code-enum gap, not an observed bug.

**Minimal production-safe fix:** Added explicit branches in `classifyDasAsset` — `LEGACY_NFT` treated as an alias of `V1_NFT` (`kind: 'legacy'`); `MplBubblegumV2` explicit-accepted as `kind: 'legacy'` (no dedicated `NftKind` bucket exists for compressed assets — this makes the previously-implicit fallback behavior explicit instead of changing it); `MplCoreCollection`/`MplCoreGroup` explicitly **hard-rejected** (`interface=...`) since they are collection/group-level accounts, not individually owned NFTs — a case the original audit text underspecified but the "do not make unsupported assets executable/destructive by accident" instruction called for. `V2_NFT` intentionally left with no dedicated branch (ambiguous per docs; already falls through to the existing `token_standard` checks). `isProgrammable` in `tools-mmm-pools.ts` was **not** changed to treat `V2_NFT`/`LEGACY_NFT` as programmable — neither implies pNFT status, so doing so would have introduced false positives; a clarifying comment was added instead.

**Status:** ✅ Fixed — commit `e9dcf26`. Regression-tested live against two real mints (a legacy `V1_NFT` and the Mutantmon T22 mint) post-fix — both still classify as `{ok:true, kind:'legacy'}`, unchanged from pre-fix behavior.

---

### Finding D2 — `searchAssets`' `tokenType`+`ownerAddress` coupling: undocumented but live-confirmed, and VL's workaround is correct

**Severity:** Informational

**Evidence:** Official docs fetched for this audit did not surface this validation rule explicitly. Live API call made against the project's own Helius key for this audit:
```
params: { grouping: ["collection","G3uz4QgSbPFxmCc29YjoE9A1T8BBtJSFSNsb1ZJt4Gzw"], tokenType: "all", page: 1, limit: 1, burnt: false }
→ {"error":{"code":-32000,"message":"Validation Error: Must provide `owner_address` when using `token_type` field"}}
```
The identical call with `tokenType` omitted succeeded (`"total":0,"items":[]`, no error). VL source, `src/enrichment/helius-das.ts` (`getCollectionMintedCount`) already carries this exact finding as a code comment:
```typescript
// NB: do NOT pass `tokenType` here. Helius DAS validates `tokenType` only in
// conjunction with `ownerAddress` — sending it with grouping-only filters
// returns `-32000 Validation Error: Must provide owner_address when using
// token_type field`...
```

**Root cause / behavior:** An undocumented (or at least not surfaced by the pages fetched for this audit) server-side validation coupling in Helius's `searchAssets` implementation.

**Impact:** None — VL already discovered this empirically (live source, priority #4, exactly as this audit's rules permit) and coded the correct workaround before this audit ran.

**Fix:** None needed.

**Status:** Compliant — no action. Documented here so the constraint has an audit-trail entry independent of the inline code comment.

---

### Finding D3 — `tools-mmm-pools.ts`'s wallet-asset scan silently truncates on transient failure

**Severity:** Medium

**Evidence:** VL source, `src/server/tools-mmm-pools.ts` (`getAllWalletAssets`):
```typescript
for (let page = 1; page <= 20; page++) {
  try {
    const r = await fetch(..., { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) break;
    const j = await r.json() as { result?: { items?: DasAsset[]; total?: number } };
    const batch = j.result?.items ?? [];
    all.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
  } catch { break; }
}
return all;
```
Contrast with the equivalent, more defensive scan in `src/tools-holders/fetch-assets.ts` (`fetchCollectionOwners`), which sets `dasError` / `truncated` on the identical failure classes and returns them to the caller for surfacing.

**Root cause:** `getAllWalletAssets`'s `catch { break; }` and `if (!r.ok) break;` both silently stop pagination and return whatever pages were already collected — the caller (`fetchWalletNftsForPool`, ultimately the MMM Pool Lookup UI) has no way to distinguish "this wallet genuinely owns only 3 matching NFTs" from "the scan died on page 2 of 6 owing to a transient 429/timeout and 3 is a truncated undercount."

**Impact:** A user checking the MMM Pool Lookup tool with a large wallet could see fewer eligible NFTs than they actually hold, with zero indication that the result is incomplete — directly relevant to this session's own repeated pattern of the user pasting an NFT mint and asking "does this fit the pool," which this scan is supposed to answer proactively.

**Minimal production-safe fix:** `getAllWalletAssets` now returns `{ assets, truncated: boolean }` (mirroring `fetchCollectionOwners`'s shape) — `truncated` is set on a non-ok HTTP response or a thrown fetch/parse error, left `false` on the normal short-page completion path. `fetchWalletNftsForPool` propagates it through to `{ nfts, truncated }`, and the `GET /tools/mmm-pools/wallet-nfts` endpoint now includes `truncated` in its JSON response. No circuit-breaker/retry logic added (explicitly out of scope, that's D10). Frontend (`mmm-pool-lookup/page.tsx`) was **not** touched — it only reads `data.nfts` today and ignores unknown fields, so the new field is additive/non-breaking; wiring a UI warning off `truncated` is a separate follow-up.

**Status:** ✅ Fixed — commit `e9dcf26`.

---

### Finding D4 — `helius-das.ts`'s DAS fetch has no retry, but call-site design already absorbs most of the practical impact

**Severity:** Low

**Evidence:** VL source, `src/enrichment/helius-das.ts` (`fetchAssetWithSource`) — single `fetch()` attempt with an 8s timeout; any non-ok response, thrown error, or `json.error`/missing `json.result` goes straight to `assetMissCache.set(address, true)` (60s negative cache), no retry attempt. Contrast with `src/mints/collection-confirm.ts`'s explicit 3-attempt retry queue (30s/120s/300s) for the same underlying `getAsset` call, built specifically to handle "DAS hasn't indexed this mint yet" per that file's own docstring.

**Root cause / behavior:** The low-level fetch layer (`helius-das.ts`) is deliberately simple (cache + inflight-dedup only); retry-on-transient-failure is instead implemented per-caller where the stakes justify it (`collection-confirm.ts`), and where they don't, callers are designed to fail safe. `src/mints/enricher.ts`'s `isConfirmedFungibleVerdict` explicitly distinguishes a DAS transport failure from a confirmed non-NFT verdict and does **not** evict the mint-feed row on the former — so a `verifyAndFetchAsset` failure never removes a real NFT from `/mints`, it only skips the group-name-patch and fungible-eviction-check for that one specific mint. Per-mint (not per-group) dedup in `enricher.ts` means a transient failure on one mint doesn't block enrichment attempts for later mints in the same collection drop.

**Impact:** Low in practice. The one residual gap: `enricher.ts`'s per-mintAddress `verifiedMints` set is marked "attempted" at enqueue time, before the DAS call runs — so if a *specific* mint's one DAS attempt fails transiently, that exact mint never gets a second try (self-heals only via later mints in the same group triggering their own independent attempts, not via that mint being retried).

**Minimal production-safe fix (not applied — backlog per audit rules):** Either add a bounded retry (1 attempt, short delay) inside `fetchAssetWithSource` for timeout/5xx/429 specifically, or remove the mint from `verifiedMints` on a transient (not confirmed-fungible) verdict so a later re-enqueue can retry it.

**Status:** Backlog — low priority given the existing fail-safe design; no confirmed case of a real NFT being permanently mis-enriched found in this audit.

---

### Finding D5 — `getAssetBatch` is documented and available but never used

**Severity:** Informational

**Evidence:** `helius.dev/docs/api-reference/das/getassetbatch` — *"retrieves detailed information for up to 1,000 Solana NFTs, compressed NFTs, or tokens in a single efficient batch request."* Full-repository grep for `getAssetBatch` / `method:\s*['"]getAssetBatch['"]` returned zero matches anywhere in `src/`.

**Root cause / behavior:** Every DAS-consuming path in the repo (`mints/enricher.ts`'s throttled one-mint-at-a-time queue, `mints/collection-confirm.ts`'s per-mint retry queue, `mints/name-backfill.ts`'s per-mint sweep) issues individual `getAsset` calls rather than batching pending mint addresses into one `getAssetBatch` call.

**Impact:** None confirmed — these paths are already rate-shaped (500ms `REQUEST_GAP_MS` throttle, per-mint dedup) specifically to stay well under Helius limits per their own comments, so this is a potential credit/latency efficiency opportunity, not a correctness issue.

**Fix:** Not proposed — this is architecture-shaped batching work, explicitly out of scope for this audit's "not a refactor task" instruction. Recorded for a future dedicated pass if DAS credit cost becomes a constraint.

**Status:** Backlog — informational, no urgency.

---

### Finding D6 — `mint_extensions` is unused; not a gap for VL's current needs

**Severity:** Informational

**Evidence:** The `getAsset` documentation page fetched for this audit did not surface a `mint_extensions` field in the schema summary returned (it may exist on the live page under a section not captured by the fetch). VL's `DasAsset` interfaces (`helius-das.ts`, `tools-mmm-pools.ts`) do not model or read `mint_extensions` anywhere.

**Root cause / behavior:** VL's actual Token-2022 detection need — confirmed working in this session on a real T22 mint (Mutantmon) and shipped in the `tools-mmm-pools.ts` MMM-builder fix — is satisfied entirely by the simpler `token_info.token_program` field, which does not require parsing the extension list.

**Impact:** None. `mint_extensions` would only matter if VL needed to read specific T22 extension *contents* (e.g. `metadata_pointer`'s embedded fields, transfer-fee config) — no current feature does.

**Fix:** None needed.

**Status:** No action.

---

### Finding D7 — Audit #5 T4/T9 (Token-2022 FungibleAsset admission gap) remains open, now unblocked

**Severity:** Carried from Audit #5 (originally Backlog / blocked on live DAS validation)

**Evidence:** Audit #5 Finding T4 required confirming that Helius DAS actually returns `token_info.token_program` before a fix could be written. This session independently live-confirmed the field on a real Token-2022 mint (Mutantmon, `token_info.token_program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"`) — ad hoc, outside this audit series, during unrelated MMM-pool work. VL source, `src/enrichment/helius-das.ts`'s `DasAsset` interface (used specifically by `classifyDasAsset`, the mint-feed's NFT-vs-fungible gate) still has **no** `token_info.token_program` field:
```typescript
token_info?: {
  decimals?: number;
  supply?: number;
};
```
The `FungibleAsset` accept branch (`decimals === 0 && fSupply === 1 → { ok: true, kind: 'sft' }`) therefore still cannot exclude a Token-2022 WNS-style NFT-shaped token, per Audit #5 T4's original concern.

**Root cause:** The validation Audit #5 asked for is now done, but the corresponding code change was never made — this is a distinct file/type from the one already fixed for the *MMM builder tool's* T22 support (`tools-mmm-pools.ts`'s `DasAsset`, which does have `token_info.token_program` as of this session's earlier fix).

**Impact:** Unchanged from Audit #5's original assessment — no confirmed production occurrence of a WNS/T22 token reaching this path with the vulnerable `FungibleAsset`+decimals=0+supply=1 shape.

**Minimal production-safe fix (not applied — backlog per audit rules):** Add `token_program?: string` to `helius-das.ts`'s `DasAsset.token_info`, and add an early exclusion in `classifyDasAsset`'s `FungibleAsset` branch when `token_info.token_program === TOKEN_2022_PROGRAM`.

**Status:** Backlog — unblocked (validation step complete), fix still not applied; the operator did not request implementation of this fix in this audit's execution.

---

### Finding D8 — `collection-confirm.ts`'s multi-attempt retry queue correctly handles DAS indexing lag

**Severity:** Informational

**Evidence:** VL source, `src/mints/collection-confirm.ts` module docstring: *"a freshly-minted MPL Core asset isn't in DAS's index for the first few seconds (sometimes a couple of minutes) after the on-chain tx confirms... This module accepts the row optimistically... then verifies asynchronously via three DAS polls at 30 s / 120 s / 300 s after the mint."*

**Root cause / behavior:** This directly matches the audit checklist's "stale / cached DAS data" concern — DAS is a secondary index with a real, variable-length lag after on-chain confirmation, and any code that treats a single immediate `getAsset` miss as authoritative would misclassify or drop real assets. This module explicitly does not do that.

**Impact:** None — correct design, addresses a real and previously-observed failure mode (per the module's own cited incident signature).

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding D9 — `tools-holders/fetch-assets.ts` is a fully compliant reference implementation

**Severity:** Informational

**Evidence:** VL source, `src/tools-holders/fetch-assets.ts` — explicit `dasError`/`truncated` result fields surfaced to the caller on every failure class, `PAGE_LIMIT = 1000` matching the documented `getAssetsByGroup` maximum, `PAGE_TIMEOUT_MS = 10_000` on every request, and explicit handling of the documented-but-easy-to-miss `burnt: true` stale-owner behavior (verified against chain per its own code comment: a burnt asset's account becomes a 1-byte closed stub, yet DAS continues to report a stale pre-burn owner, which would otherwise inflate that wallet into a phantom top holder).

**Root cause / behavior:** N/A — this is the audit calling out a correct pattern, for contrast with Finding D3's gap in a sibling tool.

**Impact:** None — this module should be treated as the template for D3's fix.

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding D10 — No 429-specific handling in any DAS caller; official rate-limit docs page not locatable

**Severity:** Low

**Evidence:** `helius.dev/docs/rate-limits` and `helius.dev/docs/rpc/limits` both returned HTTP 404 when fetched for this audit — Helius's current docs site does not appear to publish a rate-limit/retry-policy reference at either guessed path (or it has moved; not locatable via the sources this audit's priority list permits). VL source: none of `helius-das.ts`'s `fetchAssetWithSource`, `tools-mmm-pools.ts`'s DAS calls, or `tools-holders/fetch-assets.ts` distinguish HTTP 429 from any other non-ok response — all three treat it identically to a 5xx or malformed response (fail/cache-miss/break, no backoff).

**Root cause:** No official Helius-specific rate-limit/retry guidance could be sourced for this audit (see above). Evaluated instead against the codebase's own internal precedent: `src/ingestion/me-raw/ingest.ts`'s `fetchRawTx` (audited in #6) has an explicit `isRateLimit()` check and a circuit-breaker (30s cooldown after 2 consecutive exhausted 429s) — no DAS caller has an equivalent.

**Impact:** Unconfirmed — no production incident traced to DAS-specific rate-limiting in this audit. Given DAS calls in this repo are already throttled at the application level (500ms gaps, per-mint/per-collection dedup, TTL caches), sustained 429 storms are less likely here than in the high-volume `getTransaction` path Audit #6 flagged, but the codebase has no defense if one occurs.

**Minimal production-safe fix (not applied — backlog per audit rules):** Reuse the `isRateLimit()` pattern from `me-raw/ingest.ts` in `helius-das.ts`'s `fetchAssetWithSource`, at minimum to log/distinguish 429s from other failures before deciding whether a shared DAS-specific circuit breaker is warranted.

**Status:** Backlog — real gap by internal-consistency standard, but external (Helius) retry guidance could not be sourced, and no confirmed production incident.

## Audit #6 — Solana RPC + WebSocket Architecture

**Sources:**
- Official Solana docs: `solana.com/docs/rpc` (commitment parameter), `solana.com/docs/rpc/websocket/logssubscribe`, `solana.com/docs/rpc/websocket/slotsubscribe`, `solana.com/docs/rpc/http/getsignaturesforaddress`, `solana.com/docs/rpc/http/gettransaction`, `solana.com/docs/references/terminology`.
- VL source (9 files): `src/ingestion/listener.ts`, `src/ingestion/amm-poller.ts`, `src/ingestion/me-raw/ingest.ts`, `src/ingestion/mint-raw/index.ts` (`enrichCgSupply`), `src/ingestion/mint-raw/reconcile.ts`, `src/ingestion/concurrency.ts`, `src/db/poller-state.ts`, `src/mints/core-supply-refresher.ts`, `src/mints/collection-created-resolver.ts`, `src/mints/resize-status-resolver.ts`, `src/index.ts` (boot order).

**Scope note:** this audit covers `src/ingestion/*` and its `src/mints/*`/`src/db/*` RPC call sites only — the same scope as Audits #1–#5 (the Live Mint Feed / sale ingestion pipeline). The MMM pool transaction-builder tool (`src/server/tools-mmm-pools.ts`, `frontend/src/app/tools/mmm-pool-lookup/`) is a separate subsystem that constructs and submits transactions (blockhash lifecycle, signing) and is explicitly **out of scope** here — confirmed with the operator 2026-07-03.

**Architecture facts confirmed:**
- Two independent, redundant discovery paths run continuously: `listener.ts` (per-program `logsSubscribe` WS + a fast/healthy-cadence `getSignaturesForAddress` poller) and `amm-poller.ts` (a DB-cursor-persisted `getSignaturesForAddress` gap-healer, described in its own header comment as "the authoritative source of truth for which transactions exist on-chain").
- A dedicated `slotSubscribe` WebSocket provides a ~400ms heartbeat independent of any program subscription, used purely to detect a dead TCP connection when NFT-sale volume is naturally low.
- All sale/mint RPC reads request `commitment: 'confirmed'` explicitly (never rely on the RPC default) — one exception found (Finding R3).
- Every signature is deduplicated at insert time via Postgres `ON CONFLICT (signature) DO NOTHING` (per `CLAUDE.md` / `insert.ts`), making the ingestion pipeline correct regardless of which path (WS, fast poller, gap-healer, webhook) delivers a given signature first, or whether more than one delivers it.
- `getTransaction` is called with `maxSupportedTransactionVersion: 0` and manually merges `meta.loadedAddresses` (writable/readonly) into `transaction.message.accountKeys`, with signer-flags reconstructed from `header.numRequiredSignatures` — required because raw `json` encoding omits per-key signer booleans for ALT-loaded versioned transactions.

**Audit #6 finding status:**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| R1 | Informational | Compliant | `logsSubscribe`/`getTransaction`/`getSignaturesForAddress` all explicitly request `commitment: 'confirmed'`, correctly overriding the documented `finalized` default |
| R2 | Informational | Compliant | `getTransaction` versioned-tx handling (`maxSupportedTransactionVersion: 0` + ALT merge + signer reconstruction) matches documented behavior |
| R3 | Low | ✅ Fixed — commit `6ce9415` | `enrichCgSupply`'s `getAccountInfo` call omits `commitment`, silently defaulting to `finalized` — inconsistent with every other RPC call site in the codebase |
| R4 | High | ✅ Fixed — commit `6ce9415` | `amm-poller.ts` `fetchPage()` has no request timeout — the only RPC call site in the audited codebase without one; a hung connection permanently wedges that target's gap-healer |
| R5 | Medium | Backlog | `amm-poller.ts` `fetchPage()` has no 429-specific handling / circuit breaker, unlike `me-raw/ingest.ts`'s `fetchRawTx` |
| R6 | Informational | No action | `confirmationStatus` field in `getSignaturesForAddress` responses is typed but unread — harmless, since `commitment: 'confirmed'` already gates the result set server-side |
| R7 | Informational | Compliant | WS-unreliability defense (dual-poller + watchdog + hard periodic refresh) is architecturally correct given official docs document no delivery/gap guarantee for `logsSubscribe` |
| R8 | Informational | Compliant | `before`/`until` pagination in both pollers matches documented semantics and correctly avoids the "silently returns only the newest `limit` sigs" gap failure mode |
| R9 | Informational | N/A — out of scope | Blockhash lifecycle, `getSignatureStatuses`, `searchTransactionHistory`, `accountSubscribe`, `programSubscribe`, `signatureSubscribe`, `blockSubscribe`, `rootSubscribe`, `getBlock`, `getBlocks`, `getSlot`, `getProgramAccounts` are not used anywhere in the audited ingestion pipeline — it is 100% read-only (no transaction construction/signing/submission occurs in this code path) |
| R10 | Informational | Compliant | Idempotent `ON CONFLICT (signature) DO NOTHING` insert makes the pipeline correct under any WS/RPC notification ordering — official docs make no ordering guarantee between a WS notification and a subsequent RPC read, and VL's design doesn't need one |

---

### Finding R1 — Commitment level explicitly set to `confirmed` everywhere it matters

**Severity:** Informational

**Evidence:** `solana.com/docs/rpc` — *"Many RPC methods and subscriptions accept a `commitment` parameter... If a method or subscription accepts `commitment` and you omit it, the default is typically `finalized`."* `solana.com/docs/rpc/websocket/logssubscribe` confirms the same default for the WS config object.

**Root cause / behavior:** `listener.ts` explicitly documents (openSubscription, ~line 878) why `confirmed` was chosen over the default: subscribing at `processed` measured a ~40% null-result rate against `fetchRawTx`, because Helius notified before the tx was indexed at `confirmed`. All `logsSubscribe` (`{ commitment: 'confirmed' }`), `getTransaction` (`commitment: 'confirmed'`), and `getSignaturesForAddress` (`commitment: 'confirmed'`) calls across `listener.ts`, `amm-poller.ts`, and `me-raw/ingest.ts` set this explicitly rather than relying on the default.

**Impact:** None — this is the correct, deliberate choice, evidenced by the documented before/after measurement in the code comments.

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding R2 — Versioned-transaction (`maxSupportedTransactionVersion`) handling is correct

**Severity:** Informational

**Evidence:** `solana.com/docs/rpc/http/gettransaction` — *"Setting it to `0` allows you to fetch all transactions, including both Versioned and legacy transactions... If you omit this parameter, only legacy transactions will be returned — any versioned transaction will result in an error."*

**Root cause / behavior:** `me-raw/ingest.ts` (`_fetchRawTxRpc`) sets `maxSupportedTransactionVersion: 0` and separately reconstructs `accountKeys` from `meta.loadedAddresses.writable`/`.readonly` plus a signer-flag rebuild from `message.header.numRequiredSignatures` — because raw `json` encoding does not include ALT-loaded accounts in `message.accountKeys` and does not carry a per-key `signer` boolean at all (only the header's numRequiredSignatures count implies it).

**Impact:** None — correct handling. Without this, every v0 (ALT) sale/mint transaction would either be rejected by the RPC (if `maxSupportedTransactionVersion` were omitted) or silently miss accounts referenced only via the ALT (if the merge were skipped).

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding R3 — `enrichCgSupply`'s `getAccountInfo` omits `commitment`, silently defaulting to `finalized`

**Severity:** Low

**Evidence:** `solana.com/docs/rpc` — *"If a method or subscription accepts `commitment` and you omit it, the default is typically `finalized`."* VL source, `src/ingestion/mint-raw/index.ts` (`enrichCgSupply`):
```typescript
body: JSON.stringify({
  jsonrpc: '2.0', id: 'cm-supply', method: 'getAccountInfo',
  params: [candyMachineState, { encoding: 'base64' }],
}),
```
No `commitment` key in the params object — every other RPC call site audited (`listener.ts` ×4, `amm-poller.ts`, `me-raw/ingest.ts`, `mint-raw/reconcile.ts`, `core-supply-refresher.ts`) explicitly sets `commitment: 'confirmed'`.

**Root cause:** Simple omission — the params object for this one call was never given a `commitment` field, so the RPC silently falls back to `finalized`.

**Impact:** `finalized` commitment lags `confirmed` by however long it takes 2/3 of stake to vote past the block (documentation does not give a fixed slot count — see "documentation ambiguous" note below). In practice this means a just-minted Candy Machine's `items_redeemed` count read by this function can be a few seconds staler than the rest of the pipeline (which reads at `confirmed`). `CM_SUPPLY_TTL_MS` is 15 seconds, so the extra lag is within the existing cache tolerance — no user-visible bug has been traced to this. It is a real inconsistency, not a confirmed production incident.

**Documentation ambiguity:** Official docs state the *definition* of `finalized` vs `confirmed` but do not give an exact slot-count or time delta between them anywhere in the pages fetched for this audit (`solana.com/docs/rpc`, `solana.com/docs/references/terminology`) — the practical lag is a network-observed quantity, not a protocol-guaranteed constant, so an exact "N seconds slower" claim cannot be sourced from official docs and is not asserted here.

**Minimal production-safe fix:** Add `commitment: 'confirmed'` to the `params` object in `enrichCgSupply`, matching every other call site.

**Status:** ✅ Fixed — commit `6ce9415`. `params: [candyMachineState, { encoding: 'base64', commitment: 'confirmed' }]`.

---

### Finding R4 — `amm-poller.ts` `fetchPage()` has no request timeout — can permanently wedge a target's gap-healer

**Severity:** High

**Evidence:** VL source, `src/ingestion/amm-poller.ts` (`fetchPage`, full function body — every other audited call site is quoted below for contrast):
```typescript
const res = await fetch(rpcUrl(), {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [program, params] }),
});
```
No `signal` key at all. Contrast with every other RPC call site in the audited codebase, all of which set an explicit timeout:
- `listener.ts` `pollTarget`: `signal: AbortSignal.timeout(8_000)`
- `listener.ts` `seedSeenSigs`: `signal: AbortSignal.timeout(8_000)`
- `me-raw/ingest.ts` `_fetchRawTxRpc`: `AbortController` + `FETCH_TIMEOUT_MS = 8_000`
- `mint-raw/reconcile.ts`: `signal: AbortSignal.timeout(10_000)`
- `mint-raw/index.ts` `enrichCgSupply`: `signal: AbortSignal.timeout(8_000)`
- `mints/core-supply-refresher.ts`: `AbortController` + 15s manual timer
- `mints/collection-created-resolver.ts`, `mints/resize-status-resolver.ts` (×2 call sites): `AbortController`-based timeouts

Node's global `fetch` (undici) has no default request timeout — an unresponsive or half-open TCP connection to the RPC endpoint will hang for the underlying OS socket timeout (which can be minutes), not for any application-level bound, unless a `signal` is supplied.

**Root cause:** `fetchPage()` is the sole low-level RPC caller inside `amm-poller.ts`. `sweepTarget()` sets `sweepInFlight.set(target.name, true)` before calling it and only clears the flag in a `finally` block after the awaited chain (`fetchSinceCursor` → `fetchPage`) settles. If `fetchPage`'s `fetch()` call never settles (hangs), the `finally` never runs, `sweepInFlight` for that target stays `true` forever, and every subsequent scheduled `tick()` call for that target short-circuits at the re-entrancy guard (`if (sweepInFlight.get(target.name)) return;`) without ever attempting another sweep.

**Impact:** A single stalled TCP connection to the Helius RPC endpoint (a real, if infrequent, class of failure — silently dropped connections without a FIN/RST are a known behavior of some proxies/load balancers under network partition) permanently disables `amm-poller`'s gap-healing for one program (`me_v2`, `mmm`, `tcomp`, `tamm`, or `orbis`) until the process is restarted. Per the file's own header comment, this poller is explicitly "the authoritative source of truth for which transactions exist on-chain" — its silent death is not visible in any existing alerting (no watchdog analogous to `listener.ts`'s slot/event staleness checks exists for `amm-poller`). Sales for the affected program would still flow through `listener.ts`'s WS + fast-poller paths, so this is a *coverage-quality* degradation, not a full outage — but it defeats the specific purpose this poller exists for. No production incident has been confirmed for this specific failure mode; the finding is a code-level gap, not an observed outage.

**Minimal production-safe fix:** Add a bounded `AbortController` (matching the 8–10s pattern used everywhere else in the codebase) to the `fetch()` call inside `fetchPage()`, e.g. `signal: AbortSignal.timeout(8_000)`, so a hung connection surfaces as a normal rejected promise into `sweepTarget`'s existing `catch` block instead of hanging indefinitely.

**Status:** ✅ Fixed — commit `6ce9415`. Added `signal: AbortSignal.timeout(8_000)` to the `fetch()` call in `fetchPage()`, matching the pattern already used in `listener.ts` / `me-raw/ingest.ts` / `mint-raw/reconcile.ts`. A timeout now surfaces as a normal rejected promise into `sweepTarget`'s existing `catch`/`finally`, so `sweepInFlight` is guaranteed to reset within 8s instead of hanging indefinitely.

---

### Finding R5 — `amm-poller.ts` `fetchPage()` has no 429 / rate-limit-specific handling

**Severity:** Medium

**Evidence:** VL source, `src/ingestion/amm-poller.ts` (`fetchPage`) — the only error handling present is `if (json.error) throw new Error(...)`; there is no HTTP-status check for `429` and no equivalent of `me-raw/ingest.ts`'s `isRateLimit()` / circuit-breaker (`COOLDOWN_MS`, `COOLDOWN_THRESH`, `onRateLimitExhausted`).

**Root cause:** `fetchPage`'s only failure path is a thrown exception, caught generically by `sweepTarget`'s outer `try/catch` (logs and returns). A 429 response is treated identically to any other RPC error — no distinction, no backoff specific to rate-limiting.

**Impact:** Under sustained rate-limiting, every one of the (up to 5) `amm-poller` targets independently retries on its own next scheduled tick (5s–15s later depending on mode/backoff state) with no coordinated backoff — unlike `me-raw/ingest.ts`'s `fetchRawTx`, which trips a shared 30-second cooldown after 2 consecutive exhausted 429s. This does not risk data loss (the next tick's `getSignaturesForAddress` call re-covers the same window via the persisted cursor), but it does not actively reduce request pressure during a 429 episode the way the sibling `fetchRawTx` path does, and could prolong a rate-limit episode across all 5 targets simultaneously.

**Minimal production-safe fix:** Reuse or mirror `me-raw/ingest.ts`'s `isRateLimit()` check inside `fetchPage`, and apply a short per-target cooldown (or reuse the existing saturated/degraded cadence machinery) on repeated 429s before the next scheduled tick fires.

**Status:** Backlog — real gap, but self-healing via the existing tick cadence and persisted cursor; no confirmed production incident.

---

### Finding R6 — `confirmationStatus` field is fetched but never read

**Severity:** Informational

**Evidence:** `solana.com/docs/rpc/http/getsignaturesforaddress` — response field `confirmationStatus: string | null`, possible values `"processed"`, `"confirmed"`, or `"finalized"`. VL source: `amm-poller.ts` declares `interface SigInfo { signature: string; err: unknown; confirmationStatus: string | null; }` but no code in the audited files reads `.confirmationStatus` on any row.

**Root cause / behavior:** Every `getSignaturesForAddress` call in the audited codebase passes `commitment: 'confirmed'` as a request parameter. Per `solana.com/docs/rpc`, the commitment parameter "specifies how finalized a block must be before the node returns data" — meaning the RPC server itself is expected to gate the result set to that level or higher before returning it, making a client-side re-check of `confirmationStatus` per-row redundant for VL's purposes.

**Impact:** None. The field being present-but-unused is not a bug — it's an artifact of typing the full RPC response shape.

**Fix:** None needed; optional cleanup only if the interface is touched for another reason.

**Status:** No action.

---

### Finding R7 — Dual-poller + watchdog architecture is the correct response to `logsSubscribe`'s undocumented delivery guarantees

**Severity:** Informational

**Evidence:** `solana.com/docs/rpc/websocket/logssubscribe` was fetched specifically for this audit to check for any documented guarantee about notification ordering, dropped/missed notifications, or resubscribe-after-disconnect gap coverage. None of these are addressed anywhere on the official page — the documentation covers only the request/response shape and the `mentions` filter's one-address limitation.

**Root cause / behavior:** In the absence of any documented delivery guarantee, VL's `listener.ts` is built around the explicit assumption that `logsSubscribe` **cannot** be trusted alone (module docstring: *"Reconnects automatically... Slot heartbeat + dual watchdog + forced 120s restart prevent silent stalls"*; a further comment: *"WS logsSubscribe is currently unreliable... This poller is the PRIMARY discovery path"*). Concretely: (a) a dedicated `slotSubscribe` heartbeat detects a fully-dead TCP connection independent of program-specific traffic; (b) a three-tier watchdog (global slot >20s stale, global event >30s stale, per-target notification staleness with quiet-program-aware thresholds) restarts exactly the failed scope; (c) every reconnect triggers an immediate `getSignaturesForAddress` catch-up poll to backfill whatever the WS missed during the outage; (d) an independent, DB-cursor-persisted `amm-poller` runs continuously regardless of WS health as a second, restart-surviving discovery path; (e) a 30-minute unconditional hard-refresh cycles every subscription as a backstop for degradation the watchdog logic doesn't catch.

**Impact:** None — this is defense-in-depth appropriately scaled to a documented absence of guarantees, not overengineering. The idempotent DB insert (Finding R10) means even redundant re-delivery across all of these paths is harmless.

**Fix:** None needed.

**Status:** Compliant — no action. Worth noting for future maintainers: this architecture exists *because* the protocol offers no missed-notification guarantee, not despite one.

---

### Finding R8 — `before`/`until` pagination correctly avoids the "returns only the newest `limit` sigs" gap

**Severity:** Informational

**Evidence:** `solana.com/docs/rpc/http/getsignaturesforaddress` — `before`: *"Start searching backwards from this transaction signature. If not provided the search starts from the top of the highest max confirmed block."* `until`: *"Search until this transaction signature, if found before limit reached."* `limit` max is 1000; VL uses page sizes of 20 (`amm-poller.ts`) and 100 (`listener.ts`), both within bounds.

**Root cause / behavior:** Both pollers correctly recognize that a single `getSignaturesForAddress` call bounded only by `limit` can silently truncate if more than `limit` signatures landed since the last cursor (`listener.ts`'s own comment: *"the RPC returns only the LIMIT newest sigs and silently skips older-but-still-newer-than-prevCursor ones"*). `amm-poller.ts`'s `fetchSinceCursor` detects this via a `saturated` flag (full page AND more than `LOW_PAGE_THRESHOLD` pages walked) and continues paginating backward with `before` while holding `until` fixed at the last confirmed cursor, persisting a `<frozen_newest>:<before>` continuation marker in Postgres (`poller_state`) so the walk survives a process restart. `listener.ts`'s `mpl_core` cursor-poll implements the equivalent at-cap pagination in-process.

**Impact:** None — this is exactly the correct mitigation for the documented `limit`-truncation risk, and the persisted continuation marker additionally protects against losing the walk across a restart, which the bare protocol semantics do not provide on their own.

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding R9 — Blockhash lifecycle, `getSignatureStatuses`, and account/program/signature/block/root subscriptions are out of scope (not used)

**Severity:** Informational

**Evidence:** Full-repository grep of `src/ingestion/**/*.ts` and the RPC-calling files under `src/mints/*` / `src/db/*` for `getSignatureStatuses`, `searchTransactionHistory`, `getLatestBlockhash`, `accountSubscribe`, `programSubscribe`, `signatureSubscribe`, `blockSubscribe`, `rootSubscribe`, `getBlock`, `getBlocks`, `getSlot`, `getProgramAccounts` returned zero real call sites (only comment/string mentions of `getAccountInfo`, which *is* used — see `mint-raw/index.ts` `enrichCgSupply` and `core-supply-refresher.ts`'s `getMultipleAccounts`, both audited above/positively).

**Root cause / behavior:** The audited pipeline is a **read-only ingestion service** — it discovers signatures (`getSignaturesForAddress`, `logsSubscribe`), fetches their contents (`getTransaction`), and reads a small number of account states for enrichment (`getAccountInfo`, `getMultipleAccounts`). It never constructs, signs, or submits a transaction, so there is no blockhash to expire, no signature to poll for confirmation after sending, and no reason to subscribe to a specific account or program's account-level changes (`accountSubscribe`/`programSubscribe`) or block-level events (`blockSubscribe`/`rootSubscribe`).

**Impact:** None — this is a scope boundary, not a gap. (The transaction-*sending* MMM pool builder tool, which does need blockhash-lifecycle handling, is a separate subsystem explicitly excluded from this audit's scope — see the scope note at the top of Audit #6.)

**Fix:** None needed / not applicable.

**Status:** N/A — out of scope for this audit target.

---

### Finding R10 — Idempotent insert makes WS/RPC ordering assumptions unnecessary

**Severity:** Informational

**Evidence:** Official docs (`solana.com/docs/rpc/websocket/logssubscribe`, `solana.com/docs/rpc`) make no statement anywhere about ordering guarantees between a WebSocket notification and a subsequent or concurrent RPC read for the same transaction, nor about whether two different notification sources (e.g. two separate `logsSubscribe` connections, or a WS notification vs. a poller's `getSignaturesForAddress` result) can legitimately deliver the same signature more than once. VL source: `insertSaleEvent` uses `ON CONFLICT (signature) DO NOTHING` (documented in `CLAUDE.md`: *"`ON CONFLICT (signature) DO NOTHING` makes re-ingest safe"*).

**Root cause / behavior:** Rather than assuming any particular delivery order or exactly-once semantics from the protocol (which the docs do not promise), every code path that can discover a signature (WS listener, fast poller, `amm-poller`, Helius webhook fast-path) is allowed to race independently, with per-scope in-memory dedup (`sigSeenInScope`, `markLocalSeen`, `seenSigs`) as a *cost* optimization (avoiding redundant `getTransaction` credits), and the database `ON CONFLICT` clause as the actual *correctness* guarantee.

**Impact:** None — this is the correct way to handle an undocumented ordering/uniqueness guarantee: don't assume one, make the final write idempotent instead.

**Fix:** None needed.

**Status:** Compliant — no action.
