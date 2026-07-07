// ----------------------------------------------------------------------------
// src/lib/comments/types.ts
//
// Shared constants + wire shapes for the #182 comments system. Pure module
// (no server-only imports) so both route handlers and client components can
// import the types + limits.
// ----------------------------------------------------------------------------

/// Body byte bounds. Mirrors the octet_length CHECK in 0009 EXACTLY — the
/// validator and the DB agree so a body that passes the app never trips the
/// constraint (and vice-versa). Bytes, not chars: a 700-char multibyte string
/// can exceed 2000 bytes.
export const BODY_MIN_BYTES = 1 as const;
export const BODY_MAX_BYTES = 2000 as const;

/// Top-level page size. The GET route CLAMPS a client-supplied limit into
/// [1, MAX]; junk (`?limit=abc`) falls back to DEFAULT. Never trust the number.
export const TOP_LEVEL_PAGE_DEFAULT = 30 as const;
export const TOP_LEVEL_PAGE_MAX = 50 as const;

/// Replies returned inline per top-level comment. A parent with more than this
/// gets `repliesNextCursor` set; the rest load via the reply-pagination path
/// (keyed by the market target + parentId, never a bare UUID).
export const REPLY_PAGE = 3 as const;

/// Attempt-throttle caps (per user). The 60s window guards burst/RPC; the
/// per-UTC-day window is the coarse daily ceiling (calendar day, matches the
/// sponsor limiter — see rate-limit.ts). Both count ATTEMPTS, not successes.
export const RATE_PER_MINUTE = 4 as const;
export const RATE_PER_DAY = 100 as const;

export type CommentScope = 'main' | 'pm';

/// The author's on-chain position on THIS market, derived at read time from
/// the event ledger (main) / stakes (pm). null when the author has no stake.
export type CommentPosition = 'yes' | 'no' | 'both' | null;

/// One comment as serialized to the client. Explicit allowlist — NO email,
/// magic_eoa, or user_id in the scalar fields. `avatarSeed` is sha256(user_id):
/// stable + non-reversible, drives the glyph fallback. `avatarUrl` is the
/// author's uploaded profile photo when they have one (a single-origin Vercel
/// Blob URL, else null); the UI renders it via <AvatarCircle>, falling back to
/// the glyph. NOTE (Joshua, 2026-07-07): the blob path is `/avatars/<user_id>/…`,
/// so a user WITH a photo does expose their internal user_id inside this URL —
/// a consciously-accepted, low-marginal-risk relaxation of "no user_id in the
/// wire" (name + betting-side badge are already public; user_id is an identifier,
/// not a capability). Users without a photo leak nothing new.
/// `body` is '' on a deleted row. `replies` + `repliesNextCursor` are populated
/// on TOP-LEVEL comments only (empty / null on a reply).
export interface CommentWire {
  id: string;
  parentId: string | null;
  authorLabel: string;
  avatarSeed: string;
  avatarUrl: string | null;
  isOwn: boolean;
  position: CommentPosition;
  body: string;
  deleted: boolean;
  createdAt: string; // ISO 8601
  replies: CommentWire[];
  repliesNextCursor: string | null;
}

/// GET response envelope for a market's top-level comments.
export interface CommentsPage {
  comments: CommentWire[];
  nextCursor: string | null;
}
