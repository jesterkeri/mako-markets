'use client';

// The last-resort error page: a crash in the root layout still reaches Sentry (when it is configured) and shows a plain
// way back instead of a blank screen. Copy: no em dashes, no "we/our/us".
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0b0b0b', color: '#f5f5f5', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Something broke on this page.</h1>
          <p style={{ opacity: 0.75 }}>Reload the page, or go back and try again.</p>
          {/* A full page load on purpose: the root layout itself failed, so client-side navigation may not work. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" style={{ color: '#FACC15', fontWeight: 700 }}>Back to Mako Market</a>
        </main>
      </body>
    </html>
  );
}
