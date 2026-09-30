import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Notifications · Mako Market' };

/// Notifications (22a). Not built yet; per the founder's decision (2026-09-30) the page says "coming soon"
/// rather than hiding the bell or showing made-up items.
export default function NotificationsPage() {
  return (
    <>
      <div className="mk-desk mk-desk-frame" style={{ paddingTop: 28 }}>
        <h1 style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40, letterSpacing: '-0.02em', margin: 0 }}>Notifications</h1>
        <p style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: '.06em', margin: '8px 0 0' }}>COMING SOON</p>
        <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', maxWidth: 520, margin: '16px 0 0' }}>
          Round results, refunds and replies to your comments will show up here once notifications launch. Until
          then, results and claims are on Me.
        </p>
      </div>
      <div className="mk-mob mk-m" style={{ padding: '6px 16px 0' }}>
        <h1 style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 32, letterSpacing: '-0.02em', margin: 0 }}>Notifications</h1>
        <div style={{ marginTop: 16, borderRadius: 28, background: 'var(--raise)', padding: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Coming soon</div>
          <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', margin: '6px 0 0' }}>
            Round results, refunds and replies will show up here once notifications launch. Until then, results
            and claims are on Me.
          </p>
        </div>
      </div>
    </>
  );
}
