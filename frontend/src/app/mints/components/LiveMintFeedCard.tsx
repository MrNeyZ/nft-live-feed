// VictoryLabs — Mints: one card in the right-side Live Mint Feed.
// Extracted from page.tsx so the page file stays maintainable. JSX
// byte-identical to the prior inline block — same className stack,
// same style objects, same nested IIFEs for collection-name / NFT-
// type pill / age tier. Closure surface is just `event`, `group`
// (pre-looked-up from `rows` in the page), and `now`.

import { ItemThumb } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';
import type { MintEvent, MintStatus } from '../lib/types';
import {
  colorForCollection, colorForCollectionMuted, colorForWallet, isSolPubkey,
} from '../lib/palette';
import { fmtAge, shortMint, thumb200 } from '../lib/format';
import { buildLaunchMyNftUrl } from '../lib/source';

interface Props {
  event: MintEvent;
  /** Pre-looked-up collection-level row for `event.groupingKey`. May
   *  be undefined for events whose collection hasn't surfaced in the
   *  table yet (typical for the first event of a brand-new drop). */
  group: MintStatus | undefined;
  now:   number;
}

export function LiveMintFeedCard({ event: ev, group, now }: Props) {
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
  // Per-mint image only. We deliberately do NOT fall back to
  // `group?.imageUrl` here — that produced the bug where every
  // card in a collection painted the same image:
  // `patchAccumulatorMeta` used to write the FIRST resolved
  // per-NFT image into the collection row, and every other card
  // without its own resolved image inherited it via this fallback.
  // Collection-row image is unaffected (renders in the trending
  // table only); unresolved live cards now show a per-mint
  // placeholder (mintAddress-seeded color + shortMint initials)
  // until their own DAS retry lands a unique image.
  const cardImage      = ev.nftImageUrl ?? null;
  const priceText      = ev.priceLamports == null
    ? '—'
    : ev.priceLamports === 0 ? 'FREE' : formatSol(ev.priceLamports / 1e9);
  const priceColor     = ev.priceLamports == null
    ? '#55556e'
    : ev.priceLamports === 0 ? '#5ce0a0' : '#f0eef8';
  // NFT-type pill. We only know `programSource` on the wire (no
  // separate nftType today), so Core → CORE; everything else
  // collapses to the spec's "NFT" fallback.
  const nftTypeLabel: string =
    ev.programSource === 'mpl_core'   ? 'CORE'   :
    ev.programSource === 'bubblegum'  ? 'cNFT'   :
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
      style={{
        // Card chrome — exact mirror of /feed `.feed-card`: 10/12
        // padding, 12 px gap, 56 px thumb, 1 px hairline border,
        // 7 px radius, faint background. Hover tint via the
        // className rule in globals.css.
        // 3 px left accent stripe in the same deterministic
        // collection color used on the row above — visually groups
        // all mints from the same collection in the stream.
        // `borderLeftWidth` overrides the hairline.
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px',
        border: '1px solid rgba(255,255,255,0.06)',
        borderLeft: `3px solid ${colorForCollection(ev.collectionAddress ?? ev.groupingKey)}`,
        borderRadius: 7,
        background: 'rgba(255,255,255,0.02)',
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      {/* 56×56 thumbnail rendered from a 200×200 /thumb source so
          hi-DPI displays render crisply without enlarging the card
          footprint. Falls back to the shared abbr/color placeholder
          when no image yet. */}
      <ItemThumb
        imageUrl={thumb200(cardImage)}
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
              title={`Solscan · ${ev.mintAddress}`}
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
              title={`LaunchMyNFT · ${group?.name ?? collectionLine}`}
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
                  title={`X · live search "${xName}"`}
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
          <div style={{ fontSize: 10.5, color: colorForWallet(ev.minter), fontFamily: "'SF Mono','Fira Code',monospace", marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <a
              href={`https://solscan.io/account/${ev.minter}`}
              target="_blank"
              rel="noreferrer"
              title={`Solscan · ${ev.minter}`}
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
          tracker pills untouched. */}
      {(() => {
        const tint =
          ev.sourceLabel === 'LaunchMyNFT' ? { bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' } :
          ev.sourceLabel === 'VVV'         ? { bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' } :
          ev.sourceLabel === 'GRAVE'       ? { bg: 'rgba(160,160,168,0.15)', fg: '#a0a0a8' } :
                                             { bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
        return (
          <span style={{
            display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
            background: tint.bg, color: tint.fg,
            letterSpacing: '0.3px', flexShrink: 0,
          }}>{nftTypeLabel}</span>
        );
      })()}
      <span style={{
        minWidth: 64, textAlign: 'right',
        fontSize: 13, fontWeight: 700, color: priceColor,
        fontFamily: "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
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
