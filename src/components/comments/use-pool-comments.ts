'use client';

// Data for the pool page's comments block (9a). Everything goes through the existing comments layer
// (`@/lib/use-comments`: the polled infinite list, post, delete, reply pages); nothing here talks to the API itself.
// The one extra read is the viewer's own stake on this pool, for "Posting as … · holds YES", taken from the contract
// with the same query the pool page already runs, so wagmi serves both from one request.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContract } from 'wagmi';

import { useIsAdmin } from '@/lib/admin';
import type { CommentPosition, CommentWire } from '@/lib/comments/types';
import { makoContract } from '@/lib/contract';
import { fetchMoreReplies, useComments, type CommentTargetParams } from '@/lib/use-comments';
import { useNowSec } from '@/lib/use-now';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';

import { initialOf, viewerLabel, viewerSide } from './pool-comments-model';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/// A canonical uint256 string as a bigint, else null (the page passes `market.id.toString()`, so null means a bug,
/// and the stake read is simply skipped).
function marketIdOf(s: string): bigint | null {
  return /^(0|[1-9][0-9]{0,77})$/.test(s) ? BigInt(s) : null;
}

function useViewerSide(marketId: string, user: AuthedUser | null): CommentPosition {
  const id = marketIdOf(marketId);
  const account = user ? accountAddress(user) : null;
  // Same shape as PoolClient's getUserBet read, so the two share one wagmi query.
  const q = useReadContract({
    ...makoContract,
    functionName: 'getUserBet',
    args: [id ?? 0n, account ?? ZERO],
    query: { enabled: account !== null && id !== null, refetchInterval: 10_000 },
  });
  return account !== null && id !== null ? viewerSide(q.data) : null;
}

/// Who is looking. `loading` and `error` are kept apart from `out`: a failed session check must not be shown as
/// "signed out" (see use-user.ts).
export type Viewer =
  | { kind: 'loading' }
  | { kind: 'error'; retry: () => void }
  | { kind: 'out' }
  | { kind: 'in'; label: string; initial: string; avatarUrl: string | null; side: CommentPosition };

export function usePoolComments(marketId: string) {
  const target = useMemo<CommentTargetParams>(() => ({ scope: 'main', marketId }), [marketId]);
  const u = useUser();
  const side = useViewerSide(marketId, u.user);
  const isAdmin = useIsAdmin();
  const query = useComments(target);
  const nowMs = useNowSec(30_000) * 1000;

  let viewer: Viewer;
  if (u.user) {
    const label = viewerLabel(u.user);
    viewer = { kind: 'in', label, initial: initialOf(label), avatarUrl: u.user.avatarUrl, side };
  } else if (u.isLoading) {
    viewer = { kind: 'loading' };
  } else if (u.isError) {
    viewer = { kind: 'error', retry: () => void u.refetch() };
  } else {
    viewer = { kind: 'out' };
  }

  const comments = query.data?.pages.flatMap((p) => p.comments) ?? [];
  return { target, viewer, isAdmin, query, comments, nowMs };
}

/// One top-level comment's replies: the first few come inline with the comment; "view more" pages the rest into
/// local state. Two fixes over the old component (#193): the next cursor follows the comment itself until a page has
/// been loaded, so a reply that pushes a thread past the inline window becomes reachable at once, and posting or
/// deleting a reply reconciles the locally held pages instead of leaving them stale until a remount. And every time
/// the comment list refreshes (`refreshedAt`), the pages already loaded are fetched again from the start, so a reply
/// deleted by someone else (a moderator, the author in another tab) disappears; if that fetch fails the thread falls
/// back to its inline replies rather than keep showing pages it can no longer vouch for (Codex S4 r1).
export function useThread(comment: CommentWire, target: CommentTargetParams, refreshedAt = 0) {
  const [extra, setExtra] = useState<{ replies: CommentWire[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  /// How many "view more" pages are held, so a refresh can fetch the same span again.
  const pagesLoaded = useRef(0);
  const latest = useRef({ comment, target });
  latest.current = { comment, target };

  useEffect(() => {
    if (!refreshedAt || pagesLoaded.current === 0) return;
    let cancelled = false;
    const { comment: c, target: t } = latest.current;
    void (async () => {
      const replies: CommentWire[] = [];
      let next = c.repliesNextCursor;
      let pages = 0;
      try {
        while (pages < pagesLoaded.current && next) {
          const page = await fetchMoreReplies(t, c.id, next);
          replies.push(...page.comments);
          next = page.nextCursor;
          pages += 1;
        }
        if (cancelled) return;
        pagesLoaded.current = pages;
        setExtra(pages === 0 ? null : { replies, cursor: next });
      } catch {
        if (cancelled) return;
        pagesLoaded.current = 0;
        setExtra(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshedAt]);

  // A delete shifts the inline window, so a loaded reply can come back inline too: show each id once.
  const inline = new Set(comment.replies.map((r) => r.id));
  const replies = extra ? [...comment.replies, ...extra.replies.filter((r) => !inline.has(r.id))] : comment.replies;
  const cursor = extra ? extra.cursor : comment.repliesNextCursor;

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const page = await fetchMoreReplies(target, comment.id, cursor);
      setExtra((prev) => ({ replies: [...(prev?.replies ?? []), ...page.comments], cursor: page.nextCursor }));
      pagesLoaded.current += 1;
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return {
    replies,
    cursor,
    loading,
    loadFailed,
    loadMore,
    /// A new reply lands at the end of the thread: drop the local pages so the refreshed comment (inline replies
    /// plus its own cursor) leads to it.
    onReplyPosted: () => {
      pagesLoaded.current = 0;
      setExtra(null);
    },
    /// The server drops a deleted reply from every reply page; drop it from the local pages as well.
    onReplyDeleted: (id: string) => setExtra((prev) => (prev ? { ...prev, replies: prev.replies.filter((r) => r.id !== id) } : prev)),
  };
}
