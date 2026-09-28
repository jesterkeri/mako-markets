// WatchState: one SQLite-backed Durable Object holding the run lease and what the watch has already said.
// Each RPC is one synchronous storage transaction, so acquire and commit are atomic.

import { DurableObject } from 'cloudflare:workers';

/// Shorter than the five-minute cron period, so a crashed run's lease is free for the next one.
export const LEASE_MS = 240_000;

export type AlertKind = 'unsettled' | 'no-price';

export interface Meta {
  /// Every round id below this one is terminal and fully reported; the scan starts here.
  cursor: number;
  /// Per round id: when each alert kind was DELIVERED (Telegram confirmed). An undelivered alert is retried.
  alerted: Record<string, Partial<Record<AlertKind, number>>>;
  lastStatus: string | null;
  lastRunAt: number | null;
}

export const INITIAL_META: Meta = { cursor: 1, alerted: {}, lastStatus: null, lastRunAt: null };

export type AcquireResult = { ok: true; token: number; meta: Meta } | { ok: false };

export class WatchState extends DurableObject<Record<string, never>> {
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

  /// Saves what was delivered and releases the lease, only while `token` still holds it.
  commit(token: number, meta: Meta, now: number): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number; expires_at: number }>(
        `SELECT token, held, expires_at FROM lease WHERE id = 1`,
      ).one();
      if (lease.token !== token || lease.held !== 1 || lease.expires_at <= now) return { ok: false };
      sql.exec(`UPDATE meta SET json = ? WHERE id = 1`, JSON.stringify(meta));
      sql.exec(`UPDATE lease SET held = 0 WHERE id = 1`);
      return { ok: true };
    });
  }
}
