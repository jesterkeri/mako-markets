import type { Metadata } from 'next';
import Link from 'next/link';

import { Mascot } from '@/components/Mascot';
import { PhoneDetailChrome } from '@/components/shell/PhoneDetailChrome';
import { StillInTheWaterDesktop, StillInTheWaterMobile } from '@/components/StillInTheWater';

import s from './not-found.module.css';

export const metadata: Metadata = { title: 'Page not found · Mako Market Beta' };

const pill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 9999,
  background: '#111',
  color: '#F4EBD6',
  fontWeight: 800,
};
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
};

/// 404 (7a): the page fell off the chart. Says plainly what happened and that funds are safe, then offers live
/// pools as the way back.
export default function NotFound() {
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ padding: '26px 0 0' }}>
          <div className={`${s.card} ${s.deskCard}`}>
            <svg className={s.deskTrail} viewBox="0 0 1232 480" preserveAspectRatio="xMaxYMin meet" aria-hidden="true">
              <path d="M690 460 C 640 380, 700 300, 760 330 S 860 420, 900 330 S 980 150, 1080 120 S 1150 60, 1170 44" fill="none" stroke="#D94A3D" strokeWidth="4" strokeDasharray="4 12" strokeLinecap="round" />
            </svg>
            <span className={s.deskCross} aria-hidden="true">✕</span>
            <span className={s.deskNote} aria-hidden="true">this page?</span>
            <div className={s.deskCopy}>
              <span style={{ ...pill, gap: 8, height: 30, padding: '0 13px', fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase' }}>
                {dot}Page not found
              </span>
              <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 128, lineHeight: 0.85, letterSpacing: '-0.06em', marginTop: 16 }}>404</div>
              <h1 style={{ margin: '16px 0 0', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40, lineHeight: 1.02, letterSpacing: '-0.035em' }}>
                Even Mako can’t find this page.
              </h1>
              <p style={{ fontSize: 17, lineHeight: 1.55, margin: '10px 0 0', opacity: 0.75, maxWidth: 540 }}>
                The link is old or mistyped, or the round or pool it points to never existed. Nothing was bet here, so your balance is where you left it.
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                <Link href="/rounds" className="mk-press97" style={{ ...deskButton, background: '#FACC15', color: '#000', boxShadow: '0 0 0 2px #111' }}>
                  Go to Rounds →
                </Link>
                <Link href="/pools" className="mk-press97" style={{ ...deskButton, background: 'transparent', color: '#111', boxShadow: 'inset 0 0 0 2px #111' }}>
                  Browse Pools
                </Link>
              </div>
            </div>
            <div className={s.deskSun} aria-hidden="true" />
            <Mascot pose="07-lost-map" motion="look" alt="Mako, lost, holding a map upside down" className={`${s.deskMascot} ${s.mascotEdge}`} />
          </div>
        </div>
        <StillInTheWaterDesktop />
      </div>

      <div className="mk-mob mk-m">
        {/* A missing pool or round (/pools/N) is a route where the shell hides its phone nav; bring it back. */}
        <PhoneDetailChrome>
          <div style={{ padding: '4px 12px 0' }}>
            <div className={`${s.card} ${s.mobCard}`}>
              <span aria-hidden="true" style={{ position: 'absolute', right: 18, top: 12, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1, color: '#D94A3D' }}>✕</span>
              <span style={{ ...pill, gap: 6, height: 28, padding: '0 12px', fontSize: 12 }}>
                {dot}Page not found
              </span>
              <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 96, lineHeight: 0.85, letterSpacing: '-0.06em', marginTop: 14 }}>404</div>
              <div className={s.mobArt}>
                <svg className={s.mobTrail} viewBox="0 0 330 250" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M10 60 C 40 140, 120 110, 150 170 S 230 240, 330 200" fill="none" stroke="#D94A3D" strokeWidth="4" strokeDasharray="4 12" strokeLinecap="round" />
                </svg>
                <div className={s.mobSun} aria-hidden="true" />
                <Mascot pose="07-lost-map" motion="look" alt="Mako, lost, holding a map upside down" className={`${s.mobMascot} ${s.mascotEdge}`} />
              </div>
            </div>
          </div>
          <div style={{ padding: '20px 20px 0' }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.03em' }}>
              Even Mako can’t find this page.
            </h1>
            <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', margin: '8px 0 0' }}>
              The link is old or mistyped. Nothing was bet here, so your balance is where you left it.
            </p>
            <div style={{ marginTop: 16 }}>
              <Link
                href="/rounds"
                className="m3-press"
                style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800, textDecoration: 'none' }}
              >
                Go to Rounds
              </Link>
            </div>
          </div>
          <StillInTheWaterMobile />
        </PhoneDetailChrome>
      </div>
    </>
  );
}
