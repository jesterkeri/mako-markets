// WatchState: one SQLite-backed Durable Object holding the run lease and what the watch has already said.
// Each RPC is one synchronous storage transaction, so acquire and commit are atomic.

import { DurableObject } from 'cloudflare:workers';

/// Shorter than the five-minute cron period, so a crashed run's lease is free for the next one.
export const LEASE_MS = 240_000;

export type AlertKind = 'unsettled' | 'no-price';

/// What the Data Streams API returned for a round's two seconds, and when it was asked (ms).
export interface Evidence {
  start: string;
  close: string;
  at: number;
}

/// A round refunded NoPrice whose alert Telegram has not confirmed yet. Terminal rounds never change, so
/// what the alert needs is kept here and the round is never read from the chain again.
export interface PendingNoPrice {
  startTime: number;
  closeTime: number;
}

export interface Meta {
  /// Every round id below this one has been read at least once; each run reads the next ids from here, so
  /// new rounds are always reached however long an old round stays open (Codex T2.0d r1).
  historyCursor: number;
  /// Non-terminal round ids, ALL re-read every run (the contract caps them at MAX_ACTIVE_ROUNDS). Never
  /// dropped until the chain shows them terminal (Codex T2.0d r2).
  active: number[];
  /// Rotation point if `active` ever exceeds MAX_ACTIVE_READ, so a read that cannot cover all of them in one
  /// run still covers every one within a bounded number of runs, and drops none.
  activeCursor: number;
  /// NoPrice alerts waiting for Telegram. Removed ONLY when Telegram confirms delivery (Codex T2.0d r2).
  noPrice: Record<string, PendingNoPrice>;
  /// Per active round id: when the unsettled alert was DELIVERED (Telegram confirmed).
  alerted: Record<string, Partial<Record<AlertKind, number>>>;
  /// Per round id in an alert condition: the report check, kept across runs so checks rotate through every
  /// due round even while Telegram is down (Codex T2.0d r1).
  evidence: Record<string, Evidence>;
  /// The round id the next Healthchecks failure page starts at (lines are paged in round-id order), so a body
  /// larger than Healthchecks stores pages through every line across runs (Codex T2.0d r3). A round id, not a
  /// position, so lines appearing or leaving between runs cannot shift it past one (adversary on 5ac8a70).
  hcCursor: number;
  lastStatus: string | null;
  lastRunAt: number | null;
}

export const INITIAL_META: Meta = {
  historyCursor: 1,
  active: [],
  activeCursor: 0,
  noPrice: {},
  alerted: {},
  evidence: {},
  hcCursor: 0,
  lastStatus: null,
  lastRunAt: null,
};

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

  /// Moves the Healthchecks page cursor, after a page was accepted, only if it still points where that page
  /// began: a concurrent or later run that already moved it wins, and the worst case is a repeated page.
  advanceHcCursor(from: number, next: number): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const meta = JSON.parse(sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`).one().json) as Meta;
      if ((meta.hcCursor ?? 0) !== from) return { ok: false };
      meta.hcCursor = next;
      sql.exec(`UPDATE meta SET json = ? WHERE id = 1`, JSON.stringify(meta));
      return { ok: true };
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
