// KeeperState: one SQLite-backed Durable Object holding the run lease and the keeper's memory between runs.
// Each RPC is one synchronous storage transaction with no await inside, so acquire and commit are atomic.
//
// Guarantees the keeper relies on:
//   - at most one run holds the lease, so two runs can never sign with the same nonce;
//   - a run that lost the lease (it expired, another run took it) cannot commit;
//   - the in-flight transaction survives between runs, so the next run checks it before sending another.

import { DurableObject } from 'cloudflare:workers';

/// Shorter than the one-minute cron period, so a crashed run's lease is free for the next one.
export const LEASE_MS = 50_000;

/// What a transaction does. Older records without `kind` are settlements.
export type TxKind = 'settle' | 'round-refund' | 'pool-refund';

export interface InFlight {
  hash: string;
  nonce: number;
  /// The round id for a settlement or round refund; the V4 market id for a pool refund.
  roundId: string;
  sentAt: number;
  kind?: TxKind;
}

export interface Meta {
  inFlight: InFlight | null;
  /// When the keeper first became unhealthy, continuously; null while healthy.
  unhealthySince: number | null;
  lastStatus: string | null;
  lastRunAt: number | null;
  /// Per pending round id: when the keeper last tried it (ms), so rounds take turns.
  attempts: Record<string, number>;
  /// Per pending round id: transactions that reverted on chain or were dropped. At 2 the round is no longer
  /// sent (it would only burn gas) and the keeper raises an alarm until the round leaves pendingSettlement.
  txFailures: Record<string, number>;
  /// Refund discovery (Joshua 2026-09-29: after 24 hours, refund automatically). For each contract: the next
  /// id not yet read, and the ids still open (non-terminal round, unresolved V4 market), re-read every run.
  roundsCursor: number;
  roundsOpen: number[];
  poolsCursor: number;
  poolsOpen: number[];
  /// When each automatic V4 refund was SENT (ms), for the circuit breaker: 3 per hour, 6 per day.
  poolRefundsSent: number[];
  /// Set when the breaker trips; V4 refunds stay halted until REFUND_BREAKER_RESET is later than this.
  breakerTrippedAt: number | null;
}

export const INITIAL_META: Meta = {
  inFlight: null,
  unhealthySince: null,
  lastStatus: null,
  lastRunAt: null,
  attempts: {},
  txFailures: {},
  roundsCursor: 1,
  roundsOpen: [],
  poolsCursor: 0,
  poolsOpen: [],
  poolRefundsSent: [],
  breakerTrippedAt: null,
};

export type AcquireResult = { ok: true; token: number; meta: Meta } | { ok: false };
export type CommitResult = { ok: true } | { ok: false };

export class KeeperState extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token INTEGER NOT NULL, held INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
      sql.exec(`INSERT OR IGNORE INTO lease (id, token, held, expires_at) VALUES (1, 0, 0, 0)`);
      sql.exec(`INSERT OR IGNORE INTO meta (id, json) VALUES (1, ?)`, JSON.stringify(INITIAL_META));
    });
  }

  acquire(now: number): AcquireResult {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number; expires_at: number }>(
        `SELECT token, held, expires_at FROM lease WHERE id = 1`,
      ).one();
      if (lease.held === 1 && lease.expires_at > now) return { ok: false } as const;
      const token = lease.token + 1;
      sql.exec(`UPDATE lease SET token = ?, held = 1, expires_at = ? WHERE id = 1`, token, now + LEASE_MS);
      const meta = JSON.parse(sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`).one().json) as Meta;
      return { ok: true, token, meta } as const;
    });
  }

  /// Records a signed transaction BEFORE it is sent (its hash is known once signed), only if `token` still
  /// holds the lease. A run that sends and then crashes has therefore always left its transaction behind for
  /// the next run to check; a run that cannot record it does not send.
  recordInFlight(token: number, inFlight: InFlight, now: number, extra: Partial<Meta> = {}): CommitResult {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number; expires_at: number }>(
        `SELECT token, held, expires_at FROM lease WHERE id = 1`,
      ).one();
      if (lease.token !== token || lease.held !== 1 || lease.expires_at <= now) return { ok: false } as const;
      const meta = JSON.parse(sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`).one().json) as Meta;
      // `extra` rides in the same write: a refund's breaker count must survive a crash after sending.
      sql.exec(`UPDATE meta SET json = ? WHERE id = 1`, JSON.stringify({ ...meta, ...extra, inFlight }));
      return { ok: true } as const;
    });
  }

  /// Saves the run's memory and releases the lease, only if `token` still holds it and has not expired.
  commit(token: number, meta: Meta, now: number): CommitResult {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number; expires_at: number }>(
        `SELECT token, held, expires_at FROM lease WHERE id = 1`,
      ).one();
      if (lease.token !== token || lease.held !== 1 || lease.expires_at <= now) return { ok: false } as const;
      sql.exec(`UPDATE meta SET json = ? WHERE id = 1`, JSON.stringify(meta));
      sql.exec(`UPDATE lease SET held = 0 WHERE id = 1`);
      return { ok: true } as const;
    });
  }

  read(): Meta {
    return JSON.parse(this.ctx.storage.sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`).one().json) as Meta;
  }
}
