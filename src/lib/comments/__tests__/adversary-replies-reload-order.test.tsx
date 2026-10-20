// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/adversary-replies-reload-order.test.tsx  (#193 adversary r2)
//
// After the viewer replies in an expanded thread, CommentThread re-reads the
// replies past the first window (reloadMore) and stores the result
// unconditionally. Two such re-reads, or a re-read and a delete, can land in
// either order on a slow network. A re-read that started earlier but lands
// later must not overwrite newer state: it would hide the viewer's second
// reply (spec #193 (c), (d)) or bring back a reply the viewer just deleted
// (spec #193 (b)).
//
// The third case covers spec (a) for a reply by someone else: once the thread
// is expanded to its end, the 60 s poll returns the same window and cursor, so
// a reply posted past the window afterwards must still become reachable. The
// fourth is the same for someone else's delete of a reply in the expanded list.
//
// The data hooks are mocked the way comments-replies-reconcile.test.tsx does.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { CommentWire } from '@/lib/comments/types';

type Page = { comments: CommentWire[]; nextCursor: string | null };

const h = vi.hoisted(() => ({
  comments: {
    data: { pages: [{ comments: [] as unknown[], nextCursor: null }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  },
  pages: new Map<string, unknown>(),
  // A cursor listed here answers its NEXT call with this pending promise instead.
  held: new Map<string, Promise<unknown>>(),
  calls: [] as (string | null)[],
}));

vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: { authType: 'magic' } }) }));
vi.mock('@/lib/admin', () => ({ useIsAdmin: () => false }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/use-comments', () => ({
  useComments: () => h.comments,
  usePostComment: () => ({
    mutate: (_input: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    isPending: false,
    error: null,
  }),
  useDeleteComment: () => ({
    mutate: (_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    isPending: false,
  }),
  fetchMoreReplies: async (_t: unknown, _parent: string, cursor: string | null) => {
    h.calls.push(cursor);
    const held = h.held.get(cursor ?? '');
    if (held) {
      h.held.delete(cursor ?? '');
      return held;
    }
    const page = h.pages.get(cursor ?? '');
    if (!page) throw new Error(`no page for ${cursor}`);
    return page;
  },
  commentsQueryKey: () => ['comments'],
}));

const { CommentsSection } = await import('@/components/CommentsSection');

const reply = (id: string, over: Partial<CommentWire> = {}): CommentWire => ({
  id,
  parentId: 't1',
  authorLabel: `Author ${id}`,
  avatarSeed: 'abc12345',
  avatarUrl: null,
  authorAddress: null,
  isOwn: false,
  position: null,
  body: `body ${id}`,
  deleted: false,
  createdAt: new Date('2026-10-20T12:00:00Z').toISOString(),
  replies: [],
  repliesNextCursor: null,
  repliesCount: 0,
  ...over,
});

// `repliesCount` is the server's count of ALL the thread's live replies, past the window too.
const thread = (replies: CommentWire[], repliesNextCursor: string | null, repliesCount = 0): CommentWire => ({
  ...reply('t1', { parentId: null, body: 'the thread' }),
  replies,
  repliesNextCursor,
  repliesCount,
});

function setThread(t: CommentWire) {
  h.comments = { ...h.comments, data: { pages: [{ comments: [t], nextCursor: null }] } };
}

// A fresh element each time: rerendering the SAME element object lets React skip the update.
const ui = () => <CommentsSection scope="main" marketId="5" />;

async function postReply(text: string) {
  fireEvent.click(screen.getAllByText('REPLY')[0]);
  fireEvent.change(screen.getByPlaceholderText(/Reply to/), { target: { value: text } });
  const posts = screen.getAllByRole('button', { name: /^POST/ });
  await act(async () => fireEvent.click(posts[posts.length - 1])); // the reply box's, after the page's own composer
}

afterEach(() => {
  cleanup();
  h.pages.clear();
  h.held.clear();
  h.calls = [];
});

describe('#193 adversary r2: re-reads after a reply land out of order', () => {
  it("two quick replies: the first re-read landing last does not hide the viewer's second reply", async () => {
    // Server: window r1 r2 r3 (cursor c3), then r4. The viewer expands to the end.
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3'));
    h.pages.set('c3', { comments: [reply('r4')], nextCursor: null });
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r4')).toBeTruthy();

    // Reply 1 (r5): its re-read of c3 is slow and will answer with what the server held then, r4 r5.
    let releaseFirst!: (p: Page) => void;
    h.held.set('c3', new Promise<Page>((res) => (releaseFirst = res)));
    await postReply('first');

    // Reply 2 (r6): its re-read of c3 answers at once with r4 r5 r6.
    h.pages.set('c3', { comments: [reply('r4'), reply('r5', { isOwn: true }), reply('r6', { isOwn: true })], nextCursor: null });
    await postReply('second');
    rerender(ui()); // the list query refetched after the posts; the window and its cursor are unchanged
    expect(screen.getByText('body r6')).toBeTruthy();

    // The first re-read lands last.
    await act(async () => releaseFirst({ comments: [reply('r4'), reply('r5', { isOwn: true })], nextCursor: null }));

    // r6 must still be shown, or at least reachable through VIEW MORE.
    const reachable = screen.queryByText('body r6') !== null || screen.queryByText('VIEW MORE REPLIES') !== null;
    expect(reachable).toBe(true);
  });

  it('a re-read in flight when the viewer deletes a reply does not bring the deleted reply back', async () => {
    // Server: window r1 r2 r3 (cursor c3), then r4 (the viewer's) and r5. The viewer expands to the end.
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3'));
    h.pages.set('c3', { comments: [reply('r4', { isOwn: true }), reply('r5')], nextCursor: null });
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r4')).toBeTruthy();

    // The viewer replies (r6); the re-read of c3 is slow and was answered before the delete below.
    let release!: (p: Page) => void;
    h.held.set('c3', new Promise<Page>((res) => (release = res)));
    await postReply('mine');

    // The viewer deletes r4 while that re-read is in flight.
    await act(async () => fireEvent.click(screen.getByText('DELETE')));
    rerender(ui()); // the delete invalidated the list; the window and its cursor are unchanged
    expect(screen.queryByText('body r4')).toBeNull();

    // The re-read lands with what the server held before the delete.
    await act(async () =>
      release({ comments: [reply('r4', { isOwn: true }), reply('r5'), reply('r6', { isOwn: true })], nextCursor: null }),
    );

    expect(screen.queryByText('body r4')).toBeNull();
  });

  // Was skipped as a known limit of #193; closed by the live reply count in the window key (owner's call, 2026-10-20).
  it("someone else's reply posted after the thread was expanded to its end becomes reachable after the poll", async () => {
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3', 4));
    h.pages.set('c3', { comments: [reply('r4')], nextCursor: null });
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.queryByText('VIEW MORE REPLIES')).toBeNull();

    // Another user posts r5. The 60 s poll returns the same window and cursor (r5 lies past r4); only the count moves.
    h.pages.set('c3', { comments: [reply('r4'), reply('r5')], nextCursor: null });
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3', 5));
    await act(async () => {
      rerender(ui());
    });

    const reachable = screen.queryByText('body r5') !== null || screen.queryByText('VIEW MORE REPLIES') !== null;
    expect(reachable).toBe(true);
  });

  it("someone else's delete of a reply in the expanded list removes it after the poll", async () => {
    // Server: window r1 r2 r3 (cursor c3), then r4 and r5, both by another user. The viewer expands to the end.
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3', 5));
    h.pages.set('c3', { comments: [reply('r4'), reply('r5')], nextCursor: null });
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r4')).toBeTruthy();

    // r4's author deletes it. The poll returns the same window and cursor; the count drops to 4.
    h.pages.set('c3', { comments: [reply('r5')], nextCursor: null });
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3', 4));
    await act(async () => {
      rerender(ui());
    });

    // The thread falls back to the server's window and its VIEW MORE: the deleted reply is gone.
    expect(screen.queryByText('body r4')).toBeNull();
    expect(screen.getByText('VIEW MORE REPLIES')).toBeTruthy();

    // VIEW MORE reaches what is left past the window, without the deleted reply.
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r5')).toBeTruthy();
    expect(screen.queryByText('body r4')).toBeNull();
  });
});
