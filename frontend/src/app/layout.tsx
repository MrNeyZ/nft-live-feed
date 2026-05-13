import type { Metadata } from 'next';
import { Playfair_Display } from 'next/font/google';
import './globals.css';
import { Gate } from '@/runtime/Gate';
import { ViewportDebugBadge } from '@/lib/ViewportDebugBadge';

// Playfair Display — italic 600 + italic 800 ONLY. Used by the topbar
// VictoryLabs wordmark lockup (`.vl-logo` in globals.css). Exposed as the
// CSS variable `--font-playfair-display` so `--vl-font-serif` can reference
// it; next/font provides the font via this variable, not by its CSS name,
// so the roman Playfair 700/800 still loaded by the <link> in <head> below
// (used elsewhere, e.g. the access Gate) is left untouched.
const playfairDisplay = Playfair_Display({
  subsets: ['latin'],
  style: 'italic',
  weight: ['600', '800'],
  display: 'swap',
  variable: '--font-playfair-display',
});

export const metadata: Metadata = {
  title: 'VictoryLabs — Live Feed',
  description: 'Solana-wide NFT sales in real time',
  // Favicon = the new V-mark: a dark rounded square + the purple "V" from
  // the typography wordmark (squared-up / upright, chunkier than the slanted
  // Playfair italic so it survives 16px). Three artefacts live under
  // `app/`: icon.svg (crisp, primary), icon.png 64×64 (raster fallback),
  // apple-icon.png 180×180. Listed explicitly here SVG-first so browsers
  // that support SVG favicons use it and the rest fall back to the PNG.
  // (Next emits a single set of <link>s from this; the file conventions
  // just serve the routes.) The header brand mark stays the full wordmark
  // lockup (`.vl-logo`, rendered by TopNav); the old `/brand/V-logo.png`
  // is no longer referenced.
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon.png', type: 'image/png', sizes: '64x64' },
    ],
    apple: { url: '/apple-icon.png', type: 'image/png', sizes: '180x180' },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={playfairDisplay.variable}>
      <head>
        {/* Apply persisted UI layout-mode before first paint so PC/Phone
            users don't flash the default laptop layout on hydrate. Mirrors
            readLayoutMode() in @/soloist/layout-mode. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=localStorage.getItem('vl.layoutMode');if(m==='pc'||m==='laptop'||m==='phone')document.documentElement.dataset.layout=m;}catch(e){}`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Italianno&family=Dancing+Script:wght@700&family=Fira+Code:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body><Gate>{children}</Gate><ViewportDebugBadge /></body>
    </html>
  );
}
