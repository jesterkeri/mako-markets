import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Sidebar } from '@/components/Sidebar';
import { PriceTicker } from '@/components/PriceTicker';
import { MarketIntelAside } from '@/components/MarketIntelAside';
import { Analytics } from '@vercel/analytics/next';
import { THEME_BOOT_SCRIPT } from '@/lib/use-theme';

// Removed `next/font/google` Inter import to eliminate remote font fetch
// during Vercel build (was failing in sandboxed CI). System font stack is
// defined in globals.css.

export const metadata: Metadata = {
  title: 'Mako Market',
  description: 'Short-form prediction markets on Monad',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Inline theme boot — runs before React hydrates so the correct
            data-theme is on <html> on first paint. Reads localStorage, falls
            back to system preference, then to dark. Must stay inline; pulling
            it into a separate file would race the first render. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          <div className="w-full min-h-[100dvh] flex flex-col md:flex-row relative bg-transparent transition-all duration-500">
            <Sidebar />
            <div className="relative z-10 flex-1 flex flex-col items-stretch w-full min-w-0 max-w-full">
              {children}
            </div>
            {/* MARKET INTEL — right-hand column on xl+ screens. Lives at
                the layout level so every route (home, /me, /create,
                /market/[id], /admin/*) shows it in desktop mode. */}
            <MarketIntelAside />
          </div>
          {/* Crypto price crawl. Fixed to the viewport bottom, needs to be
              inside <Providers> so its useQuery-style fetch has access to
              the QueryClient. Mounted at layout-level so every route shows
              it — admin pages, market detail, feed, /me, create, etc. */}
          <PriceTicker />
        </Providers>
        {/* Vercel Web Analytics — anonymous page-view counters. Only sends
            data from production deploys on Vercel; silent no-op locally. */}
        <Analytics />
      </body>
    </html>
  );
}
