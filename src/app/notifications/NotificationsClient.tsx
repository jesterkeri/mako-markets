'use client';

import { NotificationList } from '@/components/notifications/NotificationList';
import { SignInLink } from '@/components/signin/SignInLink';
import { useUser } from '@/lib/use-user';

/// /notifications (22a, #214 S1): the signed-in user's notifications, 20 a page with "Load more", marked read as they
/// are shown. Signed out, it asks for a sign-in; a sign-in check that fails offers a retry, never the sign-in prompt.
export function NotificationsClient() {
  const { user, isLoading, isError, refetch } = useUser();
  const note: React.CSSProperties = { fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', margin: '16px 0 0' };
  if (user) {
    return (
      <div style={{ marginTop: 16, maxWidth: 640, borderRadius: 16, background: 'var(--raise)', overflow: 'hidden' }}>
        <NotificationList limit={20} paged />
      </div>
    );
  }
  if (isLoading) return <p style={note}>Loading…</p>;
  if (isError) {
    return (
      <p role="alert" style={note}>
        Your sign-in could not be checked.{' '}
        <button type="button" onClick={() => void refetch()} style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700, textDecoration: 'underline' }}>
          Try again
        </button>
      </p>
    );
  }
  return (
    <p style={note}>
      <SignInLink style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>Sign in</SignInLink> to see results, refunds and replies to your comments.
    </p>
  );
}
