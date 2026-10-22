// ----------------------------------------------------------------------------
// #214 Notifications S1: announcing terminal chain events (NOTIFICATIONS_PLAN r8 §3.2).
//
// Used by both scans (the V4 batch writer in leaderboard/indexer.ts, and rounds-scan.ts). No `server-only` import:
// scripts/seed-leaderboard.mts runs the V4 scan under tsx, where that package throws.
//
// History guard (notify_cursor). Inside every batch transaction that announces a terminal event: seed the row from
// NOTIFY_FROM_BLOCK − 1 if it is missing, lock it, announce only events above it, raise it to the batch end. With no
// row and no env var nothing is announced (fail closed). Only notifying scans write it, so an old build that moves
// the ledger cursor without notifying cannot make a result count as announced (Invariant H, §3.10).
//
// Recipient history (Invariant R, §3.2 "Recipient history"). Before the transaction that moves notified_through past
// an event, the whole roster of that pool or round is in hand: the ledger roster (committed rows plus this batch's
// rows) when its per-side address counts equal the contract's own counts at 'finalized', else every Mako account
// address's position read from the contract at 'finalized'. The membership instant is the batch COMMIT:
//   step 0  read account_address_version (V0) before any users / user_safes read;
//   step 5  the transaction's last statement is `SELECT version … FOR SHARE`; it commits only on V0. Every write that
//           adds, changes, moves or removes an account address raises the version in its own transaction through
//           0020's triggers, so a write committed before the check is seen, one in flight is waited for, and one that
//           reaches its trigger after the check waits for this commit;
//   step 6  a moved version, or a foreign-key failure (23503) of a notification insert (a recipient's users row was
//           deleted while the transaction ran), throws RosterChanged; the transaction rolls back and the roster step
//           runs again, at most 3 attempts. The fetched logs and the 'finalized' re-reads are reused. If every attempt
//           sees a change the batch fails with 'roster_changed': neither empty nor committed, so it is fetched again.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import type { PublicClient } from 'viem';

import type { DbOrTx } from '@/db/client';
import { isCreatorFeeForfeited } from '@/lib/bet';
import { accountAddresses, accountUserIds } from '@/lib/leaderboard/identity';
import { withRpcRetry } from '@/lib/leaderboard/rpc-gate';
import { makoAbi } from '@/lib/MakoMarkets.abi';

import { poolCreatorKey, poolResultKey } from './keys';
import { KIND_DEFAULTS, prefOnColumn, type NotificationKind } from './prefs';

export const MAX_ROSTER_ATTEMPTS = 3;

/// The version moved, or a recipient was deleted mid-transaction: roll back and read the roster again.
export class RosterChanged extends Error {
  constructor(why: string) {
    super(`account registry changed during the batch (${why})`);
    this.name = 'RosterChanged';
  }
}

/// Every attempt saw the registry change. The scan reports `error: 'roster_changed'`.
export class RosterAttemptsExhausted extends Error {
  constructor() {
    super('roster_changed');
    this.name = 'RosterAttemptsExhausted';
  }
}

/// A roster attempt would start after the route's hard stop (plan §3.9): the batch fails, nothing is skipped.
export class RosterHardStop extends Error {
  constructor() {
    super('hard stop reached before a roster attempt');
    this.name = 'RosterHardStop';
  }
}

/// Where the roster rule reads account addresses. Injectable so tests can commit a registry write between the reads
/// and the commit; production always uses identity.ts.
export interface AccountSource {
  addresses(db: DbOrTx, chainId: number): Promise<string[]>;
  userIds(db: DbOrTx, addresses: readonly string[], chainId: number): Promise<Map<string, string[]>>;
}
export const DEFAULT_ACCOUNTS: AccountSource = { addresses: accountAddresses, userIds: accountUserIds };

const rowsOf = <T>(res: unknown): T[] => {
  const raw = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return (Array.isArray(raw) ? raw : []) as T[];
};

// ---- Floor ------------------------------------------------------------------

