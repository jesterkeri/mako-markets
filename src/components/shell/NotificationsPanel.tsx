'use client';

/// The notifications dropdown (22a frame). Notifications are not built yet (founder's decision, 2026-09-30:
/// show "coming soon" rather than hide or fake them), so the panel says so; it never shows an unread count.
export function NotificationsPanel() {
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
        <span style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)' }}>COMING SOON</span>
      </div>
      <div style={{ padding: '18px 16px 20px', fontSize: 14, lineHeight: 1.5, color: 'var(--dim)' }}>
        Round results, refunds and replies to your comments will show up here once notifications launch. Until
        then, results and claims are on Me.
      </div>
    </div>
  );
}
