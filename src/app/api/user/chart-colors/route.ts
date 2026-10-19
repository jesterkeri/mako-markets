import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users, userSafes } from '@/db/schema';
import { CHART_COLOR_KEYS, DEFAULT_CHART_COLORS, parseChartColorPatch, parseChartColors } from '@/lib/chart-colors';
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
  // Merged in the database, in the one statement, so two tabs (or two devices) changing different colours both stick.
  // The stored value counts only if it is a complete valid set; anything else (null, or a malformed legacy value) is
  // replaced by the defaults inside the same statement, so there is no separate repair step to race (Codex
  // CHART_COLORS R1 F1). Nested CASE: the key checks run only on a JSON object.
  const held = sql`CASE WHEN jsonb_typeof(${users.chartColors}) = 'object' THEN (CASE WHEN ${users.chartColors} ?& ${sql.raw(`array['${CHART_COLOR_KEYS.join("','")}']`)}
      AND (SELECT count(*) FROM jsonb_object_keys(${users.chartColors})) = ${CHART_COLOR_KEYS.length}
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(${users.chartColors}) e WHERE jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~* '^#[0-9a-f]{6}$')
    THEN ${users.chartColors} ELSE ${JSON.stringify(DEFAULT_CHART_COLORS)}::jsonb END) ELSE ${JSON.stringify(DEFAULT_CHART_COLORS)}::jsonb END`;
  const merged = patch === null ? null : sql`(${held}) || ${JSON.stringify(patch)}::jsonb`;
  const updated = await db
    .update(users)
    .set({ chartColors: merged })
    .where(ownRow(session.userId, body.account))
    .returning({ chartColors: users.chartColors });
  if (updated.length === 0) return Response.json({ error: 'account_changed' }, { status: 409 });
  if (patch === null) return Response.json({ colors: null });
  const colors = parseChartColors(updated[0].chartColors);
  // Cannot happen (a valid set or the defaults, merged with a validated patch); never answer a set that was not written.
  if (!colors) return Response.json({ error: 'not_saved' }, { status: 500 });
  return Response.json({ colors });
}
