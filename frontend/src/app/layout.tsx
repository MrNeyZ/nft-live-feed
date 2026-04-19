import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NFT Live Feed',
  description: 'Solana-wide NFT sales in real time',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
