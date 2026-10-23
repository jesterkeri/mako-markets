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

  /// A fake of GET /api/notifications that pages exactly as the route does (route.ts): newest first by key, `limit`
  /// items, `next` = the last item's key when more exist, an older page strictly below the cursor. `bump` re-opens a
  /// row or adds a new one at the top (created_at = now()). `failNext` fails the next GET whose cursor matches.
  function feed(start: number) {
    let clock = 0;
    const key = () => `2026-10-22T10:00:00.${String(++clock).padStart(6, '0')}Z`;
    const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rows = new Map<number, { ca: string; read: boolean }>();
    for (let n = 1; n <= start; n++) rows.set(n, { ca: key(), read: true });
    const posted: string[] = [];
    const fails: Array<'top' | 'older'> = [];
    const fetchFake = async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push(...(JSON.parse(init.body!) as { ids: string[] }).ids);
        return new Response(JSON.stringify({ updated: 1 }));
      }
      const q = new URL(url, 'http://x').searchParams;
      const cursor = q.get('cursor');
      const limit = Number(q.get('limit'));
      const which = cursor ? 'older' : 'top';
      const f = fails.indexOf(which);
      if (f >= 0) {
        fails.splice(f, 1);
        return new Response('no', { status: 500 });
      }
      const all = [...rows].map(([n, r]) => ({ n, r, k: `${r.ca}_${id(n)}` })).sort((a, b) => (a.k < b.k ? 1 : -1));
      const below = cursor ? all.filter((x) => x.k < cursor) : all;
      const page = below.slice(0, limit);
      return new Response(
        JSON.stringify({
          items: page.map((x) => ({ id: id(x.n), kind: 'reply', data: { poolId: String(x.n), count: 1 }, eventAt: '2026-10-22T10:00:00Z', read: x.r.read, key: x.k })),
          next: below.length > limit ? page[page.length - 1].k : null,
        }),
      );
    };
    return {
      fetchFake,
      posted,
      id,
      bump: (n: number) => rows.set(n, { ca: key(), read: false }),
      unread: (n: number) => void (rows.get(n)!.read = false),
      failNext: (which: 'top' | 'older') => fails.push(which),
      all: () => [...rows.keys()],
    };
  }
  const shownPools = () => screen.queryAllByRole('link').map((a) => Number(a.getAttribute('href')!.split('/').pop()));
  const mount = (limit: number) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationList limit={limit} paged={true} />
      </QueryClientProvider>,
    );
  const clickMore = async () => {
    const before = shownPools().join(',');
    screen.getByText('Load more').click();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    return before;
  };
  const drain = async () => {
    for (let i = 0; i < 50 && screen.queryByText('Load more'); i++) await clickMore();
  };

  it('"Load more" also brings up a reply re-opened above the cursor after the first page, without repeats (Codex S1 code review R2)', async () => {
    const f = feed(4); // newest first: 4, 3 | 2, 1
    vi.stubGlobal('fetch', f.fetchFake);
    mount(2);
    await screen.findByText('Load more');
    f.bump(1); // re-opened: 1 now sorts above the cursor
    await drain();
    const pools = shownPools();
    expect(pools[0]).toBe(1);
    expect(pools.slice().sort()).toEqual([1, 2, 3, 4]);
  });

  it('more arrivals and re-opens than one top page holds are all shown, exactly once (Codex S1 code review R3 F1)', async () => {
    const f = feed(6); // 6, 5 | 4, 3 | 2, 1
    vi.stubGlobal('fetch', f.fetchFake);
    mount(2);
    await screen.findByText('Load more');
    // limit + 1 = 3 rows rise above everything shown: two re-opened from below the cursor, one new.
    f.bump(2);
    f.bump(1);
    f.bump(7);
    await drain();
    const pools = shownPools();
    expect(pools.length).toBe(new Set(pools).size);
    expect(pools.slice().sort()).toEqual(f.all().sort());
  });

  it('any mix of arrivals and re-opens between clicks, then paging to the end: every row is shown exactly once', async () => {
    let seed = 7;
    const rand = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % k);
    for (let run = 0; run < 12; run++) {
      const f = feed(9);
      vi.stubGlobal('fetch', f.fetchFake);
      const { unmount } = mount(3);
      await screen.findByText('Load more');
      let next = 10;
      for (let i = 0; i < 8 && screen.queryByText('Load more'); i++) {
        const burst = rand(6); // 0..5: up to limit + 2 changes before a click
        for (let b = 0; b < burst; b++) (rand(2) === 0 ? f.bump(next++) : f.bump(1 + rand(next - 1)));
        await clickMore();
      }
      await drain(); // the changes stop; paging continues to the end of the feed
      const pools = shownPools();
      expect(pools.length).toBe(new Set(pools).size);
      expect(pools.slice().sort((a, b) => a - b)).toEqual(f.all().sort((a, b) => a - b));
      unmount();
      vi.unstubAllGlobals();
    }
  });

  for (const failing of ['top', 'older'] as const) {
    it(`if the ${failing} page of a "Load more" fails, nothing it did not render is marked read (Codex S1 code review R3 F2)`, async () => {
      const f = feed(4); // 4, 3 | 2, 1
      vi.stubGlobal('fetch', f.fetchFake);
      mount(2);
      await screen.findByText('Load more');
      f.unread(2); // an unread item on the older page
      f.bump(5); // a new unread item on the top page
      f.failNext(failing);
      screen.getByText('Load more').click();
      expect(await screen.findByText('More could not be loaded. Try again.')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
      const shownIds = shownPools().map(f.id);
      expect(f.posted.filter((x) => !shownIds.includes(x))).toEqual([]);
      expect(shownPools().sort()).toEqual([3, 4]);
    });
  }
});
