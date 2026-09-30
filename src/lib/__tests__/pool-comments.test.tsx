// The pool page's comments block (9a), both layouts, rendered with the comments hooks, the session and the stake read
// mocked. Covers what the old CommentsSection guaranteed and the redesign must keep: signed out goes to sign-in, a
// post sends the trimmed text (and a reply its parent), delete shows only on your own comment unless you moderate,
// the holder badge, the 2,000-byte limit, bodies as literal text, load more and "view more replies".

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommentWire } from '@/lib/comments/types';
import type { AuthedUser } from '@/lib/use-user';

const h = vi.hoisted(() => ({
  user: null as AuthedUser | null,
  isAdmin: false,
  bet: undefined as readonly [bigint, bigint, boolean] | undefined,
  reads: [] as { functionName?: string; args?: readonly unknown[] }[],
  comments: [] as CommentWire[],
  hasNextPage: false,
  isLoading: false,
  isError: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  postMutate: vi.fn(),
  postError: null as unknown,
  deleteMutate: vi.fn(),
  fetchMoreReplies: vi.fn(),
}));

vi.mock('@/lib/use-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-user')>()),
  useUser: () => ({ user: h.user, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/admin', () => ({ useIsAdmin: () => h.isAdmin }));
vi.mock('wagmi', () => ({
  useReadContract: (cfg: { functionName?: string; args?: readonly unknown[] }) => {
    h.reads.push(cfg);
    return { data: h.bet };
  },
}));
vi.mock('@/lib/use-comments', () => ({
  useComments: () => ({
    data: h.isLoading || h.isError ? undefined : { pages: [{ comments: h.comments, nextCursor: h.hasNextPage ? 'next' : null }] },
    isLoading: h.isLoading,
    isError: h.isError,
    hasNextPage: h.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: h.fetchNextPage,
    refetch: h.refetch,
  }),
  usePostComment: () => ({ mutate: h.postMutate, isPending: false, error: h.postError }),
  useDeleteComment: () => ({ mutate: h.deleteMutate, isPending: false, isError: false }),
  fetchMoreReplies: h.fetchMoreReplies,
}));

const { PoolCommentsDesktop, PoolCommentsMobile } = await import('@/components/comments/PoolComments');
const model = await import('@/components/comments/pool-comments-model');

const SAFE = '0x00000000000000000000000000000000000000A5';

const USER: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'dayo@example.com',
  magicEoa: '0x00000000000000000000000000000000000000e0',
  safeAddress: SAFE,
  displayName: 'dayo',
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

const comment = (over: Partial<CommentWire> = {}): CommentWire => ({
  id: 'c1',
  parentId: null,
  authorLabel: 'Ann',
  avatarSeed: 'abc12345',
  avatarUrl: null,
  isOwn: false,
  position: null,
  body: 'Saka back in the squad changes everything.',
  deleted: false,
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  replies: [],
  repliesNextCursor: null,
  ...over,
});

afterEach(() => {
  cleanup();
  h.user = null;
  h.isAdmin = false;
  h.bet = undefined;
  h.reads = [];
  h.comments = [];
  h.hasNextPage = false;
  h.isLoading = false;
  h.isError = false;
  h.postError = null;
  vi.clearAllMocks();
});

const LAYOUTS = [
  {
    name: 'desktop',
    C: PoolCommentsDesktop,
    placeholder: 'Add a comment. Take a side.',
    signIn: 'SIGN IN',
    post: 'POST',
    reply: 'REPLY',
    del: 'DELETE',
    more: 'LOAD MORE',
    moreReplies: 'VIEW MORE REPLIES',
    retry: 'TRY AGAIN',
  },
  {
    name: 'mobile',
    C: PoolCommentsMobile,
    placeholder: 'Add a comment',
    signIn: 'Sign in',
    post: 'Post',
    reply: 'Reply',
    del: 'Delete',
    more: 'Show more',
    moreReplies: 'View more replies',
    retry: 'Try again',
  },
] as const;

describe.each(LAYOUTS)('PoolComments ($name)', (L) => {
  const renderIt = (onSignIn = vi.fn()) => ({ onSignIn, ...render(<L.C marketId="7" onSignIn={onSignIn} />) });
  const postButtons = () => screen.getAllByRole('button', { name: L.post });

  it('signed out: no composer, and both SIGN IN and REPLY call onSignIn', () => {
    h.comments = [comment()];
    const { onSignIn } = renderIt();
    expect(screen.queryByPlaceholderText(L.placeholder)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: L.signIn }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: L.reply }));
    expect(onSignIn).toHaveBeenCalledTimes(2);
    expect(h.postMutate).not.toHaveBeenCalled();
  });

  it('a post sends the trimmed text, and clears the draft only once the server took it', () => {
    h.user = USER;
    renderIt();
    const box = screen.getByPlaceholderText(L.placeholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  Taking YES at these odds.  ' } });
    fireEvent.click(postButtons()[0]);
    expect(h.postMutate).toHaveBeenCalledTimes(1);
    const [input, opts] = h.postMutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    expect(input).toEqual({ body: 'Taking YES at these odds.' });
    expect(box.value).toBe('  Taking YES at these odds.  ');
    act(() => opts.onSuccess());
    expect(box.value).toBe('');
  });

  it('a reply sends its parent id', () => {
    h.user = USER;
    h.comments = [comment({ id: 'parent-1' })];
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: L.reply }));
    fireEvent.change(screen.getByPlaceholderText('Reply to Ann'), { target: { value: 'Agreed' } });
    const buttons = postButtons();
    fireEvent.click(buttons[buttons.length - 1]);
    expect(h.postMutate.mock.calls[0][0]).toEqual({ body: 'Agreed', parentId: 'parent-1' });
  });

  it('DELETE shows only on your own comment and deletes that one', () => {
    h.user = USER;
    h.comments = [comment({ id: 'mine', isOwn: true, authorLabel: 'dayo' }), comment({ id: 'theirs' })];
    renderIt();
    const del = screen.getAllByRole('button', { name: L.del });
    expect(del).toHaveLength(1);
    fireEvent.click(del[0]);
    expect(h.deleteMutate.mock.calls[0][0]).toBe('mine');
  });

  it('an admin sees DELETE on every live comment', () => {
    h.user = USER;
    h.isAdmin = true;
    h.comments = [comment({ id: 'mine', isOwn: true }), comment({ id: 'theirs' }), comment({ id: 'gone', deleted: true, body: '', replies: [comment({ id: 'r1', parentId: 'gone' })] })];
    renderIt();
    // Two live top-level comments plus the reply under the deleted one; the deleted comment itself has none.
    expect(screen.getAllByRole('button', { name: L.del })).toHaveLength(3);
    expect(screen.getByText('This comment was deleted.')).toBeTruthy();
  });

  it('shows the holder badge for YES, NO and BOTH, and none without a stake', () => {
    h.comments = [
      comment({ id: 'a', authorLabel: 'gunner_ade', position: 'yes' }),
      comment({ id: 'b', authorLabel: 'bluesky', position: 'no' }),
      comment({ id: 'c', authorLabel: 'mina', position: 'both' }),
      comment({ id: 'd', authorLabel: 'lurker', position: null }),
    ];
    renderIt();
    expect(screen.getByText('HOLDS YES')).toBeTruthy();
    expect(screen.getByText('HOLDS NO')).toBeTruthy();
    expect(screen.getByText('HOLDS BOTH')).toBeTruthy();
    expect(screen.getAllByText(/^HOLDS /)).toHaveLength(3);
  });

  it('counts bytes, not characters, and refuses a post past 2,000', () => {
    h.user = USER;
    renderIt();
    const box = screen.getByPlaceholderText(L.placeholder);
    // "é" is two bytes in UTF-8: 1,000 of them is exactly the limit.
    fireEvent.change(box, { target: { value: 'é'.repeat(1000) } });
    expect(screen.getByText('2000/2000')).toBeTruthy();
    expect((postButtons()[0] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(box, { target: { value: `${'é'.repeat(1000)}a` } });
    const counter = screen.getByText('2001/2000');
    expect(counter.style.color).toBe('var(--mako-red)');
    const button = postButtons()[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(h.postMutate).not.toHaveBeenCalled();
  });

  it('shows the reason a post was refused', () => {
    h.user = USER;
    h.postError = Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
    renderIt();
    expect(screen.getByRole('alert').textContent).toBe('Slow down a moment, then try again.');
  });

  it('renders an HTML-looking body as literal text, never an element', () => {
    const payload = '<img src=x onerror="alert(1)">';
    h.comments = [comment({ body: payload })];
    const { container } = renderIt();
    expect(screen.getByText(payload)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the author photo when there is one', () => {
    const photo = 'https://x.public.blob.vercel-storage.com/avatars/u1/a.webp';
    h.comments = [comment({ avatarUrl: photo })];
    const { container } = renderIt();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(photo);
    expect(container.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('empty, error and load more', () => {
    const first = renderIt();
    expect(screen.getByText('No comments yet. Take a side.')).toBeTruthy();
    first.unmount();

    h.isError = true;
    const second = renderIt();
    expect(screen.getByRole('alert').textContent).toContain('Can’t load comments right now.');
    fireEvent.click(screen.getByRole('button', { name: L.retry }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
    second.unmount();

    h.isError = false;
    h.comments = [comment()];
    h.hasNextPage = true;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: L.more }));
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('pages in more replies and then hides the button', async () => {
    h.comments = [comment({ id: 'p', replies: [comment({ id: 'r1', parentId: 'p', body: 'first reply' })], repliesNextCursor: 'cur-1' })];
    h.fetchMoreReplies.mockResolvedValueOnce({ comments: [comment({ id: 'r2', parentId: 'p', body: 'fourth reply' })], nextCursor: null });
    renderIt();
    expect(screen.getByText('first reply')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: L.moreReplies }));
    expect(await screen.findByText('fourth reply')).toBeTruthy();
    expect(h.fetchMoreReplies).toHaveBeenCalledWith({ scope: 'main', marketId: '7' }, 'p', 'cur-1');
    expect(screen.queryByRole('button', { name: L.moreReplies })).toBeNull();
  });
});

describe('PoolComments desktop composer line', () => {
  it('names the account the way the server will, with the side it holds on this pool', () => {
    h.user = USER;
    h.bet = [0n, 5_000_000n, false];
    render(<PoolCommentsDesktop marketId="7" onSignIn={vi.fn()} />);
    expect(screen.getByText('Posting as dayo · holds NO')).toBeTruthy();
    const read = h.reads.find((r) => r.functionName === 'getUserBet');
    expect(read?.args).toEqual([7n, SAFE]);
  });

  it('falls back to the short account address, never the email', () => {
    h.user = { ...USER, displayName: null };
    render(<PoolCommentsDesktop marketId="7" onSignIn={vi.fn()} />);
    expect(screen.getByText('Posting as 0x0000…00a5')).toBeTruthy();
    expect(screen.queryByText(/dayo@example\.com/)).toBeNull();
  });
});

describe('pool comments model', () => {
  it('viewerSide reads the contract stake', () => {
    expect(model.viewerSide(undefined)).toBeNull();
    expect(model.viewerSide([0n, 0n, false])).toBeNull();
    expect(model.viewerSide([1n, 0n, false])).toBe('yes');
    expect(model.viewerSide([0n, 1n, true])).toBe('no');
    expect(model.viewerSide([1n, 1n, false])).toBe('both');
  });

  it('timeAgo says "just now" under a minute and relative time after', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(model.timeAgo('2026-09-30T11:59:30Z', now)).toBe('just now');
    expect(model.timeAgo('2026-09-30T12:00:05Z', now)).toBe('just now');
    expect(model.timeAgo('2026-09-30T11:56:00Z', now)).toBe('4 minutes ago');
    expect(model.timeAgo('not a date', now)).toBe('');
  });

  it('postingAs and the badge copy', () => {
    expect(model.postingAs('dayo', null)).toBe('Posting as dayo');
    expect(model.postingAs('dayo', 'both')).toBe('Posting as dayo · holds BOTH');
    expect(model.SIDE_BADGE.yes.label).toBe('HOLDS YES');
  });

  it('own avatar is yellow; others keep one colour per seed and never yellow', () => {
    expect(model.avatarColour('abc', true)).toBe('var(--mako-signal)');
    expect(model.avatarColour('abc', false)).toBe(model.avatarColour('abc', false));
    for (const seed of ['0', 'ff', 'abcdef12', 'zz9']) expect(model.avatarColour(seed, false)).not.toBe('var(--mako-signal)');
  });

  it('draftBytes trims before counting', () => {
    expect(model.draftBytes('   ')).toEqual({ bytes: 0, tooLong: false, empty: true });
    expect(model.draftBytes(' ab ')).toEqual({ bytes: 2, tooLong: false, empty: false });
  });
});
