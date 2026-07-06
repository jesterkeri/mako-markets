'use client';

// ----------------------------------------------------------------------------
// src/lib/use-comments.ts
//
// TanStack hooks over /api/comments. The list is an infinite query (keyset
// pagination) that polls every 30s so comments feel live without websockets.
// Post + delete invalidate the list (optimistic-free — the plan's choice; the
// refetch shows the server's canonical assembly incl. position badges).
//
// Wire types come from the browser-safe @/lib/comments/types (no server-only
// imports), so this stays client-safe.
// ----------------------------------------------------------------------------

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import type { CommentsPage, CommentScope } from '@/lib/comments/types';

const REFETCH_MS = 30_000;

export interface CommentTargetParams {
  scope: CommentScope;
  marketId?: string;
  slug?: string;
}

function targetParams(t: CommentTargetParams): URLSearchParams {
  const p = new URLSearchParams({ scope: t.scope });
  if (t.scope === 'main' && t.marketId) p.set('marketId', t.marketId);
  if (t.scope === 'pm' && t.slug) p.set('slug', t.slug);
  return p;
}

function targetBody(t: CommentTargetParams): Record<string, string> {
  return t.scope === 'main'
    ? { scope: 'main', marketId: t.marketId ?? '' }
    : { scope: 'pm', slug: t.slug ?? '' };
}

export function commentsQueryKey(t: CommentTargetParams): string[] {
  return ['comments', t.scope === 'main' ? `main:${t.marketId}` : `pm:${t.slug}`];
}

export function useComments(t: CommentTargetParams, enabled = true) {
  return useInfiniteQuery<CommentsPage>({
    queryKey: commentsQueryKey(t),
    queryFn: async ({ pageParam }) => {
      const p = targetParams(t);
      if (pageParam) p.set('cursor', pageParam as string);
      const res = await fetch(`/api/comments?${p.toString()}`);
      if (!res.ok) throw new Error(`comments fetch failed: ${res.status}`);
      return (await res.json()) as CommentsPage;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: REFETCH_MS,
    enabled,
  });
}

export interface PostCommentError extends Error {
  code?: string;
  status?: number;
}

export function usePostComment(t: CommentTargetParams) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; parentId?: string }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...targetBody(t),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          body: input.body,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        const e: PostCommentError = new Error(err.error ?? `post failed: ${res.status}`);
        e.code = err.error;
        e.status = res.status;
        throw e;
      }
      return (await res.json()) as { ok: true; id: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsQueryKey(t) }),
  });
}

export function useDeleteComment(t: CommentTargetParams) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/comments/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      return (await res.json()) as { ok: true };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsQueryKey(t) }),
  });
}

/// Imperative "load more replies" for one parent — the component holds the
/// appended replies in local state (per-parent), keeping the infinite-query
/// state limited to the top-level list.
export async function fetchMoreReplies(
  t: CommentTargetParams,
  parentId: string,
  cursor: string | null,
): Promise<CommentsPage> {
  const p = targetParams(t);
  p.set('parentId', parentId);
  if (cursor) p.set('cursor', cursor);
  const res = await fetch(`/api/comments?${p.toString()}`);
  if (!res.ok) throw new Error(`replies fetch failed: ${res.status}`);
  return (await res.json()) as CommentsPage;
}
