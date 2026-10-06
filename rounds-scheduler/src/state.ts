// SchedulerState: one SQLite-backed Durable Object holding the scheduler's run lease, so two overlapping cron runs
// (a slow run meeting the next, or a redelivered invocation) can never both send (Codex Rounds r1, Part B).
// Each RPC is one synchronous storage transaction, so acquire and release are atomic.
import { DurableObject } from 'cloudflare:workers';

/// Shorter than the 5-minute cron period, so a crashed run's lease is free for the next one.
export const LEASE_MS = 240_000;

/// A run may sign and send only if, at that moment, it still holds the lease with at least this long left (Codex
/// Rounds r2, Part B: a time check made earlier does not bound the network calls that follow it).
export const SEND_MARGIN_MS = 60_000;

export type Acquired = { ok: true; token: number } | { ok: false };

export class SchedulerState extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token INTEGER NOT NULL, held INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
      sql.exec(`INSERT OR IGNORE INTO lease (id, token, held, expires_at) VALUES (1, 0, 0, 0)`);
    });
  }

  acquire(now: number): Acquired {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number; expires_at: number }>(`SELECT token, held, expires_at FROM lease WHERE id = 1`).one();
      if (lease.held === 1 && lease.expires_at > now) return { ok: false } as const;
      const token = lease.token + 1;
      sql.exec(`UPDATE lease SET token = ?, held = 1, expires_at = ? WHERE id = 1`, token, now + LEASE_MS);
      return { ok: true, token } as const;
    });
  }

  /// The last step before a run signs: true only while `token` holds the lease with SEND_MARGIN_MS or more left.
  /// Nothing but local signing and the one bounded send follows it.
  confirm(token: number, now: number): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const lease = this.ctx.storage.sql.exec<{ token: number; held: number; expires_at: number }>(
        `SELECT token, held, expires_at FROM lease WHERE id = 1`,
      ).one();
      return { ok: lease.token === token && lease.held === 1 && lease.expires_at - now >= SEND_MARGIN_MS };
    });
  }

  /// Frees the lease, only while `token` still holds it.
  release(token: number): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec<{ token: number; held: number }>(`SELECT token, held FROM lease WHERE id = 1`).one();
      if (lease.token !== token || lease.held !== 1) return { ok: false };
      sql.exec(`UPDATE lease SET held = 0 WHERE id = 1`);
      return { ok: true };
    });
  }
}
