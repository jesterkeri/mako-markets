// ----------------------------------------------------------------------------
// #214 S1 two-connection tests (NOTIFICATIONS_PLAN r8 §8 S1 "Account membership" 7 and "Account removal" 12). They
// prove the lock waits that pglite (one connection) cannot: an address write in flight at the batch's FOR SHARE check,
// a users delete in flight at a notification insert's foreign-key check, and writes that reach their trigger after the
// check. They need a real, THROWAWAY PostgreSQL 16 (the CI service container the plan names, from #213):
//
//   NOTIFY_PG_TEST_URL=postgres://postgres:postgres@localhost:5432/notify_test pnpm test:notify
//
// The suite DROPS and recreates the `public` schema of that database, so it refuses any host other than localhost,
// 127.0.0.1 or the CI service name `postgres`. Without the variable it is skipped, and says so.
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { accountAddresses, accountUserIds } from '@/lib/leaderboard/identity';
import { runLeaderboardIndexerOnce } from '@/lib/leaderboard/indexer';
import type { AccountSource } from '@/lib/notifications/produce';

import { betLog, CHAIN, mockChain, noSleep, resolvedLog, V4, type MockChain } from '../__tests__/harness';

const URL_ENV = process.env.NOTIFY_PG_TEST_URL;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);
const usable = (() => {
  if (!URL_ENV) return false;
  try {
    return LOCAL_HOSTS.has(new URL(URL_ENV).hostname);
  } catch {
    return false;
  }
})();
if (!usable) {
  console.warn(
    URL_ENV
      ? '[notify race tests] SKIPPED: NOTIFY_PG_TEST_URL must point at a throwaway local PostgreSQL (localhost, 127.0.0.1 or postgres).'
      : '[notify race tests] SKIPPED: set NOTIFY_PG_TEST_URL to a throwaway PostgreSQL 16 to run the two-connection tests.',
  );
}

const F = 1_000;
const HEAD = 1_216;
const P = 5;
const ALICE = '0xa11ce00000000000000000000000000000000001';
const CAROL = '0xca401000000000000000000000000000000000c3';
const SAFE = '0x5AFE000000000000000000000000000000000001';

