import type { Metadata } from 'next';
import { Playfair_Display } from 'next/font/google';
import './globals.css';
import { Gate } from '@/runtime/Gate';
import { GATE_CSS } from '@/runtime/gate-css';
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
  // Favicon = VictoryLabs brand mark. favicon.ico in app/ (served at
  // /favicon.ico); SVG + PNG sizes + apple-touch in public/ (exact paths).
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png' }],
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
        {/* Gate screen CSS — injected here (SSR HTML) so changes are live
            on every deploy regardless of browser chunk cache. */}
        <style dangerouslySetInnerHTML={{ __html: GATE_CSS }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Parisienne&family=Playfair+Display:wght@700;800&family=Italianno&family=Dancing+Script:wght@700&family=Fira+Code:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body><Gate>{children}</Gate><ViewportDebugBadge /></body>
    </html>
  );
}
