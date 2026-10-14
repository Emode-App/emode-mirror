import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';

// The same pairing as emode.style: Outfit for display, Inter for reading.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', display: 'swap' });

export const metadata: Metadata = {
    title: 'Emode Mirror',
    description: 'Try on anything, in the mirror.',
    robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className={`${inter.variable} ${outfit.variable}`}>
            <body className="antialiased">{children}</body>
        </html>
    );
}
