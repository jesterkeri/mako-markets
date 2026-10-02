// A reply deleted elsewhere (a moderator, the author in another tab) disappears from a thread whose "view more" pages
// a reader has already loaded, at the comment list's next refresh (Codex S4 r1 MINOR 3).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { CommentWire } from '@/lib/comments/types';

const m = vi.hoisted(() => ({ fetchMoreReplies: vi.fn() }));
vi.mock('@/lib/use-comments', () => ({ fetchMoreReplies: m.fetchMoreReplies, useComments: vi.fn() }));
vi.mock('wagmi', () => ({ useReadContract: () => ({ data: undefined }) }));
vi.mock('@/lib/admin', () => ({ useIsAdmin: () => false }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));

import { useThread } from '@/components/comments/use-pool-comments';

const reply = (id: string): CommentWire => ({
  id,
  parentId: 'p',
  authorLabel: id,
  avatarSeed: id,
  avatarUrl: null,
  isOwn: false,
  position: null as unknown as CommentWire['position'],
  body: `body ${id}`,
  deleted: false,
  createdAt: '2026-10-02T10:00:00.000Z',
  replies: [],
  repliesNextCursor: null,
});
const parent: CommentWire = { ...reply('p'), parentId: null, replies: [reply('r1')], repliesNextCursor: 'c1' };
const target = { scope: 'main' as const, marketId: '7' };
const ids = (r: CommentWire[]) => r.map((x) => x.id);

afterEach(() => m.fetchMoreReplies.mockReset());

describe('useThread refresh', () => {
  it('drops a loaded reply that the refreshed pages no longer return', async () => {
    m.fetchMoreReplies.mockResolvedValueOnce({ comments: [reply('r2'), reply('r3')], nextCursor: null });
    const { result, rerender } = renderHook(({ at }) => useThread(parent, target, at), { initialProps: { at: 1 } });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(ids(result.current.replies)).toEqual(['r1', 'r2', 'r3']);

    // r2 is deleted elsewhere; the list refreshes.
    m.fetchMoreReplies.mockResolvedValueOnce({ comments: [reply('r3')], nextCursor: null });
    rerender({ at: 2 });
    await waitFor(() => expect(ids(result.current.replies)).toEqual(['r1', 'r3']));
    expect(m.fetchMoreReplies).toHaveBeenLastCalledWith(target, 'p', 'c1');
  });

  it('falls back to the inline replies when the refresh fails, never keeping pages it cannot vouch for', async () => {
    m.fetchMoreReplies.mockResolvedValueOnce({ comments: [reply('r2')], nextCursor: null });
    const { result, rerender } = renderHook(({ at }) => useThread(parent, target, at), { initialProps: { at: 1 } });
    await act(async () => {
      await result.current.loadMore();
    });
    m.fetchMoreReplies.mockRejectedValueOnce(new Error('offline'));
    rerender({ at: 2 });
    await waitFor(() => expect(ids(result.current.replies)).toEqual(['r1']));
  });

  it('a refresh with nothing expanded fetches nothing', async () => {
    const { rerender } = renderHook(({ at }) => useThread(parent, target, at), { initialProps: { at: 1 } });
    rerender({ at: 2 });
    rerender({ at: 3 });
    expect(m.fetchMoreReplies).not.toHaveBeenCalled();
  });
});
