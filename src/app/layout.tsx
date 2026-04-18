import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Sidebar } from '@/components/Sidebar';
import { Analytics } from '@vercel/analytics/next';

// Removed `next/font/google` Inter import to eliminate remote font fetch
// during Vercel build (was failing in sandboxed CI). System font stack is
// defined in globals.css.

export const metadata: Metadata = {
  title: 'Mako Markets',
  description: 'Short-form prediction markets on Monad',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <Providers>
          <div className="w-full min-h-[100dvh] flex flex-col md:flex-row relative bg-transparent transition-all duration-500">
            <Sidebar />
            {/* overflow-x-clip (not overflow-hidden or overflow-x-hidden)
                — hidden on any axis makes the element a scroll ancestor,
                which traps `position: sticky` descendants inside this
                wrapper (MARKET INTEL panel scrolls with the page instead
                of pinning). `clip` clips without creating a scroll
                container, so sticky children keep sticking against the
                viewport. */}
            <div className="relative z-10 flex-1 flex flex-col h-full items-stretch w-full max-w-full overflow-x-clip">
              {children}
            </div>
          </div>
        </Providers>
        {/* Vercel Web Analytics — anonymous page-view counters. Only sends
            data from production deploys on Vercel; silent no-op locally. */}
        <Analytics />
      </body>
    </html>
  );
}
