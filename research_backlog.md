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
| 9 | Magic Eden Integration Compliance (bridge lifecycle, retries, confirmation, sale parser) | Complete | 2026-07-03 |
| 10 | Solana Transaction Lifecycle, Wallet, Signing & Sending Architecture | Complete | 2026-07-03 |
| 11 | Live Feed Architecture & Event Completeness | Complete | 2026-07-03 |
| 12 | Postgres / Database Consistency, Idempotency, Retention & Query Performance | Complete | 2026-07-03 |
| 13 | Security, Trust Boundaries & Production Hardening | Complete | 2026-07-03 |

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
| 1 | Magic Eden API (sale ingestion parser) | ✅ Addressed by Audit #9 (Finding ME6) — `sellerNetPriceSol` guard confirmed present in the ME v2 path only; MMM/cNFT paths lack it (Backlog). |

---

## Audit #11 — Live Feed Architecture & Event Completeness

**Sources:**
- Official docs: `solana.com/docs/rpc/websocket/logssubscribe`, `solana.com/docs/rpc/http/getsignaturesforaddress`, `solana.com/docs/rpc#configuring-state-commitment`, `helius.dev/docs/rpc/websocket` (idle timeout, keepalive, reconnect guidance).
- VL codebase: `src/ingestion/listener.ts` (2072 lines — primary logsSubscribe live path + cursor poller), `src/ingestion/amm-poller.ts` (AMM gap-healer), `src/db/insert.ts` (idempotent write path), `src/server/sse.ts` (fan-out), `src/events/emitter.ts` (replay buffers).
- One implementation detail (SSE reconnect/replay semantics) required checking the EventSource/SSE web-platform spec, which is outside the Solana/Helius/ME/Metaplex source list — flagged explicitly per the audit's own exception for "absolutely required to verify an implementation detail."

**Findings use prefix LF.**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| LF1 | Medium-High | ✅ Fixed | Per-target WS reconnect backoff has no jitter — the self-scheduled "hard refresh" path does, the actual unplanned-disconnect path doesn't |
| LF2 | Low | ✅ Fixed | Code comment cites an unconfirmed "~30s" Helius idle-timeout figure; official docs say 10 minutes — comment-accuracy only, no functional effect |
| LF3 | — | Compliant | `logsSubscribe` + `getTransaction` both pinned to `commitment: 'confirmed'`, deliberately avoiding a measured `processed`-vs-confirmed indexing race |
| LF4 | — | Compliant | Gap-healer's `getSignaturesForAddress` usage matches documented newest-first + `before`/`until` pagination; already fixed a real inter-page gap-loss incident |
| LF5 | — | Compliant | "Warm mode" mint-tracker catch-up-skip is a deliberate, self-documented, accepted incompleteness trade-off, not an oversight |
| LF6 | — | Informational | Sales are broadcast in processing-completion order, not strict on-chain chronological order — architectural characteristic, not a documented-behavior violation |
| LF7 | — | Compliant | DB-level idempotency (`ON CONFLICT DO NOTHING` + `RETURNING id`) correctly gates SSE emission — a duplicate signature never reaches the broadcast layer |
| LF8 | Medium | Backlog | `sale`/`metaUpdate`/`rawpatch`/`remove` SSE channels have no replay/backfill of any kind — no app-level snapshot buffer (unlike `mint_meta`, which has one) and no `Last-Event-ID` support (no SSE frame ever sets `id:`) |

---

### Finding LF1 — Per-target WS reconnect backoff has no jitter

**Severity:** Medium-High

**Doc:** `helius.dev/docs/rpc/websocket` — Helius's own reconnection guidance explicitly recommends "exponential backoff with jitter" and states connections drop "every few minutes" in practice, causing "missing expected subscription updates."

**Evidence:** `src/ingestion/listener.ts`, `openSubscription`'s `ws.on('close', ...)` handler:
```typescript
const nextBackoff = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
console.warn(`[listener/${target.name}] disconnected (code=${code})  reconnecting in ${backoffMs / 1000}s`);
setTimeout(() => openSubscription(target, nextBackoff, true), backoffMs);
```
No randomization. Contrast with the self-scheduled "hard periodic refresh" path in the same file, which explicitly adds jitter:
```typescript
const delay = i * HARD_REFRESH_STAGGER_MS + Math.floor(Math.random() * HARD_REFRESH_STAGGER_MS);
// comment: "spread the reconnect storm across ~TARGETS.length × step seconds instead of a single instant"
```

**Root cause:** jitter was added only for the self-triggered periodic refresh. The real unplanned-disconnect handler — the one actually exercised by Helius's documented "connection drops every few minutes" behavior, which is provider-side and likely to hit several of VL's 6 concurrent WS connections at once — never got the same treatment.

**Impact:** if Helius drops multiple/all of VL's target subscriptions simultaneously, every affected target reconnects on the identical deterministic backoff schedule (10s→20s→40s→80s→120s), re-subscribing AND firing simultaneous `getSignaturesForAddress` catch-up polls (the `isReconnect=true` path) at each retry boundary — a self-inflicted synchronized burst against the same Helius endpoint, exactly the failure mode the `HARD_REFRESH` jitter already exists to prevent, just not applied here.

**Minimal production-safe fix:** add `Math.random() * <small window, e.g. 3000ms>` to the per-target `setTimeout` delay in the `ws.on('close')` handler, mirroring the existing `HARD_REFRESH_STAGGER_MS` pattern.

**Status: Fixed.** Added `RECONNECT_JITTER_MS = 3_000` and applied `backoffMs + Math.floor(Math.random() * RECONNECT_JITTER_MS)` as the actual `setTimeout` delay in `ws.on('close')` — the exponential `nextBackoff` value passed forward to the next attempt is untouched, only the wait for *this* reconnect gets jittered, same principle as `HARD_REFRESH_STAGGER_MS`. Subscription logic untouched.

---

### Finding LF2 — Code comment cites an unconfirmed Helius idle-timeout figure

**Severity:** Low

**Doc:** `helius.dev/docs/rpc/websocket`: *"WebSockets have a 10-minute inactivity timer."*

**Evidence:** `listener.ts`, comment above `openSubscription`: *"if Helius drops idle WebSocket connections every ~30s"*.

**Root cause:** an empirical/assumed figure baked into a design-rationale comment, apparently never checked against Helius's published number.

**Impact:** none functionally — the actual behavior the comment justifies (not resetting `lastNotificationTs` on automatic reconnect) is unaffected either way, and is if anything more conservative than the real 10-minute window requires. Flagged only because the audit requires grounding every claim, including ones embedded in comments, against official docs.

**Minimal production-safe fix:** update the comment to cite the correct figure or drop the specific number.

**Status: Fixed.** Comment now reads "Helius's documented WS idle timeout is 10 minutes (helius.dev/docs/rpc/websocket)". Comment-only change, no behavior affected.

**Status:** Backlog — cosmetic, not fixed this pass.

---

### Finding LF3 — `commitment: 'confirmed'` used consistently across subscribe and fetch

**Severity:** — (Compliant)

**Doc:** `solana.com/docs/rpc#configuring-state-commitment` — `processed` is "the newest view, but it can still be rolled back"; `confirmed` requires supermajority vote.

**Evidence:** `logsSubscribe` params use `{ commitment: 'confirmed' }` with an explicit comment recording a measured ~40% null-result rate when subscribing at `processed` (a real race against the processed→confirmed indexing window, ~0.8–1.2s), matched against `getTransaction`'s own `confirmed` commitment.

**Status:** Compliant — subscribe-side and fetch-side commitment levels are intentionally aligned, based on the team's own measured data, avoiding an internally-inconsistent race.

---

### Finding LF4 — Gap-healer's `getSignaturesForAddress` usage matches documented pagination behavior

**Severity:** — (Compliant)

**Doc:** `solana.com/docs/rpc/http/getsignaturesforaddress` — "newest first"; does not accept `processed`; `before`/`until` for pagination.

**Evidence:** `amm-poller.ts` calls with `commitment: 'confirmed'` (valid) and implements a `before`-continuation walk specifically because a single page returns only the newest `limit` signatures — with a comment recording a real prior incident ("MMM loss") where an earlier single-page implementation silently dropped the gap between the page boundary and the `until` cursor.

**Status:** Compliant.

---

### Finding LF5 — "Warm mode" mint-tracker catch-up skip is a deliberate, accepted trade-off

**Severity:** — (Compliant/Informational)

**Evidence:** `listener.ts` reconnect handler explicitly skips the catch-up poll for mint targets when the mint tracker is in "warm" mode, with an in-code comment: *"warm explicitly tolerates incomplete/delayed coverage."*

**Status:** Compliant — this is a conscious, documented trade-off, not an oversight. Noted because `logsSubscribe` itself has zero documented delivery guarantee (the official reference documents notification structure and commitment levels only — no guarantee of delivery, ordering, or dedup), so "warm mode" has no independent backstop during any disconnect window. Accepted risk, matches the mode's own stated intent.

---

### Finding LF6 — Sales are broadcast in processing-completion order, not strict on-chain order

**Severity:** — (Informational)

**Evidence:** six independent subscription pipelines (me_v2, mmm, tcomp, tamm, mpl_core, token_metadata) each run their own async `getTransaction` fetch + parse + insert + emit chain with independent latency. Neither `src/db/insert.ts` nor `src/server/sse.ts` re-sorts by `blockTime` before broadcasting — events reach the frontend in the order their individual pipelines finish processing, not the order they occurred on-chain.

**Root cause:** no official Solana/Helius doc specifies or requires a particular fan-out order for a multi-program real-time aggregator built on independent WS subscriptions; this is an inherent architectural property of the design, not a documented-behavior violation.

**Status:** Informational — recorded per the audit's "transaction ordering" scope item; not a defect. The system already tolerates deliberate reordering elsewhere (e.g. `MMM_DEFER_MS` noise-shedding delay), so arrival-order display is consistent with the rest of the design.

---

### Finding LF7 — DB-level idempotency correctly gates SSE emission end-to-end

**Severity:** — (Compliant)

**Evidence:** `src/db/insert.ts`, `insertSaleEvent`:
```sql
INSERT INTO sale_events (...) VALUES (...) ON CONFLICT (signature) DO NOTHING RETURNING id
```
```typescript
const id = result.rows[0]?.id ?? null;
if (!id) { /* ... */ return null; }   // duplicate signature — already processed
```
The function returns before any enrichment scheduling or `saleEventBus.emitSale(...)` call when the insert was a no-op conflict.

**Status:** Compliant — a signature reaching the ingestion pipeline twice (WS + poller race, WS + gap-healer overlap, etc.) can never result in two SSE broadcasts or two DB rows; the `RETURNING id` check is the correct place to gate this, and it's wired correctly.

---

### Finding LF8 — Sale-side SSE channels have no replay or backfill mechanism

**Severity:** Medium

**Note on sourcing:** the mechanism in question (`Last-Event-ID` / EventSource auto-reconnect resume) is a web-platform SSE behavior, not documented in the Solana/Helius/ME/Metaplex source list. Included per the audit's own allowance to check an implementation detail against a non-primary source when required — flagged explicitly as such, not presented as a Solana/Helius doc violation.

**Evidence:** `src/server/sse.ts` never writes an `id:` field in any SSE frame (`event: sale\ndata: ...\n\n` etc., no `id: N` line anywhere in the file) — so a reconnecting `EventSource` has no `Last-Event-ID` to send and the server has no way to resume from a specific point even if it wanted to. Compare `src/events/emitter.ts`'s `mint_meta` channel, which has an explicit bounded ring buffer replayed to every new SSE connection (`recentMintMetaSnapshot()`, sized "to comfortably cover the longest DAS retry window"). No equivalent buffer exists for `sale`, `metaUpdate`, `rawpatch`, or `remove`. `frontend/src/app/feed/page.tsx` opens its `EventSource` with no prior REST fetch of recent sales — the feed starts empty on every page load/reload and stays that way until the next live sale fires.

**Root cause:** the mint-tracker team solved this exact problem (late-connecting tabs, DAS-patch replay) for `mint_meta`; the same pattern was never ported to the sales side, which predates it.

**Impact:** the underlying data is never lost — `sale_events` (Postgres) is the real source of truth and is populated correctly regardless of any SSE client's state. The loss is purely display-side: a user who reloads `/feed`, backgrounds a tab, or hits any network blip during an active session sees a silent gap in the live feed with zero indication anything was missed, and nothing ever backfills it.

**Minimal production-safe fix:** none applied (audit only). Two independent options exist, either mirrors an already-proven in-repo pattern: (a) a small bounded ring buffer of recent `sale` events replayed on SSE connect, exactly like `mint_meta`'s; or (b) a lightweight REST snapshot endpoint (`GET /api/sales/recent`-style) fetched once on `/feed` mount before opening the `EventSource`.

**Status:** Backlog — not fixed as part of this audit (audit-only, no code changes).

---

## Audit #11 summary

**Real, fixable production risks identified:** LF1 (reconnect jitter gap — Medium-High, ✅ Fixed) and LF8 (no sale-side SSE replay — Medium, still Backlog — SSE replay/backfill architecture explicitly out of scope for the LF1/LF2 fix pass).

**Cosmetic:** LF2 (comment accuracy, ✅ Fixed).

**Confirmed compliant, no action needed:** LF3, LF4, LF5, LF7.

**Recorded as architectural characteristic, not a defect:** LF6.

---

## Audit #10 — Solana Transaction Lifecycle, Wallet, Signing & Sending Architecture

**Sources:**
- Official docs: `solana.com/docs/core/transactions/confirmation` (signature-vs-confirmation distinction), `solana.com/docs/rpc/http/simulatetransaction`, `docs.phantom.com/solana/sending-a-transaction` (documented-recommended `signAndSendTransaction` path), `docs.phantom.com/solana/establishing-a-connection` (`onlyIfTrusted` semantics).
- VL codebase: `frontend/src/wallet/phantom.ts`, `frontend/src/app/collection/[slug]/page.tsx`, `src/server/buy-me.ts`, `src/server/tools-mmm-pools.ts`, `tools/magiceden-vl-mmm-accept.user.js`.
- **Scope note:** distinct from Audits #8/#9 (MMM-tool-specific) — this audit inventories every wallet-connect/sign/send call site repo-wide, including the Collection-page ME auction-house Buy flow, not previously audited.

**Findings use prefix TX** (distinct from Audit #9's ME-prefixed findings).

| Finding | Severity | Status | Notes |
|---|---|---|---|
| TX1 | High | ✅ Fixed | Collection-page Buy flow never confirmed the tx landed — marked "done" on signature alone |
| TX2 | High | Backlog | No `simulateTransaction` anywhere in the codebase — broadens Audit #8's M4 |
| TX3 | Medium | Informational | Phantom's own "most recommended" `signAndSendTransaction` path is structurally unusable for VL's cosigned txs — root cause tying TX1/TX2/Audit-9 ME1 together |
| TX4 | — | Compliant | `eagerConnectPhantom`'s `onlyIfTrusted:true` matches official Phantom docs exactly |
| TX5 | — | Compliant | No `signAllTransactions` usage anywhere — batch-signing risk class doesn't apply |
| TX6 | — | Informational | `buy-me.ts`'s structured `rejectLog()` is the better logging pattern in-repo (relevant to Audit #9's ME3) |

---

### Finding TX1 — Collection-page Buy flow never confirmed the transaction landed on-chain ✅

**Severity:** High

**Status: Fixed**

**Doc:** `solana.com/docs/core/transactions/confirmation` — a signature returned by `sendTransaction`/`signAndSendTransaction` is not itself confirmation; official pattern requires a follow-up `getSignatureStatuses`/`getBlockHeight` poll.

**Evidence (before fix):** `frontend/src/app/collection/[slug]/page.tsx` `onBuyListing` marked the buy `done` (rendered ✓) the instant `signSendAndConfirm` returned a signature, with no follow-up check — unlike `mmm-pool-lookup/page.tsx`, which already polled `/api/tools/mmm-pools/tx-status` after the same call.

**Fix applied:** after `signSendAndConfirm` resolves, `onBuyListing` now sets a `confirming` busy-step and polls the existing `/api/tools/mmm-pools/tx-status` endpoint (unchanged — `getSignatureStatuses` + `searchTransactionHistory:true`, same as MMM tool) up to 5× with a 3s backoff. `BuyStatus` gained a `pending` kind (submitted, not yet confirmed) distinct from `done` (confirmed/finalized) and `error` (on-chain failure, surfaced from `err`). If the poll never observes a landed status, the UI shows "sent" / "Submitted, confirmation pending — solscan.io/tx/&lt;sig&gt;" rather than claiming success. `sendTransaction`/`skipPreflight` and wallet architecture untouched — reuses the existing backend endpoint verbatim, no backend change.

---

### Finding TX2 — No transaction simulation anywhere in the lifecycle

**Severity:** High

**Doc:** `solana.com/docs/rpc/http/simulatetransaction` — a free, side-effect-free dry run, available before a user is even asked to sign.

**Evidence:** zero `simulateTransaction` references anywhere in `src/` or `frontend/src/`.

**Status:** Backlog — explicitly excluded from this fix pass per instruction.

---

### Finding TX3 — Phantom's documented "most recommended" send path is unusable for VL's cosigned transactions

