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
  title: 'Live Feed | VictoryLabs',
  description: 'Solana-wide NFT sales in real time',
  // Favicon = Soloist brand mark (spectral-ink). Assets under `app/`:
  // favicon.ico (multi-size, desktop), icon.svg (SVG, modern browsers),
  // icon.png 32×32 (raster fallback), apple-icon.png 180×180 (iOS).
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }],
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
