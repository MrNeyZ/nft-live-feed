// VictoryLabs — Mints: one card in the right-side Live Mint Feed.
// Extracted from page.tsx so the page file stays maintainable. JSX
// byte-identical to the prior inline block — same className stack,
// same style objects, same nested IIFEs for collection-name / NFT-
// type pill / age tier. Closure surface is just `event`, `group`
// (pre-looked-up from `rows` in the page), and `now`.

import type { CSSProperties } from 'react';
import { ItemThumb } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';
import type { MintEvent, MintStatus } from '../lib/types';
import {
  colorForCollection, colorForCollectionMuted, colorForWallet, isSolPubkey,
} from '../lib/palette';
import { fmtAge, shortMint, thumb200 } from '../lib/format';
import { buildLaunchMyNftUrl, sourceHref } from '../lib/source';

/** Trim + treat empty-string as "no value". `??` only catches null /
 *  undefined, so a localStorage payload from an earlier reducer regime
 *  with `nftImageUrl: ""` would pin the chain to a blank URL even when
 *  a real fallback existed. */
function normalizeUrl(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

interface Props {
  event: MintEvent;
  /** Pre-looked-up collection-level row for `event.groupingKey`. May
   *  be undefined for events whose collection hasn't surfaced in the
   *  table yet (typical for the first event of a brand-new drop). */
  group: MintStatus | undefined;
  now:   number;
  /** Hover-scope dim. When the operator hovers a collection row, mints NOT in
   *  that collection fade to ~0.15 (matching mints stay full opacity and
   *  cluster to the top). Pure paint — no layout change. Default false. */
  dimmed?: boolean;
  /** Hover-pause hooks — fire when the cursor enters/leaves the card body
   *  (not surrounding panel padding). Wired to the page-level zone counter
   *  so the LEFT and RIGHT panes share one `hoverPaused` state. */
  onPauseEnter?: () => void;
  onPauseLeave?: () => void;
}

export function LiveMintFeedCard({ event: ev, group, now, dimmed = false, onPauseEnter, onPauseLeave }: Props) {
  // NFT name vs. collection name. Per the targeted-mode spec, these
  // are distinct lines on the card: the NFT's own name is the
  // prominent first line; the collection name (when known) sits
  // below in a smaller muted font. Backend doesn't ship per-mint
  // nftName on the wire today, so we fall back to the shortened
  // mint address for the top line and use the group's resolved name
  // for the collection subtitle.
  const collectionName = group?.name ?? null;
  // NFT name source order:
  //   1. per-mint `nftName` from the SSE `mint_meta` patch
  //      (DAS-resolved post-hoc; the live update path).
  //   2. shortMint(mintAddress) placeholder until the patch
  //      arrives — at least visually distinct per row.
  //   3. literal "NFT" as last resort (cNFTs without a mint
  //      address).
  const nftName        = (ev.nftName && ev.nftName.length > 0)
    ? ev.nftName
    : (isSolPubkey(ev.mintAddress) ? shortMint(ev.mintAddress) : 'NFT');
  // Defensive frontend strip — when backend patched `group.name`
  // with the raw per-NFT name (e.g. "Kryptos #287"), strip the
  // trailing `#N` to derive a collection-style label ("Kryptos").
  // This catches the race where the synthesized-row upsert from a
  // `mint` event lands BEFORE collection-confirm strips it on the
  // backend; without this guard the bottom line mirrors the top
  // line and reads as "missing".
  const strippedCollection = collectionName
    ? collectionName.replace(/\s*#\s*\d+\s*$/, '').trim()
    : null;
  // Final collection line. Order:
  //   1. stripped backend name whenever it resolves to a real
  //      string (preferred — even when it duplicates `nftName`;
  //      the collection-accent colour applied to this line below
  //      visually disambiguates the two and an honest collection
  //      name beats a base58 stub every time).
  //   2. short collection address — only when no name has resolved
  //      yet.
  //   3. literal "—" when neither is available.
  const collectionLine =
    (strippedCollection && strippedCollection.length > 0)
      ? strippedCollection
      : (ev.collectionAddress ? shortMint(ev.collectionAddress) : '—');
  const abbr           = (nftName[0] ?? '?').toUpperCase() + (nftName[1] ?? '').toUpperCase();
  // Image priority on the live-feed CARD:
  //   1. `ev.nftImageUrl` — the per-mint asset image surfaced by DAS
  //      via `mint_meta`. We use it even when it's the launchpad's
  //      shared pre-reveal placeholder (the same URL recurs on every
  //      mint). That's not a bug: it IS the official per-mint
  //      metadata image — Magic Eden paints the same brown-bag /
  //      sock-puppet placeholder on every card during a pre-reveal
  //      drop, and showing the on-chain truth beats hiding it. The
  //      `/thumb` proxy rewrites broken dedicated gateways
  //      (`*.mypinata.cloud/ipfs/<CID>` → `ipfs.io/ipfs/<CID>`,
  //      `gateway.irys.xyz/<txid>` → `arweave.net/<txid>`) so the
  //      bytes resolve even when the URL the metadata cites has
  //      gone 403/404 on its origin.
  //   2. `group?.representativeImageUrl` — confidently-unique per-NFT
  //      image observed elsewhere in this drop (sticky write-once
  //      from `collection-confirm.ts` once variety is established).
  //      Used when no per-mint image has arrived yet for THIS card —
  //      better than initials.
  //   3. `group?.imageUrl` — collection hero from
  //      `enrichLaunchpadCollectionMeta` (Candy Guard / LMNFT-Core
  //      paths). Last-resort image fallback before initials.
  //   4. null → ItemThumb renders abbr + colour-seeded placeholder.
  //
  // The earlier `evIsPlaceholder`-based suppression of tier 1 is
  // intentionally gone: it was preserving "per-mint identity" for
  // drops where there genuinely is none pre-reveal, and the cost
  // was either initials or an unrelated collection hero — neither
  // of which matches what the on-chain metadata actually says.
  //
  // Each candidate is normalized (`trim()` + empty-string→null) before
  // the `??` chain so a stale localStorage payload with
  // `nftImageUrl: ""` (a previous reducer regime wrote literal empty
  // strings — `??` does NOT catch those) doesn't pin the card to a
  // blank URL and bypass tier 2/3. Belt-and-braces: the hydrator on
  // page.tsx now also normalizes at read time, but this guard
  // catches any code path that ever introduces an empty image field
  // again (defensive — costs one trim per render).
  const nftImg  = normalizeUrl(ev.nftImageUrl);
  const repImg  = normalizeUrl(group?.representativeImageUrl);
  const heroImg = normalizeUrl(group?.imageUrl);
  const cardImage = nftImg ?? repImg ?? heroImg ?? null;
  // Fallback for ItemThumb. The primary above often resolves to the
  // per-mint image, which on a pre-reveal drop is the launchpad's shared
  // placeholder served only via a flaky/over-quota gateway (e.g. Flork's
  // mypinata→ipfs.io). When that fails to load, fall through to the
  // collection hero — the same reliable URL the left tracker renders —
  // instead of degrading to initials. heroImg is preferred over repImg
  // (repImg is typically the same placeholder as the primary).
  const cardFallback = heroImg ?? repImg ?? null;
  if (group?.name === 'Flork') {
    // Temporary Flork-only trace — confirms which tier the chain
    // picks for the current Bu8x… debugging session. Remove once
    // the brown-bag rendering is visually verified end-to-end.
    const tier = nftImg ? 'nft' : repImg ? 'representative' : heroImg ? 'collection' : 'initials';
    // eslint-disable-next-line no-console
    console.debug(`[mints/flork] sig=${ev.signature.slice(0, 8)}… tier=${tier} url=${cardImage ?? '—'}`);
  }
  const priceText      = ev.priceLamports == null
    ? '—'
    : ev.priceLamports === 0 ? 'FREE' : formatSol(ev.priceLamports / 1e9);
  const priceColor     = ev.priceLamports == null
    ? '#55556e'
    : ev.priceLamports === 0 ? '#5ce0a0' : '#f0eef8';
  // NFT-type pill. We only know `programSource` on the wire (no
  // separate nftType today), so Core → CORE; everything else
  // collapses to the spec's "NFT" fallback. Candy Machine rows
  // override the generic "NFT" label so the type pill reads CANDY,
  // matching the adjacent source pill — paired pinks read as one
  // colour family at a glance, and "NFT" was uninformative there.
  const nftTypeLabel: string =
    ev.programSource === 'mpl_core'              ? 'CORE'  :
    ev.programSource === 'bubblegum'             ? 'cNFT'  :
    ev.sourceLabel   === 'Metaplex Candy Machine' ? 'CANDY' :
    'NFT';
  // Two-tier freshness on the right Live Mint Feed:
  //   • `mints-feed-row-fresh`  (< 2.5 s) — one-shot slide-in +
  //     green flash for brand-new SSE arrivals (cache-restored
  //     events have an old `receivedAt` and never qualify).
  //   • `mints-feed-row-recent` (2.5–15 s) — soft lilac halo that
  //     persists for the rest of the 15 s window so a card stays
  //     visually distinct after the flash decays. Mutually
  //     exclusive with -fresh so the two effects never stack.
  // Boundary precision is gated by the page-level 5 s force tick
  // (same cadence used by the age-tier color below) — a 14 s card
  // flips off within 5 s of crossing the threshold.
  const ageMsCard    = now - ev.receivedAt;
  const isFreshFlash = ageMsCard < 2500;
  const isRecent     = !isFreshFlash && ageMsCard < 15000;
  return (
    <div
      className={
        'mints-feed-row' +
        (isFreshFlash ? ' mints-feed-row-fresh'  : '') +
        (isRecent     ? ' mints-feed-row-recent' : '')
      }
      onMouseEnter={onPauseEnter}
      onMouseLeave={onPauseLeave}
      style={{
        // Card chrome — exact mirror of /feed `.feed-card`: 10/12
        // padding, 12 px gap, 56 px thumb, 1 px hairline border,
        // 7 px radius, faint background. Hover tint via the
        // className rule in globals.css.
        // Collection accent is now a SYMMETRIC two-sided edge stripe
        // (left + right) painted by `.mints-feed-row::before/::after`
        // from the `--mint-accent` var below — replacing the old heavy
        // 3 px one-sided left border. Same deterministic collection
        // color, lower weight, balanced — matching /feed sales cards.
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px',
        border: '1px solid rgba(255,255,255,0.06)',
        '--mint-accent': colorForCollection(ev.collectionAddress ?? ev.groupingKey),
        borderRadius: 7,
        background: 'rgba(255,255,255,0.02)',
        // Hover-scope dim — non-matching mints fade out while a collection row
        // is hovered. Opacity-only (no display/size change) so the card keeps
        // its footprint and the panel never reflows. Eased so the fade reads
        // as deliberate rather than a flicker.
        opacity: dimmed ? 0.15 : 1,
        // Transitions live on `.mints-feed-row` in globals.css so the
        // hover lift (transform + scale) animates in lock-step with bg
        // and border-color. Inline `transition` removed — it shadowed
        // the class rule and made the transform snap.
        // Cast: this @types/react rejects `--*` custom-property keys in a
        // bare style literal, so assert the whole object as CSSProperties.
      } as CSSProperties}
    >
      {/* 56×56 thumbnail rendered from a 200×200 /thumb source so
          hi-DPI displays render crisply without enlarging the card
          footprint. Falls back to the shared abbr/color placeholder
          when no image yet. */}
      <ItemThumb
        imageUrl={thumb200(cardImage)}
        /* 2nd-tier URL tried (with its own proxy→raw retry) before
           initials — see cardFallback above. */
        fallbackImageUrl={thumb200(cardFallback)}
        /* When a real per-NFT image lands we keep the collection-
           color tint behind it (matches the row accent stripe).
           When it's the placeholder path we seed by `mintAddress`
           instead so two cards in the same collection paint visibly
           different tiles — otherwise the abbr is the only varying
           pixel and the tiles read as duplicates. */
        color={colorForCollection(
          cardImage
            ? (ev.collectionAddress ?? ev.groupingKey)
            : (ev.mintAddress ?? ev.signature)
        )}
        abbr={abbr}
        size={56}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Top line: NFT name. Clickable → Solscan token page when
            a real mint address is present. */}
        <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isSolPubkey(ev.mintAddress) ? (
            <a
              href={`https://solscan.io/token/${ev.mintAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              
              style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
            >
              {nftName}
            </a>
          ) : (
            nftName
          )}
        </div>
        {/* Bottom line: collection name (smaller, muted) per the
            targeted-mode spec. Falls back to the shortened collection
            address, then to "—". Clickable when we can build a
            LaunchMyNFT link for this row's group — same target as
            the LMNFT pill in the trending table on the left. We
            resolve the URL via `buildLaunchMyNftUrl` which already
            handles the deployer-only explore fallback. Cursor +
            underline-on-hover match the title-line link styling so
            users recognise it as interactive. */}
        {(() => {
          const lmnftHref = group ? buildLaunchMyNftUrl(group) : null;
          // X badge eligible only when we have a real collection
          // name (`strippedCollection`), not the short-address
          // fallback — searching base58 yields nothing useful.
          const xName = (strippedCollection && strippedCollection.length > 0) ? strippedCollection : null;
          const baseStyle: React.CSSProperties = {
            // Collection tier in the card's text hierarchy: NFT
            // title above is the bright primary (#f0eef8, weight
            // 600); collection name here takes the muted-tint
            // variant of the same deterministic accent the stripe /
            // tracker / fallback-avatar use (see
            // `COLLECTION_PALETTE_MUTED`) — each entry is pre-blended
            // 25 % collection hue / 75 % neutral gray so collections
            // still visually group by colour, but the line reads as
            // gray-with-a-tint rather than a second headline. Real
            // desaturation, not an alpha overlay (the previous
            // `+'cc'` form just darkened bright hues; it didn't pull
            // them toward neutral). Wallet line below takes its own
            // muted wallet palette so bots / repeat minters cluster
            // visually. Four-tier ladder (title → collection →
            // wallet → age/source) preserved; only the *colours*
            // changed, not the size/weight/position.
            fontSize: 11,
            color: colorForCollectionMuted(ev.collectionAddress ?? ev.groupingKey),
            fontWeight: 500,
            // Hierarchy kept but not washed-out: pulled back from the
            // v2 0.62 to 0.78 so the line still reads as secondary
            // without looking faded inside the purple palette.
            opacity: 0.78,
            overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            // `minWidth: 0` + `flex: 1` let the name truncate inside
            // the row-flex wrapper below; without these flexbox
            // stretches the element past its intended width and the
            // ellipsis never fires.
            minWidth: 0, flex: 1,
          };
          const nameEl = lmnftHref ? (
            <a
              href={lmnftHref}
              target="_blank"
              rel="noopener noreferrer"
              
              style={{
                ...baseStyle,
                display: 'block', textDecoration: 'none', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              onClick={(e) => e.stopPropagation()}
            >
              {collectionLine}
            </a>
          ) : (
            <div style={baseStyle}>{collectionLine}</div>
          );
          // Single flex wrapper hosts the name + the optional X badge
          // sibling. The wrapper takes the marginTop that used to sit
          // on `baseStyle` so the vertical rhythm between title /
          // collection / wallet is unchanged. When no `xName` is
          // available the wrapper still renders so layout is
          // identical across rows with/without the badge.
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, minWidth: 0 }}>
              {nameEl}
              {xName && (
                <a
                  href={`https://x.com/search?q=${encodeURIComponent(xName)}&src=recent_search_click`}
                  target="_blank"
                  rel="noopener noreferrer"
                  
                  style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brand/x.png" alt="X" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
                </a>
              )}
            </div>
          );
        })()}
        {/* Minter wallet — compact mono styling matching the seller/
            buyer rows in /feed. Plain shortened wallet (no
            "minter:" prefix) and clickable to the Solscan account
            page in a new tab. Hidden when the field isn't on the
            wire (some replays / cNFT paths). */}
        {ev.minter && (
          <div style={{ fontSize: 10.5, color: colorForWallet(ev.minter), fontFamily: "'SF Mono','Fira Code',monospace", marginTop: 2, opacity: 0.74, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <a
              href={`https://solscan.io/account/${ev.minter}`}
              target="_blank"
              rel="noreferrer"
              
              style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
            >
              {shortMint(ev.minter)}
            </a>
          </div>
        )}
      </div>
      {/* Compact NFT-type pill (CORE / pNFT / cNFT / NFT).
          Background + foreground tinted by sourceLabel so the eye
          associates the type pill with the launchpad: LMNFT →
          yellow, VVV → cyan, GRAVE → gray, anything else → existing
          purple default. Tones are the *same* values used by
          `sourceBadge()` for the adjacent source pill, so the two
          read as one colour family per source. Right-pane only —
          tracker pills untouched.
          Clickable when the shared `sourceHref(group)` resolves to a
          per-collection deep-link — same destination logic the left
          mints-table source badge uses (`MintsSourceBadge` →
          `sourceHref`). LMNFT / VVV / GRAVE / Metaplex-Core (item-
          details via `lastMintAddress`) all route through one helper;
          rows where the helper returns null render the prior plain
          span. Visual chrome (padding, fontSize, borderRadius,
          letterSpacing) is verbatim — only `<span>` becomes `<a>`. */}
      {(() => {
        const tint =
          // Core Candy Machine v3 launchpad mint → CANDY pink (the CORE
          // typeLabel is unchanged); raw Core falls through to purple below.
          ev.coreLaunchpad                            ? { bg: 'rgba(229,138,163,0.15)', fg: '#e58aa3' } :
          ev.sourceLabel === 'LaunchMyNFT'            ? { bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' } :
          ev.sourceLabel === 'VVV'                    ? { bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' } :
          ev.sourceLabel === 'GRAVE'                  ? { bg: 'rgba(160,160,168,0.15)', fg: '#a0a0a8' } :
          ev.sourceLabel === 'Metaplex Candy Machine' ? { bg: 'rgba(229,138,163,0.15)', fg: '#e58aa3' } :
                                                        { bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
        const pillStyle: React.CSSProperties = {
          display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
          background: tint.bg, color: tint.fg,
          letterSpacing: '0.3px', flexShrink: 0,
          textDecoration: 'none',
        };
        // Derive the link via the same helper the mints table uses.
        // `group` is the per-collection rollup pre-looked-up by the
        // page; absent only for the first event of a brand-new
        // collection. When absent, fall through to a plain pill so
        // the visual matches the prior behaviour exactly.
        const href = group ? sourceHref(group) : null;
        return href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            
            style={{ ...pillStyle, cursor: 'pointer' }}
            onClick={(e) => e.stopPropagation()}
          >{nftTypeLabel}</a>
        ) : (
          <span style={pillStyle}>{nftTypeLabel}</span>
        );
      })()}
      <span style={{
        minWidth: 64, textAlign: 'right',
        // Strong hierarchy pass: price is the focal data on the card.
        // Bumped fontSize 13 → 14 and fontWeight 700 → 800 — single
        // element, no card resize, but the price now clearly outranks
        // the muted collection/wallet lines per the polish brief.
        fontSize: 14, fontWeight: 800, color: priceColor,
        fontFamily: "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
        // Tighter letter-spacing so the bumped size doesn't push the
        // age pill to the right by more than ~1 px at common amounts.
        letterSpacing: '-0.2px',
      }}>{priceText}</span>
      {(() => {
        // Age tier coloring — mirrors /feed's TimeAgo tiers (pink
        // <15s, amber 15s–3m, muted >3m). Re-evaluated on the
        // page-level 5 s force tick; boundary precision is fine for
        // this surface (avoids a per-card 1 s timer on 150 cards).
        const ageMs = now - ev.receivedAt;
        const ageColor:  string = ageMs < 15000 ? '#e87ab0' : ageMs < 180000 ? '#c7b479' : '#877496';
        const ageWeight: 500 | 600 = ageMs < 15000 ? 600 : 500;
        return (
          <span style={{ minWidth: 56, textAlign: 'right', fontSize: 11, color: ageColor, fontWeight: ageWeight, flexShrink: 0 }}>
            {fmtAge(ev.receivedAt)}
          </span>
        );
      })()}
    </div>
  );
}
