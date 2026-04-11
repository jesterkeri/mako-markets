import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';

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
          {/* Main Mobile App Bounding Box */}
          <div className="w-full max-w-md mx-auto min-h-[100dvh] flex flex-col relative border-x border-black bg-[var(--color-background)]">
            <div className="relative z-10 w-full flex flex-col h-full">
              {children}
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
