import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/queries.ts
//
// Read path for the comments system. Two queries, no N+1:
//   1. top-level comments, newest-first, keyset-paginated over (created_at, id);
//   2. their replies, windowed to REPLY_PAGE per parent (deleted filtered
//      INSIDE the window so deleted replies never consume a slot).
// Then identity + position-badge resolution and assembly to CommentWire[].
//
// Soft-delete display rule: a deleted top-level is shown (as `deleted`, empty
// body) ONLY if it still has ≥1 live reply; otherwise it's hidden. Deleted
// replies are never shown.
//
// EVERY read is keyed by the caller-supplied market target, never a bare UUID
// (plan §2 / Codex r2 MAJOR-3) — parentBelongsToTarget gates the reply-page
// path so a LinkOnly PM market's replies can't be reached without its slug.
// ----------------------------------------------------------------------------

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { makoMarketEvents, marketComments } from '@/db/schema';
import { encodeCursor, type Cursor } from './cursor';
import { resolveCommentAuthors } from './identity';
import {
  REPLY_PAGE,
  type CommentPosition,
  type CommentsPage,
  type CommentWire,
} from './types';

export type CommentTarget =
  | { scope: 'main'; chainId: number; contractAddress: string; marketId: string }
  | { scope: 'pm'; pmMarketDbId: string };

const commentCols = {
  id: marketComments.id,
  parentId: marketComments.parentId,
  userId: marketComments.userId,
  body: marketComments.body,
  deletedAt: marketComments.deletedAt,
  createdAt: marketComments.createdAt,
};

type SelectedRow = {
  id: string;
  parentId: string | null;
  userId: string;
  body: string;
  deletedAt: Date | null;
  createdAt: Date;
};

/** WHERE predicate selecting a single market's comments by scope+target. */
function targetWhere(target: CommentTarget) {
  return target.scope === 'main'
    ? and(
        eq(marketComments.scope, 'main'),
        eq(marketComments.chainId, target.chainId),
        eq(marketComments.contractAddress, target.contractAddress),
        eq(marketComments.marketId, target.marketId),
      )
    : and(
        eq(marketComments.scope, 'pm'),
        eq(marketComments.pmMarketDbId, target.pmMarketDbId),
      );
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  const raw = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
}

interface ReplyRow {
  id: string;
  parentId: string;
  userId: string;
  body: string;
  createdAt: Date;
}

/** Windowed replies for a set of top-level ids: up to `perParent` live replies
 * each, oldest-first, `deleted_at IS NULL` filtered INSIDE the window. */
async function fetchRepliesWindow(
  db: DbOrTx,
  parentIds: string[],
  perParent: number,
): Promise<ReplyRow[]> {
  if (parentIds.length === 0) return [];
  const res = await db.execute(sql`
    SELECT id, "parentId", "userId", body, "createdAt"
      FROM (
        SELECT mc.id,
               mc.parent_id AS "parentId",
               mc.user_id   AS "userId",
               mc.body,
               mc.created_at AS "createdAt",
               row_number() OVER (
                 PARTITION BY mc.parent_id ORDER BY mc.created_at ASC, mc.id ASC
               ) AS rn
          FROM market_comments mc
         WHERE mc.parent_id IN ${parentIds} AND mc.deleted_at IS NULL
      ) sub
     WHERE rn <= ${perParent}
     ORDER BY "parentId", "createdAt" ASC, id ASC
  `);
  return rowsOf(res).map((r) => ({
    id: r.id as string,
    parentId: r.parentId as string,
    userId: r.userId as string,
    body: r.body as string,
    createdAt: new Date(r.createdAt as string | Date),
  }));
}

/** Position badges for main-scope markets: aggregate the bet ledger per actor.
 * lower()-both-sides is already handled — actors are stored lowercase and the
 * addresses passed in are lowercased by the identity resolver. PM badges are
 * deferred to Slice B (returns empty). */
async function fetchMainBadges(
  db: DbOrTx,
  target: Extract<CommentTarget, { scope: 'main' }>,
  addressesLower: string[],
): Promise<Map<string, CommentPosition>> {
  const out = new Map<string, CommentPosition>();
  if (addressesLower.length === 0) return out;
  const rows = await db
    .select({
      actor: makoMarketEvents.actor,
      hasYes: sql<boolean>`bool_or(${makoMarketEvents.isYes})`,
      hasNo: sql<boolean>`bool_or(NOT ${makoMarketEvents.isYes})`,
    })
    .from(makoMarketEvents)
    .where(
      and(
        eq(makoMarketEvents.kind, 'bet'),
        eq(makoMarketEvents.chainId, target.chainId),
        eq(makoMarketEvents.contractAddress, target.contractAddress),
        eq(makoMarketEvents.marketId, target.marketId),
        inArray(makoMarketEvents.actor, addressesLower),
      ),
    )
    .groupBy(makoMarketEvents.actor);
  for (const r of rows) {
    const yes = r.hasYes === true;
    const no = r.hasNo === true;
    const pos: CommentPosition = yes && no ? 'both' : yes ? 'yes' : no ? 'no' : null;
    if (pos) out.set(r.actor, pos);
  }
  return out;
}

interface WireInputRow {
  id: string;
  parentId: string | null;
  userId: string;
  body: string;
  createdAt: Date;
}

