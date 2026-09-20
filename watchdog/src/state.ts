// WatchdogState: one SQLite-backed Durable Object that holds the run lease
// and all watchdog state (r15 §5.5). Each RPC is one synchronous storage
// transaction with no await inside (F19), so acquire and commit are atomic.
//
// I6: at most one run holds the lease; a run that lost it cannot commit; an
// event whose scheduledTime is not strictly newer than the last accepted one
// cannot acquire.

import { DurableObject } from 'cloudflare:workers';
import { LEASE_MS } from './config';
import type { CheckRow } from './classify';

export interface Meta {
  /// Exclusive bound: every id below it was read in a committed run and any
  /// creation alert it raised was confirmed by Telegram.
  creationCursor: number;
  /// N at the first committed run; ids below it existed before the watchdog.
  bootstrapN: number | null;
  /// Discovery: true once one full read seeded the resolved set.
  resolvedBootstrapped: boolean;
  snapshotBlock: number | null;
  /// Provider B's latest block at the last committed run (pb: advancing).
  lastLatestBlock: number | null;
  /// UTC date (YYYY-MM-DD) of the last delivered daily digest.
  lastDigestDate: string | null;
  /// Set while the cursor waits on an unconfirmed creation alert (S3).
  creationPendingSince: number | null;
}

export const INITIAL_META: Meta = {
  creationCursor: 0,
  bootstrapN: null,
  resolvedBootstrapped: false,
  snapshotBlock: null,
  lastLatestBlock: null,
  lastDigestDate: null,
  creationPendingSince: null,
};

export interface CriticalRow {
  key: string;
  since: number;
  lastDeliveredAt: number | null;
  /// When a refund command was last offered for this market, so the longest
  /// unserved market goes first when more commands are due than a run offers
  /// (review r4). Null means never.
  lastCommandAt: number | null;
  line: string;
  marketId: number | null;
  code: string | null;
}

export interface WarningRow {
  key: string;
  since: number;
  deliveredAt: number | null;
  lastCommandAt: number | null;
  line: string;
}

export interface NoteRow {
  key: string;
  createdAt: number;
  text: string;
}

export interface AuditRow {
  marketId: number;
  block: number;
  discoveredAt: number;
}

export interface Snapshot {
  token: number;
  meta: Meta;
  checks: CheckRow[];
  criticals: CriticalRow[];
  warnings: WarningRow[];
  notes: NoteRow[];
  resolvedBits: string;
  auditQueueSize: number;
}

export interface CommitPayload {
  meta: Meta;
  checks: CheckRow[];
  criticals: CriticalRow[];
  warnings: WarningRow[];
  notes: NoteRow[];
  resolvedBits: string;
  auditAppend: AuditRow[];
}

export type AcquireResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: 'not_newer' | 'lease_held' };
export type CommitResult = { ok: true } | { ok: false; reason: 'fenced' | 'not_newer' };

interface Lease {
  token: number;
  held: boolean;
  expiresAt: number;
  scheduledTime: number | null;
  lastAccepted: number | null;
}

