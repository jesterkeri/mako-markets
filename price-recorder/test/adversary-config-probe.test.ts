// Adversary on eda38c7 (unit b): the config CHECKs (CHARTS_DS_PLAN 5.2, section 11) on a local D1. serve and record
// must be the integer 0 or 1 and nothing else can be stored; the kill switch must print exactly one row with serve 0
// on a seeded and on an empty table.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { readConfig, recording, serving } from '../src/config';

const db = () => env.DB;
const KILL =
  "INSERT INTO config (id, serve, record, p_bf, updated_at) VALUES (1, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER)) ON CONFLICT(id) DO UPDATE SET serve = 0, updated_at = excluded.updated_at RETURNING id, serve, record";

describe('serve and record accept only the integer 0 or 1', () => {
  for (const v of ["'1'", '1.0', '1e0', "x'01'", "'true'", '2', '-1', 'NULL', '0.5', "' 1'", "CAST('1' AS NUMERIC) + 0.0"])
    for (const col of ['serve', 'record'])
      it(`${col} = ${v} is refused`, async () => {
        await expect(db().prepare(`UPDATE config SET ${col} = ${v} WHERE id = 1`).run()).rejects.toThrow();
      });
  it('true is the integer 1 in SQLite, so it is stored as 1 (allowed, it is the integer)', async () => {
    await db().prepare('UPDATE config SET serve = true WHERE id = 1').run();
    expect(serving(await readConfig(db()))).toBe(true);
  });
  it('a JS 1 bound as a parameter arrives as a REAL on D1 and is refused (fails closed; operator SQL uses literals)', async () => {
    await expect(db().prepare('UPDATE config SET record = ?1 WHERE id = 1').bind(1).run()).rejects.toThrow(/CHECK constraint failed/);
    expect(recording(await readConfig(db()))).toBe(false);
  });
  it('a JS 1.5 bound as a parameter is refused', async () => {
    await expect(db().prepare('UPDATE config SET record = ?1 WHERE id = 1').bind(1.5).run()).rejects.toThrow();
  });
});

describe('the kill switch', () => {
  it('seeded: one row, serve 0', async () => {
    await db().prepare('UPDATE config SET serve = 1, record = 1 WHERE id = 1').run();
    const r = await db().prepare(KILL).all();
    expect(r.results).toEqual([{ id: 1, serve: 0, record: 1 }]);
    expect(serving(await readConfig(db()))).toBe(false);
  });
  it('empty table: one row, serve 0, record 0', async () => {
    await db().prepare('DELETE FROM config').run();
    expect(serving(await readConfig(db()))).toBe(false);
    const r = await db().prepare(KILL).all();
    expect(r.results).toEqual([{ id: 1, serve: 0, record: 0 }]);
    const c = await readConfig(db());
    expect(c.valid).toBe(true);
  });
  it('p_bf 74.5 passes the CHECK but the read is invalid, so OFF', async () => {
    await db().prepare('UPDATE config SET serve = 1, record = 1, p_bf = 74.5 WHERE id = 1').run();
    const c = await readConfig(db());
    expect(c.valid).toBe(false);
    expect(serving(c)).toBe(false);
  });
});