**Severity:** Medium (Informational — architectural fact, no fix proposed)

**Doc:** `docs.phantom.com/solana/sending-a-transaction` — Phantom states `signAndSendTransaction` is *"by far the easiest and most recommended"* path.

**Evidence:** `phantom.ts` cannot use it for any versioned/cosigned or multi-signer legacy tx (`signAndSendTransaction` rejects partially-signed txs) — forced onto `signTransaction` + custom backend-proxy send instead.

**Status:** Informational — root cause tying TX1/TX2/Audit #9's ME1 together; no fix proposed, the workaround is required.

---

### Finding TX4 — `eagerConnectPhantom` compliant with official Phantom docs

**Severity:** —

**Doc:** `docs.phantom.com/solana/establishing-a-connection` — confirms `connect({onlyIfTrusted:true})` semantics (4001 error + no popup if untrusted) match VL's implementation exactly.

**Status:** Compliant, no action.

---

### Finding TX5 — No `signAllTransactions` usage anywhere

**Severity:** —

Every flow signs exactly one transaction per user action. Batch-signing wallet-compat risk class doesn't apply to this codebase.

**Status:** Compliant / not applicable.

---

### Finding TX6 — `buy-me.ts`'s structured rejection logging is the better pattern in-repo

**Severity:** —

`rejectLog()` logs `{reason, mint, buyer, price, ...}` as structured JSON on every rejection branch — proof the fix pattern Audit #9's ME3 wants already exists in this codebase.

**Status:** Informational, no action this pass.

---

## Audit #10 summary

**Fixed this pass:** TX1 only, per explicit instruction — reuses the existing `/api/tools/mmm-pools/tx-status` endpoint verbatim (no backend change), adds a `pending` status + confirm-poll to the Collection-page Buy flow only. `sendTransaction`/`skipPreflight`/wallet architecture untouched, no refactor.

**Explicitly not touched:** TX2 (simulation/`skipPreflight`), wallet architecture.

**Remaining backlog:** TX2. TX3/TX4/TX5/TX6 are informational/compliant, no fix needed.

---

## Audit #9 — Magic Eden Integration Compliance (bridge lifecycle, retries, confirmation, sale parser)

**Sources:**
- Official docs: `solana.com/docs/core/transactions/confirmation` (blockhash validity window, `skipPreflight`, resend guidance), `solana.com/docs/core/transactions` (1,232-byte transaction size limit), `docs.magiceden.io/reference/get_instructions-mmm-sol-fulfill-buy` and `.../get_mmm-pools-1` (re-verified, same accessibility gaps as Audit #8), `wallet-standard/wallet-standard` `DESIGN.md` (documented Uint8Array-in/out contract for wallet adapters), `docs.phantom.com/solana/sending-a-transaction` (confirmed no documented duck-typed-object support).
- VL codebase: `frontend/src/lib/mmm-bridge.ts`, `frontend/src/wallet/phantom.ts`, `src/server/tools-mmm-pools.ts`, `tools/magiceden-vl-mmm-accept.user.js`, `frontend/src/app/tools/mmm-pool-lookup/page.tsx`, `src/ingestion/me-raw/parser.ts`, `src/ingestion/me-raw/price.ts`.
- **Scope note:** distinct from Audit #8 (userscript/bridge/proxy/cosigner architecture) — this audit covers what #8 left out or under-covered: retries, confirmation/blockhash lifecycle, popup lifecycle, Wallet Standard compliance, telemetry, and the ME sale-ingestion parser (`me-raw/*`, Audit #8's own "Next Research Target #1").

**Audit #9 finding status:**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| ME1 | High | Backlog | Confirm-poll loops (×3, duplicated) never re-broadcast and ignore the blockhash's real ~60–90s validity window; silently give up after ~15s |
| ME2 | Medium | ✅ Fixed | Bounded retry (max 2 retries, 250ms→500ms backoff) added to `rpcPost` for `getLatestBlockhash`/`getAccountInfo`/`getSignatureStatuses` only — `sendTransaction` untouched |
| ME3 | Medium | Backlog | No telemetry/observability beyond `console.log`/`console.error` anywhere in the flow — broadens Audit #8's M11 |
| ME4 | Medium | ✅ Fixed | `waitForMessage` in `mmm-bridge.ts` now detects a closed ME popup (500ms interval, mirroring `pingUntilReady`) and rejects immediately with a dedicated "popup closed" error instead of waiting out the full timeout |
| ME5 | Medium | Backlog | Confirms/grounds Audit #8's M8 with an actual Wallet Standard doc citation — duck-typed fake tx object is confirmed non-compliant with the documented Uint8Array-in/out contract |
| ME6 | Medium | Backlog | Seller-net rent-refund inflation guard exists only in the ME v2 sale parser (`parseMeV2Sale`), not in `parseMmmSale` or `parseMeCnftSale` — unconfirmed on real MMM/cNFT mainnet data |
| ME7 | Informational | Compliant | 1,232-byte transaction size limit is officially documented (IPv6 min MTU − header) — confirms `phantom.ts`'s "Transaction too large" special-case targets a real protocol ceiling |
| ME8 | Low | ✅ Fixed | Removed the permanent one-off diagnostic block in `parser.ts` keyed to a single historical tx signature, marked "TEMPORARY" in its own comment |

---

### Finding ME1 — Confirmation flow never re-broadcasts and ignores the blockhash validity window

**Severity:** High

**Doc:** `solana.com/docs/core/transactions/confirmation` — a blockhash is valid for the last 151 of 300 stored hashes, ~60–90s in practice; official guidance: *"clients should keep resending a transaction... on a frequent interval"* until expiry.

**Evidence:** `frontend/src/app/tools/mmm-pool-lookup/page.tsx` has the identical pattern three times: `for (attempt<5) { sleep(3000); poll tx-status }`. On the 5th failed attempt the loop ends silently — no `setTxPhase` call, no error, no retry.

**Root cause:** polling is bound to a fixed ~15s wall-clock window unrelated to the tx's actual `lastValidBlockHeight`; the send itself is one-shot (relies solely on `maxRetries:3` at the RPC node), not client-side resubmission as the docs recommend.

**Impact:** any delay beyond ~15s (common under congestion, well inside the ~60–90s the blockhash stays valid) leaves the UI silently stuck showing a signature with neither confirmed nor failed status.

**Status:** Backlog — not touched in this pass (excluded by explicit instruction).

---

### Finding ME2 — No retry/backoff in `rpcPost` for any RPC call ✅

**Severity:** Medium

**Status: Fixed**

**Fix applied:** `src/server/tools-mmm-pools.ts` — `rpcPost` now retries only `getLatestBlockhash`, `getAccountInfo`, and `getSignatureStatuses` on failure, up to 2 retries with 250ms→500ms backoff, each attempt keeping its own `AbortSignal.timeout()`. `sendTransaction` and all other (state-changing) RPC calls are unretried, unchanged.

---

### Finding ME3 — No telemetry/observability beyond `console.log`/`console.error` anywhere in this flow

**Severity:** Medium

**Evidence:** no Sentry/Datadog/PostHog/analytics reference in any ME-related file. Every diagnostic in `mmm-bridge.ts`, `phantom.ts`, `tools-mmm-pools.ts`, the userscript, and `page.tsx` is console-only.

**Impact:** broadens Audit #8's M11 — the entire flow is invisible outside a live browser console/server terminal.

**Status:** Backlog — no vendor decision made; not in this fix pass.

---

### Finding ME4 — Popup-closed not detected while awaiting a bridge response ✅

**Severity:** Medium

**Status: Fixed**

**Fix applied:** `frontend/src/lib/mmm-bridge.ts` — `waitForMessage` now runs a 500ms `w.closed` check (same interval `pingUntilReady` already used to stop pinging) for the whole time it's waiting, for both the ready-handshake and per-request response waits. On close it clears the timeout/listener and rejects immediately with `popup closed (<label>)` instead of waiting out the full `REQUEST_TIMEOUT_MS`/`READY_TIMEOUT_MS`.

---

### Finding ME5 — Duck-typed transaction object confirmed non-compliant with the Wallet Standard's documented contract

**Severity:** Medium

**Doc:** `wallet-standard/wallet-standard` `DESIGN.md`: *"The interface in the standard will always input and output transactions... as raw bytes (Uint8Array)... Wallet Adapter will encode these as web3.js Transaction... for compatibility with dapps."*

**Evidence:** `tools/magiceden-vl-mmm-accept.user.js` — `fakeTx = { serialize: () => bytes, version: 0, signatures: [] }`; the code's own comment already flags "Phantom may vary."

**Status:** Backlog — grounds Audit #8's M8 with an actual doc citation; not touched in this pass (existing fallback already absorbs failure).

---

### Finding ME6 — Seller-net rent-refund guard exists in only one of three sale parsers

**Severity:** Medium

**Evidence:** `src/ingestion/me-raw/parser.ts` — the `sellerNetClean` guard (drops `sellerNetLamports` when it exceeds the canonical price) exists only in `parseMeV2Sale`. `parseMmmSale` and `parseMeCnftSale` feed `computeSellerNetLamports` straight into `sellerNetLamports`/`sellerNetPriceSol` with no upper-bound check.

**Impact:** per the Live Feed sale-price display chain (`sellerNetPriceSol ?? priceSol`), if an MMM or cNFT sale ever closes an escrow/listing account and refunds rent in the same tx, the same inflated-price bug fixed for ME v2 reappears unguarded and user-visible. Unconfirmed on real MMM/cNFT mainnet data.

**Status:** Backlog — not touched in this pass (excluded by explicit instruction).

---

### Finding ME7 — Transaction size limit officially documented

**Severity:** Informational

**Doc:** `solana.com/docs/core/transactions` — max transaction size **1,232 bytes** (IPv6 min MTU 1,280 − 48-byte header).

**Status:** Compliant — confirms `phantom.ts`'s "Transaction too large" special-case (and Audit #8's M3 `tokenStandard=4` workaround rationale) targets a real, documented protocol ceiling. No action.

---

### Finding ME8 — Permanent one-off diagnostic block in the sale parser ✅

**Severity:** Low

**Status: Fixed**

**Fix applied:** removed the `if (tx.signature === '57uuQJLbQRZfXoSnueSKEQtR4G4nWTHBN3PCtNajm1PdVjzWQCHa8yn33xQD4ieow3AL996tVoigyYokkNx3kB3s') console.log(...)` block in `src/ingestion/me-raw/parser.ts`, left over from the trait-bid investigation and marked "TEMPORARY" in its own comment.

---

## Audit #9 summary

**Fixed this pass:** ME2, ME4, ME8 — all production-safe, isolated, no behavior change outside the targeted failure modes. Commit hash recorded at the top of this file's git history for this change (see `git log`).

**Explicitly not touched (per instruction):** ME1, ME6.

**Remaining backlog:** ME3, ME5, ME7(compliant, no action needed).

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

---

## Audit #12 — Postgres / Database Consistency, Idempotency, Retention & Query Performance

**Scope:** Audit-only, no code changes. Postgres as source of truth for `sale_events`, `mint_events`, `rare_feed_events`, `mint_rarity_cache`, `mint_resize_status`, `collection_created`, `collection_catalog`, `poller_state`.

**Sources:**
- Official docs: `postgresql.org/docs/current/sql-insert.html` (ON CONFLICT / UPSERT semantics), `postgresql.org/docs/current/sql-createindex.html` (CONCURRENTLY restrictions), `postgresql.org/docs/current/routine-vacuuming.html` (autovacuum), `node-postgres.com/apis/pool` (Pool config + error event), `solana.com/docs/core/transactions` (multi-instruction transaction model).
- VL codebase: all 19 files in `src/db/migrations/`, `src/db/client.ts`, `src/db/insert.ts`, `src/db/queries.ts`, `src/db/poller-state.ts`, `src/db/blocked-mint-cache.ts`, `src/db/resize-status.ts`, `src/db/collection-created.ts`, `src/db/migrate.ts`, `src/mints/event-store.ts`, `src/rare-feed/store.ts`, `src/rare-feed/rarity.ts`, `src/rare-feed/evaluator.ts`, `src/server/collection-stats.ts`, `src/server/listings-store.ts`, `src/server/tools-trending-collections.ts`, full-repo greps for transaction usage, SQL-injection surface, and pagination patterns.
- Live read-only inspection of the production database (`\dt`, `\di`, `pg_stat_user_tables`, and `EXPLAIN` / `EXPLAIN ANALYZE` on real hot-query shapes with real parameter values). No destructive SQL, no `VACUUM`/`ANALYZE` run, no migrations run, no writes performed.