function toWire(
  row: WireInputRow,
  authors: Awaited<ReturnType<typeof resolveCommentAuthors>>,
  badges: Map<string, CommentPosition>,
  viewerUserId: string | null,
  deleted: boolean,
  replies: CommentWire[],
  repliesNextCursor: string | null,
): CommentWire {
  const author = authors.get(row.userId);
  const addr = author?.addressLower ?? null;
  return {
    id: row.id,
    parentId: row.parentId ?? null,
    authorLabel: author?.authorLabel ?? 'anon',
    avatarSeed: author?.avatarSeed ?? '',
    isOwn: viewerUserId !== null && viewerUserId === row.userId,
    position: addr ? badges.get(addr) ?? null : null,
    body: deleted ? '' : row.body,
    deleted,
    createdAt: row.createdAt.toISOString(),
    replies,
    repliesNextCursor,
  };
}

/** Top-level comments for a market, newest-first, keyset-paginated, with each
 * comment's first REPLY_PAGE live replies inlined. */
export async function getCommentsPage(
  db: DbOrTx,
  target: CommentTarget,
  cursor: Cursor | null,
  limit: number,
  viewerUserId: string | null,
): Promise<CommentsPage> {
  const keyset = cursor
    ? or(
        lt(marketComments.createdAt, cursor.createdAt),
        and(eq(marketComments.createdAt, cursor.createdAt), lt(marketComments.id, cursor.id)),
      )
    : undefined;

  const scanned = (await db
    .select(commentCols)
    .from(marketComments)
    .where(and(targetWhere(target), isNull(marketComments.parentId), keyset))
    .orderBy(desc(marketComments.createdAt), desc(marketComments.id))
    .limit(limit + 1)) as SelectedRow[];

  const hasNext = scanned.length > limit;
  const pageRows = scanned.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  // Cursor is the last SCANNED page row (visibility filtering below may drop
  // some, but continuation must still resume after the row we paged past).
  const nextCursor =
    hasNext && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  const topIds = pageRows.map((r) => r.id);
  const replyRows = await fetchRepliesWindow(db, topIds, REPLY_PAGE + 1);

  const repliesByParent = new Map<string, ReplyRow[]>();
  for (const rr of replyRows) {
    const arr = repliesByParent.get(rr.parentId) ?? [];
    arr.push(rr);
    repliesByParent.set(rr.parentId, arr);
  }

  const authors = await resolveCommentAuthors(db, [
    ...pageRows.map((r) => r.userId),
    ...replyRows.map((r) => r.userId),
  ]);
  const addrs = [
    ...new Set(
      [...authors.values()]
        .map((a) => a.addressLower)
        .filter((a): a is string => a !== null),
    ),
  ];
  const badges =
    target.scope === 'main'
      ? await fetchMainBadges(db, target, addrs)
      : new Map<string, CommentPosition>();

  const comments: CommentWire[] = [];
  for (const top of pageRows) {
    const raw = repliesByParent.get(top.id) ?? [];
    const hasMoreReplies = raw.length > REPLY_PAGE;
    const kept = raw.slice(0, REPLY_PAGE);
    const deleted = top.deletedAt !== null;
    // Hide a deleted top-level with no live replies (nothing to show).
    if (deleted && kept.length === 0) continue;

    const replyWires = kept.map((rr) =>
      toWire(rr, authors, badges, viewerUserId, false, [], null),
    );
    const lastReply = kept[kept.length - 1];
    const repliesNextCursor =
      hasMoreReplies && lastReply
        ? encodeCursor({ createdAt: lastReply.createdAt, id: lastReply.id })
        : null;
    comments.push(
      toWire(top, authors, badges, viewerUserId, deleted, replyWires, repliesNextCursor),
    );
  }

  return { comments, nextCursor };
}

/** True iff `parentId` is a TOP-LEVEL comment under `target`. The route calls
 * this before serving a reply page so a reply set can only be reached via its
 * market's target, never a bare parent UUID (Codex r2 MAJOR-3). */
export async function parentBelongsToTarget(
  db: DbOrTx,
  parentId: string,
  target: CommentTarget,
): Promise<boolean> {
  const rows = await db
    .select({ id: marketComments.id })
    .from(marketComments)
    .where(and(eq(marketComments.id, parentId), isNull(marketComments.parentId), targetWhere(target)))
    .limit(1);
  return rows.length > 0;
}

/** A page of a single parent's live replies (oldest-first, keyset). The caller
 * MUST have validated parentBelongsToTarget first; `target` here is only for
 * badge resolution. */
export async function getRepliesPage(
  db: DbOrTx,
  target: CommentTarget,
  parentId: string,
  cursor: Cursor | null,
  limit: number,
  viewerUserId: string | null,
): Promise<CommentsPage> {
  const keyset = cursor
    ? or(
        gt(marketComments.createdAt, cursor.createdAt),
        and(eq(marketComments.createdAt, cursor.createdAt), gt(marketComments.id, cursor.id)),
      )
    : undefined;

  const rows = (await db
    .select(commentCols)
    .from(marketComments)
    .where(and(eq(marketComments.parentId, parentId), isNull(marketComments.deletedAt), keyset))
    .orderBy(asc(marketComments.createdAt), asc(marketComments.id))
    .limit(limit + 1)) as SelectedRow[];

  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  const authors = await resolveCommentAuthors(db, page.map((r) => r.userId));
  const addrs = [
    ...new Set(
      [...authors.values()]
        .map((a) => a.addressLower)
        .filter((a): a is string => a !== null),
    ),
  ];
  const badges =
    target.scope === 'main'
      ? await fetchMainBadges(db, target, addrs)
      : new Map<string, CommentPosition>();

  const comments = page.map((r) =>
    toWire(r, authors, badges, viewerUserId, false, [], null),
  );
  return { comments, nextCursor };
}
