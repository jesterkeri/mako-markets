'use client';

// ----------------------------------------------------------------------------
// src/components/CommentsSection.tsx  (#182)
//
// Comment thread for a market (main or PM). Reads are public; the composer
// shows a SIGN IN CTA when signed out. Body + author label render as REACT
// TEXT NODES only — no dangerouslySetInnerHTML, no markdown, no URL
// auto-linkification (plan §6 MUST-1: the #1 comments XSS vector). Avatars are
// glyph-only (avatarSeed, no <img>). Brand tokens only → correct in both themes.
// ----------------------------------------------------------------------------

import { formatDistanceToNowStrict } from 'date-fns';
import { useState } from 'react';
import Link from 'next/link';

import { AvatarCircle } from '@/components/AvatarCircle';
import { useIsAdmin } from '@/lib/admin';
import { BODY_MAX_BYTES, type CommentPosition, type CommentWire } from '@/lib/comments/types';
import { bodyByteLength } from '@/lib/comments/validate';
import { useUser } from '@/lib/use-user';
import {
  fetchMoreReplies,
  useComments,
  useDeleteComment,
  usePostComment,
  type CommentTargetParams,
  type PostCommentError,
} from '@/lib/use-comments';

const POST_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Slow down a moment, then try again.',
  comments_disabled: 'Comments are turned off for this market.',
  market_not_found: 'This market could not be found.',
  market_check_unavailable: "Couldn't reach the chain. Try again shortly.",
  parent_deleted: 'That comment was deleted.',
  parent_not_top_level: 'You can only reply to a top-level comment.',
  unauthorized: 'Sign in to comment.',
};

function postErrorCopy(e: unknown): string {
  const code = (e as PostCommentError)?.code;
  return (code && POST_ERROR_COPY[code]) || 'Could not post. Try again.';
}

