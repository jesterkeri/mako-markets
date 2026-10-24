// ----------------------------------------------------------------------------
// price-recorder/src/lease.ts
//
// The single-writer lease (CHARTS_DS_PLAN 4.4), on D1's own clock so every tick judges expiry the same way whatever
// the worker clocks say. The statements are the plan's, verbatim apart from `now`:
//   * acquire, one statement that also works when the row is missing; acquired iff it returns one row whose holder
//     is ours. It is sent in one batch after a read of the row as it was, so the tick knows exactly whether it took
//     over a lease whose holder never released it (`lease_recovered`); the batch is one transaction, so that read
//     cannot see another tick's change between the two;
//   * fence, the FIRST statement of the write batch: inserts into lease_guard (ok CHECK = 1) whether this tick still
//     holds an unexpired lease; if not, the CHECK fails and D1 rolls back the whole batch (`lease_lost`);
//   * guard delete, so lease_guard is empty again when the batch ends;
//   * release, the LAST statement of the batch, holder-scoped: a tick that no longer holds the lease releases nothing.
// A tick that fails before its batch never releases; its lease expires at `until`.
// ----------------------------------------------------------------------------

/// Plan 4.4: 58 s to send the batch + D1's 30 s batch limit = 88 s < 90 s.
export const LEASE_TTL_S = 90;

export const D1_NOW = "CAST(strftime('%s', 'now') AS INTEGER)";

export const LEASE_READ_SQL = `SELECT holder, until, ${D1_NOW} AS now FROM lease WHERE id = 1`;

export const LEASE_ACQUIRE_SQL =
  `INSERT INTO lease (id, holder, until) VALUES (1, ?1, ${D1_NOW} + ${LEASE_TTL_S}) ` +
  `ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE lease.until < ${D1_NOW} RETURNING holder`;

export const LEASE_FENCE_SQL =
  `INSERT INTO lease_guard (ok) SELECT COALESCE((SELECT holder = ?1 AND until >= ${D1_NOW} FROM lease WHERE id = 1), 0)`;

export const LEASE_GUARD_DELETE_SQL = 'DELETE FROM lease_guard';

export const LEASE_RELEASE_SQL = 'UPDATE lease SET until = 0 WHERE id = 1 AND holder = ?1';

/// Whether `holder` still holds an unexpired lease (read only after a failed batch, to tell `lease_lost` apart).
export const LEASE_HELD_SQL = `SELECT COALESCE((SELECT holder = ?1 AND until >= ${D1_NOW} FROM lease WHERE id = 1), 0) AS held`;

export type Acquired = { acquired: true; recovered: boolean } | { acquired: false };

export async function acquireLease(db: D1Database, holder: string): Promise<Acquired> {
  const [before, taken] = await db.batch<Record<string, unknown>>([db.prepare(LEASE_READ_SQL), db.prepare(LEASE_ACQUIRE_SQL).bind(holder)]);
  const rows = taken.results;
  if (rows.length !== 1 || rows[0].holder !== holder) return { acquired: false };
  // The previous holder never released (release sets until = 0), and its lease had expired, or we would not hold it.
  const prev = before.results[0];
  return { acquired: true, recovered: prev !== undefined && prev.until !== 0 };
}

export const fence = (db: D1Database, holder: string): D1PreparedStatement => db.prepare(LEASE_FENCE_SQL).bind(holder);
export const guardDelete = (db: D1Database): D1PreparedStatement => db.prepare(LEASE_GUARD_DELETE_SQL);
export const release = (db: D1Database, holder: string): D1PreparedStatement => db.prepare(LEASE_RELEASE_SQL).bind(holder);

export async function stillHeld(db: D1Database, holder: string): Promise<boolean> {
  const row = await db.prepare(LEASE_HELD_SQL).bind(holder).first<{ held: number }>();
  return row?.held === 1;
}
