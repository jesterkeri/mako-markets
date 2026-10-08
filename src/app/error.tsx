'use client';

// An error on any page, shown inside the site's own header in the 404 page's design (7a), instead of the bare
// last-resort page (Joshua, 2026-10-08). Says plainly that funds are safe and offers a retry and a way on. The crash
// still reaches Sentry when it is configured. Copy: no em dashes, no "we/our/us".
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

import { Mascot } from '@/components/Mascot';

import s from './not-found.module.css';

const pill: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', borderRadius: 9999, background: '#111', color: '#F4EBD6', fontWeight: 800 };
const dot = <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#D94A3D' }} />;
const deskButton: React.CSSProperties = {
  height: 54,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 24px',
  borderRadius: 9999,
  fontFamily: 'var(--mako-font-display)',
  fontWeight: 800,
  fontSize: 16,
  textDecoration: 'none',
  border: 0,
  cursor: 'pointer',
};
const BODY = 'Your bets and balance are safe on-chain, and nothing was lost. Try again, or carry on from Pools.';

export default function ErrorPage({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  // A server error carries an identifier that matches its server log; it is safe to show (no details).
  const ref = error.digest ? <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 12, opacity: 0.6, marginTop: 12 }}>Reference {error.digest}</div> : null;
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ padding: '26px 0 0' }}>
          <div className={`${s.card} ${s.deskCard}`}>
            <svg className={s.deskTrail} viewBox="0 0 1232 480" preserveAspectRatio="xMaxYMin meet" aria-hidden="true">
              <path d="M690 460 C 640 380, 700 300, 760 330 S 860 420, 900 330 S 980 150, 1080 120 S 1150 60, 1170 44" fill="none" stroke="#D94A3D" strokeWidth="4" strokeDasharray="4 12" strokeLinecap="round" />
            </svg>
            <span className={s.deskCross} aria-hidden="true">✕</span>
            <div className={s.deskCopy}>
              <span style={{ ...pill, gap: 8, height: 30, padding: '0 13px', fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase' }}>
                {dot}Something broke
              </span>
              <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 128, lineHeight: 0.85, letterSpacing: '-0.06em', marginTop: 16 }}>Oops.</div>
              <h1 style={{ margin: '16px 0 0', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40, lineHeight: 1.02, letterSpacing: '-0.035em' }}>
                Something broke on this page.
              </h1>
              <p style={{ fontSize: 17, lineHeight: 1.55, margin: '10px 0 0', opacity: 0.75, maxWidth: 540 }}>{BODY}</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                <button type="button" onClick={() => unstable_retry()} className="mk-press97" style={{ ...deskButton, background: '#FACC15', color: '#000', boxShadow: '0 0 0 2px #111' }}>
                  Try again
                </button>
                <Link href="/pools" className="mk-press97" style={{ ...deskButton, background: 'transparent', color: '#111', boxShadow: 'inset 0 0 0 2px #111' }}>
                  Browse Pools
                </Link>
              </div>
              {ref}
            </div>
            <div className={s.deskSun} aria-hidden="true" />
            <Mascot pose="20-error-cable" motion="glitch" alt="Mako holding an unplugged cable" className={`${s.deskMascot} ${s.mascotEdge}`} />
          </div>
        </div>
      </div>

      <div className="mk-mob mk-m">
        <div style={{ padding: '4px 12px 0' }}>
          <div className={`${s.card} ${s.mobCard}`}>
            <span aria-hidden="true" style={{ position: 'absolute', right: 18, top: 12, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1, color: '#D94A3D' }}>✕</span>
            <span style={{ ...pill, gap: 6, height: 28, padding: '0 12px', fontSize: 12 }}>
              {dot}Something broke
            </span>
            <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 96, lineHeight: 0.85, letterSpacing: '-0.06em', marginTop: 14 }}>Oops.</div>
            <div className={s.mobArt}>
              <svg className={s.mobTrail} viewBox="0 0 330 250" preserveAspectRatio="none" aria-hidden="true">
                <path d="M10 60 C 40 140, 120 110, 150 170 S 230 240, 330 200" fill="none" stroke="#D94A3D" strokeWidth="4" strokeDasharray="4 12" strokeLinecap="round" />
              </svg>
              <div className={s.mobSun} aria-hidden="true" />
              <Mascot pose="20-error-cable" motion="glitch" alt="Mako holding an unplugged cable" className={`${s.mobMascot} ${s.mascotEdge}`} />
            </div>
          </div>
        </div>
        <div style={{ padding: '20px 20px 0' }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.03em' }}>Something broke on this page.</h1>
          <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', margin: '8px 0 0' }}>{BODY}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => unstable_retry()}
              className="m3-press"
              style={{ height: 56, border: 0, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}
            >
              Try again
            </button>
            <Link
              href="/pools"
              className="m3-press"
              style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9999, boxShadow: 'inset 0 0 0 2px var(--mako-canvas-fg)', color: 'var(--mako-canvas-fg)', fontSize: 16, fontWeight: 800, textDecoration: 'none' }}
            >
              Browse Pools
            </Link>
          </div>
          {ref}
        </div>
      </div>
    </>
  );
}
