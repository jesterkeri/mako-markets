// #214 S1 DOM tests (happy-dom): the bell badge and its label, and the list's mark-read-on-open (NOTIFICATIONS_PLAN r8
// §3.5; §8 S1 "Browser": badge text and aria, opening marks the shown ids read).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { NotificationBadge, NotificationList, bellLabel } from '@/components/notifications/NotificationList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('bell badge', () => {
  it('shows 1 to 9, then 9+; nothing at 0 or when the count failed', () => {
    const text = (n: number | null | undefined) => {
      const { container, unmount } = render(<NotificationBadge count={n} />);
      const t = container.textContent;
      unmount();
      return t;
    };
    expect(text(0)).toBe('');
    expect(text(null)).toBe('');
    expect(text(undefined)).toBe('');
    expect(text(3)).toBe('3');
    expect(text(9)).toBe('9');
    expect(text(10)).toBe('9+');
    expect(text(100)).toBe('9+');
  });

  it('labels the bell with the unread count', () => {
    expect(bellLabel(3)).toBe('Notifications, 3 unread');
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(null)).toBe('Notifications');
    expect(bellLabel(100)).toBe('Notifications, 99+ unread');
  });
});

describe('NotificationList', () => {
  it('renders the page from render() and marks exactly the unread ids it shows as read', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body!) });
        return new Response(JSON.stringify({ updated: 1 }));
      }
      return new Response(
        JSON.stringify({
          items: [
            { id: 'a0000000-0000-4000-8000-000000000001', kind: 'claim', data: { t: 'pool', id: '7', outcome: 'yes', why: 'won' }, eventAt: '2026-10-22T10:00:00Z', read: false },
            { id: 'a0000000-0000-4000-8000-000000000002', kind: 'reply', data: { poolId: '7', count: 2 }, eventAt: '2026-10-22T09:00:00Z', read: true },
          ],
          next: null,
        }),
      );
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationList limit={10} paged={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('You won')).toBeTruthy();
    expect(screen.getByText('2 new replies')).toBeTruthy();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ url: '/api/notifications/read', body: { ids: ['a0000000-0000-4000-8000-000000000001'] } });
    // The unread dot stays for this view.
    expect(screen.getAllByLabelText('Unread')).toHaveLength(1);
  });

  it('shows the empty state, and an error with a retry', async () => {
    let fail = true;
    vi.stubGlobal('fetch', async () => (fail ? new Response('no', { status: 500 }) : new Response(JSON.stringify({ items: [], next: null }))));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationList limit={10} paged={false} />
      </QueryClientProvider>,
    );
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    retry.click();
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
  });

  it('"Load more" also brings up a reply re-opened above the cursor after the first page, without repeats (Codex S1 code review R2)', async () => {
    const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const item = (n: number, read = true) => ({ id: id(n), kind: 'reply', data: { poolId: String(n), count: 1 }, eventAt: '2026-10-22T10:00:00Z', read });
    let reopened = false;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ updated: 1 }));
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      // Before "Load more": page one = 9, 8, next = cursor; page two would hold 7 and R (= 1).
      if (!cursor) return new Response(JSON.stringify({ items: reopened ? [item(1, false), item(9), item(8)] : [item(9), item(8)], next: 'c1' }));
      // After R was re-opened it sits above the cursor, so the older page no longer holds it.
      return new Response(JSON.stringify({ items: reopened ? [item(7)] : [item(7), item(1)], next: null }));
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationList limit={2} paged={true} />
      </QueryClientProvider>,
    );
    await screen.findByText('Load more');
    reopened = true;
    screen.getByText('Load more').click();
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull());
    const pools = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    // R (pool 1) is shown, at the top, and nothing appears twice.
    expect(pools).toHaveLength(4);
    expect(new Set(pools).size).toBe(4);
    expect(pools[0]).toContain('1');
  });
});
