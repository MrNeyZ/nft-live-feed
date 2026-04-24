import type { Metadata } from 'next';
import './globals.css';
import { Gate } from '@/runtime/Gate';

export const metadata: Metadata = {
  title: 'Soloist — Live Feed',
  description: 'Solana-wide NFT sales in real time',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Italianno&family=Dancing+Script:wght@700&family=Fira+Code:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body><Gate>{children}</Gate></body>
    </html>
  );
}
