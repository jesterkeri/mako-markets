// The feedback abuse limit against real Postgres (pglite + migration 0012): 5 an hour per account, 30 an hour shared
// by every signed-out sender, a rejected attempt counts nothing, the hour rolls, concurrent sends cannot overshoot,
// and the table keeps at most one row per key.

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FEEDBACK_ANON_PER_HOUR, FEEDBACK_PER_ACCOUNT_PER_HOUR } from '@/lib/feedback';
import { feedbackLimitKey, hourWindowKey, reserveFeedback } from '@/lib/feedback-rate-limit';

import { createFeedbackTestDb, type FeedbackTestDb } from './feedback-test-db';

const USER = '0d6f6a8e-6d55-4e7a-9a4e-5a1c2b3d4e5f';
const T = new Date('2026-10-01T12:10:00.000Z');
const later = (minutes: number) => new Date(T.getTime() + minutes * 60_000);

let tdb: FeedbackTestDb;
beforeEach(async () => {
  tdb = await createFeedbackTestDb();
});
afterEach(async () => {
  await tdb.close();
});

async function rows(): Promise<Array<{ key: string; window_key: string; count: number }>> {
  const res = await tdb.db.execute(sql`SELECT key, window_key, count FROM feedback_rate_limits ORDER BY key, window_key`);
  return (res.rows as Array<{ key: string; window_key: string; count: number | string }>).map((r) => ({ ...r, count: Number(r.count) }));
}

describe('feedbackLimitKey', () => {
  it('a signed-in sender has their own key; every signed-out sender shares one', () => {
    expect(feedbackLimitKey(USER)).toEqual({ key: `u:${USER}`, cap: FEEDBACK_PER_ACCOUNT_PER_HOUR });
    expect(feedbackLimitKey(null)).toEqual({ key: 'anon', cap: FEEDBACK_ANON_PER_HOUR });
    expect(FEEDBACK_PER_ACCOUNT_PER_HOUR).toBe(5);
    expect(FEEDBACK_ANON_PER_HOUR).toBe(30);
  });

  it('the window is the clock hour', () => {
    expect(hourWindowKey(T)).toBe(`h:${Math.floor(T.getTime() / 3_600_000)}`);
    expect(hourWindowKey(later(49))).toBe(hourWindowKey(T));
    expect(hourWindowKey(later(50))).not.toBe(hourWindowKey(T));
  });
});

describe('reserveFeedback', () => {
  it('allows 5 an hour for an account, then refuses without counting the refusal', async () => {
    const limit = feedbackLimitKey(USER);
    for (let i = 0; i < 5; i++) expect(await reserveFeedback(tdb.db as never, limit, T)).toBe(true);
    expect(await reserveFeedback(tdb.db as never, limit, T)).toBe(false);
    expect(await reserveFeedback(tdb.db as never, limit, later(30))).toBe(false);
    expect(await rows()).toEqual([{ key: `u:${USER}`, window_key: hourWindowKey(T), count: 5 }]);
  });

  it('allows 30 an hour for all signed-out senders together', async () => {
    const anon = feedbackLimitKey(null);
    for (let i = 0; i < 30; i++) expect(await reserveFeedback(tdb.db as never, anon, T)).toBe(true);
    expect(await reserveFeedback(tdb.db as never, anon, T)).toBe(false);
    // A signed-in account is not held back by the shared signed-out bucket.
    expect(await reserveFeedback(tdb.db as never, feedbackLimitKey(USER), T)).toBe(true);
  });

  it('a new hour starts a fresh count and drops the old row', async () => {
    const limit = feedbackLimitKey(USER);
    for (let i = 0; i < 5; i++) await reserveFeedback(tdb.db as never, limit, T);
    expect(await reserveFeedback(tdb.db as never, limit, later(60))).toBe(true);
    expect(await rows()).toEqual([{ key: `u:${USER}`, window_key: hourWindowKey(later(60)), count: 1 }]);
  });

  it('concurrent sends cannot get past the cap', async () => {
    const limit = feedbackLimitKey(USER);
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveFeedback(tdb.db as never, limit, T)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await rows())[0].count).toBe(5);
  });

  it('a database error propagates, so the route refuses to send', async () => {
    await tdb.db.execute(sql`DROP TABLE feedback_rate_limits`);
    await expect(reserveFeedback(tdb.db as never, feedbackLimitKey(null), T)).rejects.toThrow();
  });
});

describe('migration 0012', () => {
  it('stores only an account key or the shared anon key, never anything else (no IPs)', async () => {
    await expect(tdb.db.execute(sql`INSERT INTO feedback_rate_limits (key, window_key, count) VALUES ('203.0.113.7', 'h:1', 1)`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO feedback_rate_limits (key, window_key, count) VALUES ('anon', 'd:2026-10-01', 1)`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO feedback_rate_limits (key, window_key, count) VALUES ('anon', 'h:1', -1)`)).rejects.toThrow();
    await tdb.db.execute(sql`INSERT INTO feedback_rate_limits (key, window_key, count) VALUES (${`u:${USER}`}, 'h:1', 1)`);
  });
});
