// ----------------------------------------------------------------------------
// src/app/api/comments/route.ts
//
// GET  /api/comments?scope=main&marketId=<id>[&parentId=<uuid>][&cursor][&limit]
// GET  /api/comments?scope=pm&slug=<slug>[&parentId=<uuid>][&cursor][&limit]
// POST /api/comments   { scope, marketId|slug, parentId?, body }
//
// Read posture (plan §2, grounded in LinkOnly/Public): main is public; pm is
// authorized by slug possession (the whole PM surface is dark behind
// isPmEnabled). Reads read the session ONLY to personalize isOwn — never to
// gate. `comments_enabled=false` blocks new writes, not reads. Every read is
// keyed by the caller-supplied target; the reply-page path additionally
// asserts parentBelongsToTarget so a bare parent UUID can't reach a market's
// replies.
//
// POST gate order: same-origin → session → parse (validates format + rejects
// unknown keys) → ATTEMPT THROTTLE (before the RPC) → target existence/auth →
// insert (with the in-txn depth-1 parent check).
// ----------------------------------------------------------------------------

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';
import { isPmEnabled } from '@/lib/pm-enabled';

import { decodeCursor, type Cursor } from '@/lib/comments/cursor';
import {
  checkMainMarket,
  resolveMainTarget,
  resolvePmTarget,
} from '@/lib/comments/market-target';
import { createComment } from '@/lib/comments/mutations';
import {
  getCommentsPage,
  getRepliesPage,
  parentBelongsToTarget,
  type CommentTarget,
} from '@/lib/comments/queries';
import { reserveAttemptOrReject } from '@/lib/comments/rate-limit';
import {
  TOP_LEVEL_PAGE_DEFAULT,
  TOP_LEVEL_PAGE_MAX,
} from '@/lib/comments/types';
import {
  clampLimit,
  isCanonicalUint256,
  isUuid,
  isValidSlug,
  parsePostBody,
} from '@/lib/comments/validate';

// Route handlers aren't cached by default in this Next, but pin it: the list
// must feel live (client polls) and it reads the session per request.
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => Response.json(body, { status });

/** Resolve the target from GET query params, or an error Response. */
async function resolveGetTarget(
  url: URL,
): Promise<{ target: CommentTarget } | { error: Response }> {
  const scope = url.searchParams.get('scope');
  if (scope === 'main') {
    const marketId = url.searchParams.get('marketId');
    if (!marketId || !isCanonicalUint256(marketId)) {
      return { error: json({ error: 'bad_market_id' }, 400) };
    }
    return { target: resolveMainTarget(marketId) };
  }
  if (scope === 'pm') {
    if (!isPmEnabled()) return { error: json({ error: 'not_found' }, 404) };
    const slug = url.searchParams.get('slug');
    if (!slug || !isValidSlug(slug)) return { error: json({ error: 'bad_slug' }, 400) };
    const pm = await resolvePmTarget(slug);
    if (!pm) return { error: json({ error: 'not_found' }, 404) };
    return { target: pm.target };
  }
  return { error: json({ error: 'bad_scope' }, 400) };
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  const resolved = await resolveGetTarget(url);
  if ('error' in resolved) return resolved.error;
  const { target } = resolved;

  const limit = clampLimit(
    url.searchParams.get('limit'),
    TOP_LEVEL_PAGE_DEFAULT,
    TOP_LEVEL_PAGE_MAX,
  );

  let cursor: Cursor | null = null;
  const cursorParam = url.searchParams.get('cursor');
  if (cursorParam !== null) {
    cursor = decodeCursor(cursorParam);
    if (cursor === null) return json({ error: 'bad_cursor' }, 400);
  }

  // Session read personalizes isOwn only — it never gates a read.
  const session = await getUserSession();
  const viewerUserId = session?.userId ?? null;

  const parentIdParam = url.searchParams.get('parentId');
  if (parentIdParam !== null) {
    if (!isUuid(parentIdParam)) return json({ error: 'bad_parent' }, 400);
    // Reply-page path: the parent must be a top-level comment UNDER this target,
    // so a market's replies are only reachable via its own target (not a bare
    // UUID learned out of band).
    const belongs = await parentBelongsToTarget(db, parentIdParam, target);
    if (!belongs) return json({ error: 'not_found' }, 404);
    const page = await getRepliesPage(db, target, parentIdParam, cursor, limit, viewerUserId);
    return Response.json(page);
  }

  const page = await getCommentsPage(db, target, cursor, limit, viewerUserId);
  return Response.json(page);
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return json({ error: 'cross_origin' }, 403);

  const session = await getUserSession();
  if (!session) return json({ error: 'unauthorized' }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'bad_body' }, 400);
  }
  const parsed = parsePostBody(raw);
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  // Throttle BEFORE any RPC/slug I/O — bounds RPC + serializes the burst.
  const reserve = await reserveAttemptOrReject(db, session.userId, new Date());
  if (!reserve.ok) return json({ error: 'rate_limited', scope: reserve.scope }, 429);

  let target: CommentTarget;
  if (parsed.scope === 'main') {
    // Tri-state: 'absent' is a real 404; 'unverifiable' means the RPC read
    // threw (provider down / rate-limited) — still fail closed (no write),
    // but 503 so the UI says "try again" instead of a misleading "not found".
    const check = await checkMainMarket(parsed.marketId);
    if (check === 'absent') return json({ error: 'market_not_found' }, 404);
    if (check === 'unverifiable') {
      return json({ error: 'market_check_unavailable' }, 503);
    }
    target = resolveMainTarget(parsed.marketId);
  } else {
    if (!isPmEnabled()) return json({ error: 'not_found' }, 404);
    const pm = await resolvePmTarget(parsed.slug);
    if (!pm) return json({ error: 'not_found' }, 404);
    if (!pm.commentsEnabled) return json({ error: 'comments_disabled' }, 403);
    target = pm.target;
  }

  const result = await createComment(db, {
    target,
    userId: session.userId,
    parentId: parsed.parentId,
    body: parsed.body,
  });
  if (!result.ok) {
    const status = result.error === 'parent_not_found' ? 404 : 400;
    return json({ error: result.error }, status);
  }
  return Response.json({ ok: true, id: result.id }, { status: 201 });
}
