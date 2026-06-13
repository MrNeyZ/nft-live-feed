/**
 * Targeted regression for Live Mint Feed missing NFT names.
 *
 * Repro: sig 4V1ESV… (LaunchMyNFT → MPL Core mint, asset 7ymHdb8…). DAS had
 * indexed the asset's collection + json_uri at retry time but NOT
 * `content.metadata.name`, so collection-confirm emitted mint_meta with no
 * name and the row's nft_name stayed empty → the card fell back to
 * shortMint(mintAddress). The off-chain JSON (already fetched for the image)
 * carries the real per-NFT name "Micros #8881".
 *
 * This test asserts the fix path: fetchMetaFromJsonUri(jsonUri) resolves the
 * RAW per-NFT name, and that name passes the frontend's `hasRealNftName`
 * guard (≠ collection name / stripped-collection) so it renders as the title.
 *
 * Run: npx ts-node src/mints/resolve-name.test.ts
 */
import 'dotenv/config';
import { getAsset } from '../enrichment/helius-das';
import { fetchMetaFromJsonUri } from '../enrichment/metaplex-onchain';
import { cleanName } from './clean-name';

const ASSET    = '7ymHdb8hWWwdxYwJTmJauUVR7XEWqPPkgrX5twgMWKot';
const EXPECTED = 'Micros #8881';

// Mirror of LiveMintFeedCard.tsx hasRealNftName: a per-NFT name is only shown
// when it differs from the collection name and its "#N"-stripped form.
function hasRealNftName(nftName: string | null, collectionName: string | null): boolean {
  if (!nftName || nftName.length === 0) return false;
  const stripped = collectionName ? collectionName.replace(/\s*#\s*\d+\s*$/, '').trim() : null;
  return nftName !== collectionName && nftName !== stripped;
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, detail: string) => {
    if (cond) { console.log(`✅ ${name} — ${detail}`); pass++; }
    else      { console.log(`❌ ${name} — ${detail}`); fail++; }
  };

  const meta = await getAsset(ASSET);
  console.log(`getAsset: nftName=${JSON.stringify(meta.nftName)} jsonUri=${meta.jsonUri ?? 'null'}`);

  // The fix resolves the per-NFT name from the off-chain JSON via the SAME
  // fetch the image path already uses (works even when DAS metadata.name is
  // empty, which is the failure mode for fresh Core mints).
  const off = meta.jsonUri ? await fetchMetaFromJsonUri(meta.jsonUri, ASSET) : { image: null, name: null };
  const rawDasName = typeof meta.nftName === 'string' && meta.nftName.trim() ? meta.nftName.trim() : null;
  const rawNftName = rawDasName ?? off.name;   // collection-confirm's preference order

  check('off-chain JSON name resolves', off.name === EXPECTED, `off.name=${JSON.stringify(off.name)}`);
  check('per-NFT title resolves to real name', rawNftName === EXPECTED, `rawNftName=${JSON.stringify(rawNftName)}`);

  // BEFORE the fix the emitted name was cleanName(name) = "Micros" (==
  // stripped collection), which the frontend rejects → shortMint fallback.
  const cleaned = cleanName(EXPECTED);
  const collectionName = cleaned; // collection-row name is the cleaned form
  check('cleaned name would be rejected by frontend (old behaviour)',
        !hasRealNftName(cleaned, collectionName), `cleaned=${JSON.stringify(cleaned)} → fallback to shortMint`);
  check('raw name is accepted by frontend (after fix)',
        hasRealNftName(rawNftName, collectionName), `raw=${JSON.stringify(rawNftName)} → shown as title`);

  console.log(`\nRESULT: ${pass} passed  ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
