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

## Next Research Targets

Ordered by expected parser coverage gap / protocol complexity.

| # | Protocol / Source | Notes |
|---|---|---|
| 1 | Metaplex Core | Dominant current standard; `core-v2-detector.ts` is the primary parser. Check Create/Transfer/Burn/Update instruction coverage. |
| 2 | Bubblegum / cNFT | cNFT mints are high volume; check Bubblegum v2 vs v1 instruction differences, concurrent Merkle tree handling. |
| 3 | Candy Guard / Candy Machine V3 | CG is the dominant minting infrastructure; audit `Guard1Jw…` vs `CMAGYFEN…` (Core CG) path completeness. |
| 4 | Token-2022 / SPL Token | Check whether Token-2022 NFTs (decimals=0, supply=1) are correctly rejected; any edge cases with `MintTo` vs `MintToChecked`. |
| 5 | Solana Runtime / RPC / WebSocket | Audit `logsSubscribe` notification completeness, slot gap detection, and reconnect behavior under load. |
| 6 | Helius DAS / Enhanced Transactions | Audit `getAsset` field stability, `tokenStandard` completeness across TM and Core, and `interface` enum coverage. |
| 7 | Magic Eden API | Audit ME v2 sale parser against current ME API contract; check `sellerNetPriceSol` inflation guard behavior. |
