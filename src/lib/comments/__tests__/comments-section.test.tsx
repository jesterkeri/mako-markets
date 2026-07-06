// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/comments-section.test.tsx
//
// DOM tests for CommentsSection. The load-bearing one is XSS: a body that looks
// like HTML must render as LITERAL TEXT (React escaping), never a parsed
// element. The data hooks are mocked so this stays a pure render test.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { CommentWire } from '@/lib/comments/types';

const h = vi.hoisted(() => ({
  user: null as { authType: string } | null,
  comments: {
    data: { pages: [{ comments: [] as CommentWire[], nextCursor: null }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  },
}));

vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: h.user }) }));
vi.mock('@/lib/admin', () => ({ useIsAdmin: () => false }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/use-comments', () => ({
  useComments: () => h.comments,
  usePostComment: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteComment: () => ({ mutate: vi.fn(), isPending: false }),
  fetchMoreReplies: vi.fn(),
  commentsQueryKey: () => ['comments'],
}));

const { CommentsSection } = await import('@/components/CommentsSection');

const comment = (over: Partial<CommentWire> = {}): CommentWire => ({
  id: 'c1',
  parentId: null,
  authorLabel: 'Ann',
  avatarSeed: 'abc12345',
  isOwn: false,
  position: null,
  body: 'hello world',
  deleted: false,
  createdAt: new Date('2026-07-04T12:00:00Z').toISOString(),
  replies: [],
  repliesNextCursor: null,
  ...over,
});

function setComments(list: CommentWire[]) {
  h.comments = { ...h.comments, data: { pages: [{ comments: list, nextCursor: null }] } };
}

afterEach(() => {
  cleanup();
  h.user = null;
  setComments([]);
});

describe('CommentsSection XSS guard', () => {
  it('renders an HTML-looking body as literal text, never a parsed element', () => {
    const payload = '<img src=x onerror="alert(1)">';
    setComments([comment({ body: payload })]);
    const { container } = render(<CommentsSection scope="main" marketId="5" />);
    // The literal string is present as text…
    expect(screen.getByText(payload)).toBeTruthy();
    // …and NO <img> element was created (glyph avatar has none either).
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
  });
});

describe('CommentsSection rendering', () => {
  it('shows the SIGN IN cta when signed out and the composer when signed in', () => {
    h.user = null;
    setComments([]);
    const { rerender } = render(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByText('SIGN IN')).toBeTruthy();

    h.user = { authType: 'magic' };
    rerender(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByPlaceholderText(/Add a comment/i)).toBeTruthy();
  });

  it('renders the author label + position badge', () => {
    setComments([comment({ authorLabel: 'Ann', position: 'yes' })]);
    render(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByText('Ann')).toBeTruthy();
    expect(screen.getByText('HOLDS YES')).toBeTruthy();
  });

  it('shows [deleted] and not the original body for a deleted comment', () => {
    setComments([comment({ deleted: true, body: '' })]);
    render(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByText('[deleted]')).toBeTruthy();
  });

  it('shows the empty state when there are no comments', () => {
    setComments([]);
    h.user = null;
    render(<CommentsSection scope="main" marketId="5" />);
    expect(screen.getByText(/No comments yet/i)).toBeTruthy();
  });
});
