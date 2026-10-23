'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { render } from '@/lib/notifications/copy';
import { USER_QUERY_KEY } from '@/lib/use-user';

// #214 The notification list shared by the bell's panel and /notifications (NOTIFICATIONS_PLAN r8 §3.5). It loads a
// page from /api/notifications and then marks exactly the ids it rendered as read (mark read on open, Q10): an item
// that arrives after the load stays unread. Items keep their unread dot for this view. The text comes only from
// render(), so nothing user-written is ever shown.

type Item = { id: string; kind: string; data: unknown; eventAt: string; read: boolean };

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function NotificationBadge({ count }: { count: number | null | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      style={{ position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9999, background: 'var(--mako-red)', color: '#fff', fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center' }}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

export const bellLabel = (count: number | null | undefined) => (count && count > 0 ? `Notifications, ${count > 99 ? '99+' : count} unread` : 'Notifications');

export function NotificationList({ limit, paged, onNavigate }: { limit: number; paged: boolean; onNavigate?: () => void }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  /// One page; the ids it holds that are unread are then marked read (the ids rendered, never a "created up to"
  /// cut). A failed mark only leaves them unread; the badge refetches either way.
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const res = await fetch(`/api/notifications?${q}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`notifications ${res.status}`);
      const page = (await res.json()) as { items: Item[]; next: string | null };
      const unread = page.items.filter((i) => !i.read).map((i) => i.id);
      if (unread.length > 0) {
        void fetch('/api/notifications/read', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: unread }),
        })
          .catch(() => undefined)
          .finally(() => void queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY }));
      }
      return page;
    },
    [limit, queryClient],
  );

  /// "Load more" fetches the next older page AND the top page again. The cursor bounds the older page by value, so an
  /// item that rose above it after the first page was read (a re-opened reply, plan §3.2(3)) or arrived since is not
  /// on the older page; it is on the top page, so it is put at the top (replacing its old place if it was shown), and
  /// the older page adds only ids not already shown. Nothing is skipped and nothing repeats in this view (Codex S1 code
  /// review R2).
  const load = useCallback(
    (cursor: string | null) =>
      (cursor ? Promise.all([fetchPage(cursor), fetchPage(null)]) : fetchPage(null).then((p) => [p, null] as const)).then(
        ([page, top]) => {
          if (!alive.current) return;
          setItems((prev) => {
            if (!cursor) return page.items;
            const topIds = new Set(top!.items.map((i) => i.id));
            const kept = [...top!.items, ...prev.filter((i) => !topIds.has(i.id))];
            const shown = new Set(kept.map((i) => i.id));
            return [...kept, ...page.items.filter((i) => !shown.has(i.id))];
          });
          setNext(page.next);
          setStatus('ready');
          setMore(false);
        },
        () => {
          if (!alive.current) return;
          setStatus('error');
          setMore(false);
        },
      ),
    [fetchPage],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const first = () => {
    setStatus('loading');
    void load(null);
  };
  const loadMore = () => {
    if (!next) return;
    setMore(true);
    void load(next);
  };

  const dim: React.CSSProperties = { fontSize: 14, lineHeight: 1.5, color: 'var(--dim)' };
  if (status === 'loading' && items.length === 0) return <div style={{ ...dim, padding: '18px 16px' }}>Loading…</div>;
  if (status === 'error' && items.length === 0) {
    return (
      <div role="alert" style={{ ...dim, padding: '18px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        Notifications could not be loaded.
        <button type="button" onClick={first} style={{ height: 30, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontSize: 13, fontWeight: 700 }}>
          Retry
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return <div style={{ ...dim, padding: '18px 16px' }}>Nothing yet. Results, refunds and replies to your comments show up here.</div>;
  }
  return (
    <div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((n) => {
          const r = render(n);
          return (
            <li key={n.id} style={{ boxShadow: 'inset 0 -1px 0 var(--line)' }}>
              <Link href={r.href} onClick={onNavigate} style={{ display: 'flex', gap: 10, padding: '12px 16px', color: 'inherit', textDecoration: 'none' }}>
                <span
                  aria-label={n.read ? undefined : 'Unread'}
                  style={{ flex: 'none', width: 8, height: 8, marginTop: 7, borderRadius: '50%', background: n.read ? 'transparent' : 'var(--mako-red)' }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 800 }}>{r.title}</span>
                  <span style={{ display: 'block', ...dim }}>{r.body}</span>
                  <span style={{ display: 'block', fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{when(n.eventAt)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {status === 'error' && <div role="alert" style={{ ...dim, padding: '10px 16px' }}>More could not be loaded. Try again.</div>}
      {paged && next && (
        <button type="button" onClick={loadMore} disabled={more} style={{ margin: '14px 16px', height: 36, padding: '0 16px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontSize: 13, fontWeight: 700 }}>
          {more ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
