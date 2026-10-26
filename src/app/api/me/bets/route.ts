import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/db/client';
import { makoMarketEvents } from '@/db/schema';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS } from '@/lib/contract';
import { authorizeMeRoundsCaller } from '@/lib/me-rounds-caller';

/**
 * GET /api/me/bets?account=0x…&pool=<id>
 *
 * The signed-in caller's own bets on one pool, from the leaderboard ledger (mako_market_events, kind 'bet', the live
 * V4 contract), one row per BetPlaced log: Me's Share sheet makes one PnL card per bet. Own account only, the same
 * guard as /api/me/rounds (me-rounds-caller.ts). The ledger runs behind the chain (its cron), so the browser compares
 * the rows with the stake it read on chain and says so when they do not add up yet.
 *
 *   200 { bets: [{ tx: "0x…", log: 5, isYes: true, amount: "1000000", at: 1792134800 }] }   oldest first
 *   400 { error: "bad_request" }        account or pool missing or malformed
 *   401 / 403 / 503                     as /api/me/rounds (sign_in_required, not_your_account, caller_unavailable)
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL = /^\d{1,18}$/;
const NO_STORE = { 'cache-control': 'no-store' };

export type MeBetWire = { tx: string; log: number; isYes: boolean; amount: string; at: number };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const account = q.get('account') ?? '';
  const pool = q.get('pool') ?? '';
  if (q.getAll('account').length !== 1 || q.getAll('pool').length !== 1 || !ADDRESS.test(account) || !POOL.test(pool)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });
  }
  const caller = await authorizeMeRoundsCaller(account);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: NO_STORE });
  const rows = await db
    .select({ tx: makoMarketEvents.txHash, log: makoMarketEvents.logIndex, isYes: makoMarketEvents.isYes, amount: makoMarketEvents.amount, at: makoMarketEvents.blockTimestamp })
    .from(makoMarketEvents)
    .where(
      and(
        eq(makoMarketEvents.chainId, MONAD_TESTNET_ID),
        eq(makoMarketEvents.contractAddress, MAKO_ADDRESS.toLowerCase()),
        eq(makoMarketEvents.kind, 'bet'),
        eq(makoMarketEvents.marketId, BigInt(pool).toString()),
        eq(makoMarketEvents.actor, account.toLowerCase()),
      ),
    )
    .orderBy(asc(makoMarketEvents.blockNumber), asc(makoMarketEvents.logIndex));
  const bets: MeBetWire[] = rows.map((r) => ({ tx: r.tx.toLowerCase(), log: r.log, isYes: r.isYes === true, amount: String(r.amount), at: Math.floor(r.at.getTime() / 1000) }));
  return NextResponse.json({ bets }, { headers: NO_STORE });
}
