'use client';

import Link from 'next/link';

import { NotificationList } from '@/components/notifications/NotificationList';

/// The notifications dropdown (22a frame, #214 S1). The newest 10, marked read as they are shown; "See all" opens
/// /notifications. Results, refunds, creator earnings and replies arrive here; reminders and price alerts come in
/// later slices.
export function NotificationsPanel({ onClose }: { onClose?: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="mk-pop"
      style={{
        position: 'absolute',
        top: 46,
        right: 0,
        width: 400,
        zIndex: 60,
        borderRadius: 16,
        overflow: 'hidden',
        background: 'var(--mako-canvas)',
        boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 30px 80px rgba(0,0,0,.5)',
        transformOrigin: 'top right',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
        <span style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 18 }}>Notifications</span>
        <Link href="/notifications" onClick={onClose} style={{ marginLeft: 'auto', fontFamily: 'var(--mako-font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--mako-canvas-fg)' }}>
          SEE ALL
        </Link>
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        <NotificationList limit={10} paged={false} onNavigate={onClose} />
      </div>
    </div>
  );
}
