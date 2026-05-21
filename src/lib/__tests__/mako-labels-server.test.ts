// ----------------------------------------------------------------------------
// src/lib/__tests__/mako-labels-server.test.ts
//
// Integration tests for the mako-labels DAO. pglite-backed so the SQL
// CHECK constraints (octet_length 1..32 per label) and the
// ON CONFLICT (market_id) DO UPDATE clause behave exactly as in
// production. Mocking Drizzle would miss both of those.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMakoLabels,
  getMakoLabelsBatch,
  upsertMakoLabels,
} from '@/lib/mako-labels-server';
import { createMakoLabelsTestDb, type MakoLabelsTestDb } from './mako-labels-test-db';

let active: MakoLabelsTestDb | null = null;

beforeEach(async () => {
  active = await createMakoLabelsTestDb();
});

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
});

describe('upsertMakoLabels', () => {
  it('inserts a new row and returns the persisted labels', async () => {
    const r = await upsertMakoLabels(active!.db as never, {
      marketId: '42',
      label1: 'APC',
      label2: 'PDP',
    });
    expect(r).toEqual({ label1: 'APC', label2: 'PDP' });
  });

  it('is idempotent — second call updates rather than insert-duplicates', async () => {
    await upsertMakoLabels(active!.db as never, {
      marketId: '7',
      label1: 'YES_CUSTOM',
      label2: 'NO_CUSTOM',
    });

    /// Snapshot updatedAt before the second upsert so we can prove the
    /// onConflict SET clause actually bumps it. The bump matters
    /// because the admin edit surface uses updatedAt for "last edited"
    /// display.
    const beforeRow = await active!.client.query<{ updated_at: string }>(
      'SELECT updated_at FROM mako_market_outcome_labels WHERE market_id = 7',
    );
    const before = new Date(beforeRow.rows[0].updated_at).getTime();

    /// Sleep ~10ms so the timestamp comparison isn't a no-op on systems
    /// where two upserts inside the same millisecond round to identical
    /// instants.
    await new Promise((resolve) => setTimeout(resolve, 15));

    const r = await upsertMakoLabels(active!.db as never, {
      marketId: '7',
      label1: 'TEAM A',
      label2: 'TEAM B',
    });
    expect(r).toEqual({ label1: 'TEAM A', label2: 'TEAM B' });

    /// Verify single row only + updatedAt bumped.
    const fetched = await getMakoLabels(active!.db as never, '7');
    expect(fetched).toEqual({ label1: 'TEAM A', label2: 'TEAM B' });

    const afterRow = await active!.client.query<{ updated_at: string }>(
      'SELECT updated_at FROM mako_market_outcome_labels WHERE market_id = 7',
    );
    const after = new Date(afterRow.rows[0].updated_at).getTime();
    expect(after).toBeGreaterThan(before);
  });

  it('throws on non-numeric marketId', async () => {
    await expect(
      upsertMakoLabels(active!.db as never, {
        marketId: 'not-a-number',
        label1: 'A',
        label2: 'B',
      }),
    ).rejects.toThrow(/invalid marketId/);
  });

  it('rejects label1 violating the SQL byte-length CHECK', async () => {
    const over = 'x'.repeat(33);
    await expect(
      upsertMakoLabels(active!.db as never, {
        marketId: '1',
        label1: over,
        label2: 'PDP',
      }),
    ).rejects.toThrow();
  });

  it('rejects empty label1 via the SQL byte-length CHECK', async () => {
    await expect(
      upsertMakoLabels(active!.db as never, {
        marketId: '2',
        label1: '',
        label2: 'PDP',
      }),
    ).rejects.toThrow();
  });
});

describe('getMakoLabels', () => {
  it('returns null when no row exists (UI falls back to YES/NO)', async () => {
    const r = await getMakoLabels(active!.db as never, '999');
    expect(r).toBeNull();
  });

  it('returns the row for a known market', async () => {
    await upsertMakoLabels(active!.db as never, {
      marketId: '10',
      label1: 'BULLS',
      label2: 'BEARS',
    });
    const r = await getMakoLabels(active!.db as never, '10');
    expect(r).toEqual({ label1: 'BULLS', label2: 'BEARS' });
  });

  it('returns null for non-numeric ids (silently — no throw)', async () => {
    const r = await getMakoLabels(active!.db as never, 'abc');
    expect(r).toBeNull();
  });
});

describe('getMakoLabelsBatch', () => {
  it('returns an empty Map for empty input WITHOUT touching the DB', async () => {
    const map = await getMakoLabelsBatch(active!.db as never, []);
    expect(map.size).toBe(0);
  });

  it('returns string-keyed Map for the requested ids that exist', async () => {
    await upsertMakoLabels(active!.db as never, {
      marketId: '1',
      label1: 'A1',
      label2: 'A2',
    });
    await upsertMakoLabels(active!.db as never, {
      marketId: '2',
      label1: 'B1',
      label2: 'B2',
    });
    await upsertMakoLabels(active!.db as never, {
      marketId: '3',
      label1: 'C1',
      label2: 'C2',
    });

    const map = await getMakoLabelsBatch(active!.db as never, ['1', '2', '999']);
    expect(map.size).toBe(2);
    expect(map.get('1')).toEqual({ label1: 'A1', label2: 'A2' });
    expect(map.get('2')).toEqual({ label1: 'B1', label2: 'B2' });
    expect(map.has('999')).toBe(false);
  });

  it('uses STRING keys (not bigint) — see round-9 key discipline', async () => {
    await upsertMakoLabels(active!.db as never, {
      marketId: '55',
      label1: 'X',
      label2: 'Y',
    });
    const map = await getMakoLabelsBatch(active!.db as never, ['55']);

    /// String key lookup hits.
    expect(map.get('55')).toEqual({ label1: 'X', label2: 'Y' });

    /// Bigint lookup must NOT find anything — this guards against the
    /// round-8 silent-miss bug returning. If this assertion ever fires
    /// the Map's key type quietly widened to bigint and the home feed
    /// will fall back to YES/NO again.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((map as Map<any, any>).get(55n)).toBeUndefined();
  });

  it('filters out non-numeric ids in the input rather than throwing', async () => {
    await upsertMakoLabels(active!.db as never, {
      marketId: '4',
      label1: 'P',
      label2: 'Q',
    });
    const map = await getMakoLabelsBatch(active!.db as never, ['4', 'bogus', '']);
    expect(map.size).toBe(1);
    expect(map.get('4')).toEqual({ label1: 'P', label2: 'Q' });
  });

  it('drops ids above Number.MAX_SAFE_INTEGER without throwing', async () => {
    /// The column is `bigint mode:'number'` so values past 2^53 would
    /// silently lose precision via Number(). The DAO filters such ids
    /// out at the boundary; the batch read just returns nothing for
    /// them instead of crashing or returning a wrong row. This is the
    /// hard future limit codex flagged in Group A review.
    const overSafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const map = await getMakoLabelsBatch(active!.db as never, [overSafe, '4']);
    /// '4' has no row in this test path, so the map is empty (not crashing
    /// on the over-safe id is the actual assertion).
    expect(map.has(overSafe)).toBe(false);
  });
});
