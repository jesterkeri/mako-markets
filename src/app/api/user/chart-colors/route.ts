import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users, userSafes } from '@/db/schema';
import { DEFAULT_CHART_COLORS, mergeChartColors, parseChartColorPatch, parseChartColors } from '@/lib/chart-colors';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';

// GET  /api/user/chart-colors?account=0x… -> { colors: ChartColors | null }   (null = TradingView defaults)
// POST /api/user/chart-colors  { account, patch: Partial<ChartColors> | null } -> { colors }   (null patch = Reset)
//   The change is merged into what the account holds; the answer is the resulting set.
//   `account` is the address the read or change is for (wallet, or Safe for email accounts); 409 if the session is now
//   another account, so neither a read nor a save made before a sign-in elsewhere crosses accounts.
// The signed-in user's candle colours (src/lib/chart-colors.ts). Signed out: 401; the charts then use the defaults.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/// The session's own row, and only while `account` (any case) is its wallet address or one of its Safes.
const ownRow = (userId: string, account: string) =>
  and(
    eq(users.id, userId),
    sql`(lower(${users.walletAddress}) = ${account.toLowerCase()} OR EXISTS (SELECT 1 FROM ${userSafes} WHERE ${userSafes.userId} = ${users.id} AND lower(${userSafes.safeAddress}) = ${account.toLowerCase()}))`,
  );

export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const account = new URL(req.url).searchParams.get('account') ?? '';
  if (!ADDRESS_RE.test(account)) return Response.json({ error: 'bad_account' }, { status: 400 });
  const rows = await db.select({ chartColors: users.chartColors }).from(users).where(ownRow(session.userId, account)).limit(1);
  if (rows.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
  return Response.json({ colors: parseChartColors(rows[0].chartColors) });
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: { account?: unknown; patch?: unknown };
  try {
    body = (await req.json()) as { account?: unknown; patch?: unknown };
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const patch = body?.patch === null ? null : parseChartColorPatch(body?.patch);
  if (body?.patch !== null && patch === null) return Response.json({ error: 'bad_body' }, { status: 400 });
  if (typeof body.account !== 'string' || !ADDRESS_RE.test(body.account)) return Response.json({ error: 'bad_body' }, { status: 400 });
  const where = ownRow(session.userId, body.account);
  // Merged in the database, in the one statement, so two tabs (or two devices) changing different colours both stick.
  const merged =
    patch === null
      ? null
      : sql`COALESCE(${users.chartColors}, ${JSON.stringify(DEFAULT_CHART_COLORS)}::jsonb) || ${JSON.stringify(patch)}::jsonb`;
  for (let attempt = 0; ; attempt++) {
    const updated = await db.update(users).set({ chartColors: merged }).where(where).returning({ chartColors: users.chartColors });
    if (updated.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
    if (patch === null) return Response.json({ colors: null });
    const colors = parseChartColors(updated[0].chartColors);
    if (colors) return Response.json({ colors });
    // A malformed stored value merged into junk: replace it with the change over the defaults, only if it is still that
    // junk (compare and set); if another save got there first, merge again onto what it wrote, once.
    const repaired = mergeChartColors(null, patch);
    const fixed = await db
      .update(users)
      .set({ chartColors: repaired })
      .where(and(where, sql`${users.chartColors} = ${JSON.stringify(updated[0].chartColors)}::jsonb`))
      .returning({ id: users.id });
    if (fixed.length > 0 || attempt > 0) return Response.json({ colors: repaired });
  }
}
