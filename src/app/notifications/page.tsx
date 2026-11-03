import type { Metadata } from 'next';

import { NotificationsClient } from './NotificationsClient';

export const metadata: Metadata = { title: 'Notifications · Mako Market Beta' };

/// Notifications (22a, #214 S1): results, refunds, creator earnings and replies to your comments.
export default function NotificationsPage() {
  return (
    <>
      <div className="mk-desk mk-desk-frame" style={{ paddingTop: 28 }}>
        <h1 style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40, letterSpacing: '-0.02em', margin: 0 }}>Notifications</h1>
      </div>
      <div className="mk-mob mk-m" style={{ padding: '6px 16px 0' }}>
        <h1 style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 32, letterSpacing: '-0.02em', margin: 0 }}>Notifications</h1>
      </div>
      {/* One list for both layouts, so the page loads and marks read once. */}
      <div className="mk-desk-frame">
        <NotificationsClient />
      </div>
    </>
  );
}
