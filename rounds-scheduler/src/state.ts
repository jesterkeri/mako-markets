// SchedulerState: one SQLite-backed Durable Object holding the scheduler's run lease and its one send intent, so two
// overlapping cron runs (a slow run meeting the next, or a redelivered invocation) can never both send transactions
// that execute (Codex Rounds r1, r2 and r3, Part B). Each RPC is one synchronous storage transaction, so every
// check-and-write here is atomic.
//
// Why a durable intent and not a time check (Codex Rounds r3): a lease check made before any further await (signing,
// a request starting) can be outlived by a Worker that is descheduled, so no clock margin is a proof. Instead the run
// SIGNS first and then records the signed transaction here, which succeeds only while its token holds the lease and
// no earlier intent is unresolved. A late send from that run can then only be that recorded transaction, and every
// later holder rebroadcasts exactly it instead of scheduling anything new until the chain shows its nonce used.
import { DurableObject } from 'cloudflare:workers';

/// Shorter than the 5-minute cron period, so a crashed run's lease is free for the next one.
export const LEASE_MS = 240_000;

export type Acquired = { ok: true; token: number } | { ok: false };

/// A signed schedule transaction recorded before it is sent. `raw` is public once broadcast; it holds no key.
export interface SendIntent {
  house: `0x${string}`;
  nonce: number;
  startTime: number;
  hash: `0x${string}`;
  raw: `0x${string}`;
  recordedAt: number;
}

export class SchedulerState extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token INTEGER NOT NULL, held INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
      sql.exec(`INSERT OR IGNORE INTO lease (id, token, held, expires_at) VALUES (1, 0, 0, 0)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS intent (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT)`);
      sql.exec(`INSERT OR IGNORE INTO intent (id, json) VALUES (1, NULL)`);
    });
  }

  private holds(token: number, now: number): boolean {
    const lease = this.ctx.storage.sql
      .exec<{ token: number; held: number; expires_at: number }>(`SELECT token, held, expires_at FROM lease WHERE id = 1`)
      .one();
    return lease.token === token && lease.held === 1 && lease.expires_at > now;
  }

  private current(): SendIntent | null {
    const row = this.ctx.storage.sql.exec<{ json: string | null }>(`SELECT json FROM intent WHERE id = 1`).one();
    return row.json ? (JSON.parse(row.json) as SendIntent) : null;
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

  /// The unresolved send intent, if any, for the run holding the lease (null for anyone else).
  intent(token: number, now: number): { ok: true; intent: SendIntent | null } | { ok: false } {
    return this.ctx.storage.transactionSync(() => (this.holds(token, now) ? { ok: true as const, intent: this.current() } : { ok: false as const }));
  }

  /// Records a signed transaction before it is sent: only while `token` holds the lease and no intent is unresolved.
  /// A run may send only a transaction this accepted.
  recordIntent(token: number, now: number, intent: SendIntent): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      if (!this.holds(token, now) || this.current() !== null) return { ok: false };
      this.ctx.storage.sql.exec(`UPDATE intent SET json = ? WHERE id = 1`, JSON.stringify(intent));
      return { ok: true };
    });
  }

  /// Clears the intent once the chain shows its nonce used: only the lease holder, and only that exact intent.
  clearIntent(token: number, now: number, hash: `0x${string}`): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const cur = this.current();
      if (!this.holds(token, now) || cur === null || cur.hash !== hash) return { ok: false };
      this.ctx.storage.sql.exec(`UPDATE intent SET json = NULL WHERE id = 1`);
      return { ok: true };
    });
  }
}