/// NOTIFY_FROM_BLOCK when it is a valid positive integer, else null. It only seeds notify_cursor.
export function notifyFromBlockEnv(raw = process.env.NOTIFY_FROM_BLOCK): number | null {
  if (raw === undefined || !/^\s*[0-9]{1,15}\s*$/.test(raw)) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/// F: the contract's notified_through, or NOTIFY_FROM_BLOCK − 1 when no row exists, or null (no floor).
export async function readNotifyFloor(
  db: DbOrTx,
  chainId: number,
  contractLower: string,
  notifyFromBlock: number | null,
): Promise<{ floor: number | null; fromRow: boolean }> {
  const rows = rowsOf<{ nt: number | string }>(
    await db.execute(sql`SELECT notified_through AS nt FROM notify_cursor WHERE chain_id = ${chainId} AND contract_address = ${contractLower}`),
  );
  if (rows.length > 0) return { floor: Number(rows[0].nt), fromRow: true };
  return { floor: notifyFromBlock === null ? null : notifyFromBlock - 1, fromRow: false };
}

// ---- Rows -------------------------------------------------------------------

export interface NotificationInsert {
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  data: Record<string, unknown>;
  eventAt: Date;
  /// The terminal event's block: rows of events at or below the locked notified_through are dropped.
  blockNumber: number;
}

/// Inserts rows for users whose kind switch is on (prefOnColumn casts only a JSON boolean). Selecting from users
/// means a user deleted before this statement yields no row; one deleted while it runs fails the foreign-key check
/// with 23503, which the caller turns into RosterChanged.
export async function insertNotifications(tx: DbOrTx, rows: readonly NotificationInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(
    rows.map(
      (r) =>
        sql`(${r.userId}::uuid, ${r.kind}::text, ${r.dedupeKey}::text, ${JSON.stringify(r.data)}::jsonb, ${r.eventAt.toISOString()}::timestamptz, ${KIND_DEFAULTS[r.kind]}::boolean)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO notifications (user_id, kind, dedupe_key, data, event_at)
    SELECT v.user_id, v.kind, v.dedupe_key, v.data, v.event_at
      FROM (VALUES ${values}) AS v(user_id, kind, dedupe_key, data, event_at, dflt)
      JOIN users u ON u.id = v.user_id
     WHERE ${prefOnColumn(sql`v.kind`, sql`v.dflt`)}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);
}

const isForeignKeyViolation = (err: unknown): boolean => {
  for (let e: unknown = err, i = 0; e && typeof e === 'object' && i < 8; e = (e as { cause?: unknown }).cause, i += 1) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
};

// ---- Announce ---------------------------------------------------------------

/// Address -> the sides it holds a stake on ('yes'/'no' for pools, 'up'/'down' for rounds).
export type Roster = Map<string, Set<string>>;

export interface AnnounceItem {
  blockNumber: number;
  /// One roster attempt: the ledger roster when it matches the contract's counts, else positions read from the
  /// contract for `accounts()` (read lazily, after V0). Throws when a read fails, which fails the batch.
  resolveRoster(accounts: () => Promise<string[]>): Promise<{ roster: Roster; fromChain: boolean }>;
  /// Addresses besides the roster that may receive a row (a pool's creator).
  extraAddresses: readonly string[];
  /// The rows for this event, given the roster and the account mapping.
  buildRows(roster: Roster, usersOf: (address: string) => readonly string[]): NotificationInsert[];
}

export interface AnnounceArgs {
  db: DbOrTx;
  chainId: number;
  contractLower: string;
  batchEnd: number;
  /// NOTIFY_FROM_BLOCK − 1, used only to create a missing notify_cursor row; null when the env var is unset.
  seedNotifiedThrough: number | null;
  items: readonly AnnounceItem[];
  /// The batch's own rows (ledger events or round entrants), inside the transaction; returns how many landed.
  writeRows(tx: DbOrTx): Promise<number>;
  /// The ownership-gated scan-cursor advance to batchEnd, inside the transaction.
  advanceCursor(tx: DbOrTx): Promise<void>;
  accounts?: AccountSource;
  /// No roster attempt starts at or after this time (ms).
  hardStopAt?: number;
  now?: () => number;
  /// Test seam (the two-connection tests): runs inside the transaction after the version check passed, before COMMIT.
  afterVersionCheck?: () => Promise<void>;
}

export interface AnnounceResult {
  inserted: number;
  rosterFromChain: number;
  notifiedThrough: number;
}

type Tx = DbOrTx & { transaction: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };

async function readVersion(db: DbOrTx, forShare: boolean): Promise<number> {
  const rows = rowsOf<{ version: number | string }>(
    await db.execute(
      forShare
        ? sql`SELECT version FROM account_address_version WHERE id FOR SHARE`
        : sql`SELECT version FROM account_address_version WHERE id`,
    ),
  );
  if (rows.length === 0) throw new Error('account_address_version row is missing (migration 0020 not applied?)');
  return Number(rows[0].version);
}

/// Writes one batch that holds terminal events above notified_through: the batch's rows, the notifications, the
/// notify_cursor statements and the cursor advance in one transaction, under the version check and bounded retry.
export async function announceBatch(args: AnnounceArgs): Promise<AnnounceResult> {
  const accounts = args.accounts ?? DEFAULT_ACCOUNTS;
  const now = args.now ?? Date.now;
  const { db, chainId, contractLower } = args;
  for (let attempt = 1; attempt <= MAX_ROSTER_ATTEMPTS; attempt += 1) {
    if (args.hardStopAt !== undefined && now() >= args.hardStopAt) throw new RosterHardStop();
    // Step 0: the version, before any users / user_safes read of this attempt.
    const v0 = await readVersion(db, false);
    let accountList: Promise<string[]> | null = null;
    const lazyAccounts = () => (accountList ??= accounts.addresses(db, chainId));
    const resolved = [];
    for (const item of args.items) resolved.push({ item, ...(await item.resolveRoster(lazyAccounts)) });
    const lookup = new Set<string>();
    for (const r of resolved) {
      for (const a of r.roster.keys()) lookup.add(a);
      for (const a of r.item.extraAddresses) lookup.add(a.toLowerCase());
    }
    const users = await accounts.userIds(db, [...lookup], chainId);
    const usersOf = (a: string) => users.get(a.toLowerCase()) ?? [];
    const rows = resolved.flatMap((r) => r.item.buildRows(r.roster, usersOf));

    let inserted = 0;
    let notifiedThrough = 0;
    try {
      await (db as Tx).transaction(async (tx) => {
        inserted = await args.writeRows(tx);
        if (args.seedNotifiedThrough !== null) {
          await tx.execute(sql`
            INSERT INTO notify_cursor (chain_id, contract_address, notified_through)
            VALUES (${chainId}, ${contractLower}, ${args.seedNotifiedThrough})
            ON CONFLICT (chain_id, contract_address) DO NOTHING`);
        }
        const locked = rowsOf<{ nt: number | string }>(
          await tx.execute(sql`
            SELECT notified_through AS nt FROM notify_cursor
             WHERE chain_id = ${chainId} AND contract_address = ${contractLower} FOR UPDATE`),
        );
        if (locked.length === 0) throw new Error('notify_cursor row missing inside an announcing batch');
        const nt = Number(locked[0].nt);
        try {
          await insertNotifications(tx, rows.filter((r) => r.blockNumber > nt));
        } catch (err) {
          if (isForeignKeyViolation(err)) throw new RosterChanged('a recipient was deleted');
          throw err;
        }
        const raised = rowsOf<{ nt: number | string }>(
          await tx.execute(sql`
            UPDATE notify_cursor SET notified_through = GREATEST(notified_through, ${args.batchEnd})
             WHERE chain_id = ${chainId} AND contract_address = ${contractLower}
            RETURNING notified_through AS nt`),
        );
        notifiedThrough = Number(raised[0].nt);
        await args.advanceCursor(tx);
        // Step 5: the last statement. Waits for an in-flight address write, then sees its version.
        if ((await readVersion(tx, true)) !== v0) throw new RosterChanged('version moved');
        await args.afterVersionCheck?.();
      });
    } catch (err) {
      if (err instanceof RosterChanged) continue;
      throw err;
    }
    return { inserted, rosterFromChain: resolved.filter((r) => r.fromChain).length, notifiedThrough };
  }
  throw new RosterAttemptsExhausted();
}

// ---- Pools (V4) -------------------------------------------------------------

/// The fields of getMarket the producer uses. The question string is never stored, rendered or logged.
export interface MarketAtFinalized {
  creator: `0x${string}`;
  totalYes: bigint;
  totalNo: bigint;
  yesBettorCount: number;
  noBettorCount: number;
  outcome: number;
  resolved: boolean;
  creatorFeeBpsSnapshot: number;
}

/// Outcome enum of MakoMarketsV4 (src/lib/contract.ts Outcome).
const V4_YES = 1;
const V4_NO = 2;
const V4_REFUND = 3;

/// getMarket(id) at 'finalized' for every id, through the gate, retried on rate limits. Never logs the question.
export async function readMarketsAtFinalized(
  client: PublicClient,
  contract: `0x${string}`,
  ids: readonly bigint[],
  sleep?: (ms: number) => Promise<void>,
): Promise<MarketAtFinalized[]> {
  if (ids.length === 0) return [];
  const res = await withRpcRetry(
    () =>
      client.multicall({
        contracts: ids.map((id) => ({ address: contract, abi: makoAbi, functionName: 'getMarket' as const, args: [id] as const })),
        allowFailure: false,
        blockTag: 'finalized',
      }),
    sleep,
  );
  return (res as unknown as MarketAtFinalized[]).map((m) => ({
    creator: m.creator,
    totalYes: m.totalYes,
    totalNo: m.totalNo,
    yesBettorCount: Number(m.yesBettorCount),
    noBettorCount: Number(m.noBettorCount),
    outcome: Number(m.outcome),
    resolved: m.resolved,
    creatorFeeBpsSnapshot: Number(m.creatorFeeBpsSnapshot),
  }));
}

/// Sides held per address in the committed ledger plus this batch's BetPlaced rows for `marketId`.
export async function ledgerPoolRoster(
  db: DbOrTx,
  chainId: number,
  contractLower: string,
  marketId: string,
  batchBets: readonly { actor: string; isYes: boolean }[],
): Promise<Roster> {
  const rows = rowsOf<{ actor: string; yes: boolean; no: boolean }>(
    await db.execute(sql`
      SELECT actor, bool_or(is_yes) AS yes, bool_or(NOT is_yes) AS no
        FROM mako_market_events
       WHERE chain_id = ${chainId} AND contract_address = ${contractLower} AND market_id = ${marketId} AND kind = 'bet'
       GROUP BY actor`),
  );
  const roster: Roster = new Map();
  const add = (a: string, side: string) => {
    const s = roster.get(a) ?? new Set<string>();
    s.add(side);
    roster.set(a, s);
  };
  for (const r of rows) {
    if (r.yes) add(r.actor.toLowerCase(), 'yes');
    if (r.no) add(r.actor.toLowerCase(), 'no');
  }
  for (const b of batchBets) add(b.actor.toLowerCase(), b.isYes ? 'yes' : 'no');
  return roster;
}

const countSide = (roster: Roster, side: string) => [...roster.values()].filter((s) => s.has(side)).length;

/// Groups the roster's sides by account: one row per user per thing, whatever addresses they bet from.
function sidesByUser(roster: Roster, usersOf: (a: string) => readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [addr, sides] of roster) {
    for (const uid of usersOf(addr)) {
      const s = out.get(uid) ?? new Set<string>();
      for (const side of sides) s.add(side);
      out.set(uid, s);
    }
  }
  return out;
}

export interface PoolEvent {
  contractLower: `0x${string}`;
  chainId: number;
  id: bigint;
  outcome: number;
  blockNumber: number;
  eventAt: Date;
  market: MarketAtFinalized;
  batchBets: readonly { actor: string; isYes: boolean }[];
}

export function poolItem(
  db: DbOrTx,
  client: PublicClient,
  ev: PoolEvent,
  sleep?: (ms: number) => Promise<void>,
): AnnounceItem {
  const idStr = ev.id.toString();
  const m = ev.market;
  return {
    blockNumber: ev.blockNumber,
    extraAddresses: [m.creator],
    async resolveRoster(accounts) {
      const ledger = await ledgerPoolRoster(db, ev.chainId, ev.contractLower, idStr, ev.batchBets);
      if (countSide(ledger, 'yes') === m.yesBettorCount && countSide(ledger, 'no') === m.noBettorCount) {
        return { roster: ledger, fromChain: false };
      }
      const addrs = await accounts();
      const roster: Roster = new Map();
      if (addrs.length > 0) {
        const bets = (await withRpcRetry(
          () =>
            client.multicall({
              contracts: addrs.map((a) => ({ address: ev.contractLower, abi: makoAbi, functionName: 'getUserBet' as const, args: [ev.id, a as `0x${string}`] as const })),
              allowFailure: false,
              blockTag: 'finalized',
            }),
          sleep,
        )) as unknown as (readonly [bigint, bigint, boolean])[];
        addrs.forEach((a, i) => {
          const sides = new Set<string>();
          if (bets[i][0] > 0n) sides.add('yes');
          if (bets[i][1] > 0n) sides.add('no');
          if (sides.size > 0) roster.set(a, sides);
        });
      }
      return { roster, fromChain: true };
    },
    buildRows(roster, usersOf) {
      const rows: NotificationInsert[] = [];
      const base = { eventAt: ev.eventAt, blockNumber: ev.blockNumber };
      const key = poolResultKey(ev.contractLower, idStr);
      const outcome = ev.outcome === V4_YES ? 'yes' : ev.outcome === V4_NO ? 'no' : 'refund';
      for (const [userId, sides] of sidesByUser(roster, usersOf)) {
        if (ev.outcome === V4_REFUND) {
          rows.push({ ...base, userId, kind: 'claim', dedupeKey: key, data: { t: 'pool', id: idStr, outcome, why: 'refund' } });
        } else if (sides.has(outcome)) {
          rows.push({ ...base, userId, kind: 'claim', dedupeKey: key, data: { t: 'pool', id: idStr, outcome, why: 'won' } });
        } else {
          rows.push({ ...base, userId, kind: 'result', dedupeKey: key, data: { t: 'pool', id: idStr, outcome, side: outcome === 'yes' ? 'no' : 'yes' } });
        }
      }
      // Creator earnings: only on a YES/NO outcome with a fee snapshot above 0, a fee above 0 (the contract's integer
      // math, claimCreatorFee), and not forfeited. MAKO pools snapshot 0.
      const bps = BigInt(m.creatorFeeBpsSnapshot);
      if ((ev.outcome === V4_YES || ev.outcome === V4_NO) && bps > 0n && ((m.totalYes + m.totalNo) * bps) / 10_000n > 0n && !isCreatorFeeForfeited(m.totalYes, m.totalNo, bps)) {
        for (const userId of usersOf(m.creator)) {
          rows.push({ ...base, userId, kind: 'claim', dedupeKey: poolCreatorKey(ev.contractLower, idStr), data: { t: 'pool', id: idStr, outcome, why: 'creator' } });
        }
      }
      return rows;
    },
  };
}

/// True when the 'finalized' re-read confirms the event: resolved, with the event's outcome.
export const marketConfirms = (m: MarketAtFinalized, outcome: number) => m.resolved === true && m.outcome === outcome;
