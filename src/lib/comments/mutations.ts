import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/mutations.ts
//
// Write path: create (with the depth-1 parent check inside the insert txn) and
// owner/admin soft-delete.
//
// createComment locks the parent FOR SHARE inside the transaction so a
// concurrent soft-delete of the parent conflicts (closes the TOCTOU, Codex Q1),
// and asserts the parent is a top-level comment on the SAME target that isn't
// deleted (depth-1 rule + no cross-market replies).
//
// #214: in the same transaction a reply also upserts the parent author's
// `reply` notification (NOTIFICATIONS_PLAN r8 §3.2(3)): one row per parent
// comment, a count of unread replies, re-opened as a new item once read. No
// self-reply, main markets only, the author's `reply` switch read through
// prefOn (never a cast of a non-boolean), and no user text in the row, so the
// upsert cannot make the comment fail.
//
// Delete is soft-only. Owner path scopes by user_id in the WHERE (a miss is 0
// rows, never someone else's row — API1/BOLA). Admin path omits the user_id
// scope. Both are no-ops on an already-deleted row (idempotent-ish → the route
// maps 0 rows to 404).
// ----------------------------------------------------------------------------

import { and, eq, isNull } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { marketComments } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { replyKey } from '@/lib/notifications/keys';
import { prefOn } from '@/lib/notifications/prefs';
import type { CommentTarget } from './queries';

export interface CreateCommentInput {
  target: CommentTarget;
  userId: string;
  parentId: string | null;
  body: string;
}

export type CreateResult =
  | { ok: true; id: string; createdAt: Date }
  | {
      ok: false;
      error: 'parent_not_found' | 'parent_mismatch' | 'parent_not_top_level' | 'parent_deleted';
    };

interface ParentLockRow {
  scope: string;
  chainId: number | null;
  contractAddress: string | null;
  marketId: string | null;
  pmMarketDbId: string | null;
  parentId: string | null;
  deletedAt: Date | null;
  userId: string;
}

function parentMatchesTarget(p: ParentLockRow, target: CommentTarget): boolean {
  if (p.scope !== target.scope) return false;
  if (target.scope === 'main') {
    return (
      p.chainId === target.chainId &&
      p.contractAddress === target.contractAddress &&
      p.marketId === target.marketId
    );
  }
  return p.pmMarketDbId === target.pmMarketDbId;
}

function insertValues(input: CreateCommentInput) {
  const { target } = input;
  return {
    scope: target.scope,
    chainId: target.scope === 'main' ? target.chainId : null,
    contractAddress: target.scope === 'main' ? target.contractAddress : null,
    marketId: target.scope === 'main' ? target.marketId : null,
    pmMarketDbId: target.scope === 'pm' ? target.pmMarketDbId : null,
    userId: input.userId,
    parentId: input.parentId,
    body: input.body,
  };
}

export async function createComment(
  db: DbOrTx,
  input: CreateCommentInput,
): Promise<CreateResult> {
  return db.transaction(async (tx) => {
    let parent: ParentLockRow | undefined;
    if (input.parentId) {
      const res = await tx.execute(sql`
        SELECT scope,
               chain_id AS "chainId",
               contract_address AS "contractAddress",
               market_id AS "marketId",
               pm_market_db_id AS "pmMarketDbId",
               parent_id AS "parentId",
               deleted_at AS "deletedAt",
               user_id AS "userId"
          FROM market_comments
         WHERE id = ${input.parentId}
         FOR SHARE
      `);
      const rows =
        ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as ParentLockRow[];
      parent = Array.isArray(rows) ? rows[0] : undefined;
      if (!parent) return { ok: false, error: 'parent_not_found' } as const;
      if (!parentMatchesTarget(parent, input.target)) {
        return { ok: false, error: 'parent_mismatch' } as const;
      }
      if (parent.parentId !== null) {
        return { ok: false, error: 'parent_not_top_level' } as const;
      }
      if (parent.deletedAt !== null) {
        return { ok: false, error: 'parent_deleted' } as const;
      }
    }

    const inserted = await tx
      .insert(marketComments)
      .values(insertValues(input))
      .returning({ id: marketComments.id, createdAt: marketComments.createdAt });
    if (parent && input.parentId && parent.userId !== input.userId && input.target.scope === 'main' && parent.marketId) {
      await upsertReplyNotification(tx, parent.userId, input.parentId, parent.marketId);
    }
    return { ok: true, id: inserted[0].id, createdAt: inserted[0].createdAt } as const;
  });
}

/// One row per parent comment for its author. An unread row counts one more reply; a row already read is re-opened
/// as a new item (count 1, unread, fresh times, out of any pending email), so it rises to the top of the feed and
/// survives the 90-day prune. The feed's cursor carries its own (created_at, id) boundary, and the list re-reads the
/// top page with every "Load more", so a row moving up is shown at the top, never skipped or repeated
/// (api/notifications/route.ts, NotificationList.tsx). poolId is the parent's market_id, which the
/// validators constrain to a canonical uint256; no name and no body.
export async function upsertReplyNotification(tx: DbOrTx, parentUserId: string, parentId: string, marketId: string) {
  await tx.execute(sql`
    INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at)
    SELECT ${parentUserId}::uuid, 'reply', ${replyKey(parentId)}, jsonb_build_object('poolId', ${marketId}::text, 'count', 1), now()
      FROM users u
     WHERE u.id = ${parentUserId}::uuid AND ${prefOn('reply')}
    ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
      data = jsonb_set(notifications.data, '{count}',
        to_jsonb(CASE WHEN notifications.read_at IS NULL THEN (notifications.data->>'count')::int + 1 ELSE 1 END)),
      event_at = now(),
      created_at = now(),
      email_id = CASE WHEN notifications.read_at IS NULL THEN notifications.email_id ELSE NULL END,
      read_at = NULL`);
}

/** Owner soft-delete. Ownership is in the WHERE, so a miss is 0 rows (never
 * someone else's row). Returns true iff a row was updated. */
export async function softDeleteOwn(
  db: DbOrTx,
  id: string,
  userId: string,
): Promise<boolean> {
  const res = await db
    .update(marketComments)
    .set({ deletedAt: new Date(), deletedBy: 'owner' })
    .where(
      and(
        eq(marketComments.id, id),
        eq(marketComments.userId, userId),
        isNull(marketComments.deletedAt),
      ),
    )
    .returning({ id: marketComments.id });
  return res.length > 0;
}

/** Admin soft-delete (no user_id scope). Returns true iff a row was updated. */
export async function softDeleteAsAdmin(db: DbOrTx, id: string): Promise<boolean> {
  const res = await db
    .update(marketComments)
    .set({ deletedAt: new Date(), deletedBy: 'admin' })
    .where(and(eq(marketComments.id, id), isNull(marketComments.deletedAt)))
    .returning({ id: marketComments.id });
  return res.length > 0;
}