**Findings use prefix DB.**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| DB1 | High | Backlog | `sale_events` unique constraint is `signature`-only; a transaction with more than one sale instruction would have every sale after the first silently dropped — both at parse time (single-object `ParseResult`, no array) and reinforced by `ON CONFLICT (signature) DO NOTHING` |
| DB2 | Medium | Validation only | `sale_events` has no retention policy, unlike `mint_events` (7d), `rare_feed_events` (7d), `mint_rarity_cache` (14d) — likely intentional (it's the collection-history source of truth), but never explicitly decided |
| DB3 | High | ✅ Fixed — commit `8226e32` | `ORDER BY block_time DESC` with no secondary tiebreaker in `queries.ts` / `collection-*.ts`; confirmed **11,269 groups of rows sharing an identical `block_time`** in production (one group 62 rows wide) — real, not theoretical, ordering/pagination ambiguity |
| DB4 | Medium | Backlog | No migrations-tracking table; `npm run migrate` is a fully manual step never invoked from `src/index.ts` boot — safety today depends entirely on every migration file being hand-written idempotent (true for all 19 today, but unenforced) |
| DB5 | — | Compliant | No explicit `BEGIN`/`COMMIT` anywhere in the codebase — but every multi-step write is deliberately fail-soft (a failed enrichment `UPDATE` never diverges DB state from the SSE frame already sent), so per-statement autocommit atomicity is sufficient for the design |
| DB6 | — | Compliant | SSE emission verified to happen only after the awaited `pool.query()` resolves, across all three write paths (`insertSaleEvent`, `patchSaleEventRaw`, `applyEnrichment`) — see also Audit #11 LF7 (idempotency gate) / LF8 (no replay buffer, tracked separately, not re-litigated here) |
| DB7 | — | Compliant | Zero SQL-injection surface — exhaustive grep of every `req.query`/`req.params`/`req.body` consumer found no request-derived value interpolated into SQL text; sort/filter fields are allow-listed enums or regex-sanitized, all values otherwise passed as `$n` bind parameters |
| DB8 | — | Compliant | Vacuum/bloat: current dead-tuple ratios (`sale_events` 8.3%, `mint_events` 18%) and `last_autovacuum`/`last_autoanalyze` timestamps are healthy at present volume; no per-table storage-parameter overrides needed today |
| DB9 | — | Compliant | Failure recovery + source-of-truth: every in-memory acceleration structure found (poller cursor, blocked-mint cache, resize-status, collection-created, mint_events ring, rare-feed events + `bootReplay`) has a corresponding DB-backed boot preload/hydration path — no purely in-memory-only marker exists that would silently lose state across a restart |
| DB10 | — | Compliant | `CREATE INDEX CONCURRENTLY` (migration 014) correctly respects the documented "cannot run inside a transaction block" restriction, via the migration runner's one-statement-per-file execution model — already self-documented in the migration's own comment |
| DB11 | Low | Informational | Per-collection hot queries (`collection-stats.ts`, seller-remaining-count range `UPDATE`) rely on Postgres combining two single-column indexes (`BitmapAnd`) rather than a matching composite index; `EXPLAIN` confirms this is cheap at the current ~105K-row scale — a scale watchpoint, not a current problem |

---

### Finding DB1 — `sale_events` unique(signature) cannot represent a multi-sale transaction

**Severity:** High

**Evidence from official documentation:**
- `solana.com/docs/core/transactions`: *"A transaction includes one or more instructions... The network processes all instructions in a transaction together."* — a single transaction/signature can legitimately contain more than one sale-type instruction (e.g., a marketplace "buy multiple" cart checkout bundling several `BuyV2`/`BuyNft`-style instructions into one signed transaction).
- `postgresql.org/docs/current/sql-insert.html`: *"ON CONFLICT DO NOTHING simply avoids inserting a row... if an arbiter constraint or index specified by conflict_target is violated."* — the arbiter here is `sale_events_signature_key` (UNIQUE on `signature` alone, migration 001), so **any** second row sharing that signature is dropped, regardless of whether it represents a genuinely different sale (different mint/seller/buyer/price).

**Evidence from current VictoryLabs code/schema:**
- `src/db/migrations/001_initial.sql:3`: `signature TEXT NOT NULL UNIQUE` — the only uniqueness arbiter on the table.
- `src/db/insert.ts` `INSERT_SQL` (`insert.ts:204-213`): `ON CONFLICT (signature) DO NOTHING RETURNING id`.
- Every raw-tx parser (`src/ingestion/me-raw/parser.ts` `parseRawMeTransaction`, and the sibling Tensor/Helius parsers) returns a single `ParseResult` / `SaleEvent | null` — grep for a `SaleEvent[]`-returning parser function across `src/ingestion/**` found zero matches, and grep for `instructionIndex`/`instruction_index`/`ixIndex` across `src/ingestion`, `src/models`, `src/db` found zero matches. The pipeline has no concept of "the Nth sale within this signature" anywhere.
- Contrast with `mint_events`, which already learned this exact lesson: migration 008 keys on `UNIQUE (signature, mint_address)` specifically so a single transaction minting multiple distinct assets is captured per-asset, not collapsed to one row.

**Root cause:** `sale_events`' identity model was designed assuming one sale per signature. Nothing in the ingestion pipeline — not the parsers, not the event model, not the DB constraint — carries an instruction-level discriminator the way `mint_events` does for mints.

**Impact:** If any tracked marketplace ever bundles more than one NFT sale into a single signed transaction, every sale after the first is silently and permanently lost — not queued, not logged as a conflict, not visible anywhere. This is a genuine, demonstrable capability of the pipeline's data model (confirmed via code + Solana's own multi-instruction transaction model), not a hypothetical protocol quirk. No specific missed sale has been confirmed in the current 104,849-row dataset during this audit (that would require independently reconciling against a marketplace's own trade history, which is out of scope for a DB-layer audit) — so this is reported as a real, evidenced mechanism, not a confirmed incident.

**Minimal production-safe fix:** Not applied (audit only). If ever pursued: parsers would need to return `SaleEvent[]` instead of a single object, and `sale_events` would need a composite arbiter (e.g., `UNIQUE (signature, mint_address)`, mirroring `mint_events`) instead of `UNIQUE (signature)` alone. This is a real schema + parser-contract change, not a one-line fix — flagged for a deliberate decision, not immediate action.

**Status:** Backlog — needs a product/eng decision on whether bundled multi-item sales are worth the parser-contract change, not a quick patch.

---

### Finding DB2 — `sale_events` has no retention policy

**Severity:** Medium

**Evidence from current VictoryLabs code/schema:**
- `mint_events` (migration 008 comment + `src/mints/event-store.ts:129-136`): `DELETE FROM mint_events WHERE created_at < now() - ($1 || ' days')::interval`, `MINT_EVENTS_RETENTION_DAYS` default 7, cleaned up daily.
- `rare_feed_events` / `mint_rarity_cache` (`src/rare-feed/store.ts:131-138`, `src/rare-feed/rarity.ts:38-41,159-160`): same pattern, 7d and 14d respectively, cleaned up every 6 hours.
- `sale_events`: no `DELETE`, no retention env var, no cleanup job anywhere in the codebase (confirmed via repo-wide grep for `DELETE FROM sale_events` — the only two hits are the per-signature blacklist/cNFT-floor deletes in `src/db/insert.ts:173,446`, not a retention sweep).
- Live inspection: `sale_events` currently holds 104,849 rows / 114 MB, spanning `block_time` from **2022-04-12** to today (2026-07-03) — over four years of history, versus `mint_events`' 7-day and `rare_feed_events`' 7-day windows.

**Root cause:** `sale_events` predates the retention pattern that was later added to `mint_events` and the Rare Feed tables; the pattern was never retrofitted onto the original table.

**Impact:** Unbounded growth going forward — currently modest (114 MB for 4+ years, ~26 MB/year at present volume), so no near-term operational risk. However, unlike `mint_events` (a sampled *feed display* cache the product explicitly treats as disposable after 7 days) and `rare_feed_events`/`mint_rarity_cache` (derived caches), `sale_events` is the actual historical record `collection-trade-history` and the Collection drill-down pages read from — deleting old rows here would be a **product** regression (loss of historical sales data), not a pure hygiene win. This needs an explicit decision, not an automatic fix.

**Minimal production-safe fix:** Not applied. If retention is ever desired, it should be scoped very differently from the other tables (e.g., archive-to-cold-storage or JSONB `raw_data` truncation for old rows, rather than row deletion) given the display dependency. If retention is *not* wanted, that should be recorded explicitly (e.g., a one-line comment on the table) so a future audit doesn't re-flag it as "missing."

**Status:** Validation only — flagging for an explicit intentional-vs-missing decision, not a code fix.

---

### Finding DB3 — `ORDER BY block_time DESC` has no secondary sort key, and production data proves ties are common

**Severity:** High

**Evidence from official documentation:**
- PostgreSQL's `SELECT` documentation (general `ORDER BY` semantics): rows that compare equal on all specified sort expressions are returned in an implementation-dependent order that can vary between executions of the same query (no stability guarantee is made for tied rows without an additional tiebreaker column).

**Evidence from current VictoryLabs code/schema:**
- `src/db/queries.ts` — `LATEST_SQL`, `BY_COLLECTION_SQL`, `BY_COLLECTION_NO_WINDOW_SQL`: all three end in `ORDER BY block_time DESC` with a bare `LIMIT $n`, no secondary key.
- Same pattern in `src/server/collection-icon.ts:75`, `collection-meta.ts:108`, `collection-chart.ts:68`, `collection-search.ts` (`array_agg(... ORDER BY block_time DESC)`), `rare-feed/evaluator.ts:313`, `scripts/backfill-mmm-legacy-takebid-buyer.ts:214`, `scripts/backfill-me-v2-logprice.ts:162`.
- Contrast with `src/mints/event-store.ts:100` (`ORDER BY block_time DESC NULLS LAST, id DESC`) and `src/rare-feed/store.ts:99` (`ORDER BY rf.sale_time DESC NULLS LAST, rf.id DESC`) — both siblings already learned to add a tiebreaker; `sale_events`' own read paths never got the same treatment.
- **Live confirmation** (read-only `GROUP BY block_time HAVING count(*) > 1` on production `sale_events`): **11,269 distinct `block_time` values are shared by 2+ rows**, the largest group being **62 rows with the identical timestamp**. This is not a theoretical edge case — it is the normal state of the table today.

**Root cause:** `block_time` is sourced from Solana's `blockTime` (whole-second Unix time) across a multi-marketplace, multi-program aggregator; many unrelated sales across different collections/programs land in the same second under real traffic. `LIMIT`-only "latest N" queries and the by-collection window queries never break these ties deterministically.

**Impact:** A client that pages by repeatedly calling `getLatestEvents(limit)` or reloads `/api/events/latest`/`/collection` endpoints across two ties spanning a `LIMIT` boundary can receive a different subset of the tied rows on each call — a row can appear to vanish from one response and reappear in another, or two different page loads can render the "same" latest-N set in a different order. Since the underlying `sale_events` row is never lost (Postgres itself is fine), this is a display/consistency risk, not a data-loss risk — but it is real and currently happening at meaningful frequency.

**Minimal production-safe fix:** Add a secondary sort key mirroring the already-proven in-repo pattern, e.g. `ORDER BY block_time DESC, id DESC` (or `ingested_at DESC` if insertion order is preferred as the tiebreaker) in `queries.ts`'s three SQL constants and the by-collection read paths. Purely additive to the `ORDER BY` clause — no schema change, no index change required (existing `sale_events_block_time_idx` still applies; `id` is the PK and trivially available for the tiebreak).

**Status:** ✅ Fixed — commit `8226e32`. Added `, id DESC` to every hot production read path ordering `sale_events` by `block_time DESC` alone:
- `src/db/queries.ts` — `LATEST_SQL`, `BY_COLLECTION_SQL`, `BY_COLLECTION_NO_WINDOW_SQL`
- `src/server/collection-icon.ts` (latest-image lookup)
- `src/server/collection-meta.ts` (`fetchNameFromDb`)
- `src/server/collection-chart.ts` (`CHART_SQL`)
- `src/rare-feed/evaluator.ts` (`bootReplay` anti-join query, `se.id DESC`)
- `src/server/collection-search.ts` (`array_agg(image_url ORDER BY block_time DESC, id DESC)`)

`src/server/runtime.ts` and `src/mints/event-store.ts` already had `id DESC` and were left untouched. Two one-off manual backfill scripts (`src/scripts/backfill-mmm-legacy-takebid-buyer.ts`, `src/scripts/backfill-me-v2-logprice.ts`) were intentionally left as-is — they are not hot read paths (run once, offline, by an operator), out of this fix's scope. No filtering, pagination shape, schema, or indexes were changed; `tsc` build verified clean, and both a plain-row and an `array_agg`-inside-aggregate variant of the new `ORDER BY` were validated with a read-only `EXPLAIN` against the live production schema.

---

### Finding DB4 — No migrations-tracking table; `npm run migrate` is a manual, non-boot-wired step

**Severity:** Medium

**Evidence from official documentation:**
- `postgresql.org/docs/current/sql-createindex.html`: confirms `CREATE INDEX CONCURRENTLY` "cannot be performed within a transaction block" — relevant because VL's migration runner's one-file-per-statement model is what makes migration 014 safe (see DB10); the same runner has no applied-migrations ledger, so it re-executes every `.sql` file's *text* on every invocation and relies entirely on each file's own idempotency.

**Evidence from current VictoryLabs code/schema:**
- `src/db/migrate.ts:14-24`: reads every file in `migrations/`, sorted, and runs `await pool.query(sql)` for each — no `schema_migrations`/`pgmigrations`-style ledger table, no check for "already applied."
- `package.json:10`: `"migrate": "ts-node src/db/migrate.ts"` — a standalone script.
- `src/index.ts` boot sequence (DB ping → `createApp()` → `startListener()` → `startAmmPoller()`): grep for `migrate` in `src/index.ts` returns zero matches — migration is never invoked automatically on backend start/restart/deploy.
- All 19 existing migration files use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (verified by reading all 19 files) — which is *why* re-running everything is safe today.

**Root cause:** The migration runner was built as "run every file, make every file idempotent" rather than "track which files have run." This works as long as the convention holds, but nothing enforces it.

**Impact:** Two related risks, both process/tooling rather than data-corruption: (1) a deploy that ships code depending on a new column requires a human to remember to run `npm run migrate` separately — if forgotten, every write referencing the new column fails immediately and loudly (a hard Postgres "column does not exist" error, not silent corruption, so this fails fast rather than fails silent); (2) if a future migration is ever written without `IF NOT EXISTS` (e.g., a one-time data backfill `INSERT`, or a `DROP COLUMN`), re-running all files on the next `npm run migrate` invocation would either error or duplicate data — there is no ledger to prevent re-execution.

**Minimal production-safe fix:** Not applied (audit only). If addressed: a minimal applied-migrations ledger table (filename + applied_at) checked before each file runs would remove the "re-run everything, hope it's idempotent" dependency without changing the existing plain-`.sql`-file authoring model.

**Status:** Backlog — real process gap, no confirmed incident; today's convention (universal `IF NOT EXISTS`) has held for all 19 migrations.

---

### Finding DB5 — No explicit transactions anywhere; compliant given the fail-soft design

**Severity:** — (Compliant)

**Evidence from official documentation:** `postgresql.org/docs/current/sql-insert.html` / general Postgres transaction semantics — each individually-sent, single-statement `pool.query(sql, params)` call is auto-committed atomically on its own; no partial-statement failure is possible within one call.

**Evidence from current VictoryLabs code/schema:** Repo-wide grep for `BEGIN`, `COMMIT`, `ROLLBACK`, and `pool.connect(` across `src/**/*.ts` (excluding tests) returned zero matches — no explicit multi-statement transaction exists anywhere in the codebase. Multi-step sequences like `insertSaleEvent`'s INSERT followed later by `UPDATE_META_SQL` (`src/db/insert.ts:461-471`) are two independent auto-committed statements. Critically, `applyEnrichment`'s `try/catch` (`insert.ts:432-509`) means a failed `UPDATE_META_SQL` is caught, logged, and **never reaches** `saleEventBus.emitMetaUpdate(...)` — so a DB write failure and the SSE broadcast fail *together*, never diverging.

**Root cause / behavior:** The architecture is intentionally "insert now, enrich later, fail-soft" (per `insert.ts`'s own comments: "MUST NOT throw or block"). Atomicity is achieved per-statement, and the fail-soft catch blocks ensure a failed follow-up write never leaves the SSE-visible state ahead of the DB-visible state.

**Impact:** None identified. The one theoretical gap — an enrichment `UPDATE` succeeding in the DB but the process crashing before `emitMetaUpdate` fires — would leave a row correctly enriched in Postgres but never announced over SSE for that specific card; the next reload/REST fetch would still show the correct enriched data, since Postgres is the source of truth read on every fresh load.

**Fix:** None needed.

**Status:** Compliant — explicit transactions are not required for this design; the fail-soft pattern is the correct simpler alternative.

---

### Finding DB6 — SSE emission consistently gated on awaited DB write success

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code/schema:** All three write→emit paths in `src/db/insert.ts` await the `pool.query(...)` call and inspect its result before emitting: `insertSaleEvent` checks `result.rows[0]?.id` before calling `emitSaleFrame` (`insert.ts:291-336`); `patchSaleEventRaw` awaits `PATCH_RAW_SQL` before `emitRawPatch` (`insert.ts:178-196`); `applyEnrichment` awaits `UPDATE_META_SQL` before `emitMetaUpdate` (`insert.ts:461-492`). No code path emits before its corresponding write settles.

**Root cause / behavior:** This is the same idempotency-gate pattern already verified in Audit #11 Finding LF7 (`ON CONFLICT ... RETURNING id` gates emission end-to-end for duplicate signatures) — this audit re-confirms it holds for the enrichment/patch paths too, not just the initial insert.

**Impact:** None — a duplicate or failed write can never produce a phantom SSE frame with no backing DB row.

**Note:** Audit #11 Finding LF8 (sale-side SSE channels have no replay/backfill buffer, no `Last-Event-ID` support) remains open and is **not** re-litigated here — it is a live-fan-out/reconnect concern already tracked in that audit's backlog, distinct from this audit's write-then-emit ordering check.

**Status:** Compliant — no action from this audit; see Audit #11 LF8 for the separate, already-tracked replay-buffer gap.

---

### Finding DB7 — No SQL-injection surface found

**Severity:** — (Compliant)

**Evidence from official documentation:** `node-postgres` parameterized queries (`pool.query(sql, params)`) send `params` via the extended query protocol as bind values, never string-interpolated into the SQL text — the standard, documented mitigation for SQL injection.

**Evidence from current VictoryLabs code/schema:** Repo-wide grep for any SQL string built via template-literal interpolation of a request-derived value (`` `...${req... ` `` patterns inside `SELECT`/`WHERE`/`ORDER BY` clauses) returned zero matches across `src/server/**`. Every endpoint accepting a sort/filter/direction parameter (`src/server/tools-trending-collections.ts:96-121`) validates against a fixed enum (`inEnum(rangeRaw, TRENDING_RANGES)`, etc.) and returns `400` on anything else *before* the value ever reaches a query. Slug-like parameters elsewhere (`tools-mmm-pools.ts:1693,1868`) are further regex-sanitized (`.replace(/[^a-z0-9_-]/g, '')`). The one template-literal `LIMIT ${MINT_TO_SLUG_MAX}` in `listings-store.ts:391` interpolates a hardcoded numeric constant (`50_000`), never a request value.

**Root cause / behavior:** Consistent use of parameterized queries plus allow-list validation at the API boundary for the few endpoints that accept sort/filter fields.

**Impact:** None.

**Status:** Compliant — no action needed.

---

### Finding DB8 — Vacuum/bloat risk is currently well-managed

**Severity:** — (Compliant)

**Evidence from official documentation:** `postgresql.org/docs/current/routine-vacuuming.html` — recommends "moderately-frequent standard VACUUM runs" for heavily-updated tables and notes autovacuum thresholds may need per-table tuning "for your situation."

**Evidence from current VictoryLabs code/schema — live inspection (`pg_stat_user_tables`):**
```
relname             n_live_tup  total_size  n_dead_tup  last_autovacuum         last_autoanalyze
sale_events         104849      114 MB      8718        2026-06-29 19:18:10+00  2026-07-02 16:06:09+00
mint_rarity_cache   15653       39 MB       251         2026-07-03 05:06:19+00  2026-07-03 05:06:19+00
mint_events         11957       21 MB       2151        2026-07-02 03:21:36+00  2026-07-03 09:55:22+00
```
No table has a custom `autovacuum_vacuum_scale_factor`/threshold override (default reliance confirmed — no `ALTER TABLE ... SET (autovacuum_...)` anywhere in the migrations). Dead-tuple ratios are ≤18% across the update-heaviest tables, and `last_autovacuum`/`last_autoanalyze` timestamps are recent relative to today (2026-07-03).

**Root cause / behavior:** Default autovacuum settings are keeping pace with the current UPDATE-churn sources (`patchSaleEventRaw`, `updateSellerRemainingCount(ByCollection)`, `mint_events` `PATCH_SQL`, `mint_resize_status`'s upsert) at present volume.

**Impact:** None currently. Worth monitoring — not fixing — if `sale_events` write volume grows an order of magnitude, since it is both the most row-heavy table and one of the update targets.

**Fix:** None needed now.

**Status:** Compliant — monitor, no action.

---

### Finding DB9 — Postgres is consistently the source of truth; every in-memory structure has a DB-backed recovery path

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code/schema:** Every in-memory acceleration/state structure found during this audit has a corresponding DB-backed boot preload or hydration path, so a process restart never permanently loses state:
- Poller cursors: `poller_state` table, read via `getLastSig` on every poll (`src/db/poller-state.ts`).
- Blacklist short-circuit cache: `preloadBlockedMintsFromDb` re-derives it from `sale_events` on boot (`src/db/blocked-mint-cache.ts:98-128`).
- Resize-status cache: `loadAllResizeStatuses` hydrates from `mint_resize_status` on resolver boot (`src/db/resize-status.ts:49-72`).
- Collection-created cache: `loadAllCollectionCreated` hydrates from `collection_created` on boot (`src/db/collection-created.ts:15-25`).
- Mint Tracker ring + meta buffer: `startMintEventPersistence` hydrates both from `mint_events` on boot (`src/mints/event-store.ts:140-158`).
- Rare Feed: `bootReplay` re-evaluates recent undecided sales via an anti-join against `rare_feed_events` (`src/rare-feed/evaluator.ts:301-348`), explicitly designed to recover state lost when "the `sale`→`meta` correlation was lost when the process restarted mid-flight."
- Mint→slug index: one-time boot preload from `sale_events` (`src/server/listings-store.ts:378-399`).

No purely in-memory-only marker (a cache with no DB-backed recovery path) was found anywhere in the audited code.

**Root cause / behavior:** This matches CLAUDE.md's stated architecture ("Backend is the source of truth... Postgres `sale_events` (single source of truth)"), and this audit confirms the claim holds structurally, not just as a stated intent — the frontend/SSE layer never becomes the only durable record of an event; a restart always recovers to the same state Postgres holds.

**Impact:** None — this is the correct pattern, consistently applied.

**Fix:** None needed.

**Status:** Compliant — no action.

---

### Finding DB10 — `CREATE INDEX CONCURRENTLY` correctly respects the transaction-block restriction

**Severity:** — (Compliant)

**Evidence from official documentation:** `postgresql.org/docs/current/sql-createindex.html`: *"a regular CREATE INDEX command can be performed within a transaction block, but CREATE INDEX CONCURRENTLY cannot."*

**Evidence from current VictoryLabs code/schema:** `src/db/migrations/014_sale_events_me_collection_slug_index.sql` is the only migration using `CONCURRENTLY`, and its own comment explicitly documents why it's safe: *"`src/db/migrate.ts` runs each `.sql` file via `pool.query()` as a single statement (no BEGIN/COMMIT wrapping), so CONCURRENTLY is safe here."* Confirmed by reading `migrate.ts` (`for (const file of files) { ... await pool.query(sql); }` — one file, one `pool.query` call, no surrounding transaction) and confirming migration 014 contains exactly one SQL statement.

**Root cause / behavior:** The migration author already reasoned through the exact documented restriction and structured both the migration file and the runner to respect it.

**Impact:** None — correctly implemented. Worth flagging only that this correctness is currently incidental to "one statement per migration file" being the house style rather than an enforced rule (see DB4) — a future migration file that combined `CONCURRENTLY` with other statements in the same file would break this invariant.

**Fix:** None needed now; covered by the same ledger recommendation as DB4 if ever implemented (a migration runner that understood statement boundaries would prevent this by construction).

**Status:** Compliant — no action.

---

### Finding DB11 — Per-collection hot queries lean on `BitmapAnd` of two single-column indexes rather than a composite index

**Severity:** Low

**Evidence from current VictoryLabs code/schema — live `EXPLAIN`:**
- `collection-stats.ts` `STATS_SQL` (`WHERE me_collection_slug = $1 AND block_time >= NOW() - INTERVAL '7 days'`) uses `Bitmap Index Scan on sale_events_me_collection_slug_idx` directly — single-index, already optimal (migration 014 was purpose-built for this).
- `updateSellerRemainingCountByCollection`'s range `UPDATE` (`WHERE seller = $2 AND collection_address = $3 AND block_time >= NOW() - interval '24 hours'`) — live `EXPLAIN` on production data:
```
Update on sale_events  (cost=35.45..55.22 rows=1)
  ->  Bitmap Heap Scan on sale_events
        Recheck Cond: (collection_address = ... AND block_time >= ...)
        Filter: (seller = ...)
        ->  BitmapAnd
              ->  Bitmap Index Scan on sale_events_collection_idx
              ->  Bitmap Index Scan on sale_events_block_time_idx
```
No index exists on `seller` alone or as part of a composite; the planner combines the `collection_address` and `block_time` indexes via `BitmapAnd` and filters `seller` during the recheck.

**Root cause / behavior:** No composite index (`collection_address, block_time`) or (`seller, collection_address`) exists; Postgres compensates via `BitmapAnd` over the two single-column indexes that do exist.

**Impact:** None currently — `EXPLAIN` cost is ~55 (cheap) at the present ~105K-row scale, and this query is a fire-and-forget background `UPDATE`, not a user-facing latency-sensitive path. Would be worth revisiting if `sale_events` grows an order of magnitude and this specific access pattern's cost grows non-linearly.

**Minimal production-safe fix:** None needed now. If ever revisited: a composite index on `(collection_address, block_time)` would let this query (and `collection-chart.ts`/`collection-meta.ts`'s similar per-collection-address scans) use a single index scan instead of a bitmap AND — but current cost does not justify the write-amplification tradeoff yet.

**Status:** Informational — scale watchpoint, no action needed today.

---

## Audit #12 summary

**Real, fixable production risks identified:**
- **DB3** (ordering — no secondary sort key on `sale_events` reads) — **High**, confirmed by live data (11,269 tied-timestamp groups). ✅ **Fixed** — commit `8226e32`.
- **DB1** (`sale_events` unique(signature) can't represent multi-sale transactions) — **High** by mechanism, but requires a parser-contract + schema change, not a quick patch. **Backlog**, needs a product decision on whether multi-item marketplace bundles are worth tracking.
- **DB4** (no migrations ledger, manual `npm run migrate`) — **Medium**, process/tooling gap, fails loud not silent. **Backlog**.
- **DB2** (`sale_events` has no retention) — **Medium**, but likely *should* stay unbounded given its role as the historical record for collection pages — **flag for an explicit decision**, not an automatic delete job.

**Confirmed compliant, no action needed:** DB5 (transaction boundaries — fail-soft design is appropriate), DB6 (SSE-after-commit ordering), DB7 (no SQL-injection surface), DB8 (vacuum/bloat currently healthy), DB9 (Postgres consistently the source of truth, every cache has a DB-backed recovery path), DB10 (`CONCURRENTLY` correctly used).

**Recorded as a scale watchpoint, not a defect:** DB11 (composite-index opportunity, cheap today).

**Ranking by production risk (highest first):** DB3 > DB1 > DB4 > DB2 > DB11 > (DB5–DB10 compliant).

**Recommended to fix immediately:** DB3 only — a one-line, additive `ORDER BY` tiebreaker change with a confirmed real-world trigger and zero downside. Everything else in this audit is either compliant, a deliberate product decision (DB2), or a larger architectural change warranting explicit sign-off before implementation (DB1, DB4).

**Update:** DB3 applied — see commit `8226e32` ("fix(db): make sale ordering deterministic"). DB1, DB2, DB4, DB11 remain intentionally unimplemented per explicit scope instruction.

---

## Audit #13 — Security, Trust Boundaries & Production Hardening

**Scope:** Audit-only, no code changes. Covers public HTTP APIs, auth, tool routes, image proxy, external fetches (SSRF), XSS, transaction safety, postMessage/userscript bridge, secrets handling, CORS/headers/CSP, SQL security, DoS/resource exhaustion, logging, and deployment assumptions (nginx/Cloudflare/UFW).

**Sources:**
- Official docs: `owasp.org` Top 10 A01/A5 (Broken Access Control), `cheatsheetseries.owasp.org` SSRF Prevention Cheat Sheet, `expressjs.com/en/guide/behind-proxies.html` (`trust proxy`), `developer.mozilla.org` `rel="noopener"` (reverse tabnabbing).
- VL backend: `src/server/app.ts`, `cors.ts`, `rate-limit.ts`, `sse.ts`, `runtime.ts`, `src/auth/siws.ts`, `src/runtime/env-validation.ts`, `buy-me.ts`, `tools-mmm-pools.ts`, `tools-sns.ts`, `tools-holders.ts`, `market.ts`, `me-bid-escrow.ts`, `mints-blocked-deployers.ts`, `subscribers.ts`, `collection-rollups.ts`, `src/ingestion/helius/webhook.ts`, full route inventory across every file in `src/server/`.
- VL frontend/bridge (delegated to a read-only Explore sub-agent, findings independently spot-verified against source): `frontend/src/lib/mmm-bridge.ts`, `frontend/src/app/thumb/route.ts`, `frontend/src/wallet/phantom.ts`, `frontend/src/runtime/auth.ts`, `frontend/src/app/layout.tsx`, `tools/magiceden-vl-mmm-accept.user.js`, plus repo-wide greps for `dangerouslySetInnerHTML`, `target="_blank"`, `NEXT_PUBLIC_`, redirect patterns, and `localStorage`.
- Live read-only inspection: `ufw status verbose`, `/etc/nginx/sites-enabled/nft-live-feed`, `.env` / `.env.example` contents (names only, no secret values read into this report), `git ls-files` (confirming no committed secrets). No requests sent to production beyond what the app already serves; no transactions sent; no destructive commands run.

**Findings use prefix SEC.**

| Finding | Severity | Status | Notes |
|---|---|---|---|
| SEC1 | Critical | ✅ Fixed — commit `220a0cb` | `POST /api/tools/mmm-pools/send-tx` has **no `requireAuth`** — any unauthenticated caller can relay an arbitrary pre-signed Solana transaction through VL's own Helius RPC key, gated only by a 10/min-per-IP rate limit |
| SEC2 | High | ✅ Fixed (ops) — 2026-07-03 | UFW allows direct origin access on 80/443 from `Anywhere`, in addition to Cloudflare-only CIDR rules — defeats the `CF-Connecting-IP`-based trust assumption hardcoded (and self-documented as fragile) in `rate-limit.ts` and `sse.ts`, letting an attacker who finds the origin IP spoof per-IP rate-limit/SSE-cap buckets at will |
| SEC3 | Medium | ✅ Fixed — commit `4fe123a` | `/thumb` route's `gateway.irys.xyz` special case performs a real server-side `fetch()` with `redirect: 'follow'` and no destination-host allowlist during the fetch — an SSRF-shaped gap per OWASP guidance, though entry is scoped to a fixed external hostname, not an arbitrary user URL |
| SEC4 | Low | Informational | A few `target="_blank"` anchors in the frontend lack an explicit `rel="noopener noreferrer"` — largely mitigated in modern browsers, which apply `noopener` behavior implicitly for `target="_blank"` per the HTML spec |
| SEC5 | Low | Informational | Two no-payload postMessage "readiness ping" frames use a wildcard `'*'` `targetOrigin` (`mmm-bridge.ts`, the userscript) — no sensitive data carried, but not best practice |
| SEC6 | — | Compliant | SIWS + HMAC bearer-token auth (`src/auth/siws.ts`, `runtime.ts`) — single-use/TTL'd nonces, constant-time comparisons, wallet allowlist enforced at multiple layers, production env-validation refuses to boot on missing/weak secrets |
| SEC7 | — | Compliant | `buy-me.ts`'s marketplace buy-now flow — thorough defense-in-depth (collection binding, live price/slippage re-check, mint binding, lamports ceiling, signer-shape validation), and correctly `requireAuth`-gated |
| SEC8 | — | Compliant | CORS origin-allowlist (`cors.ts`) — no wildcard echoing, denies preflights from unknown origins, warns loudly if production boots with an empty allowlist |
| SEC9 | — | Compliant | SSE resource-exhaustion protections (`sse.ts`) — global + per-IP connection caps checked before headers flush, backpressure-based slow-client eviction, micro-batched broadcast |
| SEC10 | — | Compliant | SQL injection surface — already exhaustively audited in Audit #12 Finding DB7 (zero injection surface found); no new dynamic-SQL pattern found in this pass |
| SEC11 | Low | Informational | A handful of cheap/cached/no-external-cost endpoints (`market.ts` `/header`, `mints-blocked-deployers.ts`, `subscribers.ts` `/heartbeat`, `collection-rollups.ts` `/rollups`) have no rate limiter; low risk given bounded input + caching. The standby `helius/webhook.ts` route also has no rate limiter (moot today — `HELIUS_WEBHOOK_AUTH` is unset, so the route isn't mounted) |
| SEC12 | — | Compliant | Secrets handling — `.env` is gitignored and not committed, `.env.example` holds only placeholders, no secret VALUES found in any `console.log`/`console.error` across the codebase (only "not set" diagnostic messages) |
| SEC13 | — | Compliant | Frontend XSS surface — only 2 `dangerouslySetInnerHTML` sites exist (`app/layout.tsx`), both fully static strings with zero interpolation of NFT/user/collection data; no raw `.innerHTML` assignment anywhere; no `NEXT_PUBLIC_*` variable is secret-shaped; no open-redirect pattern (all redirect targets are hardcoded or same-origin encoded paths) |
| SEC14 | — | Compliant | postMessage / userscript bridge (`mmm-bridge.ts` ↔ `tools/magiceden-vl-mmm-accept.user.js`) — every message that carries a real payload is origin-**and**-source-validated on both sides (no `*` used for anything sensitive); the userscript itself was already hardened to remove a hardcoded RPC key (its own v0.5.6 changelog) and contains no secrets today |

---

### Finding SEC1 — `/api/tools/mmm-pools/send-tx` is an unauthenticated open transaction-relay endpoint

**Severity:** Critical

**Evidence from official documentation:**
- OWASP A5:2017-Broken Access Control: *"Accessing API with missing access controls for POST, PUT and DELETE."* — missing server-side authorization on a state-changing API action is a canonical, top-category access-control failure.

**Evidence from current VictoryLabs code:**
- `src/server/tools-mmm-pools.ts:1563-1579`:
```typescript
router.post('/tools/mmm-pools/send-tx', limit, async (req: Request, res: Response) => {
  const { tx } = req.body as { tx?: string };
  if (!tx || typeof tx !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_tx' });
  }
  try {
    const result = await rpcPost('sendTransaction', [
      tx,
      { encoding: 'base64', skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' },
    ]) as string;
    return res.json({ ok: true, signature: result });
  } ...
```
- `limit` = `rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/mmm-pools' })` (`tools-mmm-pools.ts:1207`) — the ONLY gate on this route.
- Repo-wide grep confirms `tools-mmm-pools.ts` never imports `requireAuth` from `./runtime` — contrast with `buy-me.ts:37` (`import { requireAuth } from './runtime'`, applied to its own transaction-building route at `buy-me.ts:189`) and `tools-retardio-offers.ts:28`, both of which DO gate their transaction-adjacent actions behind login.
- `rpcPost()` (`tools-mmm-pools.ts:92-104`) calls `rpcUrl()` (`tools-mmm-pools.ts:68-73`), which embeds `process.env.HELIUS_API_KEY` — i.e. every call through this route spends VL's own Helius RPC budget.
- Independently confirmed client-side: the frontend's `phantom.ts` `backendSendRaw()` POSTs pre-signed tx bytes to this exact route with no app-level content check either — the only integrity check anywhere in the round-trip is that the transaction must already carry a valid signature to execute on-chain (this endpoint cannot forge a signature or steal funds by itself).

**Root cause:** `tools-mmm-pools.ts` follows the same "public tool, rate-limit only" convention used by its own read-only routes (`scan`, `pool`, `wallet-nfts`, `resolve-slug` — all intentionally unauthenticated by design, matching `tools-mint-analyzer.ts`'s documented "no auth middleware; pure read path" pattern). `send-tx` is not a read — it is a state-changing, cost-incurring action — but it was wired into the router using the read-tool convention instead of the `buy-me.ts` gated-action convention already established in the same codebase.

**Impact:** Any unauthenticated caller (no wallet login, no session) can use VL's production backend as a generic "submit any already-signed Solana transaction" relay, at VL's own RPC-credit expense (a resource `CLAUDE.md` explicitly calls "constrained"). This is not a fund-theft vector — a transaction still requires its own valid signature(s) to execute, so an attacker cannot use this to move someone else's funds — but it is a complete authorization bypass on a privileged, cost-incurring action, and (combined with SEC2) the only mitigating control (a 10/min-per-IP limiter) is itself trivially defeatable.

**Minimal production-safe fix:** Add `requireAuth` to this route, mirroring `buy-me.ts`'s pattern exactly: `router.post('/tools/mmm-pools/send-tx', limit, requireAuth, async (req, res) => { ... })`. One line; no behavior change for any legitimately logged-in user of the MMM tool (the frontend already sends the bearer token on other gated calls).

**Status:** ✅ Fixed — commit `220a0cb`. Added `import { requireAuth } from './runtime';` and inserted `requireAuth` into the route's middleware chain: `router.post('/tools/mmm-pools/send-tx', limit, requireAuth, async (req, res) => { ... })` in `src/server/tools-mmm-pools.ts`. Request shape, response shape, and send logic (`rpcPost('sendTransaction', ...)`) are byte-for-byte unchanged — the only behavioral change is that a caller now needs a valid bearer token (the same one already required by `buy-me.ts` and the rest of the gated-action routes) before the transaction is relayed. `tsc` build verified clean; no circular import (confirmed `runtime.ts` does not import from `tools-mmm-pools.ts`).

---

### Finding SEC2 — UFW allows direct origin access, undermining the `CF-Connecting-IP` trust assumption

**Severity:** High

**Evidence from official documentation:**
- `expressjs.com/en/guide/behind-proxies.html`: *"When using this setting, it is important to ensure there are not multiple, different-length paths to the Express application such that the client can be less than the configured number of hops away, otherwise it may be possible for the client to provide any value."*

**Evidence from current VictoryLabs code and live configuration:**
- `src/server/app.ts:33-38`: `app.set('trust proxy', 1)` — the comment states the topology is "exactly one reverse-proxy hop (nginx)."
- `src/server/rate-limit.ts:40-55` and `src/server/sse.ts:82-95` both contain near-identical comments stating the REAL topology is actually **Client → Cloudflare → nginx → Express (two hops)**, and that trusting `CF-Connecting-IP` / left-most `X-Forwarded-For` for rate-limit/SSE-cap bucketing is *"trustworthy ONLY because all ingress is forced through Cloudflare+nginx (no direct origin exposure). If the origin were ever reachable directly, CF-Connecting-IP / XFF would be client-forgeable."*
- **Live `ufw status verbose`** (read-only, this audit):
```
80                         ALLOW IN    Anywhere
443                        ALLOW IN    Anywhere
...
80                         ALLOW IN    173.245.48.0/20   (Cloudflare CIDR)
443                        ALLOW IN    173.245.48.0/20   (Cloudflare CIDR)
... (14 more Cloudflare-CIDR-scoped rules for 80/443)
80 (v6)                    ALLOW IN    Anywhere (v6)
443 (v6)                   ALLOW IN    Anywhere (v6)
```
The broad `Anywhere` (and `Anywhere (v6)`) rules for 80/443 are present **in addition to** the Cloudflare-CIDR-scoped rules, and both nginx's `server_name victorylabs.app` block and its `location /` block will serve any TCP connection that reaches port 80/443 regardless of source — there is no Cloudflare-origin-verification check (e.g. a shared secret header, mTLS, or an nginx `allow`/`deny` directive scoped to the Cloudflare CIDR list) anywhere in `/etc/nginx/sites-enabled/nft-live-feed`.

**Root cause:** The Cloudflare-CIDR-only UFW rules appear to have been added as a hardening pass without removing the original, broader `Anywhere` allow rules for the same ports — a classic "added the restrictive rule, forgot to remove the permissive one" firewall-ordering mistake. UFW evaluates rules in order and a match on the permissive `Anywhere` rule is sufficient; the narrower Cloudflare rules never come into play as an exclusive gate.

**Impact:** Anyone who discovers the origin server's IP (via DNS history, a misconfigured subdomain, a leaked header, or simple IP-range scanning of the hosting provider) can connect to nginx **directly**, bypassing Cloudflare entirely — losing Cloudflare's edge DDoS/bot mitigation for that traffic, and, more concretely for this codebase, gaining full control over the `CF-Connecting-IP` and `X-Forwarded-For` headers nginx forwards to Express. Every per-IP control in the codebase that keys on those headers — the login limiter (5/5min), SIWS-verify limiter (10/min, the actual brake on online guessing of a signature/passphrase pair), `buy/me` limiter (10/min), and the SSE per-IP connection cap (4) — can be defeated by sending a fresh, self-chosen `CF-Connecting-IP` value on every request, since nginx has no reason to strip or validate a header value that (in the intended topology) only Cloudflare would set. Both source comments in the codebase explicitly flag this exact risk as their accepted trade-off *"only because the origin is not directly exposed"* — that precondition is not currently true in production. Combined with SEC1, this removes the sole remaining control on the send-tx relay for a moderately capable attacker.

**Minimal production-safe fix:** Remove the plain `80/tcp ALLOW IN Anywhere` and `443/tcp ALLOW IN Anywhere` (and their v6 equivalents) UFW rules, leaving only the Cloudflare-CIDR-scoped rules — this is the change the existing Cloudflare-CIDR rules were clearly intended to enforce.

**Status:** ✅ Fixed (ops, no code/commit — firewall config only) — 2026-07-03. Ran, with explicit per-command user approval:
```
ufw --force delete 35   # 443 (v6) ALLOW IN Anywhere (v6)
ufw --force delete 34   # 80 (v6)  ALLOW IN Anywhere (v6)
ufw --force delete 2    # 443      ALLOW IN Anywhere
ufw --force delete 1    # 80       ALLOW IN Anywhere
```
Post-fix `ufw status numbered` confirms: only `OpenSSH` (v4 + v6) and the 30 Cloudflare-CIDR rules for 80/443 remain — no bare `Anywhere`/`Anywhere (v6)` rule exists for port 80 or 443 anymore. nginx config was not touched; backend/frontend were not restarted (not required for a firewall-only change). The `CF-Connecting-IP` trust assumption in `rate-limit.ts` and `sse.ts` now holds in production as those comments originally intended.

---

### Finding SEC3 — `/thumb` route's `gateway.irys.xyz` resolution path follows redirects during a server-side fetch with no destination-host allowlist

**Severity:** Medium

**Evidence from official documentation:**
- `cheatsheetseries.owasp.org` SSRF Prevention Cheat Sheet: *"Disable the support for the following of the redirection in your web client in order to prevent the bypass of the input validation."*

**Evidence from current VictoryLabs code:**
- `frontend/src/app/thumb/route.ts`, `probeImage()` (~line 99): performs a real Next.js-server-side `fetch(url, { method: 'GET', headers: {...}, redirect: 'follow', signal: controller.signal })` — `redirect: 'follow'` is the opposite of OWASP's documented mitigation.
- `resolveIrysTarget()` (~line 128) calls `probeImage(originalUrl)` where `originalUrl` is the caller-supplied `url` query param, gated only by `u.hostname === 'gateway.irys.xyz'` (a fixed, legitimate external hostname check on the ENTRY url, not on any redirect hop the fetch follows).
- The only post-hoc host check (~line 142, `finalHost !== 'gateway.irys.xyz' && !finalHost.endsWith('.irys.xyz')`) happens AFTER the fetch (and any redirects) already completed — it decides whether to trust the final URL as a wsrv-forwardable target, but does nothing to stop the server-side request itself from having already reached wherever the redirect chain pointed, including (in principle) a private/internal address.
- The general (non-irys) path in the same route only validates `url.startsWith('http://'||'https://')` (line 164) and never fetches the URL itself server-side — the actual byte-fetch for that path happens client-side via a `302` redirect to a fixed third-party host (`wsrv.nl`), so the wider SSRF risk described in this finding is specific to the `gateway.irys.xyz` branch only.

**Root cause:** The entry check validates the ENTRY hostname (`gateway.irys.xyz`) but the fetch client is configured to auto-follow redirects with no re-validation of each hop's destination, which is exactly the gap OWASP's cheat sheet calls out.

**Impact:** Exploitability is bounded by whether `gateway.irys.xyz` (a real, third-party, permanent-storage gateway VL does not control) can itself be induced to issue an HTTP redirect to an internal/private address for a given request — something this code-level audit cannot verify (it would require testing against or documentation from Irys's own gateway service, which is out of this audit's scope and source-priority list). No production incident is known or suspected; this is a code-level gap matching a documented anti-pattern, not a confirmed exploit path.

**Minimal production-safe fix:** Set `redirect: 'manual'` for the gateway.irys.xyz-originated probe and re-validate each hop's `Location` host against an explicit allowlist before following it, rather than letting `fetch` auto-follow to an unvalidated destination.

**Status:** ✅ Fixed — commit `4fe123a`. `frontend/src/app/thumb/route.ts`: added `probeIrysRedirectGuarded()`, a manual-redirect variant of `probeImage()` used only for the untrusted `gateway.irys.xyz`-originated probe (the fixed-host `arweave.net` probe in the same function is untouched — it was never user-influenced and was out of this fix's scope). It walks the redirect chain itself (`redirect: 'manual'`, capped at `MAX_REDIRECT_HOPS = 5`) and rejects — via `isSafeRedirectTarget()` — any hop whose destination isn't `http`/`https`, resolves to a blocked literal address (`isBlockedHost()`: loopback, `0.0.0.0`, RFC1918 10/8, 172.16/12, 192.168/16, link-local 169.254/16, IPv6 `::1`/`::`/`fe80:`/`fc`/`fd`-prefixed), or isn't on the explicit allowlist (`isAllowedRedirectHost()`: `gateway.irys.xyz` exact, `*.datasprite-cdn.com` suffix — the only two hosts this resolution path was ever documented to expect). A single `AbortController`/timer spans the whole redirect chain, preserving the original `PROBE_TIMEOUT_MS` (2500 ms) total budget rather than resetting it per hop; the existing `Range: bytes=0-0` + body-cancel size guard and content-type check are unchanged. A rejected redirect logs only the blocked hostname (`console.warn('[image/thumb] blocked redirect host=...')`, never the full URL) and returns `null`, which `resolveIrysTarget` already treats identically to any other probe miss — falling back to the existing arweave-rewrite path, so no new failure mode or response shape was introduced. Request/response shape of the route itself (`GET` params, 302-to-wsrv.nl behavior, cache headers) is byte-for-byte unchanged.

Validation performed: (1) `next build` — clean, no type errors; (2) a standalone re-implementation of the three new pure guard functions checked against 13 cases (allowed hosts, `evil.com`, loopback, AWS/GCP metadata IP `169.254.169.254`, RFC1918 ranges, `localhost`, `file://`, IPv6 loopback, and two subdomain/substring-confusion traps — `gateway.irys.xyz.evil.com` and `notdatasprite-cdn.com`) — all 13 passed; (3) local `next start` + `curl`: a normal non-irys URL still 302-redirects to wsrv.nl unchanged, a `gateway.irys.xyz` URL (nonexistent test id, so both probes miss) safely falls back to the arweave-rewrite 302 with no error, and `file:///etc/passwd` still 400s at the existing top-level protocol guard (unchanged, unrelated to this fix) — server log showed no errors across all three requests.

---

### Finding SEC4 — A few `target="_blank"` anchors lack an explicit `rel="noopener noreferrer"`

**Severity:** Low

**Evidence from official documentation:**
- `developer.mozilla.org` (`rel="noopener"`): the reverse-tabnabbing risk is real when `window.opener` is left accessible to a newly opened untrusted page — but also: *"Setting `target=\"_blank\"` on `<a>`... elements implicitly provides the same `rel` behavior as setting `rel=\"noopener\"`"* in modern browsers (a 2021+ HTML-spec-level change now shipped in current Chrome/Firefox/Safari).

**Evidence from current VictoryLabs code:**
- The large majority of ~45 `target="_blank"` occurrences across `frontend/src` correctly pair it with `rel="noopener noreferrer"` (e.g. `soloist/shared.tsx`, `app/tools/page.tsx`, `app/tools/mmm-collection-scanner/page.tsx`). All `window.open(...)` call sites pass `'noopener,noreferrer'` explicitly as the third argument.
- A handful of anchors — e.g. `frontend/src/app/tools/mmm-pool-lookup/page.tsx` (some but not all occurrences) — show a bare `target="_blank"` with no adjacent `rel=` attribute on inspection.

**Root cause:** Inconsistent copy-paste of the external-link JSX pattern across a large frontend codebase; no shared "ExternalLink" component enforces the attribute pair everywhere.

**Impact:** Low. Per the MDN documentation above, current-generation browsers apply `noopener` semantics automatically for `target="_blank"` regardless of an explicit `rel` attribute, which substantially closes the classic reverse-tabnabbing window this pattern used to open. The `noreferrer` half (suppressing the `Referer` header to the destination site) is not implicit and would still be missing on the affected links, which is a minor information-leak (destination site sees VL as the referrer), not an exploitable vulnerability.

**Minimal production-safe fix:** Not applied (audit only). If addressed: add `rel="noopener noreferrer"` to the small number of anchors missing it (a grep-and-fix pass, not a rewrite).

**Status:** Informational — real but low-impact given modern browser defaults; no user data or session compromise possible via this gap alone.

---

### Finding SEC5 — Two postMessage "readiness ping" frames use a wildcard `'*'` `targetOrigin`

**Severity:** Low

**Evidence from current VictoryLabs code:**
- `frontend/src/lib/mmm-bridge.ts` (~line 122): `w.postMessage({ type: 'VL_MMM_PING' }, '*')` — outbound ping to the ME popup window.
- `tools/magiceden-vl-mmm-accept.user.js` (~line 307): `window.opener.postMessage({ type: 'VL_MMM_READY' }, '*')` — outbound readiness signal back to whichever tab opened the ME popup.
- Every OTHER postMessage call site carrying an actual payload (pool key, seller, mint, price, or a signed-tx response) in both files uses a concrete origin (`ME_ORIGIN` on the frontend side; the caller's own already-origin-validated `event.origin` on the userscript side) — confirmed by direct reading of both files during this audit.
- Inbound handling on both sides validates the sender: `mmm-bridge.ts`'s `fromMe()` checks `e.source === w && e.origin === ME_ORIGIN`; the userscript's handler checks `VL_ORIGINS.has(event.origin)` (an explicit two-entry allowlist, not a wildcard) before acting on anything.

**Root cause:** These two frames carry no data beyond a literal type string (no pool/mint/price/tx payload), so a wildcard target was judged low-risk when written — consistent, since neither frame reveals anything sensitive to a page that happens to be listening at the wrong origin.

**Impact:** None identified. A third party who somehow intercepted either ping learns only that a VL/ME bridge popup exists and is alive — no pool, wallet, price, or transaction data is exposed via either wildcard call.

**Minimal production-safe fix:** Not applied (audit only). If addressed: replace `'*'` with the already-known concrete origin (`ME_ORIGIN` for the frontend's ping; the stored opener-origin for the userscript's ready signal) for defense-in-depth consistency with every other call site in the same files.

**Status:** Informational — no sensitive data at risk; a consistency nit, not a vulnerability.

---

### Finding SEC6 — SIWS + HMAC bearer-token auth is well-designed

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `src/auth/siws.ts` — nonces are single-use (deleted on every verify attempt regardless of outcome), TTL'd at 5 minutes, and the canonical message is rebuilt server-side from the stored nonce record rather than trusted from the client (preventing message-substitution). `runtime.ts`'s bearer-token verification (`verifyToken`) uses `timingSafeEqual` for the HMAC signature comparison and for the passphrase comparison (`siws.ts:213-219`). `src/runtime/env-validation.ts` refuses to boot in production if `UI_AUTH_SECRET`/`UI_AUTH_PASSWORD` are missing or below a minimum length, and specifically refuses the dev convenience of falling back the signing secret to the login password in production (`runtime.ts:112-123`).

**Impact:** None — this is a solid, well-reasoned auth design with an explicit, documented threat model (replay, substitution, brute-force, nonce-sniping) in the module's own header comment.

**Status:** Compliant — no action.

---

### Finding SEC7 — `buy-me.ts` marketplace buy-now flow has thorough transaction-safety checks

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `src/server/buy-me.ts` — the route is `requireAuth`-gated (`buy-me.ts:189`), re-fetches the live ME listing as the price source of truth rather than trusting a client-supplied price, verifies collection binding against VL's own enriched index before ever calling ME, and — after receiving the unsigned tx from ME — independently re-verifies (1) the mint appears in the tx's account keys, (2) the buyer's total `SystemProgram.Transfer` outflow stays within a slippage-adjusted ceiling, and (3) no signer other than the buyer is left unsatisfied (so a compromised/malicious ME response can't smuggle in an unexpected required signer).

**Impact:** None — this is a genuinely thorough defense-in-depth implementation for a server that builds (but never signs) a marketplace transaction on a user's behalf.

**Status:** Compliant — no action.

---

### Finding SEC8 — CORS origin-allowlist is correctly implemented

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `src/server/cors.ts` — reads `UI_ALLOWED_ORIGINS`, never echoes an unrecognized `Origin` back (no wildcard fallback), explicitly 403s a rejected preflight rather than silently omitting headers (a clearer failure signal than a confusing browser-side CORS error), and logs a loud startup warning if production boots with an empty allowlist. `Vary: Origin` is set so shared caches don't pin one origin's response to another's request.

**Impact:** None.

**Status:** Compliant — no action.

---

### Finding SEC9 — SSE connection/backpressure protections are correctly enforced

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `src/server/sse.ts` — `MAX_SSE_CLIENTS` (global, default 2000) and `MAX_SSE_CLIENTS_PER_IP` (default 4) are both checked and return a clean `429` BEFORE response headers are flushed (`sse.ts:617-627`), preventing a "200-then-hang" resource leak. A slow/wedged client is detected via consecutive `res.write()` backpressure returns and evicted (`sse.ts:147-178`) rather than allowed to grow Node's internal write buffer without bound. High-frequency event types are micro-batched (`sse.ts:204-233`) with a hard `MAX_BATCH_FRAMES` overflow flush, bounding both per-client and per-process memory growth under burst load.

**Impact:** None — this is a well-reasoned, multi-layered defense against SSE-specific DoS (connection exhaustion, slow-client memory growth, broadcast-loop cost blowup).

**Status:** Compliant — no action.

---

### Finding SEC10 — SQL injection surface remains zero (cross-reference to Audit #12)

**Severity:** — (Compliant)

**Evidence:** Audit #12 Finding DB7 already performed an exhaustive repo-wide grep for request-derived values interpolated into SQL text and found zero matches, with sort/filter/enum parameters allow-listed or regex-sanitized before ever reaching a query. This audit's own route-by-route pass (covering every file in `src/server/`) found no new dynamic-SQL construction pattern introduced since — every `pool.query()` call site inspected uses `$n` bind parameters exclusively.

**Impact:** None.

**Status:** Compliant — no action; see Audit #12 DB7 for the full evidence trail.

---

### Finding SEC11 — A handful of cheap endpoints (and the standby webhook) have no rate limiter

**Severity:** Low

**Evidence from current VictoryLabs code:**
- `src/server/market.ts` `/header` — no rate limit, but the route serves a 20-minute-TTL in-process cache with a `refreshing` promise that dedups concurrent cache-miss refreshes (`market.ts:68-81`); a request flood only ever reads the cached object, never fans out to the upstream APIs per-request.
- `src/server/mints-blocked-deployers.ts` `/blocked-deployers` — no rate limit, but serves a small in-memory list, no DB/external call.
- `src/server/subscribers.ts` `/heartbeat` — no rate limit; bounds input length (`MAX_SLUG_LEN = 200`) and only writes one `Map` entry per call, no DB/external call.
- `src/server/collection-rollups.ts` `/rollups` — no rate limit; input is capped to `MAX_NAMES_PER_REQUEST` and reads through an in-process cache (`getRollupsForNames`).
- `src/ingestion/helius/webhook.ts` — no rate limit on the POST handler itself; moot today since `HELIUS_WEBHOOK_AUTH` is unset in the live `.env` (confirmed this audit), so per `app.ts:47-54` the route is never mounted (a request to `/webhooks/` 404s at the Express layer regardless of nginx forwarding it).

**Root cause:** Rate limiting was applied deliberately to expensive/external-call/scan-style endpoints throughout the codebase (confirmed broadly present elsewhere: buy, holders, mmm-pools, sns, login/SIWS, trending); these particular routes were judged cheap enough to skip it, which the evidence above supports for their CURRENT implementations.

**Impact:** Low today given the bounded/cached nature of each handler. Worth a second look only if any of these routes' underlying implementation changes to add an external call or unbounded DB scan without revisiting the rate-limit decision. If `helius/webhook.ts` is ever activated (setting `HELIUS_WEBHOOK_AUTH`), it would be worth adding a rate limiter alongside the existing constant-time auth check, since a correctly-authenticated-but-malicious or compromised webhook source could otherwise submit unbounded-frequency batches.

**Minimal production-safe fix:** Not applied (audit only). If addressed: add a generous rate limiter to each (e.g. 60-120/min) purely as defense-in-depth; not urgent given current implementations are already bounded.

**Status:** Informational / Backlog — low current risk, worth a rate limiter as defense-in-depth if any of these handlers gain an external/unbounded cost path, or if the webhook route is ever activated.

---

### Finding SEC12 — Secrets handling is clean across the repository

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `.gitignore` excludes `.env` and `.env.*` (with an explicit `!.env.example` carve-out); `git ls-files` confirms only `.env.example` is tracked, and its contents are placeholders (`UI_AUTH_SECRET=replace_with_long_random_secret`, etc.), never real values. A repo-wide grep for `console.log`/`console.error`/`console.warn` lines mentioning API keys, secrets, passwords, bearer tokens, or the specific env-var names found only "not set" diagnostic messages and length/boolean summaries (matching `env-validation.ts`'s own stated policy: *"This module never logs a secret's value"*) — no actual secret value is ever written to a log line anywhere in `src/`.

**Impact:** None.

**Status:** Compliant — no action.

---

### Finding SEC13 — Frontend XSS / injection surface is clean

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** Only two `dangerouslySetInnerHTML` sites exist in the entire frontend, both in `frontend/src/app/layout.tsx` — one is a fully static inline boot script (a layout-mode `localStorage` read gated by an exact three-value allowlist before use), the other is a static CSS string (`GATE_CSS`) imported from a file with no template-literal interpolation. No `.innerHTML` assignment exists anywhere under `frontend/src`. Neither site ever receives NFT name, collection name, metadata, or any other request-derived/user-controlled data. Separately: no `NEXT_PUBLIC_*` environment variable in use is secret-shaped (only an API base URL and two boolean feature flags), and no redirect target anywhere in the frontend is taken from an unvalidated URL query parameter or other user input (all are hardcoded paths or same-origin, URI-encoded collection-slug paths sourced from VL's own backend catalog).

**Impact:** None.

**Status:** Compliant — no action.

---

### Finding SEC14 — postMessage / userscript bridge correctly validates origin and carries no hardcoded secrets

**Severity:** — (Compliant)

**Evidence from current VictoryLabs code:** `frontend/src/lib/mmm-bridge.ts`'s `fromMe()` predicate checks both `e.source === w` (the specific popup window reference) AND `e.origin === ME_ORIGIN` before trusting any inbound message; every outbound message carrying real request data (pool/seller/mint/price, or a signed-tx response) targets the concrete `ME_ORIGIN`, never `'*'` (see SEC5 for the two harmless exceptions). `tools/magiceden-vl-mmm-accept.user.js` checks inbound `event.origin` against an explicit two-entry `VL_ORIGINS` allowlist (`https://vl.nikki.gg`, `https://victorylabs.app`) before acting on anything, and its own changelog (v0.5.6) documents having removed a previously hardcoded RPC key specifically because "a userscript is plaintext/readable by anyone who installs it" — a live, applied lesson-learned, not a currently-open gap. No hardcoded secret was found in the userscript during this audit.

**Impact:** None.

**Status:** Compliant — no action.

---

## Audit #13 summary

**Ranking by production risk (highest first):**

1. **SEC1** (Critical) — `/api/tools/mmm-pools/send-tx` had no `requireAuth` — a complete authorization bypass on a state-changing, RPC-cost-incurring production endpoint. **✅ Fixed**, commit `0892c18`.
2. **SEC2** (High) — UFW allowed direct-origin access alongside Cloudflare-only rules, invalidating the `CF-Connecting-IP` trust assumption two source files' own comments rely on — compounded with SEC1 by defeating its only remaining rate-limit control. **✅ Fixed (ops)**, 2026-07-03.
3. **SEC3** (Medium) — `/thumb`'s `gateway.irys.xyz` path followed redirects during a server-side fetch with no destination-host re-validation. **✅ Fixed**, commit `4fe123a`.
4. **SEC4 / SEC5** (Low) — inconsistent `rel="noopener noreferrer"` on a few external links (largely mitigated by modern browser defaults) and two no-payload wildcard-`targetOrigin` postMessage pings (no sensitive data at risk).
5. **SEC11** (Low) — a few cheap/cached endpoints (plus the currently-unmounted webhook route) have no rate limiter; bounded risk given their current implementations.

**Confirmed compliant, no action needed:** SEC6 (SIWS/HMAC auth), SEC7 (buy-me.ts transaction safety), SEC8 (CORS allowlist), SEC9 (SSE resource limits), SEC10 (SQL injection surface, cross-ref Audit #12 DB7), SEC12 (secrets handling), SEC13 (frontend XSS surface), SEC14 (postMessage/userscript origin validation).

**Recommended to fix immediately:** SEC1 and SEC2 — both now fixed (see above). SEC3–SEC5 and SEC11 are real but lower-urgency; Backlog/Informational remains appropriate for those, unchanged by this pass.

**Not implemented in this pass:** This was an audit-only engagement — no code, firewall, or configuration changes were made. All fixes above require explicit approval before implementation, per the task's own instructions.

---

## Final Audit Triage Summary

**Scope:** Read-only triage of Audits #1–#13 as recorded in this file. No code changes, no deploys, no new findings invented. Bucketing rule below is applied uniformly across all 13 audits (which use inconsistent status vocabularies — "Deferred", "Skip", "Validation only", "Informational", "Compliant", "N/A" — pre-Audit #6 findings also have no formal `Severity` column, so severity is inferred from each finding's own "priority"/impact language where not explicit).

**Bucketing rule:**
- **Fixed** — status contains ✅ Fixed (commit or ops action recorded).
- **Open Fix-now** — status is Backlog/Deferred, a concrete minimal fix is described in the finding, and severity is High/Critical (or the audit's own summary explicitly named it a "recommended immediate fix" candidate). These are actionable and currently open.
- **Backlog** — status is Backlog/Deferred/Skip/Cleanup with Medium/Low severity, or High-severity-but-contingent-on-an-event-that-hasn't-happened (e.g. Bubblegum V2 adoption).
- **Compliant/informational** — status is Compliant, Informational, Validation-only (no fix proposed / accepted architectural risk), or N/A-out-of-scope.

### Audit status table

| # | Topic | Finding IDs | Fixed | Open Fix-now | Backlog | Compliant/Info |
|---|---|---|---|---|---|---|
| 1 | Metaplex Token Metadata | F1–F7 | 1 | 1 | 5 | 0 |
| 2 | Metaplex Core | C1–C9 | 1 | 0 | 4 | 4 |
| 3 | Bubblegum / cNFT | B1–B9 | 0 | 0 | 7 | 2 |
| 4 | Candy Guard / Candy Machine V3 | G1–G7 | 4 | 0 | 2 | 1 |
| 5 | Token-2022 / SPL Token | T1–T9 | 0 | 0 | 5 | 4 |
| 6 | Solana RPC + WebSocket Architecture | R1–R10 | 2 | 0 | 1 | 7 |
| 7 | Helius DAS Architecture | D1–D10 | 2 | 0 | 4 | 4 |
| 8 | Magic Eden Protocol & API Architecture | M1–M11 | 1 | 1 | 4 | 5 |
| 9 | ME Integration Compliance (bridge/retry/parser) | ME1–ME8 | 3 | 1 | 3 | 1 |
| 10 | Solana Tx Lifecycle, Wallet, Signing | TX1–TX6 | 1 | 1 | 0 | 4 |
| 11 | Live Feed Architecture & Event Completeness | LF1–LF8 | 2 | 0 | 1 | 5 |
| 12 | Postgres Consistency, Idempotency, Retention | DB1–DB11 | 1 | 1 | 1 | 8 |
| 13 | Security, Trust Boundaries & Hardening | SEC1–SEC14 | 3 | 0 | 0 | 11 |
| **Total** | | **119 findings** | **21** | **5** | **37** | **56** |

**Documentation integrity note (found during this triage, not a code finding):** two of the commit hashes cited inline in Audit #13 are stale — the finding text for **SEC1** (lines citing the fix) and **SEC3** cite commits `220a0cb` and `4fe123a` respectively, but those two hashes are **orphaned/not ancestors of the current branch** (verified via `git merge-base --is-ancestor`). The real commits on `main` carrying the identical fix messages are `0892c18` (SEC1 — matches what the Audit #13 *summary* section at the bottom already correctly cites) and `d299f30` (SEC3). Likely cause: a rebase/amend after this file was written. Recommend a one-line text correction to the two inline hash citations next time this file is touched — no code or status change implied.

### Top unresolved risks (ranked by production risk, highest first)

1. **M4 (Audit #8) + TX2 (Audit #10) — no `simulateTransaction`, every send path uses `skipPreflight: true`.** High severity, **evidenced twice in the same working session** (T22 ATA-derivation bug, `two_sided`-pool cosigner-empty case) — both cost a real on-chain fee that a free client-side simulation would have caught. TX2 explicitly "broadens" M4; same open issue, two audits.
2. **ME1 (Audit #9) — confirm-poll loops ignore the blockhash's real ~60–90s validity window, give up silently after ~15s, never re-broadcast.** High severity, official Solana docs directly contradict current behavior ("clients should keep resending... until expiry"). Three duplicated poll loops in `mmm-pool-lookup/page.tsx`.
3. **DB1 (Audit #12) — `sale_events` UNIQUE(signature) cannot represent a multi-instruction/multi-sale transaction.** High severity *by mechanism* (any bundled marketplace "buy multiple" tx would silently and permanently lose every sale after the first) but **zero confirmed occurrence** in the current 104,849-row dataset. Needs a product/eng decision (parser contract + schema change), not a quick patch.
4. **LF8 (Audit #11) — `sale`/`metaUpdate`/`rawpatch`/`remove` SSE channels have no replay/backfill buffer.** Medium severity but real, user-visible (feed reload/reconnect shows a silent gap with zero indication). Low implementation risk — `mint_meta`'s existing ring-buffer pattern in the same codebase is a direct template.
5. **ME6 (Audit #9) — seller-net rent-refund inflation guard exists only in `parseMeV2Sale`, not `parseMmmSale`/`parseMeCnftSale`.** Medium severity, same bug class already confirmed and fixed once for the ME v2 path — a real regression risk if an MMM/cNFT sale ever closes an escrow/listing account in the same tx, currently unguarded.
6. **M11 (Audit #8) + ME3 (Audit #9) — ME API failures and the whole bridge flow log nothing beyond `console.log`/status code; no response body, latency, or vendor telemetry anywhere.** Medium severity, directly evidenced by this session's own repeated need to manually re-run `curl` to see *why* ME rejected a request. Low implementation effort (one `await r.text()` line, matching an existing in-repo pattern).
7. **DB4 (Audit #12) — no migrations-tracking ledger; `npm run migrate` is a fully manual step never wired into boot.** Medium, process/tooling gap that fails loud (not silent) today because all 19 migrations happen to be idempotent by convention, not by enforcement.
8. **M8 (Audit #8) / ME5 (Audit #9) — duck-typed fake transaction object in the userscript's in-popup signer, confirmed non-compliant with the Wallet Standard's documented Uint8Array contract.** Medium on paper, but the existing fallback-to-VL-frontend path already absorbs the failure mode cleanly — lower real risk than its severity label suggests.
9. **T4/T9 (Audit #5) → D7 (Audit #7) — DAS `FungibleAsset`+decimals=0+supply=1 admits Token-2022 (WNS) NFT-shaped tokens; validation step (confirm `token_info.token_program` is live) is now done, fix still not applied.** Unconfirmed in production; unblocked but not implemented per explicit operator scoping.
10. **B1/B2/B3 (Audit #3) — Bubblegum V2 (`mintV2`) wrong tree index / missing MPL Noop / Merkle-tree-not-real-collection grouping.** High *if* Bubblegum V2 is ever adopted by a tracked launchpad, but currently zero production impact — contingent risk, correctly parked.

### Deduplicated backlog (same underlying issue tracked under more than one Finding ID)

| Underlying issue | Finding IDs (audit) | Status |
|---|---|---|
| No pre-send simulation / `skipPreflight: true` everywhere | M4 (#8), TX2 (#10) | Both Backlog — TX2 explicitly "broadens" M4, same fix would close both |
| Blockhash lifecycle not honored across the send/confirm round-trip | M9 (#8, expiry mid-flow), ME1 (#9, confirm-poll ignores validity window) | Both Backlog — same transaction-lifecycle family, ME1 is the more severe/evidenced half |
| ME bridge/API observability — console-only logging | M11 (#8, ME API failure logs), ME3 (#9, no telemetry anywhere in the flow) | Both Backlog — TX6 (#10, `buy-me.ts`'s `rejectLog()`) is cross-referenced in both as the *already-working* pattern to copy |
| Duck-typed fake transaction object dependent on undocumented wallet behavior | M8 (#8) | ME5 (#9) is not a duplicate finding but an explicit doc-citation upgrade of M8 ("grounds Audit #8's M8 with an actual doc citation") — same open item, cite together |
| Wildcard `'*'` `targetOrigin` on two no-payload postMessage pings | M7 (#8) | SEC5 (#13) re-audits and re-confirms the *identical* two call sites (`mmm-bridge.ts` PING, userscript READY) — literal duplicate across audits, not just related |
| SQL-injection surface (zero found) | DB7 (#12) | SEC10 (#13) is an explicit cross-reference/re-confirmation, not independent verification — Compliant, no new work |
| Token-2022 `FungibleAsset` admission gap in DAS classification | T4, T9 (#5) | D7 (#7) carries these forward — same open item, now unblocked (validation done) but still unfixed |
| MPL Core + BubblegumV2 cross-protocol gap | C9 (#2) | B6 (#3) — C9 was explicitly deferred into B6 at Audit #3 time; not two separate open items, just one, tracked under B6 (which itself folds into B1+B2) |

### Findings no longer relevant / already fully closed

Every finding this file's own text proves was closed by a later commit is already marked `✅ Fixed` in its own audit section (21 total, see table above) — none require a status change per the "only change status if the file itself proves a later fix closed it" rule. No finding was found to be silently obsoleted by a later, differently-labeled fix. The two commit-hash citations noted above are a **documentation accuracy** issue, not a status error — SEC1 and SEC3 are correctly marked Fixed; only the specific hash text is stale.

### Findings that should remain backlog intentionally (not oversights)

- **M2, M3, M5, M10 (Audit #8)** — "Validation only", no fix proposed. These record that VL's entire MMM pool-sellability methodology rests on undocumented ME behavior (`.io` domain, `tokenStandard=4`, `poolType`/`cosigner`/`blockedAt` semantics) — accepted architectural risk since no documented alternative exists.
- **DB1, DB2 (Audit #12)** — both explicitly flagged as needing a **product decision**, not a code patch: DB1 (multi-sale tx support) is a schema+parser-contract change; DB2 (`sale_events` retention) risks a **product regression** (loss of historical collection data) if "fixed" carelessly.
- **B1–B7 (Audit #3, Bubblegum V2)** — correctly parked until a tracked launchpad actually adopts Bubblegum V2 `mintV2`; fixing now would be speculative engineering against an unconfirmed future.
- **M8/ME5 (duck-typed tx object)** — the existing fallback path already handles the failure mode correctly; "fixing" this would mean removing a working optimization, not closing a gap.
- **T4/T9/D7 (Token-2022 FungibleAsset gap)** — validation is complete, but the operator has not requested implementation; correctly held pending an explicit go-ahead.
- **R9 (Audit #6)** — N/A/out-of-scope by design (the ingestion pipeline is read-only; blockhash/signing concerns belong to the MMM tool, audited separately in #9/#10).
- **SEC11 (Audit #13)** — a handful of cheap/cached/bounded-input endpoints with no rate limiter; correctly low-priority given their current bounded implementations, worth revisiting only if their cost profile changes.

### Next 5 recommended tasks

Ranked by production risk × implementation risk × user impact × effort (highest combined priority first):

1. **Turn off `skipPreflight: true` on the primary send paths and surface the simulation error before submit** (closes M4 + TX2). Highest production risk of anything open — two real, confirmed on-chain-fee losses already happened from exactly this gap in one session. Low implementation risk: flip a config value, reuse the existing "Transaction too large" friendly-error pattern for the new simulation-failure case. `phantom.ts` (frontend), `tools-mmm-pools.ts`'s `/send-tx` (backend), userscript — 3 call sites.
2. **Add a bounded ring-buffer replay for the `sale` SSE channel** (closes LF8). Real user-visible gap (silent feed gaps on reload/reconnect), but the lowest-effort fix on this list — `mint_meta`'s buffer in `src/events/emitter.ts` is a direct, already-proven-in-this-codebase template to copy for `sale`/`metaUpdate`/`rawpatch`/`remove`.
3. **Rewrite ME1's three duplicated confirm-poll loops to track the real blockhash `lastValidBlockHeight` and re-broadcast on a documented interval instead of giving up after a fixed ~15s.** Second-highest production risk open (High severity, official docs directly contradict current behavior), but higher implementation risk than #1/#2 — touches `mmm-pool-lookup/page.tsx`'s send flow directly; needs care not to regress the working sale path. Do after #1 (shares the same send/confirm surface).
4. **Extend the seller-net rent-refund inflation guard from `parseMeV2Sale` to `parseMmmSale`/`parseMeCnftSale`** (closes ME6). Same bug class already proven real and fixed once for ME v2 — low effort (copy the existing guard), Medium severity, but meaningfully reduces the chance of a user-visible inflated-price display bug reappearing unguarded on MMM/cNFT sales.
5. **Log the ME API failure response body + latency on the non-`ok` branch of `fetchBidAcceptTx`** (closes M11/ME3's most concrete sub-case). Lowest-effort item on this list (one `await r.text()` line, matching an existing truncated-body logging pattern already used elsewhere in the codebase) with immediate operator-facing payoff — directly would have saved this session's own repeated manual `curl` re-runs to diagnose ME rejections.

**Explicitly not recommended next:** DB1 (needs a product decision on multi-item sale support before any code is written) and the Bubblegum V2 findings (B1–B7, correctly contingent on an adoption event that hasn't happened) — both are real but are scoping/decision items, not ready-to-implement tasks.

---

## Audit Program v1 — Closed

**Audit Program v1 Complete.** Protocol (Metaplex Token Metadata, Core, Bubblegum, Candy Guard/Candy Machine V3, Token-2022/SPL), RPC + WebSocket ingestion, Helius DAS, Magic Eden marketplace/API integration, Solana transaction lifecycle/wallet/signing, Live Feed architecture, Postgres consistency/idempotency/retention, and Security/trust-boundary architecture have all been reviewed end-to-end against official documentation and real production/mainnet behavior — Audits #1–#13, 119 findings, 21 fixed. Findings trended from architecturally significant (RPC, DAS, ME, DB, Security in the earlier audits) toward Informational/Compliant/low-risk Backlog in the later ones, consistent with a codebase that has been genuinely hardened by the process rather than one still accumulating High/Critical issues.

**Do not open Audit #14 on a fixed cadence.** Future audits should be triggered by a specific event, not calendar time:
- A major new module (e.g. a full marketplace aggregator, a new order-book/orders system).
- Support for a new external protocol or a breaking version bump of an already-integrated one (e.g. Bubblegum V2 adoption by a tracked launchpad would immediately activate B1/B2/B3).
- A new marketplace integration beyond Magic Eden/Tensor.

Between now and the next triggering event, prioritize the two open High-severity items (M4/TX2, ME1) and the "Next 5 recommended tasks" above over new audit passes. Two non-audit review types were proposed as the next useful lens on this codebase — **not started, no findings yet**:
- **Performance review** — redundant RPC/DAS calls, latency, allocations/memory, unnecessary `JSON.parse`/`stringify`, batchable requests (e.g. `getAssetBatch`, flagged but not pursued as D5).
- **UX review** — click-count, unclear error states, missing loading/progress feedback, perceived latency — a different improvement class from the correctness/architecture focus of Audits #1–#13.

---

# Architecture Simplification #1

**Scope:** Not an audit — no protocol-doc comparison, no security review, no correctness-bug hunting. A senior-architect pass over the existing codebase (backend `src/`, frontend `frontend/src/`) looking only for duplicated logic, dead code, over-engineering, and file organization that adds cognitive load without adding value. No code was modified. Every finding below is backed by a direct repo grep/read performed during this pass — nothing is inferred without evidence.

**Method:** repo-wide `grep`/`wc -l` sweeps for repeated patterns (raw `fetch()` + `jsonrpc:'2.0'` bodies, `sleep()` definitions, TTL-cache boilerplate, duplicate type/interface declarations, duplicate function names across sibling files, commented-out dead imports) plus targeted reads of the resulting hit files to confirm each pattern is a genuine duplicate and not a false positive.

| ID | Severity | Category | One-line summary |
|---|---|---|---|
| AS1 | High | Simplify/Merge | No shared RPC/HTTP client — 33 files independently build raw Helius JSON-RPC `fetch()` calls |
| AS2 | High | Merge | A working shared `TtlCache<K,V>` already exists but is used in only 6 of ~44 files with hand-rolled TTL-cache boilerplate |
| AS3 | Medium | Split | `tools-mmm-pools.ts` is one 1,967-line file carrying 11 unrelated responsibilities behind 12 routes |
| AS4 | Medium | Merge | Two independently-defined, non-overlapping `DasAsset` interfaces — directly causes an already-open backlog bug (Audit #7 D7) |
| AS5 | Medium | Merge | Four near-identical tx-status confirm-poll loops copy-pasted across 2 frontend files |
| AS6 | Medium | Merge | The entire SSE-reconnect-with-jittered-backoff implementation is duplicated whole between `feed/page.tsx` and `mints/page.tsx` |
| AS7 | Medium | Delete | `poller.ts` + `raw-poller.ts` (600 lines) are fully dead — every import/call site commented out |
| AS8 | Medium | Refactor | Cooldown/circuit-breaker pattern implemented once well, reimplemented once differently, and simply absent in two places that need it |
| AS9 | Medium | Simplify | The ME bid-accept path always attempts a Bearer-token call documented as "reliably fails... for almost every real pool" before falling through |
| AS10 | Low | Merge | `isValidWallet` — byte-identical wallet-address validator duplicated in two auth-adjacent files |
| AS11 | Low | Merge | `sleep(ms)` reimplemented independently in 6 different files |
| AS12 | Low | Merge | Small MMM-tool UI helpers (`fmtSol`, `short`, `CopyKey`, `ADDR_RE`, `API_BASE`, `MONO`, `PANEL`) redefined per page instead of shared |

---

### Finding AS1 — No shared RPC/HTTP client for Helius JSON-RPC calls

**Severity:** High

**Category:** Simplify / Merge

**Evidence:** `find src -iname "*rpc*.ts"` returns zero results — there is no `rpc-client.ts` or equivalent anywhere in the repo. A repo-wide grep for `jsonrpc: '2.0'` (the literal JSON-RPC envelope every Solana RPC POST body needs) matches **33 separate files**: `listener.ts`, `amm-poller.ts`, `me-raw/ingest.ts`, `mint-raw/index.ts`, `mint-raw/reconcile.ts`, `tools-mmm-pools.ts`, `tools-holders/fetch-assets.ts`, `mints/core-supply-refresher.ts`, `mints/collection-created-resolver.ts`, `mints/resize-status-resolver.ts`, `mints/payment-token-enricher.ts`, `enrichment/helius-das.ts`, `enrichment/metaplex-onchain.ts`, `enrichment/lmnft-state.ts`, `server/me-bid-escrow.ts`, `server/market.ts`, `server/wallet-quick-balance.ts`, `server/tools-retardio-offers.ts`, `mint-analyzer/fetch-tx.ts`, plus a dozen one-off scripts/replay-tests. A separate grep for `AbortSignal.timeout`/`new AbortController` hits **37 call sites across 27 files**, each with its own timeout constant (values seen: 8s, 8.5s, 10s, 15s — no shared default). Audit #6 (Findings R3, R4) already found two concrete bugs that exist *because* of this — a missing `commitment` param in one call site and a missing timeout in another — that a shared client would have made structurally impossible to omit.

**Why the current architecture is unnecessarily complex:** Every new RPC call site is a fresh opportunity to forget a timeout, forget `commitment: 'confirmed'`, or hand-roll a slightly different error-handling shape. There is no single place to add a feature (e.g. request-level metrics, a shared circuit breaker per AS8, automatic retry classification) that would benefit all 33 call sites at once — each improvement has to be manually propagated file-by-file, and audits have already shown this propagation doesn't reliably happen (R3/R4 both being *inconsistencies*, not universal gaps, is the tell).

**Minimal production-safe improvement:** Extract a small `src/rpc/client.ts` exporting one `rpcCall(method, params, { timeoutMs, commitment })` helper that wraps `fetch()` + the JSON-RPC envelope + `AbortSignal.timeout` + `commitment` defaulting + JSON-RPC `error` field handling once. Migrate call sites incrementally (highest-traffic first: `listener.ts`, `me-raw/ingest.ts`, `tools-mmm-pools.ts`'s existing local `rpcPost`) — no call site needs to move on day one; new call sites should be required to use it going forward.

**Estimated benefit:** maintainability (single place to fix a systemic RPC bug instead of N places), future features (a shared client is the natural home for AS8's circuit breaker), readability (33 files get shorter), performance (none directly, though a shared client makes connection-reuse/keep-alive tuning a one-line change instead of a 33-file one).

---

### Finding AS2 — A working shared `TtlCache<K,V>` exists but is used in only 6 of ~44 files that need it

**Severity:** High

**Category:** Merge

**Evidence:** `src/enrichment/cache.ts` exports a clean, generic, already-correct `TtlCache<K,V>` class (lazy expiry on read + optional active sweep, 49 lines, no external deps). It is imported by 6 files, all inside `src/enrichment/` (`lmnft-state.ts`, `helius-das.ts`, `seller-collection-count.ts`, `image-retry.ts`, `seller-count-exact.ts`, `me-collection-name.ts`, `enrich.ts`). Meanwhile a grep for the `*_TTL_MS`/`Date.now() - x < TTL` hand-rolled pattern hits **44 other files** — `server/collection-meta.ts` (`HIT_TTL_MS`/`MISS_TTL_MS`, manual `hit.fetchedAt` check), `enrichment/me-stats.ts` (`ME_STATS_TTL_MS`, manual `now - hit.fetchedAt` check), `mints/core-supply-refresher.ts` (`PER_COLLECTION_TTL_MS`, manual `now - t.lastVerifiedAt` check), `server/tools-mmm-pools.ts`'s `fvcaInfoCache`, `rare-feed/rarity.ts`, `rare-feed/evaluator.ts`, `server/collection-stats.ts`, `server/collection-chart.ts`, `server/listings-store.ts`, `db/blocked-mint-cache.ts`, and roughly 30 more — every one reimplementing the identical `Map<K, {value, timestamp}>` + manual expiry-check shape `TtlCache` already solves.

**Why the current architecture is unnecessarily complex:** The abstraction was correctly built once, but scoped under `src/enrichment/` rather than a neutral shared location, so it reads as "the enrichment module's private cache helper" rather than "the codebase's TTL cache" — every module outside `enrichment/` independently reinvented the same 5–10 lines of boilerplate, with small inconsistent variations (some track `fetchedAt`, some `lastVerifiedAt`, some `timestamp`; some have a miss-vs-hit TTL split like `collection-meta.ts`, most don't).

**Minimal production-safe improvement:** Move `TtlCache` to a neutral path (e.g. `src/utils/ttl-cache.ts`) with a re-export left at the old path for the 6 existing importers (zero-risk, additive). New/touched call sites adopt it opportunistically — no mass migration required or recommended in one pass.

**Estimated benefit:** maintainability (one cache-correctness bug fixed once instead of found N times), readability (removes ~5–10 boilerplate lines from ~40 files over time), future features (a hit/miss-TTL split like `collection-meta.ts`'s could become a `TtlCache` constructor option instead of a one-off reimplementation).

---

### Finding AS3 — `tools-mmm-pools.ts` is one 1,967-line file carrying 11 unrelated responsibilities

**Severity:** Medium

**Category:** Split

**Evidence:** Second-largest backend file in the repo. Function/route inventory from a direct read: raw pool-account parsing + PDA derivation (`parsePool`, `deriveEscrowPda`, `applyBalance`), ME API collection-name lookups (`fetchMeCollectionInfo`, `scanOwnerPools`), DAS wallet-asset scanning + its own `DasAsset` type (`getAllWalletAssets`, `fetchWalletNftsForPool`, `assetMatchesAllowlist`), an on-chain `sol_fulfill_buy` transaction builder (`buildOnChainFulfillBuyTx`), the ME bid-accept-tx proxy with on-chain fallback (`fetchBidAcceptTx`), single-pool lookup (`lookupSinglePool`), the triage/pool-feed SSE pipeline with two independent scan-result caches (`rawPoolsCache`/`rawPoolsCacheAny`) plus a third, disk-persisted "known pool keys" ledger and its own debounced-save machinery, a tx-submission relay route, a tx-status poll-proxy route, manual-NFT/wallet-NFT endpoints, a collection-scan route, and a slug-resolve route — 12 `router.get`/`router.post` registrations total.

**Why the current architecture is unnecessarily complex:** A single file mixing "parse raw on-chain pool bytes," "call three different Magic Eden API surfaces," "scan a wallet's DAS assets," "build and relay a signed transaction," and "run a persistent SSE stream with a disk-backed dedup ledger" means every change — even one scoped to, say, the known-pool-keys ledger (as in the most recent NEW-badge fix) — happens inside the same 2,000-line file as everything else, with no compiler-enforced boundary between "pure pool math" and "network I/O" and "transaction construction." New contributors have to read the whole file to be confident a change to one concern doesn't touch another.

**Minimal production-safe improvement:** Split along the natural seams already visible in the file's own `// ──` section comments — e.g. `mmm-pool-parse.ts` (parsing/PDA/balance math, no I/O), `mmm-das.ts` (wallet-asset scanning), `mmm-tx-builder.ts` (on-chain builder + ME bid-accept proxy), `mmm-pool-stream.ts` (triage/pool-feed SSE + the three caches), leaving `tools-mmm-pools.ts` as the thin Express router that wires them together. Pure file/module reorganization — no logic changes, no behavior changes, `tsc` would catch any accidental break immediately.

**Estimated benefit:** readability (each resulting file has one job), maintainability (a change to the SSE ledger can no longer accidentally touch tx-building code in the same diff), future features (new MMM functionality has an obvious home instead of "somewhere in the 2,000-line file").

---

### Finding AS4 — Two independently-defined, non-overlapping `DasAsset` interfaces

**Severity:** Medium

**Category:** Merge

**Evidence:** `src/enrichment/helius-das.ts:41` and `src/server/tools-mmm-pools.ts:366` each declare their own `interface DasAsset`, read directly during this pass. `helius-das.ts`'s version carries `content.metadata.attributes`, `content.json_uri`, `content.links.animation_url`, `token_info.{decimals,supply}`, `ownership.owner` — but **not** `token_info.token_program`. `tools-mmm-pools.ts`'s version carries `token_info.token_program`, `compression.{compressed,tree,leaf_id}` — but **not** `token_info.decimals`/`supply`/`ownership`. Neither is a superset of the other. This is not a hypothetical concern — it is the literal, already-documented root cause of open backlog Finding **D7** (Audit #7): the Token-2022/WNS admission gap in `classifyDasAsset` cannot be fixed without adding `token_program` to `helius-das.ts`'s `DasAsset`, a field that already exists one file over in `tools-mmm-pools.ts`'s copy.

**Why the current architecture is unnecessarily complex:** Both types describe the exact same Helius `getAsset` response shape, just with whichever fields each file's author happened to need at the time. A field one file's logic needs (like `token_program`) doesn't automatically become available to the other, so a correctness fix in one place doesn't propagate — exactly the D7 situation.

**Minimal production-safe improvement:** Define one canonical `DasAsset` (union of both current field sets, all optional as they already are) in a shared location (`src/enrichment/das-types.ts` or similar), and have both `helius-das.ts` and `tools-mmm-pools.ts` import it instead of declaring their own. Purely additive to each file's available fields — no existing field is removed, so no existing read site can break.

**Estimated benefit:** maintainability (one DAS shape to keep in sync with Helius's schema instead of two), directly unblocks fixing D7 without any new investigation, readability (one obvious source of truth for "what does a DAS asset look like").

---

### Finding AS5 — Four near-identical tx-status confirm-poll loops copy-pasted across 2 frontend files

**Severity:** Medium

**Category:** Merge

**Evidence:** `frontend/src/app/tools/mmm-pool-lookup/page.tsx` contains the identical shape three times (lines ~499, ~527, ~602): `for (let attempt = 0; attempt < 5; attempt++) { sleep(3000); fetch('${API_BASE}/api/tools/mmm-pools/tx-status?sig=...') }` — already self-documented as a duplicate inside this file (Audit #9 Finding ME1: *"the identical pattern three times"*). `frontend/src/app/collection/[slug]/page.tsx` (line ~1315) added a **fourth** copy of the same loop when Audit #10's TX1 fix was implemented, with a code comment explicitly acknowledging it: *"poll the same tx-status endpoint the MMM pool tool uses."*

**Why the current architecture is unnecessarily complex:** A fix to the polling behavior itself — e.g. Audit #9's still-open ME1 (poll should track the real blockhash validity window and re-broadcast instead of giving up after a fixed ~15s, currently one of the two highest-ranked open risks in this file) — has to be applied in four places by hand, in two different files, or it will silently only half-fix the problem. TX1's own fix already demonstrates this risk materializing: a known-duplicated pattern was copied a fourth time instead of extracted, at the exact moment a developer was already looking at it closely enough to reference it by name in a comment.

**Minimal production-safe improvement:** Extract a single `pollTxStatus(signature, { attempts, intervalMs })` helper (or a `useTxStatusPoll` hook, matching the rest of the frontend's hook-heavy style) into a shared frontend lib file, and have all four call sites use it. Zero behavior change if the extraction is a faithful copy of the existing loop body; becomes the single place to apply ME1's fix later.

**Estimated benefit:** maintainability (ME1's eventual fix becomes a one-file change instead of a four-site hunt), readability, future features (any tx-confirmation UX improvement — e.g. a progress indicator — now has one implementation to enhance).

---

### Finding AS6 — SSE-reconnect-with-jittered-backoff duplicated whole between `feed/page.tsx` and `mints/page.tsx`

**Severity:** Medium

**Category:** Merge

**Evidence:** `frontend/src/app/feed/page.tsx` (1,481 lines) implements a full `EventSource` reconnect handler with exponential backoff + jitter (~line 421–487): `reconnectTimer`, backoff-reset-on-connect, comment *"Exponential backoff with jitter on reconnect — caps the herd-thunder..."*. `frontend/src/app/mints/page.tsx` (3,072 lines, the largest file in the frontend) has the same structure at ~line 1594–1608, with its own comment reading *"same pattern used [in feed/page.tsx]"* — i.e. the duplication is already known and named by whoever wrote the second copy, not a coincidence this pass discovered independently.

**Why the current architecture is unnecessarily complex:** This is the single largest duplicated block of logic found in this pass by line count. Both files are already among the two largest in the entire frontend; neither needs more inline complexity. A reconnect-behavior bug fix (e.g. backoff cap tuning, a new visibility-change edge case) has the same two-file propagation risk as AS5, just for a more complex and more safety-critical piece of logic (silent data loss on a missed reconnect is exactly what Audit #11's LF8 is about).

**Minimal production-safe improvement:** Extract a `useSseReconnect(url, handlers)` hook (or a plain non-hook connection-manager function, matching whichever style the rest of `soloist/` already favors) capturing the backoff/jitter/visibility-change logic, parameterized by the event handlers each page already defines separately. This is a larger, riskier extraction than AS5 (the surrounding event-handling code differs more between the two pages) — recommend doing it only after AS3-style file-splitting work has created a natural home for it (e.g. alongside `soloist/feed-store.ts`), not as a first move.

**Estimated benefit:** maintainability (the biggest win on this list — removes real duplicated complexity from the two largest, most complex frontend files), readability, future features (LF8's SSE replay-buffer fix, if implemented, has one connection-lifecycle implementation to hook into instead of two).

---

### Finding AS7 — `poller.ts` + `raw-poller.ts` (600 lines) are fully dead code

**Severity:** Medium

**Category:** Delete

**Evidence:** `src/ingestion/poller.ts` (351 lines) and `src/ingestion/raw-poller.ts` (249 lines). `src/index.ts` is the only file that references either, and every reference is commented out: `// import { startRawPoller } from './ingestion/raw-poller'; // disabled — see below`, `// import { startPoller } from './ingestion/poller';`, `// startPoller(); // Helius enhanced poller — disabled, see import above`. A repo-wide grep for any *live* import of either path returns nothing. CLAUDE.md itself already labels both "disabled at import (rollback only)."

**Why the current architecture is unnecessarily complex:** 600 lines of ingestion logic sit in the live `src/` tree, show up in every file listing and every "how does ingestion work" exploration, and cost real attention from anyone (including this pass) who has to determine "is this used?" before moving on — a question git history already answers for free. Keeping dead code "for rollback" duplicates what version control already does, at the cost of two files silently bit-rotting against the rest of the pipeline's evolution (e.g. neither has the R3/R4 fixes from Audit #6, since audits explicitly scoped around the live path).

**Minimal production-safe improvement:** Delete both files (git history preserves them permanently and far more reliably than a commented-out import — `git log --all -- src/ingestion/poller.ts` recovers the exact content instantly if ever needed). If an explicit rollback plan still wants a visible marker, a one-line note in CLAUDE.md pointing at the last commit that had them live is sufficient and costs zero ongoing maintenance.

**Estimated benefit:** readability (removes 600 lines and 2 files from every future "explore the ingestion pipeline" pass), maintainability (no more silent bit-rot risk), no behavior change (already fully inert).

---

### Finding AS8 — Cooldown/circuit-breaker pattern implemented once well, reimplemented once differently, absent where it's needed twice more

**Severity:** Medium

**Category:** Refactor

**Evidence:** `src/me-api-cooldown.ts` (31 lines) is a clean, well-documented, correctly shared module-scoped circuit breaker for Magic Eden API 429s — its own docstring explains it replaced N independent per-component cooldowns for exactly this reason, and it's correctly imported by 6 files (`tools-mmm-pools.ts`, `tools-retardio-offers.ts`, `collection-meta.ts`, `enrich.ts`, `me-stats.ts`, `rare-feed/providers/shared.ts`). Separately, `src/ingestion/me-raw/ingest.ts` implements its **own**, differently-shaped local circuit breaker (`isRateLimit()`, module-scoped `cooldownUntil`/`cooldownLogged` vars, a `COOLDOWN_THRESH` consecutive-failure counter `me-api-cooldown.ts` doesn't have) for Helius RPC 429s specifically — a legitimately different target (RPC vs ME API), but the *shape* of "track consecutive failures, open a cooldown window, log once per window" is reinvented rather than parameterized from a shared primitive. Meanwhile Audit #6 Finding R5 and Audit #7 Finding D10 (both still Backlog) document that `amm-poller.ts` and `helius-das.ts` have **no** circuit breaker at all for their own 429s — the exact gap `me-raw/ingest.ts`'s local copy already solved for its own call site.

**Why the current architecture is unnecessarily complex:** There are effectively three states of the same underlying need (cooldown-on-repeated-429) scattered across the codebase: one shared+correct (ME API), one local+correct-but-not-shared (RPC in `ingest.ts`), and two missing entirely (`amm-poller.ts`, `helius-das.ts`) — findings the audits already flagged as real gaps. Closing R5/D10 today means writing a *third* independent implementation of the same pattern, rather than reusing what `ingest.ts` already proved works.

**Minimal production-safe improvement:** Generalize `me-raw/ingest.ts`'s local breaker into a small `createCooldownBreaker({ thresholdMs, consecutiveFailThreshold })` factory (co-located with or exported alongside `me-api-cooldown.ts`, or in the AS1 `src/rpc/` home if that lands first), instantiate one for ME API (replacing `me-api-cooldown.ts`'s module-global state with an instance — same external API, `meCooldownActive()`/`setMeCooldown()` become thin wrappers), one for `me-raw/ingest.ts`'s RPC calls, and new ones for `amm-poller.ts`/`helius-das.ts` when R5/D10 are eventually picked up.

**Estimated benefit:** maintainability (one circuit-breaker implementation to reason about instead of a bespoke one per call site), directly reduces the future implementation cost of two already-identified open Backlog findings (R5, D10), future features (a shared breaker is the natural place to add e.g. exponential cooldown growth on repeated trips).

---

### Finding AS9 — The ME bid-accept path always attempts a Bearer-token call already documented as reliably failing for the common case

**Severity:** Medium

**Category:** Simplify

**Evidence:** `tools-mmm-pools.ts`'s `fetchBidAcceptTx` (per Audit #8/#9/#10's own extensive documentation, re-confirmed by direct read of the function during this pass) attempts the documented `.dev` + Bearer-token `sol-fulfill-buy` call **first**, on every invocation, before falling through to the on-chain builder (which itself immediately throws `me_cosigner_required` for any pool with a non-default cosigner). Audit #8 Finding M10 states plainly: *"this fallback path is structurally unable to complete a sale for any pool matching this project's own real-world pool population"* — i.e. for the common case (a real ME cosigner), this is a network round-trip to an endpoint the project's own accumulated evidence says will not work, on every single bid-accept attempt, before the code reaches the userscript-bridge path that actually works.

**Why the current architecture is unnecessarily complex:** This isn't dead code (it does work for the rare pool with no real cosigner) and isn't a correctness bug (M10's own conclusion is "no fix proposed... this is the reason the current architecture exists") — but it is an always-taken, usually-doomed code path adding latency and an extra failure mode to the hot path of the tool's single most important user action, for a case the codebase's own accumulated empirical evidence says is rare.

**Minimal production-safe improvement:** Not proposed as a code change here (this pass makes none) — but worth recording explicitly for a future pass: if the pool's `cosigner` is already known (it is, by the time `fetchBidAcceptTx` is called — callers already have the pool's on-chain data), a cheap pre-check (`cosigner === SystemProgram.programId` → try Bearer-token path; otherwise skip straight to the working path) would remove a guaranteed-slow, usually-doomed network call from the common case without touching the fallback logic itself.

**Estimated benefit:** performance (removes one network round-trip + its timeout budget from the common-case latency of the tool's primary action), readability (the "try the thing that's documented to fail" step becomes conditional instead of unconditional, which better matches what the code's own comments already say about it).

---

### Finding AS10 — `isValidWallet`: byte-identical wallet-address validator duplicated in two files

**Severity:** Low

**Category:** Merge

**Evidence:** `src/server/runtime.ts:83` and `src/auth/siws.ts:106` each define `function isValidWallet(...)` with the exact same body: `typeof x === 'string' && x.length >= 32 && x.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(x)` — same regex, same bounds, only the parameter name and one file's explanatory comment differ.

**Why the current architecture is unnecessarily complex:** Both files are in the auth-adjacent trust boundary this project's own Audit #13 rated Compliant specifically because of its careful, consistent design (SEC6). A validator this security-relevant existing in two copies is exactly the kind of place where a future edit to one copy (e.g. tightening the length bounds) silently doesn't apply to the other.

**Minimal production-safe improvement:** Move the function to a shared `src/utils/solana-address.ts` (or similar neutral location both `runtime.ts` and `siws.ts` can import from without a circular dependency — confirm neither currently imports the other, per Audit #13's own note that `runtime.ts` does not import from other server files it's paired with). One function, two importers.

**Estimated benefit:** maintainability, readability; minor security-consistency benefit (one validator to keep correct instead of two).

---

### Finding AS11 — `sleep(ms)` reimplemented independently in 6 different files

**Severity:** Low

**Category:** Merge

**Evidence:** Identical or near-identical `sleep`/`delay` helpers defined locally in `src/ingestion/concurrency.ts:22`, `src/ingestion/me-raw/ingest.ts:267`, `src/server/tools-retardio-offers.ts:373`, `src/enrichment/image-retry.ts:252`, plus inline arrow-function versions in `src/scripts/backfill-mmm-legacy-takebid-buyer.ts:107` and `src/scripts/backfill-me-v2-logprice.ts:68` — all six are `(ms) => new Promise(resolve => setTimeout(resolve, ms))` or a `function`-statement equivalent of the same one-liner.

**Why the current architecture is unnecessarily complex:** The lowest-stakes finding in this pass (a one-line function costs little to duplicate), but it's a clean, zero-risk, zero-ambiguity merge candidate — there is no version of `sleep(ms)` that legitimately needs to differ from another.

**Minimal production-safe improvement:** Export `sleep` once from an existing low-level shared file (`src/ingestion/concurrency.ts` already has it and is already a dependency-free utility module) and import it at the other 5 sites instead of redefining it.

**Estimated benefit:** readability only — this is a pure boilerplate-reduction cleanup with no functional upside beyond one fewer thing to notice-and-dismiss when reading any of these 6 files.

---

### Finding AS12 — Small MMM-tool UI helpers redefined per page instead of shared

**Severity:** Low

**Category:** Merge

**Evidence:** `fmtSol` and `short` (formatting helpers) are independently defined in both `frontend/src/app/tools/mmm-pool-lookup/page.tsx` and `frontend/src/app/tools/mmm-collection-scanner/page.tsx`. `ADDR_RE`, `API_BASE`, `MONO`, `PANEL` (constants/style tokens) are likewise redefined in both. `CopyKey` (a copy-to-clipboard component) is defined independently a **third** time in `frontend/src/app/tools/mmm-pools/page.tsx`, with a slightly narrower prop signature (`{ value }` only, vs the other file's `{ value, label, color }`) than the version in `mmm-collection-scanner/page.tsx`.

**Why the current architecture is unnecessarily complex:** Three sibling pages under `frontend/src/app/tools/` solving the same "show a Solana address with a copy button, format a SOL amount, style a panel" problems independently, with the `CopyKey` prop-signature drift already showing the early symptom of divergence duplication tends to produce (one copy silently supports a `label`/`color` override the other two don't, for no principled reason).

**Minimal production-safe improvement:** A small `frontend/src/app/tools/mmm-shared.tsx` (or extend the existing `frontend/src/soloist/shared.tsx`, which CLAUDE.md already documents as the project's shared UI-kit convention — "Copy, don't fork") exporting `fmtSol`, `short`, `CopyKey` (using the more capable 3-prop signature), `ADDR_RE`, `MONO`, `PANEL`; `API_BASE` likely already has a canonical home elsewhere in the frontend and should just be imported from there instead of redeclared.

**Estimated benefit:** readability, maintainability (one `CopyKey` behavior instead of two silently-diverged ones), future features (a `CopyKey` UX improvement — e.g. a "copied!" toast — becomes a one-file change instead of three).

---

## Overall Architecture Assessment

If starting a cleanup pass on today's codebase rather than a rewrite, the three highest-leverage moves are, in order:

1. **Extract the shared RPC client (AS1).** This is the single change with the widest blast radius of benefit — 33 files, and it's the structural precondition that makes AS8's circuit-breaker consolidation cheap to do afterward instead of independently.
2. **Promote and adopt the existing `TtlCache` (AS2).** The hard part (designing a correct generic TTL cache) is already done and already proven in production across 6 files — this is unusually low-risk for how much boilerplate it removes across the other ~40.
3. **Split `tools-mmm-pools.ts` along its existing internal seams (AS3).** Not urgent on its own, but every other MMM-related finding in this pass (AS4's DAS type, AS8's cooldown, AS9's ME-path ordering) lives inside this one file — splitting it first would make each of those follow-up fixes touch a smaller, more obviously-scoped file instead of the same 2,000-line one.

The frontend's two largest files (`mints/page.tsx` at 3,072 lines, `feed/page.tsx` at 1,481 lines) share a fully duplicated SSE-reconnect implementation (AS6) that is the single biggest chunk of duplicated logic found in this pass — but it's also the riskiest to extract safely given how large and stateful both surrounding files are, so it's correctly ranked Medium/do-later rather than a first move.

No finding in this pass identified an abstraction with real over-engineering in the "adds a layer nobody needed" sense (the codebase's existing abstractions — `me-api-cooldown.ts`, `TtlCache`, the `soloist/` shared UI kit, `domain/sale-event-adapters.ts` — are each doing real, singular jobs correctly). The dominant pattern found here is the opposite failure mode: **under-abstraction** — the same small pieces of logic (RPC calls, TTL caches, `sleep`, wallet validation, tx-status polling, SSE reconnect) being written fresh at each new call site instead of reused from a shared home, several of which (AS2, AS8) already exist in the codebase and just aren't adopted broadly.
