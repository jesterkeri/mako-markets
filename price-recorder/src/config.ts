// ----------------------------------------------------------------------------
// price-recorder/src/config.ts
//
// The `config` row (CHARTS_DS_PLAN 5.2) and the fail-closed rule of section 11. Every tick and every read takes this
// first. The row is valid only when the read returns exactly one row with id 1, integer serve, record and p_bf in their
// ranges, an integer updated_at, and feeds_refused and live_unsupported as JSON arrays of distinct symbols of the two
// feed tables. Anything else is invalid, and invalid is OFF: zero rows, two rows, a value of another type, a missing
// table, a D1 error, a missing binding. Serving needs a valid row with serve = 1, recording one with record = 1. No
// code path writes serve or record (a test greps for it); only the operator does.
// ----------------------------------------------------------------------------

import { isInt } from './db';
import { FEED_BY_SYMBOL } from './feeds';

export type Config = {
  serve: 0 | 1;
  record: 0 | 1;
  p_bf: number;
  updated_at: number;
  feeds_refused: string[];
  live_unsupported: string[];
};

export type ConfigRead = { valid: true; config: Config } | { valid: false; reason: string };

export const READ_CONFIG_SQL = 'SELECT id, serve, record, p_bf, updated_at, feeds_refused, live_unsupported FROM config';

const flag = (v: unknown): v is 0 | 1 => v === 0 || v === 1;

function symbols(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  let list: unknown;
  try {
    list = JSON.parse(v);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.every((s): s is string => typeof s === 'string' && FEED_BY_SYMBOL.has(s))) return null;
  return new Set(list).size === list.length ? list : null;
}

/// Pure: the rows a `SELECT ... FROM config` returned.
export function parseConfig(rows: readonly unknown[]): ConfigRead {
  if (rows.length !== 1) return { valid: false, reason: `config has ${rows.length} rows` };
  const r = rows[0];
  if (r === null || typeof r !== 'object') return { valid: false, reason: 'config row is not an object' };
  const x = r as Record<string, unknown>;
  if (x.id !== 1) return { valid: false, reason: 'config id is not 1' };
  if (!flag(x.serve) || !flag(x.record)) return { valid: false, reason: 'serve or record is not the integer 0 or 1' };
  if (!isInt(x.p_bf) || x.p_bf < 0 || x.p_bf > 296) return { valid: false, reason: 'p_bf out of range' };
  if (!isInt(x.updated_at)) return { valid: false, reason: 'updated_at is not an integer' };
  const refused = symbols(x.feeds_refused);
  const unsupported = symbols(x.live_unsupported);
  if (!refused) return { valid: false, reason: 'feeds_refused is not a list of feed symbols' };
  if (!unsupported) return { valid: false, reason: 'live_unsupported is not a list of feed symbols' };
  return { valid: true, config: { serve: x.serve, record: x.record, p_bf: x.p_bf, updated_at: x.updated_at, feeds_refused: refused, live_unsupported: unsupported } };
}

/// Reads config, failing closed on a missing binding, a missing table or any D1 error.
export async function readConfig(db: D1Database | undefined): Promise<ConfigRead> {
  if (!db) return { valid: false, reason: 'no D1 binding' };
  try {
    const res = await db.prepare(READ_CONFIG_SQL).all<Record<string, unknown>>();
    return parseConfig(res.results);
  } catch (e) {
    return { valid: false, reason: `config read failed: ${e instanceof Error ? e.name : 'error'}` };
  }
}

export const serving = (c: ConfigRead): boolean => c.valid && c.config.serve === 1;
export const recording = (c: ConfigRead): boolean => c.valid && c.config.record === 1;