describe.skipIf(!usable)('two connections: the membership instant is the batch commit (PostgreSQL)', () => {
  let admin: postgres.Sql;
  let poolB: postgres.Sql;
  let connA: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(URL_ENV!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve('src/db/migrations');
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    for (const e of journal.entries) {
      for (const stmt of readFileSync(join(dir, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await admin.unsafe(stmt);
      }
    }
    poolB = postgres(URL_ENV!, { max: 4, onnotice: () => {} });
    connA = postgres(URL_ENV!, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([admin?.end(), poolB?.end(), connA?.end()]);
  });

  beforeEach(async () => {
    await admin.unsafe(`TRUNCATE notifications, notify_cursor, mako_market_events, mako_leaderboard_indexer_state, user_safes, users CASCADE`);
    await admin`INSERT INTO mako_leaderboard_indexer_state (chain_id, contract_address, last_scanned_block, last_scan_target) VALUES (${CHAIN}, ${V4.address}, ${F - 1}, ${F - 1})`;
    await admin`INSERT INTO users (wallet_address, auth_type) VALUES (${CAROL}, 'wallet')`;
  });

  const chainFor = (bettor: string): MockChain =>
    mockChain({
      head: HEAD,
      logs: [betLog(P, bettor, true, F - 10), resolvedLog(P, 3, F + 10)],
      markets: new Map([[String(P), { creator: CAROL, totalYes: 1_000_000n, totalNo: 0n, yesBettorCount: 1, noBettorCount: 0, outcome: 3, resolved: true, creatorFeeBpsSnapshot: 0 }]]),
      bets: new Map([[`${P}:${bettor.toLowerCase()}`, [1_000_000n, 0n]]]),
    });

  const run = (chain: MockChain, extra: { accounts?: AccountSource; afterVersionCheck?: () => Promise<void> } = {}) =>
    runLeaderboardIndexerOnce({
      db: drizzle(poolB, { schema }) as never,
      publicClient: chain.client,
      chainId: CHAIN,
      contracts: [V4],
      chunkSize: 100,
      notifyFromBlock: F,
      sleep: noSleep,
      ...extra,
    }).then((r) => r.contracts[0]);

  /// Resolves once some backend is waiting on a lock (the batch, or the writer).
  async function lockWaitSeen() {
    for (let i = 0; i < 200; i += 1) {
      const [{ n }] = await admin`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no lock wait seen within 10 s');
  }

  /// Starts a transaction on connection A that runs `stmt` and stays open until `commit()` is called.
  function openWrite(stmt: (tx: postgres.TransactionSql) => Promise<unknown>) {
    let commit!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((r) => (commit = r));
    const begun = new Promise<void>((r) => (started = r));
    const done = connA.begin(async (tx) => {
      await stmt(tx);
      started();
      await hold;
    });
    return { begun, commit, done };
  }

  /// Opens a write on A once the named account read of the first attempt has returned.
  function hookOnce(on: 'addresses' | 'userIds', open: () => Promise<void>) {
    const counts = { addresses: 0, userIds: 0 };
    const source: AccountSource = {
      async addresses(db, chainId) {
        const r = await accountAddresses(db, chainId);
        counts.addresses += 1;
        if (on === 'addresses' && counts.addresses === 1) await open();
        return r;
      },
      async userIds(db, addrs, chainId) {
        const r = await accountUserIds(db, addrs, chainId);
        counts.userIds += 1;
        if (on === 'userIds' && counts.userIds === 1) await open();
        return r;
      },
    };
    return { source, counts };
  }

  const rowsFor = async (wallet: string) =>
    (await admin`SELECT n.kind FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.wallet_address = ${wallet}`).length;

  it('a sign-up in flight at the check: the batch waits, rolls back, retries, and Alice gets exactly one row', async () => {
    let write!: ReturnType<typeof openWrite>;
    const { source, counts } = hookOnce('addresses', async () => {
      write = openWrite((tx) => tx`INSERT INTO users (wallet_address, auth_type) VALUES (${ALICE}, 'wallet')`);
      await write.begun;
      void lockWaitSeen().then(() => write.commit());
    });
    const r = await run(chainFor(ALICE), { accounts: source });
    await write.done;
    expect(r.error).toBeUndefined();
    expect(counts.userIds).toBe(2);
    expect(await rowsFor(ALICE)).toBe(1);
  });

  it('a sign-up after the check waits for the batch commit and is not owed the result', async () => {
    let write: ReturnType<typeof openWrite> | null = null;
    const chain = chainFor(ALICE);
    const r = await run(chain, {
      afterVersionCheck: async () => {
        // B holds its transaction open after the check; A's sign-up reaches its trigger and must wait.
        write = openWrite((tx) => tx`INSERT INTO users (wallet_address, auth_type) VALUES (${ALICE}, 'wallet')`);
        await lockWaitSeen();
      },
    });
    write!.commit();
    await write!.done; // A's sign-in succeeds; its wait ended at B's commit
    expect(r.error).toBeUndefined();
    expect(await rowsFor(ALICE)).toBe(0);
    await run(chain);
    expect(await rowsFor(ALICE)).toBe(0);
  });

  it('a Safe removal in flight at the check: the batch waits, retries, and Alice gets no row', async () => {
    const [{ id }] = await admin`INSERT INTO users (email, magic_eoa, auth_type) VALUES ('alice@example.com', '0x00000000000000000000000000000000000000e1', 'magic') RETURNING id`;
    await admin`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES (${id}, ${CHAIN}, ${SAFE})`;
    let write!: ReturnType<typeof openWrite>;
    const { source, counts } = hookOnce('userIds', async () => {
      write = openWrite((tx) => tx`DELETE FROM user_safes WHERE user_id = ${id}`);
      await write.begun;
      void lockWaitSeen().then(() => write.commit());
    });
    const r = await run(chainFor(SAFE), { accounts: source });
    await write.done;
    expect(r.error).toBeUndefined();
    expect(counts.userIds).toBe(2);
    expect((await admin`SELECT 1 FROM notifications WHERE user_id = ${id}`).length).toBe(0);
  });

  it("a wallet account removal in flight: the insert's foreign-key check waits, fails 23503, and the batch retries", async () => {
    await admin`INSERT INTO users (wallet_address, auth_type) VALUES (${ALICE}, 'wallet')`;
    let write!: ReturnType<typeof openWrite>;
    const { source, counts } = hookOnce('userIds', async () => {
      write = openWrite((tx) => tx`DELETE FROM users WHERE wallet_address = ${ALICE}`);
      await write.begun;
      void lockWaitSeen().then(() => write.commit());
    });
    const r = await run(chainFor(ALICE), { accounts: source });
    await write.done;
    expect(r.error).toBeUndefined();
    expect(counts.userIds).toBe(2);
    expect((await admin`SELECT count(*)::int AS n FROM notifications`)[0].n).toBe(0);
  });

  it("a removal after the check waits for the commit: Alice's row is written, then deleted with her account", async () => {
    await admin`INSERT INTO users (wallet_address, auth_type) VALUES (${ALICE}, 'wallet')`;
    let write: ReturnType<typeof openWrite> | null = null;
    const r = await run(chainFor(ALICE), {
      afterVersionCheck: async () => {
        write = openWrite((tx) => tx`DELETE FROM users WHERE wallet_address = ${ALICE}`);
        await lockWaitSeen();
      },
    });
    write!.commit();
    await write!.done;
    expect(r.error).toBeUndefined();
    expect((await admin`SELECT count(*)::int AS n FROM notifications`)[0].n).toBe(0); // written at B's commit, then cascaded
  });

  it("a Safe-row delete after the check leaves Alice's row in place", async () => {
    const [{ id }] = await admin`INSERT INTO users (email, magic_eoa, auth_type) VALUES ('alice@example.com', '0x00000000000000000000000000000000000000e1', 'magic') RETURNING id`;
    await admin`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES (${id}, ${CHAIN}, ${SAFE})`;
    let write: ReturnType<typeof openWrite> | null = null;
    const r = await run(chainFor(SAFE), {
      afterVersionCheck: async () => {
        write = openWrite((tx) => tx`DELETE FROM user_safes WHERE user_id = ${id}`);
        await lockWaitSeen();
      },
    });
    write!.commit();
    await write!.done;
    expect(r.error).toBeUndefined();
    expect((await admin`SELECT 1 FROM notifications WHERE user_id = ${id}`).length).toBe(1);
  });
});
