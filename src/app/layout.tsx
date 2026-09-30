import type { Metadata } from 'next';
import './globals.css';
// After globals.css: the redesign's theme values (light canvas, tints, motion) must win the cascade.
import './mako-shell.css';
import { Providers } from '@/components/Providers';
import { AppShell } from '@/components/shell/AppShell';
import { Analytics } from '@vercel/analytics/next';
import { THEME_BOOT_SCRIPT } from '@/lib/use-theme';

// Removed `next/font/google` Inter import to eliminate remote font fetch
// during Vercel build (was failing in sandboxed CI). Fonts are bundled by
// fontsource (see globals.css).

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
        {/* Inline theme boot: runs before React hydrates so the correct
            data-theme is on <html> on first paint. Reads the stored choice
            (light, dark or auto), falling back to the device. Must stay
            inline; pulling it into a separate file would race the first
            render. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        {/* Vercel Web Analytics: anonymous page-view counters. Only sends
            data from production deploys on Vercel; silent no-op locally. */}
        <Analytics />
      </body>
    </html>
  );
}
