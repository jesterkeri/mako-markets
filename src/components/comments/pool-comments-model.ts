// Pure pieces of the pool page's comments block (9a): the words, colours and counts both layouts share. No hooks
// and no DOM, so each rule here is unit-testable on its own. The data itself comes from the existing comments layer
// (`@/lib/use-comments`, `@/lib/comments/*`), which this file only reads types and limits from.

import { formatDistanceStrict } from 'date-fns';

import { BODY_MAX_BYTES, type CommentPosition } from '@/lib/comments/types';
import { bodyByteLength } from '@/lib/comments/validate';
import type { PostCommentError } from '@/lib/use-comments';
import { accountAddress, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';

/// Why a post was refused, by the API's error code. Same wording as the old CommentsSection (which does not export
/// its map, and must stay untouched while older pages still use it).
export const POST_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Slow down a moment, then try again.',
  comments_disabled: 'Comments are turned off for this market.',
  market_not_found: 'This market could not be found.',
  market_check_unavailable: "Couldn't reach the chain. Try again shortly.",
  parent_deleted: 'That comment was deleted.',
  parent_not_top_level: 'You can only reply to a top-level comment.',
  unauthorized: 'Sign in to comment.',
};

export function postErrorCopy(e: unknown): string {
  const code = (e as PostCommentError | null)?.code;
  return (code && POST_ERROR_COPY[code]) || 'Could not post. Try again.';
}

export type HeldSide = Exclude<CommentPosition, null>;

/// The holder badge beside a name. Yellow is YES and red is NO across the redesign; the design has no BOTH, so a
/// holder of both sides gets a pill split between the two colours (black text reads on either half).
export const SIDE_BADGE: Record<HeldSide, { label: string; bg: string }> = {
  yes: { label: 'HOLDS YES', bg: 'var(--mako-signal)' },
  no: { label: 'HOLDS NO', bg: 'var(--mako-red)' },
  both: { label: 'HOLDS BOTH', bg: 'linear-gradient(90deg, var(--mako-signal) 50%, var(--mako-red) 50%)' },
};

/// Avatar colours for other people, picked by the author's avatar seed so one person keeps one colour. Yellow is
/// kept for the viewer's own avatar (as in the design), red for NO, and gold is left out because it reads as yellow.
export const AVATAR_COLOURS = [
  'var(--mako-teal)',
  'var(--mako-blue)',
  'var(--mako-violet)',
  'var(--mako-coral)',
  'var(--mako-cyan)',
  'var(--mako-fuchsia)',
  'var(--mako-orange)',
] as const;

export const OWN_AVATAR_COLOUR = 'var(--mako-signal)';

export function avatarColour(seed: string, own: boolean): string {
  if (own) return OWN_AVATAR_COLOUR;
  let sum = 0;
  for (let i = 0; i < Math.min(seed.length, 8); i++) sum += seed.charCodeAt(i);
  return AVATAR_COLOURS[sum % AVATAR_COLOURS.length];
}

/// The avatar letter: the label's first character, upper-cased ('?' for an empty label).
export function initialOf(label: string): string {
  const first = [...label.trim()][0];
  return first ? first.toUpperCase() : '?';
}

/// "just now" under a minute (and for a clock slightly behind the server), else "4 minutes ago".
export function timeAgo(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  if (nowMs - t < 60_000) return 'just now';
  return formatDistanceStrict(t, nowMs, { addSuffix: true });
}

/// The draft as the API will judge it: trimmed, measured in UTF-8 bytes, 1 to 2,000.
export function draftBytes(text: string): { bytes: number; tooLong: boolean; empty: boolean } {
  const bytes = bodyByteLength(text.trim());
  return { bytes, tooLong: bytes > BODY_MAX_BYTES, empty: bytes === 0 };
}

export function counterText(bytes: number): string {
  return `${bytes}/${BODY_MAX_BYTES}`;
}

/// The name a comment from this account will carry. Mirrors the server's `resolveCommentAuthors`: the display name
/// if set, else the account address (the Safe for an email account, the wallet otherwise), shortened. Never the
/// email, which the server never shows either.
export function viewerLabel(user: AuthedUser): string {
  const named = user.displayName?.trim();
  return named ? named : formatAddress(accountAddress(user).toLowerCase());
}

/// The side the account holds on this pool, from the contract's `getUserBet` (yes stake, no stake, claimed).
export function viewerSide(bet: readonly [bigint, bigint, boolean] | undefined): CommentPosition {
  if (!bet) return null;
  const yes = bet[0] > 0n;
  const no = bet[1] > 0n;
  return yes && no ? 'both' : yes ? 'yes' : no ? 'no' : null;
}

export function postingAs(label: string, side: CommentPosition): string {
  return side ? `Posting as ${label} · holds ${side.toUpperCase()}` : `Posting as ${label}`;
}
