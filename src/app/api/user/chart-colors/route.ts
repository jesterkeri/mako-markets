import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users, userSafes } from '@/db/schema';
import { parseChartColors } from '@/lib/chart-colors';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';

// GET  /api/user/chart-colors -> { colors: ChartColors | null }   (null = TradingView defaults)
// POST /api/user/chart-colors  { account, colors: ChartColors | null } -> { colors }
//   `account` is the address the change was made on (wallet, or Safe for email accounts); 409 if the session is now
//   another account, so a save made before a sign-in elsewhere never lands on the new account.
// The signed-in user's candle colours (src/lib/chart-colors.ts). Signed out: 401; the charts then use the defaults.

export async function GET() {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await db.select({ chartColors: users.chartColors }).from(users).where(eq(users.id, session.userId)).limit(1);
  if (rows.length === 0) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json({ colors: parseChartColors(rows[0].chartColors) });
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: { account?: unknown; colors?: unknown };
  try {
    body = (await req.json()) as { account?: unknown; colors?: unknown };
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const colors = body?.colors === null ? null : parseChartColors(body?.colors);
  if (body?.colors !== null && colors === null) return Response.json({ error: 'bad_body' }, { status: 400 });
  if (typeof body.account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.account)) return Response.json({ error: 'bad_body' }, { status: 400 });
  const account = body.account.toLowerCase();
  const updated = await db
    .update(users)
    .set({ chartColors: colors })
    .where(
      and(
        eq(users.id, session.userId),
        sql`(lower(${users.walletAddress}) = ${account} OR EXISTS (SELECT 1 FROM ${userSafes} WHERE ${userSafes.userId} = ${users.id} AND lower(${userSafes.safeAddress}) = ${account}))`,
      ),
    )
    .returning({ id: users.id });
  if (updated.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
  return Response.json({ colors });
}
