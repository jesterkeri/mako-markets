import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from '@/lib/chain';
import { makoAbi, MAKO_ADDRESS, MarketType, type MarketWithId } from '@/lib/contract';
import { getAdminSession } from '@/lib/admin-session';
import { db } from '@/db/client';
import { upsertMakoLabels } from '@/lib/mako-labels-server';
import {
  MAKO_LABEL_MAX_BYTES,
  utf8ByteLength,
  validateLabelPair,
} from '@/lib/mako-labels';

/**
 * POST /api/admin/mako-labels
 *
 * Admin write surface for MAKO outcome labels. The chain holds the binary
 * outcome (`Outcome.YES = 1` / `Outcome.NO = 2`); this DB row supplies the
 * display strings (`label_1`, `label_2`) that the UI uses in place of
 * "YES"/"NO" for that market.
 *
 * Auth: SIWE admin session via `getAdminSession()`. The `/admin/create-mako`
 * page gates on `useIsAdmin()` + `useAdminSession()` so by the time a POST
 * lands here the cookie should exist; 401 is the path-of-last-resort signal
 * that the client got out of sync (e.g. cookie expired between gate check
 * and submit), and the create-mako page surfaces a toast pointing at the
 * edit route for recovery.
 *
 * Chain reads (defense in depth — the UI also checks):
 *   1. `getMarket(marketId)` confirms the row exists on chain.
 *   2. `m.mType === MAKO` rejects non-MAKO ids — labels are MAKO-only.
 *   3. `m.resolved === false` rejects retroactive label edits on resolved
 *      markets (a closed market's label history shouldn't drift after the
 *      fact; the edit surface also disables the form when resolved, but
 *      we re-check here so an out-of-date client can't bypass it).
 *
 * Validation rule (binding — see mako-labels.ts):
 *   Both labels must be non-empty and each ≤ MAKO_LABEL_MAX_BYTES bytes.
 *   The "empty pair" mode (no row written, fallback to YES/NO) is NOT a
 *   write — the admin form simply skips the POST when labels are blank.
 *   This route always writes; a body with one blank label is a 400.
 *
 * Idempotency: `upsertMakoLabels` does `ON CONFLICT (market_id) DO UPDATE`,
 * so the edit surface and the create-flow's post-tx save share one code path.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RPC_URL =
  process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];

const BodySchema = z
  .object({
    marketId: z.string().regex(/^[0-9]+$/, 'marketId must be a numeric string'),
    label1: z.string().min(1, 'label1 is required').refine(
      (s) => utf8ByteLength(s.trim()) <= MAKO_LABEL_MAX_BYTES,
      `label1 exceeds ${MAKO_LABEL_MAX_BYTES} UTF-8 bytes`,
    ),
    label2: z.string().min(1, 'label2 is required').refine(
      (s) => utf8ByteLength(s.trim()) <= MAKO_LABEL_MAX_BYTES,
      `label2 exceeds ${MAKO_LABEL_MAX_BYTES} UTF-8 bytes`,
    ),
  })
  .strict();

export async function POST(req: Request) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { marketId, label1: rawLabel1, label2: rawLabel2 } = parsed.data;

  /// Re-run the shared validator. zod above covers the byte cap on each
  /// field individually; the validator covers the both-or-neither rule
  /// (zod's `min(1)` already rejects single-empty, but the validator's
  /// trim normalization mirrors what the DB row will actually store).
  const labelCheck = validateLabelPair(rawLabel1, rawLabel2);
  if (!labelCheck.ok) {
    return NextResponse.json(
      { error: 'invalid_labels', reason: labelCheck.reason },
      { status: 400 },
    );
  }
  if (labelCheck.mode === 'empty') {
    /// Shouldn't reach here because zod enforces min(1), but guard anyway.
    return NextResponse.json({ error: 'empty_labels' }, { status: 400 });
  }

  const label1 = rawLabel1.trim();
  const label2 = rawLabel2.trim();

  /// Chain-side checks. The market must exist, be MAKO, and not be
  /// resolved. We do these AFTER input validation so a malformed body
  /// can't burn an RPC call.
  const client = createPublicClient({
    chain: monadTestnet,
    transport: http(RPC_URL),
  });

  let market: MarketWithId | null;
  try {
    const m = (await client.readContract({
      address: MAKO_ADDRESS,
      abi: makoAbi,
      functionName: 'getMarket',
      args: [BigInt(marketId)],
    })) as Omit<MarketWithId, 'id'>;
    market = m && m.question ? { ...m, id: BigInt(marketId) } : null;
  } catch {
    market = null;
  }

  if (!market) {
    return NextResponse.json({ error: 'market_not_found' }, { status: 404 });
  }
  if (market.mType !== MarketType.MAKO) {
    return NextResponse.json(
      { error: 'not_mako_market', mType: market.mType },
      { status: 400 },
    );
  }
  if (market.resolved) {
    return NextResponse.json(
      { error: 'market_resolved' },
      { status: 409 },
    );
  }

  /// All checks passed — persist.
  try {
    const persisted = await upsertMakoLabels(db, {
      marketId,
      label1,
      label2,
    });
    return NextResponse.json({
      ok: true,
      marketId,
      label1: persisted.label1,
      label2: persisted.label2,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'upsert_failed';
    return NextResponse.json({ error: 'upsert_failed', message }, { status: 500 });
  }
}
