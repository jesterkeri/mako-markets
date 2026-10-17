import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { parseChartColors } from '@/lib/chart-colors';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';

// GET  /api/user/chart-colors -> { colors: ChartColors | null }   (null = TradingView defaults)
// POST /api/user/chart-colors  { colors: ChartColors | null } -> { colors }
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
  let body: { colors?: unknown };
  try {
    body = (await req.json()) as { colors?: unknown };
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const colors = body?.colors === null ? null : parseChartColors(body?.colors);
  if (body?.colors !== null && colors === null) return Response.json({ error: 'bad_body' }, { status: 400 });
  const updated = await db.update(users).set({ chartColors: colors }).where(eq(users.id, session.userId)).returning({ id: users.id });
  if (updated.length === 0) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json({ colors });
}
