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
| 1 | Solana Runtime / RPC / WebSocket | Audit `logsSubscribe` notification completeness, slot gap detection, and reconnect behavior under load. |
| 2 | Helius DAS / Enhanced Transactions | Audit `getAsset` field stability, `tokenStandard` completeness across TM and Core, and `interface` enum coverage. Also unblocks T4/T9 DAS validation. |
| 3 | Magic Eden API | Audit ME v2 sale parser against current ME API contract; check `sellerNetPriceSol` inflation guard behavior. |