function BadgeChip({ position }: { position: CommentPosition }) {
  if (!position) return null;
  const map: Record<'yes' | 'no' | 'both', { label: string; cls: string }> = {
    yes: { label: 'HOLDS YES', cls: 'bg-signal text-ink' },
    no: { label: 'HOLDS NO', cls: 'bg-mako-red text-paper' },
    both: { label: 'HOLDS BOTH', cls: 'bg-ink text-paper' },
  };
  const b = map[position];
  return (
    <span className={`mako-label text-[9px] px-2 py-0.5 rounded-full border-2 border-ink ${b.cls}`}>
      {b.label}
    </span>
  );
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

// ---- Composer ---------------------------------------------------------------

function Composer({
  onSubmit,
  pending,
  error,
  placeholder,
  autoFocus,
  compact,
}: {
  onSubmit: (body: string) => void;
  pending: boolean;
  error: unknown;
  placeholder: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const bytes = bodyByteLength(text.trim());
  const tooLong = bytes > BODY_MAX_BYTES;
  const canSubmit = bytes > 0 && !tooLong && !pending;

  function submit() {
    if (!canSubmit) return;
    onSubmit(text.trim());
    setText('');
  }

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-2 mb-6'}>
      <textarea
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        className="w-full resize-y bg-paper text-ink border-2 border-ink rounded-xl px-4 py-3 mako-body text-[15px] placeholder:text-muted focus:outline-none focus:shadow-[4px_4px_0_0_var(--mako-ink)] transition-shadow"
      />
      <div className="flex items-center justify-between gap-3">
        <span className={`mako-mono text-[11px] ${tooLong ? 'text-mako-red' : 'text-muted'}`}>
          {bytes}/{BODY_MAX_BYTES}
        </span>
        <div className="flex items-center gap-3">
          {error ? <span className="mako-mono text-[11px] text-mako-red">{postErrorCopy(error)}</span> : null}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="mako-button mako-button--signal mako-label px-4! py-2! text-[11px]! disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'POSTING…' : 'POST'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- One comment (row for both top-level and reply) -------------------------

function Row({
  comment,
  target,
  canModerate,
  viewerCanReply,
  onReply,
  isReply,
}: {
  comment: CommentWire;
  target: CommentTargetParams;
  canModerate: boolean;
  viewerCanReply: boolean;
  onReply?: () => void;
  isReply?: boolean;
}) {
  const del = useDeleteComment(target);
  const showDelete = !comment.deleted && (comment.isOwn || canModerate);

  return (
    <div className={`flex gap-3 ${isReply ? 'mt-3' : ''}`}>
      <AvatarCircle
        displayName={comment.deleted ? null : comment.authorLabel}
        initialSource={comment.authorLabel}
        seedKey={comment.avatarSeed}
        avatarUrl={null}
        size={isReply ? 30 : 36}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mako-label text-[12px] text-ink truncate max-w-[40vw]">
            {comment.deleted ? '—' : comment.authorLabel}
          </span>
          {!comment.deleted && <BadgeChip position={comment.position} />}
          <span className="mako-mono text-[10px] text-muted">{timeAgo(comment.createdAt)}</span>
        </div>
        {/* body: plain text node, escaped by React — never HTML/markdown */}
        <p className={`mako-body text-[15px] mt-1 whitespace-pre-wrap break-words ${comment.deleted ? 'text-muted italic' : 'text-ink'}`}>
          {comment.deleted ? '[deleted]' : comment.body}
        </p>
        <div className="flex items-center gap-3 mt-1">
          {!comment.deleted && viewerCanReply && onReply && (
            <button type="button" onClick={onReply} className="mako-label text-[10px] text-muted hover:text-ink transition-colors">
              REPLY
            </button>
          )}
          {showDelete && (
            <button
              type="button"
              onClick={() => del.mutate(comment.id)}
              disabled={del.isPending}
              className="mako-label text-[10px] text-muted hover:text-mako-red transition-colors disabled:opacity-40"
            >
              {del.isPending ? 'DELETING…' : 'DELETE'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Top-level comment + its replies ----------------------------------------

function CommentThread({
  comment,
  target,
  signedIn,
  canModerate,
  writable,
}: {
  comment: CommentWire;
  target: CommentTargetParams;
  signedIn: boolean;
  canModerate: boolean;
  writable: boolean;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [extraReplies, setExtraReplies] = useState<CommentWire[]>([]);
  const [replyCursor, setReplyCursor] = useState<string | null>(comment.repliesNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const post = usePostComment(target);

  const replies = [...comment.replies, ...extraReplies];

  async function loadMoreReplies() {
    if (!replyCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchMoreReplies(target, comment.id, replyCursor);
      setExtraReplies((prev) => [...prev, ...page.comments]);
      setReplyCursor(page.nextCursor);
    } catch {
      /* leave the button; a later poll refresh will reconcile */
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="bg-paper border-2 border-ink rounded-2xl p-4 shadow-[3px_3px_0_0_var(--mako-ink)]">
      <Row
        comment={comment}
        target={target}
        canModerate={canModerate}
        viewerCanReply={signedIn && writable}
        onReply={() => setReplyOpen((v) => !v)}
      />

      {replyOpen && signedIn && writable && (
        <div className="ml-9 mt-3">
          <Composer
            compact
            autoFocus
            pending={post.isPending}
            error={post.error}
            placeholder={`Reply to ${comment.deleted ? 'this thread' : comment.authorLabel}…`}
            onSubmit={(body) =>
              post.mutate({ body, parentId: comment.id }, { onSuccess: () => setReplyOpen(false) })
            }
          />
        </div>
      )}

      {replies.length > 0 && (
        <div className="ml-9 mt-2 border-l-2 border-ink/15 pl-4">
          {replies.map((r) => (
            <Row key={r.id} comment={r} target={target} canModerate={canModerate} viewerCanReply={false} isReply />
          ))}
          {replyCursor && (
            <button
              type="button"
              onClick={loadMoreReplies}
              disabled={loadingMore}
              className="mako-label text-[10px] text-muted hover:text-ink transition-colors mt-3 disabled:opacity-40"
            >
              {loadingMore ? 'LOADING…' : 'VIEW MORE REPLIES'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Section ----------------------------------------------------------------

export function CommentsSection(
  props: ({ scope: 'main'; marketId: string } | { scope: 'pm'; slug: string }) & {
    /// #182 Slice B: when false (PM markets with comments turned off) the
    /// composer + reply boxes are hidden and a muted note is shown —
    /// existing comments still READ (comments_enabled blocks writes only).
    /// Defaults true, so main markets are unchanged.
    writable?: boolean;
  },
) {
  const target: CommentTargetParams =
    props.scope === 'main'
      ? { scope: 'main', marketId: props.marketId }
      : { scope: 'pm', slug: props.slug };
  const writable = props.writable ?? true;

  const { user } = useUser();
  const signedIn = user !== null;
  const isAdmin = useIsAdmin();
  const post = usePostComment(target);
  const query = useComments(target);

  const comments = query.data?.pages.flatMap((p) => p.comments) ?? [];

  return (
    <section aria-label="Comments" className="w-full mt-4">
      <h2 className="mako-display text-[clamp(1.5rem,3vw,2rem)] text-canvas-fg mb-4">COMMENTS</h2>

      {!writable ? (
        <div className="bg-paper border-2 border-ink rounded-2xl p-5 mb-6">
          <span className="mako-body text-[15px] text-muted">
            Comments are turned off for this market.
          </span>
        </div>
      ) : signedIn ? (
        <Composer
          pending={post.isPending}
          error={post.error}
          placeholder="Add a comment. Take a side."
          onSubmit={(body) => post.mutate({ body })}
        />
      ) : (
        <div className="bg-paper border-2 border-ink rounded-2xl p-5 mb-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="mako-body text-[15px] text-muted">Sign in to join the conversation.</span>
          <Link href="/signup" className="mako-button mako-button--signal mako-label px-4! py-2! text-[11px]!">
            SIGN IN
          </Link>
        </div>
      )}

      {query.isLoading ? (
        <div className="mako-skeleton h-24 rounded-2xl" aria-hidden />
      ) : query.isError ? (
        <p className="mako-body text-muted">Could not load comments.</p>
      ) : comments.length === 0 ? (
        <p className="mako-body text-muted py-6 text-center">No comments yet. Take a side.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {comments.map((c) => (
            <CommentThread
              key={c.id}
              comment={c}
              target={target}
              signedIn={signedIn}
              canModerate={isAdmin}
              writable={writable}
            />
          ))}
          {query.hasNextPage && (
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="mako-button mako-label self-center px-5! py-2! text-[11px]! disabled:opacity-40"
            >
              {query.isFetchingNextPage ? 'LOADING…' : 'LOAD MORE'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
