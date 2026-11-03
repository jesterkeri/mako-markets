'use client';

import { useCallback, useEffect, useState } from 'react';

import type { NotificationKind, NotificationPrefs } from '@/lib/notifications/prefs';

// #214 S1 Settings switches (NOTIFICATIONS_PLAN r8 §3.4). Reads and writes /api/user/notification-prefs for the
// signed-in account; the server merges only the switch that changed, so two tabs never undo each other. Turning a kind
// off stops new notifications of that kind and does not hide old ones.

/// The Settings rows in plan order. `live` kinds have a working switch in S1; the rest arrive in later slices.
export const NOTIFICATION_ROWS: { kind: NotificationKind; label: string; note: string; live: boolean }[] = [
  { kind: 'claim', label: 'Money to claim', note: 'Winnings, refunds and creator earnings', live: true },
  { kind: 'result', label: 'Results', note: 'A pool or round you are in settled against you', live: true },
  { kind: 'reply', label: 'Replies', note: 'Someone replies to your comment', live: true },
  { kind: 'closing', label: 'Entries closing', note: 'Betting on a pool you are in or watch closes within the hour', live: false },
  { kind: 'round_start', label: 'Round starting', note: 'A round you follow or entered opens soon', live: false },
  { kind: 'price', label: 'Price alerts', note: 'A price you set an alert for is reached', live: false },
];

export function useNotificationPrefs(account: string) {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<NotificationKind | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/user/notification-prefs?account=${account}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { prefs: NotificationPrefs };
        if (alive) setPrefs(body.prefs);
      })
      .catch(() => alive && setError('Notification settings could not be loaded. Reload the page to try again.'));
    return () => {
      alive = false;
    };
  }, [account]);

  const toggle = useCallback(
    async (kind: NotificationKind) => {
      if (!prefs || saving) return;
      setSaving(kind);
      setError('');
      try {
        const r = await fetch('/api/user/notification-prefs', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account, kinds: { [kind]: !prefs.kinds[kind] } }),
        });
        if (r.status === 409) throw new Error('This page is for an account that is no longer signed in. Reload the page.');
        if (r.status === 429) throw new Error('Too many changes in a short time. Wait a minute and try again.');
        if (!r.ok) throw new Error('The change was not saved. Try again.');
        setPrefs(((await r.json()) as { prefs: NotificationPrefs }).prefs);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The change was not saved. Try again.');
      } finally {
        setSaving(null);
      }
    },
    [account, prefs, saving],
  );

  return { prefs, error, saving, toggle };
}

export function PrefSwitch({ label, on, disabled, onToggle }: { label: string; on: boolean | null; disabled?: boolean; onToggle?: () => void }) {
  const checked = on === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || on === null}
      onClick={onToggle}
      style={{
        marginLeft: 'auto',
        width: 38,
        height: 22,
        borderRadius: 9999,
        background: checked ? 'var(--mako-signal)' : 'var(--raise2)',
        opacity: disabled || on === null ? 0.55 : 1,
        position: 'relative',
        flex: 'none',
        transition: 'background-color 150ms ease',
      }}
    >
      <span style={{ position: 'absolute', top: 3, left: checked ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: checked ? '#000' : 'var(--dim)', transition: 'left 150ms ease' }} />
    </button>
  );
}
