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

## Next Research Targets

Ordered by expected parser coverage gap / protocol complexity.

| # | Protocol / Source | Notes |
|---|---|---|
| 1 | Bubblegum / cNFT | cNFT mints are high volume; check Bubblegum v2 vs v1 instruction differences, concurrent Merkle tree handling. BubblegumV2/Core cross-protocol gap (C9 above). |
| 2 | Candy Guard / Candy Machine V3 | CG is the dominant minting infrastructure; audit `Guard1Jw…` vs `CMAGYFEN…` (Core CG) path completeness. |
| 3 | Token-2022 / SPL Token | Check whether Token-2022 NFTs (decimals=0, supply=1) are correctly rejected; any edge cases with `MintTo` vs `MintToChecked`. |
| 4 | Solana Runtime / RPC / WebSocket | Audit `logsSubscribe` notification completeness, slot gap detection, and reconnect behavior under load. |
| 5 | Helius DAS / Enhanced Transactions | Audit `getAsset` field stability, `tokenStandard` completeness across TM and Core, and `interface` enum coverage. |
| 6 | Magic Eden API | Audit ME v2 sale parser against current ME API contract; check `sellerNetPriceSol` inflation guard behavior. |
