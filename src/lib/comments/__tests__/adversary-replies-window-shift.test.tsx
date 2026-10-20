// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/adversary-replies-window-shift.test.tsx  (#193 adversary)
//
// The first window of replies is built by getCommentsPage with deleted replies
// filtered INSIDE the window (queries.ts fetchRepliesWindow, `deleted_at IS
// NULL` before row_number). So deleting a window reply SHIFTS the window: the
// next live reply moves into it. A thread already expanded with VIEW MORE still
// holds that reply in its own state, so it must not be shown twice.
//
// The second case races VIEW MORE against the reload that follows the viewer's
// own reply: a page that was in flight before the reload must not be appended
// on top of the reloaded list.
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

const thread = (replies: CommentWire[], repliesNextCursor: string | null): CommentWire => ({
  ...reply('t1', { parentId: null, body: 'the thread' }),
  replies,
  repliesNextCursor,
});

function setThread(t: CommentWire) {
  h.comments = { ...h.comments, data: { pages: [{ comments: [t], nextCursor: null }] } };
}

// A fresh element each time: rerendering the SAME element object lets React skip the update.
const ui = () => <CommentsSection scope="main" marketId="5" />;

afterEach(() => {
  cleanup();
  h.pages.clear();
  h.held.clear();
  h.calls = [];
});

describe('#193 adversary: the first window is not fixed', () => {
  it('deleting a window reply in an expanded thread does not show the shifted-in reply twice', async () => {
    // Server: r1..r4 live, window r1 r2 r3, cursor after r3. The viewer owns r2.
    setThread(thread([reply('r1'), reply('r2', { isOwn: true }), reply('r3')], 'c3'));
    h.pages.set('c3', { comments: [reply('r4')], nextCursor: null });
    const { rerender } = render(ui());

    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getAllByText('body r4')).toHaveLength(1);

    // The viewer deletes r2 (a window reply). The delete invalidates the list; the refetched window
    // skips the deleted r2 and so now holds r1 r3 r4, with no more replies past it.
    await act(async () => fireEvent.click(screen.getByText('DELETE')));
    setThread(thread([reply('r1'), reply('r3'), reply('r4')], null));
    rerender(ui());

    expect(screen.queryByText('body r2')).toBeNull();
    expect(screen.getAllByText('body r4')).toHaveLength(1);
  });

  it('a VIEW MORE page in flight when the post-reply reload lands is not appended twice', async () => {
    // Server: window r1 r2 r3 (cursor c3), then r4 r5 r6 (cursor c6), then r7.
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3'));
    h.pages.set('c3', { comments: [reply('r4'), reply('r5'), reply('r6')], nextCursor: 'c6' });
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r6')).toBeTruthy();

    // The viewer clicks VIEW MORE again; that request (c6) is slow and answers with r7 only.
    let release!: (p: Page) => void;
    h.held.set('c6', new Promise<Page>((res) => (release = res)));
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));

    // Meanwhile the viewer posts a reply r8. The server now has r7 r8 after c6.
    h.pages.set('c6', { comments: [reply('r7'), reply('r8', { isOwn: true })], nextCursor: null });
    fireEvent.click(screen.getAllByText('REPLY')[0]);
    fireEvent.change(screen.getByPlaceholderText(/Reply to/), { target: { value: 'my reply' } });
    const posts = screen.getAllByRole('button', { name: /^POST/ });
    await act(async () => fireEvent.click(posts[posts.length - 1]));
    rerender(ui());
    expect(screen.getByText('body r8')).toBeTruthy();

    // The slow VIEW MORE answer arrives last.
    await act(async () => release({ comments: [reply('r7')], nextCursor: 'c7' }));

    expect(screen.getAllByText('body r7')).toHaveLength(1);
  });
});
