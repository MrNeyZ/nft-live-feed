/**
 * Read-only dry-run matrix for the generic Core launchpad fallback.
 * Replays ingestMintRaw's targeted-mode branch order EXACTLY (index.ts),
 * pure detection only — no recordMint / enrichment / DB / SSE.
 */
import 'dotenv/config';
import { fetchRawTx } from '../ingestion/me-raw/ingest';
import {
  detectLaunchpadMint,
  getMintTrackerMode,
  getMintTrackerCoreV2ScorerEnabled,
} from '../ingestion/mint-raw/launchpad-detector';
import {
  detectCoreCreateV2NftCandidate,
  detectCoreCandyMachineMint,
  detectMagicEdenCoreMint,
  detectGenericCoreLaunchpadMint,
  detectGenericTokenMetadataLaunchpadMint,
} from '../ingestion/mint-raw/core-v2-detector';

const CASES: Array<{ tag: string; sig: string; expect: string }> = (process.env.MATRIX_JSON
  ? JSON.parse(process.env.MATRIX_JSON)
  : []);

function classify(tx: any): { verdict: string; path: string; detail: string } {
  if (getMintTrackerMode() !== 'targeted') return { verdict: 'N/A', path: 'legacy_mode', detail: '' };
  const lp = detectLaunchpadMint(tx);
  if (lp) {
    if (lp.standard === 'cnft') return lp.collectionAddress
      ? { verdict: 'ACCEPT', path: 'detectLaunchpadMint(cNFT)', detail: `source=${lp.source} coll=${lp.collectionAddress}` }
      : { verdict: 'REJECT', path: 'detectLaunchpadMint(cNFT)', detail: 'no_mint' };
    return lp.mintAddress
      ? { verdict: 'ACCEPT', path: 'detectLaunchpadMint', detail: `source=${lp.source} mint=${lp.mintAddress} coll=${lp.collectionAddress}` }
      : { verdict: 'REJECT', path: 'detectLaunchpadMint', detail: 'no_mint' };
  }
  const me = detectMagicEdenCoreMint(tx);
  if (me && me.accept && me.mintAddress && me.collectionAddress)
    return { verdict: 'ACCEPT', path: 'detectMagicEdenCoreMint', detail: `mint=${me.mintAddress} coll=${me.collectionAddress}` };
  const cm = detectCoreCandyMachineMint(tx);
  if (cm && cm.accept && cm.mintAddress && cm.collectionAddress)
    return { verdict: 'ACCEPT', path: 'detectCoreCandyMachineMint', detail: `mint=${cm.mintAddress} coll=${cm.collectionAddress}` };
  const gen = detectGenericCoreLaunchpadMint(tx);
  if (gen && gen.accept && gen.mintAddress && gen.collectionAddress)
    return { verdict: 'ACCEPT', path: 'detectGenericCoreLaunchpadMint', detail: `mint=${gen.mintAddress} coll=${gen.collectionAddress} reasons=${gen.reasons.join('|')}` };
  if (getMintTrackerCoreV2ScorerEnabled()) {
    const v2 = detectCoreCreateV2NftCandidate(tx);
    if (v2 && v2.accept && v2.mintAddress && v2.collectionAddress)
      return { verdict: 'ACCEPT', path: 'detectCoreCreateV2NftCandidate', detail: `mint=${v2.mintAddress} coll=${v2.collectionAddress}` };
  }
  const tm = detectGenericTokenMetadataLaunchpadMint(tx);
  if (tm && tm.accept && tm.mintAddress && tm.collectionAddress)
    return { verdict: 'ACCEPT', path: 'detectGenericTokenMetadataLaunchpadMint', detail: `mint=${tm.mintAddress} coll=${tm.collectionAddress} reasons=${tm.reasons.join('|')}` };
  const genR = detectGenericCoreLaunchpadMint(tx);
  return { verdict: 'REJECT', path: 'unknown_launchpad', detail: `generic_reject=${genR?.rejectReason ?? 'null'} tm_reject=${tm?.rejectReason ?? 'null'}` };
}

async function main(): Promise<void> {
  console.log(`mode=${getMintTrackerMode()} coreV2Scorer=${getMintTrackerCoreV2ScorerEnabled()}\n`);
  for (const c of CASES) {
    const tx = await fetchRawTx(c.sig, false, 'low', 'mint');
    if (!tx) { console.log(`${c.tag.padEnd(22)} FETCH_FAILED  (expect ${c.expect})`); continue; }
    const r = classify(tx);
    console.log(`${c.tag.padEnd(22)} ${r.verdict.padEnd(7)} via ${r.path.padEnd(32)} | ${r.detail}\n${' '.repeat(22)} expect: ${c.expect}\n`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
