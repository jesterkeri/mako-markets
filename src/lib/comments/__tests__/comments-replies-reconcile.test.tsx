// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/comments-replies-reconcile.test.tsx  (#193)
//
// Replies past a thread's first window ("view more") live in the thread's own
// state, not in the list query, so they must be reconciled by hand: the "view
// more" cursor follows the latest server data until the thread is expanded, a
// deleted reply leaves the expanded list, and the viewer's own reply appears in
// an expanded thread. The data hooks are mocked; mutations succeed at once.
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

function setPage(cursor: string, page: Page) {
  h.pages.set(cursor, page);
}

const WINDOW = [reply('r1'), reply('r2'), reply('r3')];

afterEach(() => {
  cleanup();
  h.pages.clear();
  h.calls = [];
});

describe('#193 replies past the first window', () => {
  it('a 4th reply posted after the page loaded shows VIEW MORE once the server sends a cursor', () => {
    setThread(thread(WINDOW, null));
    const { rerender } = render(<CommentsSection scope="main" marketId="5" />);
    expect(screen.queryByText('VIEW MORE REPLIES')).toBeNull();

    // The list query refetched after the post: the window now has a cursor.
    setThread(thread(WINDOW, 'c3'));
    rerender(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByText('VIEW MORE REPLIES')).toBeTruthy();
  });

  it('a reply deleted from the expanded list leaves it at once', async () => {
    setThread(thread(WINDOW, 'c3'));
    setPage('c3', { comments: [reply('r4', { isOwn: true })], nextCursor: null });
    render(<CommentsSection scope="main" marketId="5" />);

    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r4')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByText('DELETE')));
    expect(screen.queryByText('body r4')).toBeNull();
  });

  it("the viewer's own reply appears in a thread already expanded to its end", async () => {
    setThread(thread(WINDOW, 'c3'));
    setPage('c3', { comments: [reply('r4')], nextCursor: null });
    render(<CommentsSection scope="main" marketId="5" />);
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.getByText('body r4')).toBeTruthy();
    expect(screen.queryByText('VIEW MORE REPLIES')).toBeNull();

    // The viewer replies; the server now holds r4 and r5 past the window.
    setPage('c3', { comments: [reply('r4'), reply('r5', { isOwn: true })], nextCursor: null });
    fireEvent.click(screen.getAllByText('REPLY')[0]);
    fireEvent.change(screen.getByPlaceholderText(/Reply to/), { target: { value: 'my reply' } });
    const posts = screen.getAllByRole('button', { name: /^POST/ });
    await act(async () => fireEvent.click(posts[posts.length - 1])); // the reply box's, after the page's own composer

    expect(screen.getByText('body r5')).toBeTruthy();
    expect(screen.getAllByText('body r4')).toHaveLength(1);
    expect(h.calls).toEqual(['c3', 'c3']);
  });

  it('a failed re-read after posting falls back to the window and its VIEW MORE, so the new reply stays reachable', async () => {
    setThread(thread(WINDOW, 'c3'));
    setPage('c3', { comments: [reply('r4')], nextCursor: null });
    render(<CommentsSection scope="main" marketId="5" />);
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(screen.queryByText('VIEW MORE REPLIES')).toBeNull();

    h.pages.delete('c3'); // the re-read fails
    fireEvent.click(screen.getAllByText('REPLY')[0]);
    fireEvent.change(screen.getByPlaceholderText(/Reply to/), { target: { value: 'my reply' } });
    const posts = screen.getAllByRole('button', { name: /^POST/ });
    await act(async () => fireEvent.click(posts[posts.length - 1]));

    expect(screen.queryByText('body r4')).toBeNull();
    expect(screen.getByText('VIEW MORE REPLIES')).toBeTruthy();
  });
});