export class WatchdogState extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token INTEGER NOT NULL, held INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        scheduled_time INTEGER, last_accepted INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS checks (
        code TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL,
        observed TEXT NOT NULL, streak INTEGER NOT NULL, detail TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS criticals (
        key TEXT PRIMARY KEY, since INTEGER NOT NULL, last_delivered_at INTEGER,
        line TEXT NOT NULL, market_id INTEGER, code TEXT, last_command_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS warnings (
        key TEXT PRIMARY KEY, since INTEGER NOT NULL, delivered_at INTEGER, line TEXT NOT NULL, last_command_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, text TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS resolved_set (id INTEGER PRIMARY KEY CHECK (id = 1), bits TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS audit_queue (
        market_id INTEGER PRIMARY KEY, block INTEGER NOT NULL, discovered_at INTEGER NOT NULL)`);
      sql.exec(`INSERT OR IGNORE INTO lease (id, token, held, expires_at, scheduled_time, last_accepted) VALUES (1, 0, 0, 0, NULL, NULL)`);
      sql.exec(`INSERT OR IGNORE INTO meta (id, json) VALUES (1, ?)`, JSON.stringify(INITIAL_META));
      sql.exec(`INSERT OR IGNORE INTO resolved_set (id, bits) VALUES (1, '')`);
    });
  }

  private readLease(): Lease {
    const r = this.ctx.storage.sql
      .exec<{ token: number; held: number; expires_at: number; scheduled_time: number | null; last_accepted: number | null }>(
        'SELECT token, held, expires_at, scheduled_time, last_accepted FROM lease WHERE id = 1',
      )
      .one();
    return { token: r.token, held: r.held === 1, expiresAt: r.expires_at, scheduledTime: r.scheduled_time, lastAccepted: r.last_accepted };
  }

  private readSnapshot(token: number): Snapshot {
    const sql = this.ctx.storage.sql;
    const meta = { ...INITIAL_META, ...(JSON.parse(sql.exec<{ json: string }>('SELECT json FROM meta WHERE id = 1').one().json) as Meta) };
    const checks = sql
      .exec<{ code: string; state: string; since: number; observed: string; streak: number; detail: string }>('SELECT * FROM checks')
      .toArray()
      .map((r) => ({ code: r.code, state: r.state as CheckRow['state'], since: r.since, observed: r.observed as CheckRow['observed'], streak: r.streak, detail: r.detail }));
    const criticals = sql
      .exec<{ key: string; since: number; last_delivered_at: number | null; line: string; market_id: number | null; code: string | null; last_command_at: number | null }>('SELECT * FROM criticals')
      .toArray()
      .map((r) => ({ key: r.key, since: r.since, lastDeliveredAt: r.last_delivered_at, line: r.line, marketId: r.market_id, code: r.code, lastCommandAt: r.last_command_at }));
    const warnings = sql
      .exec<{ key: string; since: number; delivered_at: number | null; line: string; last_command_at: number | null }>('SELECT * FROM warnings')
      .toArray()
      .map((r) => ({ key: r.key, since: r.since, deliveredAt: r.delivered_at, line: r.line, lastCommandAt: r.last_command_at }));
    const notes = sql
      .exec<{ key: string; created_at: number; text: string }>('SELECT * FROM notes')
      .toArray()
      .map((r) => ({ key: r.key, createdAt: r.created_at, text: r.text }));
    const resolvedBits = sql.exec<{ bits: string }>('SELECT bits FROM resolved_set WHERE id = 1').one().bits;
    const auditQueueSize = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM audit_queue').one().n;
    return { token, meta, checks, criticals, warnings, notes, resolvedBits, auditQueueSize };
  }

  /// A lease expires by the CRON's scheduled time, never by a caller's clock
  /// (review r7). Fencing protects this object's state, but it cannot unsend a
  /// Telegram message, so a run with a fast clock must not be able to take a
  /// live lease and deliver a second set of alerts. `scheduledTime` comes from
  /// the runtime's ScheduledController, is the same quantity for every run,
  /// and moves forward 300 s a tick, so a holder that has not committed by the
  /// time an event 270 s later arrives is dead by the run deadline (200 s).
  async acquire(scheduledTime: number): Promise<AcquireResult> {
    return this.ctx.storage.transactionSync((): AcquireResult => {
      const lease = this.readLease();
      if (lease.lastAccepted !== null && scheduledTime <= lease.lastAccepted) return { ok: false, reason: 'not_newer' };
      const heldSince = lease.scheduledTime ?? scheduledTime;
      if (lease.held && scheduledTime - heldSince < LEASE_MS) return { ok: false, reason: 'lease_held' };
      const token = lease.token + 1;
      this.ctx.storage.sql.exec(
        'UPDATE lease SET token = ?, held = 1, expires_at = ?, scheduled_time = ? WHERE id = 1',
        token,
        scheduledTime + LEASE_MS,
        scheduledTime,
      );
      return { ok: true, snapshot: this.readSnapshot(token) };
    });
  }

  async commit(token: number, scheduledTime: number, p: CommitPayload): Promise<CommitResult> {
    return this.ctx.storage.transactionSync((): CommitResult => {
      const lease = this.readLease();
      if (!lease.held || lease.token !== token || lease.scheduledTime !== scheduledTime) return { ok: false, reason: 'fenced' };
      if (lease.lastAccepted !== null && scheduledTime <= lease.lastAccepted) return { ok: false, reason: 'not_newer' };
      const sql = this.ctx.storage.sql;
      sql.exec('UPDATE meta SET json = ? WHERE id = 1', JSON.stringify(p.meta));
      sql.exec('DELETE FROM checks');
      for (const c of p.checks) {
        sql.exec('INSERT INTO checks (code, state, since, observed, streak, detail) VALUES (?, ?, ?, ?, ?, ?)', c.code, c.state, c.since, c.observed, c.streak, c.detail);
      }
      sql.exec('DELETE FROM criticals');
      for (const c of p.criticals) {
        sql.exec(
          'INSERT INTO criticals (key, since, last_delivered_at, line, market_id, code, last_command_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          c.key, c.since, c.lastDeliveredAt, c.line, c.marketId, c.code, c.lastCommandAt,
        );
      }
      sql.exec('DELETE FROM warnings');
      for (const w of p.warnings) {
        sql.exec('INSERT INTO warnings (key, since, delivered_at, line, last_command_at) VALUES (?, ?, ?, ?, ?)', w.key, w.since, w.deliveredAt, w.line, w.lastCommandAt);
      }
      sql.exec('DELETE FROM notes');
      for (const n of p.notes) sql.exec('INSERT INTO notes (key, created_at, text) VALUES (?, ?, ?)', n.key, n.createdAt, n.text);
      sql.exec('UPDATE resolved_set SET bits = ? WHERE id = 1', p.resolvedBits);
      for (const a of p.auditAppend) {
        sql.exec('INSERT OR IGNORE INTO audit_queue (market_id, block, discovered_at) VALUES (?, ?, ?)', a.marketId, a.block, a.discoveredAt);
      }
      sql.exec('UPDATE lease SET held = 0, last_accepted = ? WHERE id = 1', scheduledTime);
      return { ok: true };
    });
  }
}
