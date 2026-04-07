import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';

const geist = Geist({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Aprendiendo Bilingue',
  description: 'Read anything in Italian, starting today.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.className} style={{ colorScheme: 'light' }}>
      <body className="min-h-screen bg-white text-gray-900">{children}</body>
    </html>
  );
}
