// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/migration.test.ts
//
// Loads 0009_comments.sql verbatim into pglite and exercises the CHECK matrix
// the SQL owns (Drizzle can't emit these, so a typecheck-clean app is not
// enough — only a real Postgres proves them). Each case is a raw INSERT that
// must be ACCEPTED or REJECTED by the DB, independent of any app code.
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pmMarkets, users } from '@/db/schema';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195'; // lowercase, canonical
const MARKET_ID = '5';
const NONCE = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CREATOR = '0x1111111111111111111111111111111111111111';

let tdb: TestDb;
let userId: string;
let pmId: string;

beforeEach(async () => {
  tdb = await createTestDb();
  const u = await tdb.db
    .insert(users)
    .values({ email: 'a@b.co', magicEoa: '0xabc', authType: 'magic', displayName: 'Ann' })
    .returning({ id: users.id });
  userId = u[0].id;
  const m = await tdb.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'pm-1',
      clientNonce: NONCE,
      creator: CREATOR,
      marketId: 1,
      shape: 'friendly',
      createStatus: 'confirmed',
      title: 'PM One',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    })
    .returning({ id: pmMarkets.id });
  pmId = m[0].id;
});

afterEach(async () => {
  await tdb.close();
});

describe('0009_comments migration', () => {
  it('creates market_comments, comment_rate_limits, and pm_markets.comments_enabled', async () => {
    const tables = await tdb.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE tablename IN ('market_comments','comment_rate_limits')`,
    );
    expect(tables.rows).toHaveLength(2);
    const col = await tdb.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name='pm_markets' AND column_name='comments_enabled'`,
    );
    expect(col.rows).toHaveLength(1);
  });

  it('accepts a well-formed main comment and a well-formed pm comment', async () => {
    await expect(
      tdb.db.execute(
        sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
            VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, 'hi')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      tdb.db.execute(
        sql`INSERT INTO market_comments (scope, pm_market_db_id, user_id, body)
            VALUES ('pm', ${pmId}, ${userId}, 'hi')`,
      ),
    ).resolves.toBeDefined();
  });

  describe('scope shape CHECK', () => {
    it('rejects main scope missing market_id', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${userId}, 'x')`,
        ),
      ).rejects.toThrow();
    });
    it('rejects main scope that also sets pm_market_db_id', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, pm_market_db_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${pmId}, ${userId}, 'x')`,
        ),
      ).rejects.toThrow();
    });
    it('rejects pm scope that also sets a main column', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, pm_market_db_id, chain_id, user_id, body)
              VALUES ('pm', ${pmId}, ${CHAIN_ID}, ${userId}, 'x')`,
        ),
      ).rejects.toThrow();
    });
    it('rejects an unknown scope value', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, pm_market_db_id, user_id, body)
              VALUES ('other', ${pmId}, ${userId}, 'x')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('lowercase contract CHECK', () => {
    it('rejects an uppercase contract_address', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${'0xBC5A58487D7949DA2B76AC84AFC032FD0AA26195'}, ${MARKET_ID}, ${userId}, 'x')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('deleted pair + deleted_by CHECKs', () => {
    it('rejects deleted_at set with deleted_by null', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body, deleted_at)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, 'x', now())`,
        ),
      ).rejects.toThrow();
    });
    it('rejects deleted_by set with deleted_at null', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body, deleted_by)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, 'x', 'owner')`,
        ),
      ).rejects.toThrow();
    });
    it('rejects an unknown deleted_by value', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body, deleted_at, deleted_by)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, 'x', now(), 'hacker')`,
        ),
      ).rejects.toThrow();
    });
    it('accepts a soft-deleted pair (owner)', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body, deleted_at, deleted_by)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, 'x', now(), 'admin')`,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('body octet-length CHECK', () => {
    it('rejects an empty body', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, '')`,
        ),
      ).rejects.toThrow();
    });
    it('rejects a body over 2000 bytes', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, ${'a'.repeat(2001)})`,
        ),
      ).rejects.toThrow();
    });
    it('rejects multi-byte text whose BYTE length exceeds 2000 though char count does not', async () => {
      // '✓' is 3 bytes in UTF-8. 700 chars = 2100 bytes > 2000, but 700 < 2000
      // chars — proves the bound is octet_length, not char length.
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, ${'✓'.repeat(700)})`,
        ),
      ).rejects.toThrow();
    });
    it('accepts a body at exactly 2000 bytes', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO market_comments (scope, chain_id, contract_address, market_id, user_id, body)
              VALUES ('main', ${CHAIN_ID}, ${CONTRACT}, ${MARKET_ID}, ${userId}, ${'a'.repeat(2000)})`,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('comment_rate_limits count CHECK', () => {
    it('rejects a negative count', async () => {
      await expect(
        tdb.db.execute(
          sql`INSERT INTO comment_rate_limits (user_id, window_key, count) VALUES (${userId}, 'm:1', -1)`,
        ),
      ).rejects.toThrow();
    });
    it('accepts a zero/positive count and upserts', async () => {
      await tdb.db.execute(
        sql`INSERT INTO comment_rate_limits (user_id, window_key, count) VALUES (${userId}, 'm:1', 1)`,
      );
      const res = await tdb.db.execute(
        sql`INSERT INTO comment_rate_limits (user_id, window_key, count) VALUES (${userId}, 'm:1', 1)
            ON CONFLICT (user_id, window_key) DO UPDATE SET count = comment_rate_limits.count + 1
            RETURNING count`,
      );
      expect(Number((res.rows[0] as { count: number }).count)).toBe(2);
    });
  });

  it('pm_markets.comments_enabled defaults to true', async () => {
    const row = await tdb.db.execute(
      sql`SELECT comments_enabled FROM pm_markets WHERE id = ${pmId}`,
    );
    expect((row.rows[0] as { comments_enabled: boolean }).comments_enabled).toBe(true);
  });
});
