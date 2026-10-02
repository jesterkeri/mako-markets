'use client';

// The pool page's comments block (9a), desktop and mobile. Each export renders the whole block, container
// included: desktop is a hairline-topped section in the terminal look, mobile a raised card with speech-bubble
// comments. Both read the same comments layer as the old CommentsSection (polled list, post, reply, delete, admin
// delete, load more) and keep its safety rules: bodies and names render as React text only, never HTML, and a photo
// avatar is a plain <img> with no referrer that falls back to a letter.
//
// The API returns no total count, so the design's count beside "Comments" is left out rather than guessed.

import { useState } from 'react';

import type { CommentPosition, CommentWire } from '@/lib/comments/types';
import { useDeleteComment, usePostComment, type CommentTargetParams } from '@/lib/use-comments';

import {
  avatarColour,
  counterText,
  draftBytes,
  initialOf,
  OWN_AVATAR_COLOUR,
  postErrorCopy,
  postingAs,
  SIDE_BADGE,
  timeAgo,
} from './pool-comments-model';
import { usePoolComments, useThread, type Viewer } from './use-pool-comments';

type Props = {
  marketId: string;
  /// Opens the page's sign-in dialog. The signed-out block calls it rather than linking anywhere.
  onSignIn: () => void;
  /// False when the market has comments turned off: the list still reads, the composer and replies go. Pools always
  /// allow comments today, so it defaults to true.
  writable?: boolean;
};

/// What every row needs from the block around it.
type Ctx = {
  target: CommentTargetParams;
  viewer: Viewer;
  canModerate: boolean;
  writable: boolean;
  nowMs: number;
  onSignIn: () => void;
  /// When the comment list last refreshed: expanded reply pages re-fetch then, so a reply deleted elsewhere goes.
  refreshedAt: number;
};

const MONO: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const DISPLAY: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
const RED = 'var(--mako-red)';
const DELETED_TEXT = 'This comment was deleted.';

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces

