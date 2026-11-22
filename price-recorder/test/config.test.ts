// CHARTS_DS_PLAN section 11, the fail-closed rule: only exactly one valid config row turns serving or recording on.
// Local D1 cases (empty, deleted, dropped, binding absent, D1 error, concurrent operator updates) and stubs for values
// the CHECKs would never let in.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { parseConfig, readConfig, recording, serving } from '../src/config';

const seeded = { id: 1, serve: 0, record: 0, p_bf: 74, updated_at: 1792000000, feeds_refused: '["BAC","MA"]', live_unsupported: '[]' };

describe('parseConfig (pure)', () => {
  it('the seeded row is valid and OFF for both serving and recording', () => {
    const c = parseConfig([seeded]);
    expect(c).toEqual({ valid: true, config: { serve: 0, record: 0, p_bf: 74, updated_at: 1792000000, feeds_refused: ['BAC', 'MA'], live_unsupported: [] } });
    expect(serving(c)).toBe(false);
    expect(recording(c)).toBe(false);
  });

  it('serve = 1 and record = 1 turn each on, independently', () => {
    expect(serving(parseConfig([{ ...seeded, serve: 1 }]))).toBe(true);
    expect(recording(parseConfig([{ ...seeded, serve: 1 }]))).toBe(false);
    expect(recording(parseConfig([{ ...seeded, record: 1 }]))).toBe(true);
    expect(serving(parseConfig([{ ...seeded, record: 1 }]))).toBe(false);
  });

  it.each<[string, unknown[]]>([
    ['no row', []],
    ['two rows', [{ ...seeded, serve: 1 }, { ...seeded, id: 2, serve: 1 }]],
    ['a null row', [null]],
    ['id 2', [{ ...seeded, id: 2, serve: 1 }]],
    ['serve 2', [{ ...seeded, serve: 2 }]],
    ["serve '1'", [{ ...seeded, serve: '1' }]],
    ['serve true', [{ ...seeded, serve: true }]],
    ['serve 1.5', [{ ...seeded, serve: 1.5 }]],
    ['serve null', [{ ...seeded, serve: null }]],
    ['record missing', [{ ...seeded, serve: 1, record: undefined }]],
    ['p_bf 297', [{ ...seeded, serve: 1, p_bf: 297 }]],
    ['p_bf -1', [{ ...seeded, serve: 1, p_bf: -1 }]],
    ["p_bf '74'", [{ ...seeded, serve: 1, p_bf: '74' }]],
    ['updated_at text', [{ ...seeded, serve: 1, updated_at: 'now' }]],
    ['feeds_refused with an unknown symbol', [{ ...seeded, serve: 1, feeds_refused: '["BAC","XYZ"]' }]],
    ['feeds_refused with a lower-case symbol', [{ ...seeded, serve: 1, feeds_refused: '["bac"]' }]],
    ['feeds_refused with a duplicate', [{ ...seeded, serve: 1, feeds_refused: '["BAC","BAC"]' }]],
    ['feeds_refused with a number', [{ ...seeded, serve: 1, feeds_refused: '[1]' }]],
    ['feeds_refused not JSON', [{ ...seeded, serve: 1, feeds_refused: 'BAC' }]],
    ['feeds_refused an object', [{ ...seeded, serve: 1, feeds_refused: '{"BAC":1}' }]],
    ['feeds_refused null', [{ ...seeded, serve: 1, feeds_refused: null }]],
    ['live_unsupported with an unknown symbol', [{ ...seeded, serve: 1, live_unsupported: '["NOPE"]' }]],
  ])('%s: invalid, so OFF', (_n, rows) => {
    const c = parseConfig(rows);
    expect(c.valid).toBe(false);
    expect(serving(c)).toBe(false);
    expect(recording(c)).toBe(false);
  });
});

describe('readConfig on local D1', () => {
  const on = () => env.DB.prepare("UPDATE config SET serve = 1, record = 1 WHERE id = 1").run();

  it('reads the seeded database: valid, OFF', async () => {
    const c = await readConfig(env.DB);
    expect(c.valid).toBe(true);
    expect(serving(c) || recording(c)).toBe(false);
  });

  it('reads serving and recording once the operator turns them on', async () => {
    await on();
    const c = await readConfig(env.DB);
    expect(serving(c) && recording(c)).toBe(true);
  });

  it('an empty table is OFF', async () => {
    await on();
    await env.DB.prepare('DELETE FROM config').run();
    expect(await readConfig(env.DB)).toEqual({ valid: false, reason: 'config has 0 rows' });
  });

  it('a dropped table is OFF, not an exception', async () => {
    await on();
    await env.DB.prepare('DROP TABLE config').run();
    const c = await readConfig(env.DB);
    expect(c.valid).toBe(false);
    expect(serving(c)).toBe(false);
  });

  it('a missing binding is OFF', async () => {
    expect(await readConfig(undefined)).toEqual({ valid: false, reason: 'no D1 binding' });
  });

  it('a D1 error is OFF', async () => {
    const broken = { prepare: () => ({ all: () => Promise.reject(new Error('D1_ERROR: timeout')) }) } as unknown as D1Database;
    expect(await readConfig(broken)).toEqual({ valid: false, reason: 'config read failed: Error' });
  });

  it('a feeds_refused element the CHECK lets in but the feed tables do not know is OFF', async () => {
    await on();
    await env.DB.prepare(`UPDATE config SET feeds_refused = '["BAC","ZZZ"]' WHERE id = 1`).run();
    const c = await readConfig(env.DB);
    expect(c.valid).toBe(false);
    expect(serving(c) || recording(c)).toBe(false);
  });

  it('two operator updates racing: every read sees one committed row, never a mix', async () => {
    const a = env.DB.prepare('UPDATE config SET serve = 1, p_bf = 10 WHERE id = 1').run();
    const b = env.DB.prepare('UPDATE config SET serve = 0, p_bf = 20 WHERE id = 1').run();
    const reads = [readConfig(env.DB), readConfig(env.DB), readConfig(env.DB)];
    await Promise.all([a, b]);
    for (const r of await Promise.all([...reads, readConfig(env.DB)])) {
      expect(r.valid).toBe(true);
      if (!r.valid) continue;
      expect([[0, 74], [1, 10], [0, 20]]).toContainEqual([r.config.serve, r.config.p_bf]);
    }
  });
});

describe('no code path writes serve or record (section 11), and none deletes or updates a hold (8.6)', () => {
  const sources = import.meta.glob<string>('../src/**/*.ts', { eager: true, query: '?raw', import: 'default' });

  it('reads every source file', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it('no source sets serve or record', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/\bSET\b[^;`'"]*\b(serve|record)\s*=/i);
      expect(text, file).not.toMatch(/INSERT\s+INTO\s+config\b/i);
    }
  });

  it('no source deletes or updates feed_holds', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/DELETE\s+FROM\s+feed_holds/i);
      expect(text, file).not.toMatch(/UPDATE\s+feed_holds/i);
      expect(text, file).not.toMatch(/REPLACE\s+INTO\s+feed_holds/i);
    }
  });
});
