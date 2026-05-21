import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getMakoLabelsBatch } from '@/lib/mako-labels-server';
import type { MakoLabelsRow } from '@/lib/mako-labels';

/**
 * GET /api/mako-labels?ids=<id1>,<id2>,...
 *
 * Public read endpoint for MAKO outcome labels. Always batch-shaped — the
 * single-market client hook (`useMakoLabels(marketId)`) calls this same
 * route with one id and unwraps `labels[0] ?? null`. One endpoint, one
 * server handler, one DAO call (see plan round 8).
 *
 * No auth. Label strings are display-only and not secrets; the wire shape
 * is exactly what an unauthenticated viewer of a MAKO market would see.
 *
 * Response shape:
 *   { labels: Array<{ marketId: string; label1: string; label2: string }> }
 *
 *   The array omits ids that have no DB row — callers fall back to
 *   "YES" / "NO" for those (per the fallback rule in mako-labels.ts).
 *
 * Caps:
 *   - `ids.length` must be ≤ 100 per request. The home feed paginates well
 *     below this; the cap protects against pathological URLs. Over the
 *     cap returns 400.
 *   - Each id must be a numeric string. Non-numeric ids are silently
 *     dropped from the input by the DAO (rather than 400'd) so a single
 *     bad id doesn't break a multi-id request.
 *
 * Empty input (`ids=` or no `ids` query param) returns `{ labels: [] }`
 * without touching the DB. The client-side batched hook also short-
 * circuits before issuing the fetch when its input array is empty, so
 * the all-non-MAKO-feed case incurs zero network/DB cost.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IDS_PER_REQUEST = 100;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get('ids');
  const ids = (idsParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (ids.length === 0) {
    return NextResponse.json({ labels: [] });
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json(
      { error: 'too_many_ids', max: MAX_IDS_PER_REQUEST },
      { status: 400 },
    );
  }

  try {
    const map = await getMakoLabelsBatch(db, ids);
    const labels: MakoLabelsRow[] = [];
    for (const [marketId, l] of map) {
      labels.push({ marketId, label1: l.label1, label2: l.label2 });
    }
    return NextResponse.json({ labels });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'read_failed';
    return NextResponse.json({ error: 'read_failed', message }, { status: 500 });
  }
}
