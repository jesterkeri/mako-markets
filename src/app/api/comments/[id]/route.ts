// ----------------------------------------------------------------------------
// src/app/api/comments/[id]/route.ts
//
// DELETE /api/comments/[id] — soft-delete a comment.
//
// Owner path first: a live user session may delete its OWN comment (ownership
// is in the UPDATE's WHERE, so a miss is 0 rows — never someone else's).
// Admin fallback: if the owner path deleted nothing (no session, or not the
// owner's comment), a live admin (SIWE) session may delete any comment. An
// admin deleting their own comment takes the owner path first → deleted_by
// 'owner', which is correct. Neither → 404 (also for an already-deleted row).
// ----------------------------------------------------------------------------

import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';
import { getAdminSession } from '@/lib/admin-session';
import { softDeleteAsAdmin, softDeleteOwn } from '@/lib/comments/mutations';
import { isUuid } from '@/lib/comments/validate';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => Response.json(body, { status });

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!checkSameOrigin(req).ok) return json({ error: 'cross_origin' }, 403);

  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: 'not_found' }, 404);

  // Owner path.
  const session = await getUserSession();
  if (session && (await softDeleteOwn(db, id, session.userId))) {
    return Response.json({ ok: true });
  }

  // Admin fallback (only reached when the owner path deleted nothing).
  const admin = await getAdminSession();
  if (admin && (await softDeleteAsAdmin(db, id))) {
    return Response.json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}
