// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/rate-limit.test.ts
//
// Integration tests for the attempt-throttle against real Postgres (pglite).
// Proves: the caps hold sequentially AND under many concurrent calls; the
// windows roll; a rejected attempt consumes NEITHER bucket (rollback); and the
// daily cap is per UTC calendar day.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { users } from '@/db/schema';
import {
  dayWindowKey,
  minuteWindowKey,
  reserveAttemptOrReject,
} from '../rate-limit';
import { RATE_PER_DAY, RATE_PER_MINUTE } from '../types';
import { createTestDb, type TestDb } from './test-db';

let tdb: TestDb;
let userId: string;

const T = new Date('2026-07-04T12:00:30.000Z');
const plusSeconds = (base: Date, s: number) => new Date(base.getTime() + s * 1000);

beforeEach(async () => {
  tdb = await createTestDb();
  const u = await tdb.db
    .insert(users)
    .values({ email: 'r@l.co', magicEoa: '0x01', authType: 'magic' })
    .returning({ id: users.id });
  userId = u[0].id;
});

afterEach(async () => {
  await tdb.close();
});

async function bucketCount(windowKey: string): Promise<number> {
  const res = await tdb.db.execute(
    sql`SELECT count FROM comment_rate_limits WHERE user_id = ${userId} AND window_key = ${windowKey}`,
  );
  if (res.rows.length === 0) return 0;
  return Number((res.rows[0] as { count: number | string }).count);
}

describe('reserveAttemptOrReject — minute window', () => {
  it('allows RATE_PER_MINUTE then rejects with scope=minute', async () => {
    for (let i = 0; i < RATE_PER_MINUTE; i++) {
      expect(await reserveAttemptOrReject(tdb.db as never, userId, T)).toEqual({ ok: true });
    }
    expect(await reserveAttemptOrReject(tdb.db as never, userId, T)).toEqual({
      ok: false,
      scope: 'minute',
    });
  });

  it('rolls: a fresh minute resets the burst', async () => {
    for (let i = 0; i < RATE_PER_MINUTE; i++) {
      await reserveAttemptOrReject(tdb.db as never, userId, T);
    }
    // next minute → allowed again
    const next = plusSeconds(T, 60);
    expect(await reserveAttemptOrReject(tdb.db as never, userId, next)).toEqual({ ok: true });
  });

  it('a rejected attempt consumes NEITHER bucket (rollback)', async () => {
    for (let i = 0; i < RATE_PER_MINUTE; i++) {
      await reserveAttemptOrReject(tdb.db as never, userId, T);
    }
    const minuteKey = minuteWindowKey(T);
    const dayKey = dayWindowKey(T);
    expect(await bucketCount(minuteKey)).toBe(RATE_PER_MINUTE);
    expect(await bucketCount(dayKey)).toBe(RATE_PER_MINUTE);
    // the over-cap attempt:
    expect(await reserveAttemptOrReject(tdb.db as never, userId, T)).toEqual({
      ok: false,
      scope: 'minute',
    });
    // neither bucket advanced past cap
    expect(await bucketCount(minuteKey)).toBe(RATE_PER_MINUTE);
    expect(await bucketCount(dayKey)).toBe(RATE_PER_MINUTE);
  });
});

describe('reserveAttemptOrReject — concurrency', () => {
  it('under many concurrent calls in one minute, exactly RATE_PER_MINUTE succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveAttemptOrReject(tdb.db as never, userId, T)),
    );
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBe(RATE_PER_MINUTE);
  });
});

describe('reserveAttemptOrReject — daily window', () => {
  it('allows RATE_PER_DAY across many minutes then rejects with scope=day', async () => {
    // Advance the minute each attempt so the 60s cap never trips; the UTC day
    // stays constant so the day bucket accumulates to the cap.
    for (let i = 0; i < RATE_PER_DAY; i++) {
      const now = plusSeconds(T, i * 60);
      expect(await reserveAttemptOrReject(tdb.db as never, userId, now)).toEqual({ ok: true });
    }
    const past = plusSeconds(T, RATE_PER_DAY * 60);
    expect(await reserveAttemptOrReject(tdb.db as never, userId, past)).toEqual({
      ok: false,
      scope: 'day',
    });
  });

  it('a new UTC day resets the daily bucket', async () => {
    // Fill day 1 to cap (spread across minutes).
    for (let i = 0; i < RATE_PER_DAY; i++) {
      await reserveAttemptOrReject(tdb.db as never, userId, plusSeconds(T, i * 60));
    }
    // Next UTC day → allowed again (documents the accepted calendar-day edge).
    const nextDay = new Date('2026-07-05T00:00:30.000Z');
    expect(await reserveAttemptOrReject(tdb.db as never, userId, nextDay)).toEqual({ ok: true });
  });
});