function Avatar({ url, initial, colour, size, fontSize }: { url: string | null; initial: string; colour: string; size: number; fontSize: number }) {
  // Remember which URL failed, so a new URL gets a fresh try without an effect.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const box: React.CSSProperties = { flex: 'none', width: size, height: size, borderRadius: 9999 };
  if (url && failedUrl !== url) {
    return (
      <span aria-hidden="true" style={{ ...box, position: 'relative', overflow: 'hidden', display: 'block' }}>
        {/* A plain <img>, as in AvatarCircle: avatars are single-origin Vercel Blob URLs and next/image buys nothing at 36px. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <span style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', boxShadow: 'var(--edge)' }} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" style={{ ...box, background: colour, color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...DISPLAY, fontSize }}>
      {initial}
    </span>
  );
}

/// A deleted comment hides who wrote it: a blank disc, no photo.
function CommentAvatar({ c, size, fontSize }: { c: CommentWire; size: number; fontSize: number }) {
  if (c.deleted) return <Avatar url={null} initial="" colour="var(--raise2)" size={size} fontSize={fontSize} />;
  return <Avatar url={c.avatarUrl} initial={initialOf(c.authorLabel)} colour={avatarColour(c.avatarSeed, c.isOwn)} size={size} fontSize={fontSize} />;
}

function Badge({ position, mobile }: { position: CommentPosition; mobile?: boolean }) {
  if (!position) return null;
  const b = SIDE_BADGE[position];
  const style: React.CSSProperties = mobile
    ? { height: 20, padding: '0 8px', fontSize: 10, fontWeight: 800 }
    : { height: 18, padding: '0 7px', fontSize: 9, fontWeight: 700, boxShadow: 'var(--edge)' };
  return <span style={{ flex: 'none', display: 'flex', alignItems: 'center', borderRadius: 9999, background: b.bg, color: '#000', whiteSpace: 'nowrap', ...style }}>{b.label}</span>;
}

const nameStyle: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/// Body text: a React text node (escaped), line breaks kept, long words wrapped.
function Body({ c, style }: { c: CommentWire; style: React.CSSProperties }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...style, ...(c.deleted ? { color: 'var(--dim)', fontStyle: 'italic' } : null) }}>
      {c.deleted ? DELETED_TEXT : c.body}
    </div>
  );
}

function useRowDelete(c: CommentWire, ctx: Ctx, onDeleted?: (id: string) => void) {
  const del = useDeleteComment(ctx.target);
  return {
    canDelete: !c.deleted && (c.isOwn || ctx.canModerate),
    remove: () => del.mutate(c.id, { onSuccess: () => onDeleted?.(c.id) }),
    pending: del.isPending,
    failed: del.isError,
  };
}

/// Reply is offered on live top-level comments once the session is known. Signed out, it opens sign-in.
function canReplyTo(c: CommentWire, ctx: Ctx): boolean {
  return !c.deleted && ctx.writable && (ctx.viewer.kind === 'in' || ctx.viewer.kind === 'out');
}

/// The draft behind a composer: text, its byte count against the limit, and a post that clears it only once the
/// server has taken it (a refused post keeps what was typed).
function useDraft(target: CommentTargetParams, parentId: string | undefined, onPosted: (() => void) | undefined) {
  const post = usePostComment(target);
  const [text, setText] = useState('');
  const { bytes, tooLong, empty } = draftBytes(text);
  const ready = !empty && !tooLong;
  const canPost = ready && !post.isPending;
  const submit = () => {
    if (!canPost) return;
    const body = text.trim();
    post.mutate(parentId ? { body, parentId } : { body }, {
      onSuccess: () => {
        setText('');
        onPosted?.();
      },
    });
  };
  return { text, setText, bytes, tooLong, canPost, pending: post.isPending, error: post.error as unknown, submit };
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop

export function PoolCommentsDesktop({ marketId, onSignIn, writable = true }: Props) {
  const { target, viewer, isAdmin, query, comments, nowMs } = usePoolComments(marketId);
  const ctx: Ctx = { target, viewer, canModerate: isAdmin, writable, nowMs, onSignIn, refreshedAt: query.dataUpdatedAt };
  const pill: React.CSSProperties = { flex: 'none', height: 34, padding: '0 16px', borderRadius: 9999, ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em' };
  const note: React.CSSProperties = { flex: 1, fontSize: 14, lineHeight: 1.45, color: 'var(--dim)' };

  return (
    <section aria-label="Comments" style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '0 4px' }}>
        <h2 style={{ margin: 0, ...DISPLAY, fontSize: 24, letterSpacing: '-0.02em' }}>Comments</h2>
      </div>

      {!writable ? (
        <div style={{ marginTop: 14, padding: '0 4px', ...note }}>Comments are turned off for this market.</div>
      ) : viewer.kind === 'in' ? (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 14, padding: '0 4px' }}>
          <Avatar url={viewer.avatarUrl} initial={viewer.initial} colour={OWN_AVATAR_COLOUR} size={32} fontSize={13} />
          <ComposerDesktop target={target} placeholder="Add a comment. Take a side." meta={postingAs(viewer.label, viewer.side)} />
        </div>
      ) : viewer.kind === 'out' ? (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, padding: '0 4px' }}>
          <span style={note}>Sign in to join the conversation.</span>
          <button type="button" onClick={onSignIn} className="mk-press97" style={{ ...pill, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
            SIGN IN
          </button>
        </div>
      ) : viewer.kind === 'error' ? (
        <div role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, padding: '0 4px' }}>
          <span style={note}>Can’t check your sign-in right now.</span>
          <button type="button" onClick={viewer.retry} className="mk-press97" style={{ ...pill, background: 'var(--raise2)' }}>
            TRY AGAIN
          </button>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        {query.isLoading ? (
          <div aria-busy="true" aria-label="Loading comments">
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '14px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
                <span style={{ flex: 'none', width: 32, height: 32, borderRadius: 9999, background: BAR }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
                  <div style={{ width: '28%', height: 11, borderRadius: 8, background: BAR }} />
                  <div style={{ width: '76%', height: 14, borderRadius: 8, background: BAR }} />
                </div>
              </div>
            ))}
          </div>
        ) : !query.data && query.isError ? (
          <div role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <span style={note}>Can’t load comments right now.</span>
            <button type="button" onClick={() => void query.refetch()} className="mk-press97" style={{ ...pill, background: 'var(--raise2)' }}>
              TRY AGAIN
            </button>
          </div>
        ) : comments.length === 0 ? (
          <div style={{ padding: '18px 4px', boxShadow: 'inset 0 1px 0 var(--line)', fontSize: 14, color: 'var(--dim)' }}>No comments yet. Take a side.</div>
        ) : (
          <>
            {comments.map((c) => (
              <ThreadDesktop key={c.id} c={c} ctx={ctx} />
            ))}
            {query.hasNextPage && (
              <button
                type="button"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                style={{ width: '100%', height: 44, marginTop: 4, borderRadius: 9999, background: 'var(--raise)', ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', opacity: query.isFetchingNextPage ? 0.6 : 1 }}
              >
                {query.isFetchingNextPage ? 'LOADING…' : 'LOAD MORE'}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ComposerDesktop({
  target,
  placeholder,
  meta,
  parentId,
  autoFocus,
  onPosted,
}: {
  target: CommentTargetParams;
  placeholder: string;
  meta?: string;
  parentId?: string;
  autoFocus?: boolean;
  onPosted?: () => void;
}) {
  const d = useDraft(target, parentId, onPosted);
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={d.text}
        onChange={(e) => d.setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          padding: '10px 12px',
          borderRadius: 12,
          border: 0,
          outline: 0,
          background: 'var(--raise)',
          boxShadow: focused ? 'inset 0 0 0 1.5px var(--mako-canvas-fg)' : 'inset 0 0 0 1px var(--line)',
          color: 'var(--mako-canvas-fg)',
          fontFamily: 'var(--mako-font-sans)',
          fontSize: 14,
          lineHeight: 1.45,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, ...MONO, fontSize: 11, color: 'var(--dim)' }}>
        {meta && <span style={nameStyle}>{meta}</span>}
        <span style={{ flex: 'none', color: d.tooLong ? RED : 'var(--dim)' }}>{counterText(d.bytes)}</span>
        <button
          type="button"
          onClick={d.submit}
          disabled={!d.canPost}
          className="mk-press97"
          style={{
            marginLeft: 'auto',
            flex: 'none',
            height: 34,
            padding: '0 16px',
            borderRadius: 9999,
            background: d.canPost ? 'var(--mako-signal)' : 'var(--raise2)',
            color: d.canPost ? '#000' : 'var(--dim)',
            boxShadow: d.canPost ? 'var(--edge)' : 'none',
            ...MONO,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            cursor: d.canPost ? 'pointer' : 'not-allowed',
          }}
        >
          {d.pending ? 'POSTING…' : 'POST'}
        </button>
      </div>
      {d.error ? (
        <div role="alert" style={{ ...MONO, fontSize: 11, color: RED }}>
          {postErrorCopy(d.error)}
        </div>
      ) : null}
    </div>
  );
}

function MetaDesktop({ c, nowMs }: { c: CommentWire; nowMs: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...MONO, fontSize: 12, minWidth: 0 }}>
      {!c.deleted && <span style={{ fontWeight: 700, ...nameStyle }}>{c.authorLabel}</span>}
      {!c.deleted && <Badge position={c.position} />}
      <span style={{ flex: 'none', color: 'var(--dim)' }}>{timeAgo(c.createdAt, nowMs)}</span>
    </div>
  );
}

const actionsDesktop: React.CSSProperties = { display: 'flex', gap: 14, marginTop: 6, ...MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--dim)' };
const actionButtonDesktop: React.CSSProperties = { fontWeight: 700, letterSpacing: '0.12em' };

function DeleteDesktop({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...actionButtonDesktop, color: hover && !pending ? RED : 'var(--dim)', opacity: pending ? 0.5 : 1 }}
    >
      {pending ? 'DELETING…' : 'DELETE'}
    </button>
  );
}

const deleteFailed = (mobile: boolean) => (
  <div role="alert" style={mobile ? { fontSize: 13, color: RED, marginTop: 6 } : { ...MONO, fontSize: 11, color: RED, marginTop: 6 }}>
    Can’t delete right now. Try again.
  </div>
);

function ThreadDesktop({ c, ctx }: { c: CommentWire; ctx: Ctx }) {
  const t = useThread(c, ctx.target, ctx.refreshedAt);
  const d = useRowDelete(c, ctx);
  const [replyOpen, setReplyOpen] = useState(false);
  const canReply = canReplyTo(c, ctx);
  const signedIn = ctx.viewer.kind === 'in';
  const reply = () => (signedIn ? setReplyOpen((o) => !o) : ctx.onSignIn());

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <CommentAvatar c={c} size={32} fontSize={13} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <MetaDesktop c={c} nowMs={ctx.nowMs} />
        <Body c={c} style={{ fontSize: 14, lineHeight: 1.5, marginTop: 5, textWrap: 'pretty' }} />
        {(canReply || d.canDelete) && (
          <div style={actionsDesktop}>
            {canReply && (
              <button type="button" onClick={reply} aria-expanded={signedIn ? replyOpen : undefined} style={{ ...actionButtonDesktop, color: 'var(--dim)' }}>
                REPLY
              </button>
            )}
            {d.canDelete && <DeleteDesktop pending={d.pending} onClick={d.remove} />}
          </div>
        )}
        {d.failed && deleteFailed(false)}
        {replyOpen && signedIn && ctx.writable && (
          <div style={{ display: 'flex', marginTop: 10 }}>
            <ComposerDesktop
              target={ctx.target}
              parentId={c.id}
              placeholder={`Reply to ${c.authorLabel}`}
              autoFocus
              onPosted={() => {
                setReplyOpen(false);
                t.onReplyPosted();
              }}
            />
          </div>
        )}
        {(t.replies.length > 0 || t.cursor) && (
          <div style={{ marginTop: 10, paddingLeft: 14, boxShadow: 'inset 2px 0 0 var(--line)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {t.replies.map((r) => (
              <ReplyDesktop key={r.id} r={r} ctx={ctx} onDeleted={t.onReplyDeleted} />
            ))}
            {t.cursor && (
              <button
                type="button"
                onClick={() => void t.loadMore()}
                disabled={t.loading}
                style={{ alignSelf: 'flex-start', ...MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--dim)', opacity: t.loading ? 0.6 : 1 }}
              >
                {t.loading ? 'LOADING…' : 'VIEW MORE REPLIES'}
              </button>
            )}
            {t.loadFailed && (
              <div role="alert" style={{ ...MONO, fontSize: 11, color: RED }}>
                Can’t load more replies. Try again.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReplyDesktop({ r, ctx, onDeleted }: { r: CommentWire; ctx: Ctx; onDeleted: (id: string) => void }) {
  const d = useRowDelete(r, ctx, onDeleted);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <CommentAvatar c={r} size={28} fontSize={12} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <MetaDesktop c={r} nowMs={ctx.nowMs} />
        <Body c={r} style={{ fontSize: 14, lineHeight: 1.5, marginTop: 4, textWrap: 'pretty' }} />
        {d.canDelete && (
          <div style={actionsDesktop}>
            <DeleteDesktop pending={d.pending} onClick={d.remove} />
          </div>
        )}
        {d.failed && deleteFailed(false)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mobile

export function PoolCommentsMobile({ marketId, onSignIn, writable = true }: Props) {
  const { target, viewer, isAdmin, query, comments, nowMs } = usePoolComments(marketId);
  const ctx: Ctx = { target, viewer, canModerate: isAdmin, writable, nowMs, onSignIn, refreshedAt: query.dataUpdatedAt };
  const note: React.CSSProperties = { flex: 1, fontSize: 15, lineHeight: 1.4, color: 'var(--dim)' };
  const pill: React.CSSProperties = { flex: 'none', height: 46, padding: '0 18px', borderRadius: 9999, fontSize: 15, fontWeight: 800 };

  return (
    <section aria-label="Comments" style={{ borderRadius: 28, background: 'var(--raise)', padding: 16, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, ...DISPLAY, fontSize: 20 }}>Comments</h2>
      </div>

      {!writable ? (
        <div style={{ marginTop: 12, ...note }}>Comments are turned off for this market.</div>
      ) : viewer.kind === 'in' ? (
        <div style={{ marginTop: 12 }}>
          <ComposerMobile target={target} placeholder="Add a comment" />
        </div>
      ) : viewer.kind === 'out' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <span style={note}>Sign in to join the conversation.</span>
          <button type="button" onClick={onSignIn} className="m3-press" style={{ ...pill, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
            Sign in
          </button>
        </div>
      ) : viewer.kind === 'error' ? (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <span style={note}>Can’t check your sign-in right now.</span>
          <button type="button" onClick={viewer.retry} className="m3-press" style={{ ...pill, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)' }}>
            Try again
          </button>
        </div>
      ) : null}

      {query.isLoading ? (
        <div aria-busy="true" aria-label="Loading comments">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingTop: 14 }}>
              <span style={{ flex: 'none', width: 36, height: 36, borderRadius: 9999, background: BAR }} />
              <div style={{ flex: 1, borderRadius: '4px 20px 20px 20px', background: 'var(--mako-canvas)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ width: '35%', height: 12, borderRadius: 8, background: BAR }} />
                <div style={{ width: '85%', height: 14, borderRadius: 8, background: BAR }} />
              </div>
            </div>
          ))}
        </div>
      ) : !query.data && query.isError ? (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 14 }}>
          <span style={note}>Can’t load comments right now.</span>
          <button type="button" onClick={() => void query.refetch()} className="m3-press" style={{ ...pill, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)' }}>
            Try again
          </button>
        </div>
      ) : comments.length === 0 ? (
        <div style={{ paddingTop: 16, fontSize: 15, color: 'var(--dim)', textAlign: 'center' }}>No comments yet. Take a side.</div>
      ) : (
        <>
          {comments.map((c) => (
            <ThreadMobile key={c.id} c={c} ctx={ctx} />
          ))}
          {query.hasNextPage && (
            <button
              type="button"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="m3-press"
              style={{ width: '100%', height: 46, marginTop: 14, borderRadius: 9999, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', fontSize: 14, fontWeight: 700, opacity: query.isFetchingNextPage ? 0.6 : 1 }}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ComposerMobile({
  target,
  placeholder,
  parentId,
  autoFocus,
  onPosted,
}: {
  target: CommentTargetParams;
  placeholder: string;
  parentId?: string;
  autoFocus?: boolean;
  onPosted?: () => void;
}) {
  const d = useDraft(target, parentId, onPosted);
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <textarea
          value={d.text}
          onChange={(e) => d.setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          style={{
            width: '100%',
            minWidth: 0,
            flex: 1,
            boxSizing: 'border-box',
            border: 0,
            outline: 0,
            resize: 'none',
            padding: '12px 16px',
            borderRadius: 9999,
            background: 'var(--mako-canvas)',
            boxShadow: focused ? 'inset 0 0 0 1.5px var(--mako-canvas-fg)' : 'none',
            color: 'var(--mako-canvas-fg)',
            fontFamily: 'var(--mako-font-sans)',
            fontSize: 16,
            lineHeight: 1.3,
          }}
        />
        <button
          type="button"
          onClick={d.submit}
          disabled={!d.canPost}
          aria-label={d.pending ? 'Posting' : 'Post'}
          className="m3-press"
          style={{
            flex: 'none',
            width: 46,
            height: 46,
            borderRadius: 9999,
            background: d.canPost ? 'var(--mako-signal)' : 'var(--raise2)',
            color: d.canPost ? '#000' : 'var(--dim)',
            boxShadow: d.canPost ? 'var(--edge)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {d.pending ? (
            <svg className="wl-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 18.5v-13M6.5 11L12 5.5 17.5 11" />
            </svg>
          )}
        </button>
      </div>
      {/* The design keeps the resting composer bare; the byte count shows once there is something to count. */}
      {d.text.length > 0 && (
        <div style={{ padding: '6px 16px 0', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: d.tooLong ? RED : 'var(--dim)' }}>{counterText(d.bytes)}</div>
      )}
      {d.error ? (
        <div role="alert" style={{ padding: '6px 16px 0', fontSize: 13, lineHeight: 1.4, color: RED }}>
          {postErrorCopy(d.error)}
        </div>
      ) : null}
    </div>
  );
}

function MetaMobile({ c, nowMs }: { c: CommentWire; nowMs: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
      {!c.deleted && <span style={{ fontWeight: 800, ...nameStyle }}>{c.authorLabel}</span>}
      {!c.deleted && <Badge position={c.position} mobile />}
      <span style={{ flex: 'none', marginLeft: 'auto', fontSize: 12, color: 'var(--dim)' }}>{timeAgo(c.createdAt, nowMs)}</span>
    </div>
  );
}

const actionsMobile: React.CSSProperties = { display: 'flex', gap: 14, marginTop: 6, fontSize: 13, fontWeight: 700, color: 'var(--dim)' };
const bubble = (padding: string): React.CSSProperties => ({ flex: 1, minWidth: 0, borderRadius: '4px 20px 20px 20px', background: 'var(--mako-canvas)', padding });

function ThreadMobile({ c, ctx }: { c: CommentWire; ctx: Ctx }) {
  const t = useThread(c, ctx.target, ctx.refreshedAt);
  const d = useRowDelete(c, ctx);
  const [replyOpen, setReplyOpen] = useState(false);
  const canReply = canReplyTo(c, ctx);
  const signedIn = ctx.viewer.kind === 'in';
  const reply = () => (signedIn ? setReplyOpen((o) => !o) : ctx.onSignIn());

  return (
    <div style={{ paddingTop: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <CommentAvatar c={c} size={36} fontSize={14} />
        <div style={bubble('10px 14px')}>
          <MetaMobile c={c} nowMs={ctx.nowMs} />
          <Body c={c} style={{ fontSize: 15, lineHeight: 1.45, marginTop: 4 }} />
          {(canReply || d.canDelete) && (
            <div style={actionsMobile}>
              {canReply && (
                <button type="button" onClick={reply} aria-expanded={signedIn ? replyOpen : undefined} style={{ color: 'var(--dim)', fontWeight: 700 }}>
                  Reply
                </button>
              )}
              {d.canDelete && (
                <button type="button" onClick={d.remove} disabled={d.pending} style={{ color: 'var(--dim)', fontWeight: 700, opacity: d.pending ? 0.5 : 1 }}>
                  {d.pending ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </div>
          )}
          {d.failed && deleteFailed(true)}
        </div>
      </div>
      {replyOpen && signedIn && ctx.writable && (
        <div style={{ margin: '10px 0 0 48px' }}>
          <ComposerMobile
            target={ctx.target}
            parentId={c.id}
            placeholder={`Reply to ${c.authorLabel}`}
            autoFocus
            onPosted={() => {
              setReplyOpen(false);
              t.onReplyPosted();
            }}
          />
        </div>
      )}
      {(t.replies.length > 0 || t.cursor) && (
        <div style={{ marginLeft: 48 }}>
          {t.replies.map((r) => (
            <ReplyMobile key={r.id} r={r} ctx={ctx} onDeleted={t.onReplyDeleted} />
          ))}
          {t.cursor && (
            <button type="button" onClick={() => void t.loadMore()} disabled={t.loading} style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: 'var(--dim)', opacity: t.loading ? 0.6 : 1 }}>
              {t.loading ? 'Loading…' : 'View more replies'}
            </button>
          )}
          {t.loadFailed && (
            <div role="alert" style={{ marginTop: 6, fontSize: 13, color: RED }}>
              Can’t load more replies. Try again.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReplyMobile({ r, ctx, onDeleted }: { r: CommentWire; ctx: Ctx; onDeleted: (id: string) => void }) {
  const d = useRowDelete(r, ctx, onDeleted);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', paddingTop: 10 }}>
      <CommentAvatar c={r} size={28} fontSize={12} />
      <div style={bubble('8px 12px')}>
        <MetaMobile c={r} nowMs={ctx.nowMs} />
        <Body c={r} style={{ fontSize: 14, lineHeight: 1.45, marginTop: 3 }} />
        {d.canDelete && (
          <div style={actionsMobile}>
            <button type="button" onClick={d.remove} disabled={d.pending} style={{ color: 'var(--dim)', fontWeight: 700, opacity: d.pending ? 0.5 : 1 }}>
              {d.pending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
        {d.failed && deleteFailed(true)}
      </div>
    </div>
  );
}
