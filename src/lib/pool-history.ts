// The YES share of a pool over time (9a "YES share of the pool · SINCE OPENING"), from the Envio indexer's Bet entities.
// Every bet counts, the creator's seed and Mako Market's own included, because the share drawn must be the pool's real
// share at each moment: the same totals the contract holds.

import { z } from 'zod';

/// One step of the series: the moment after a bet, and YES as basis points of the pool then (0 to 10000).
export type SharePoint = { t: number; yesBps: number };

export type PoolHistory = { points: SharePoint[]; bets: number; indexedYes: string; indexedNo: string };

/// At most this many bets are read for one pool (pages of 1000). A pool past it answers `too_many`, never a cut series.
export const MAX_BETS = 5000;
const PAGE = 1000;

export const HISTORY_QUERY = `query PoolHistory($pool: String!, $offset: Int!, $limit: Int!) {
  Bet(where: { pool_id: { _eq: $pool } }, order_by: [{ timestamp: asc }, { id: asc }], offset: $offset, limit: $limit) { amount isYes timestamp }
  Pool(where: { id: { _eq: $pool } }) { totalYes totalNo betCount }
}`;

const big = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const Page = z.object({
  data: z.object({
    Bet: z.array(z.object({ amount: big, isYes: z.boolean(), timestamp: z.number().int().positive() })),
    Pool: z.array(z.object({ totalYes: big, totalNo: big, betCount: z.number().int().nonnegative() })).max(1),
  }),
});

export class HistoryError extends Error {
  override name = 'HistoryError';
}

/// The share series from bets in time order. Throws when the bets do not add up to the indexer's own pool totals, so a
/// half-read or inconsistent answer is an error, never a wrong chart.
export function shareSeries(bets: readonly { amount: bigint; isYes: boolean; timestamp: number }[], totals: { yes: bigint; no: bigint }): SharePoint[] {
  let yes = 0n;
  let no = 0n;
  const points: SharePoint[] = [];
  let lastT = 0;
  for (const b of bets) {
    if (b.timestamp < lastT) throw new HistoryError('bets out of order');
    lastT = b.timestamp;
    if (b.isYes) yes += b.amount;
    else no += b.amount;
    const total = yes + no;
    if (total === 0n) continue;
    const bps = Number((yes * 10000n) / total);
    const last = points[points.length - 1];
    // Several bets in one second are one moment: keep the share after the last of them.
    if (last && last.t === b.timestamp) last.yesBps = bps;
    else points.push({ t: b.timestamp, yesBps: bps });
  }
  if (yes !== totals.yes || no !== totals.no) throw new HistoryError('bets do not add up to the pool totals');
  return points;
}

/// Reads every bet of `poolId` from the indexer at `url`, or throws.
export async function fetchPoolHistory(url: string, poolId: bigint, signal?: AbortSignal): Promise<PoolHistory | 'too_many' | 'unknown_pool'> {
  const pool = poolId.toString();
  const bets: { amount: bigint; isYes: boolean; timestamp: number }[] = [];
  let totals: { yes: bigint; no: bigint; count: number } | null = null;
  for (let offset = 0; offset < MAX_BETS; offset += PAGE) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: HISTORY_QUERY, variables: { pool, offset, limit: PAGE } }),
      cache: 'no-store',
      signal,
    });
    if (!res.ok) throw new HistoryError(`indexer answered ${res.status}`);
    const parsed = Page.safeParse(await res.json());
    if (!parsed.success) throw new HistoryError('indexer answer not usable');
    const { Bet, Pool } = parsed.data.data;
    if (Pool.length === 0) return 'unknown_pool';
    const p = { yes: Pool[0].totalYes, no: Pool[0].totalNo, count: Pool[0].betCount };
    if (totals && (totals.yes !== p.yes || totals.no !== p.no || totals.count !== p.count)) {
      throw new HistoryError('pool changed while it was being read');
    }
    totals = p;
    if (totals.count > MAX_BETS) return 'too_many';
    bets.push(...Bet);
    if (Bet.length < PAGE) break;
  }
  if (!totals) throw new HistoryError('no answer');
  if (bets.length !== totals.count) throw new HistoryError('bet count does not match the pool');
  return {
    points: shareSeries(bets, { yes: totals.yes, no: totals.no }),
    bets: bets.length,
    indexedYes: totals.yes.toString(),
    indexedNo: totals.no.toString(),
  };
}
