import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { pmMarkets } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';
import { isPmEnabled } from '@/lib/pm-enabled';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { resolvePmActorAddress } from '@/lib/private-markets/actor';

// ----------------------------------------------------------------------------
// PATCH /api/pm/markets/[dbId]/comments-toggle   { commentsEnabled: boolean }
//   (#182 Slice B)
//
// The market CREATOR turns comments on/off after creation. comments_enabled
// blocks new comment WRITES; reads stay open (see /api/comments POST, which
// 403s `comments_disabled`). Whole surface is dark behind isPmEnabled.
//
// Gate order (mirrors the draft route + the comments routes):
//   -1. isPmEnabled            → 503 when the PM flag is off.
//    0. checkSameOrigin        → 403 (CSRF) before any state work.
//    1. getUserSession         → 401 when signed out.
//    2. body zod (strict)      → 400 on a bad / non-boolean payload.
//    3. authorize + UPDATE in ONE creator-scoped statement.
//
// Authorization is BOLA-safe: the creator address is derived server-side
// from the session (the SAME resolvePmActorAddress the draft route stores),
// lower()'d, and put in the UPDATE's WHERE alongside the row id. A caller
// who is not the creator matches zero rows → a uniform 404, identical to a
// nonexistent id, so a bare dbId can neither flip another creator's toggle
// nor confirm the market exists. Only active rows (pending|confirmed) are
// touchable; the create-time value on a pending row survives the indexer's
// confirm-flip (which never sets comments_enabled).
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => Response.json(body, { status });

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const BodySchema = z.object({ commentsEnabled: z.boolean() }).strict();

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ dbId: string }> },
) {
  if (!isPmEnabled()) return json({ error: 'feature_not_enabled' }, 503);
  if (!checkSameOrigin(req).ok) return json({ error: 'cross_origin' }, 403);

  const session = await getUserSession();
  if (!session) return json({ error: 'unauthorized' }, 401);

  const { dbId } = await ctx.params;
  // Malformed id is indistinguishable from "not found" — no existence leak.
  if (!UUID_RE.test(dbId)) return json({ error: 'not_found' }, 404);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'bad_body' }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'bad_body' }, 400);

  // Derive the creator address server-side (never trusted from the body).
  // PM is single-chain (MONAD_TESTNET_ID); resolving for that chain and
  // scoping the WHERE by creator means a cross-chain / non-creator caller
  // simply matches no rows.
  const actor = await resolvePmActorAddress(session, MONAD_TESTNET_ID);
  if (!actor.ok) return json({ error: 'not_found' }, 404);
  const creatorLower = actor.address.toLowerCase();

  const updated = await db
    .update(pmMarkets)
    .set({ commentsEnabled: parsed.data.commentsEnabled, updatedAt: new Date() })
    .where(
      and(
        eq(pmMarkets.id, dbId),
        eq(pmMarkets.creator, creatorLower),
        inArray(pmMarkets.createStatus, ['pending', 'confirmed']),
      ),
    )
    .returning({ id: pmMarkets.id });

  if (updated.length === 0) return json({ error: 'not_found' }, 404);

  return json({ ok: true, commentsEnabled: parsed.data.commentsEnabled }, 200);
}
