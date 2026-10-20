// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/adversary-replies-first-page-race.test.tsx  (#193 adversary r3)
//
// The FIRST VIEW MORE of a thread is still in flight when the viewer's own
// reply posts. The server answered that page before the reply was written, so
// it ends at the old last reply with no cursor. The post re-reads only when a
// list is already stored, and none is yet; the late page is then stored as the
// end of the thread. The viewer's reply lies past the window and the list
// query's window and cursor do not change, so nothing shows it and no VIEW
// MORE leads to it (spec #193 (c), (d)). This is not the stated exception,
// which is another user's reply arriving after the thread was expanded to its
// end.
//
// The data hooks are mocked the way adversary-replies-reload-order.test.tsx does.
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

describe('#193 adversary r3: the first VIEW MORE in flight when the viewer replies', () => {
  it("the viewer's own reply stays reachable when the first page lands after the post", async () => {
    // Server: window r1 r2 r3 (cursor c3), then r4. The viewer clicks VIEW MORE; the c3 page is slow and
    // was answered before the reply below was written: r4, no cursor.
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3'));
    let release!: (p: Page) => void;
    h.held.set('c3', new Promise<Page>((res) => (release = res)));
    const { rerender } = render(ui());
    await act(async () => fireEvent.click(screen.getByText('VIEW MORE REPLIES')));
    expect(h.calls).toEqual(['c3']);

    // The viewer posts r5 while that page is in flight. The server now holds r4 r5 past the window; the
    // refetched list keeps the same window and cursor (r5 lies past r3).
    h.pages.set('c3', { comments: [reply('r4'), reply('r5', { isOwn: true })], nextCursor: null });
    await postReply('mine');
    setThread(thread([reply('r1'), reply('r2'), reply('r3')], 'c3'));
    rerender(ui());

    // The slow first page lands with what the server held before the post.
    await act(async () => release({ comments: [reply('r4')], nextCursor: null }));
    rerender(ui()); // a later poll: same window, same cursor

    const reachable = screen.queryByText('body r5') !== null || screen.queryByText('VIEW MORE REPLIES') !== null;
    expect(reachable).toBe(true);
  });
});
