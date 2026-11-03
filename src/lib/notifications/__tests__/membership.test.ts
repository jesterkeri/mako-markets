// #214 S1: the membership instant (NOTIFICATIONS_PLAN r8 §3.2 "Recipient history", steps 0, 5 and 6; §8 S1
// "Account membership" (Codex R3 F1) and "Account removal" (Codex R4 F1)). Real migrations 0000..0020, so users,
// user_safes and the seven account-address version triggers are the real ones. A hook wraps the account reads and
// commits a registry write between those reads and the batch commit. The two-connection cases need PostgreSQL and
// live in ../__pg_tests__.
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { userSafes } from '@/db/schema';
import { accountAddresses, accountUserIds } from '@/lib/leaderboard/identity';
import { runLeaderboardIndexerOnce } from '@/lib/leaderboard/indexer';
import type { AccountSource } from '@/lib/notifications/produce';
import { upsertWalletUser } from '@/lib/user-upsert';

import {
  betLog,
  CHAIN,
  createNotifyDb,
  emailAccount,
  mockChain,
  noSleep,
  notificationsOf,
  notifiedThrough,
  resolvedLog,
  setCursor,
  V4,
  version,
  walletAccount,
  type MockChain,
  type NotifyDb,
} from './harness';

const F = 1_000;
const HEAD = 1_216;
const P = 5;
const ALICE = '0xa11ce00000000000000000000000000000000001';
const CAROL = '0xca401000000000000000000000000000000000c3';
const OLD_SAFE = '0x5AFE000000000000000000000000000000000001';
const NEW_SAFE = '0x5aFe000000000000000000000000000000000002';

let t: NotifyDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/// Counts attempts (one mapping read per attempt) and runs `hook` after the named read returns.
function hooked(on: 'addresses' | 'userIds', hook: (call: number) => Promise<void>) {
  const counts = { addresses: 0, userIds: 0 };
  const source: AccountSource = {
    async addresses(db, chainId) {
      const r = await accountAddresses(db, chainId);
      counts.addresses += 1;
      if (on === 'addresses') await hook(counts.addresses);
      return r;
    },
    async userIds(db, addrs, chainId) {
      const r = await accountUserIds(db, addrs, chainId);
      counts.userIds += 1;
      if (on === 'userIds') await hook(counts.userIds);
      return r;
    },
  };
  return { source, counts };
}

/// Roster test 1's chain: Alice's YES at F − 10 (below the cursor, never in the ledger), REFUND at F + 10, counts 1/0.
function chainFor(bettor: string, betBlock = F - 10): MockChain {
  return mockChain({
    head: HEAD,
    logs: [betLog(P, bettor, true, betBlock), resolvedLog(P, 3, F + 10)],
    markets: new Map([[String(P), { creator: CAROL, totalYes: 1_000_000n, totalNo: 0n, yesBettorCount: 1, noBettorCount: 0, outcome: 3, resolved: true, creatorFeeBpsSnapshot: 0 }]]),
    bets: new Map([[`${P}:${bettor.toLowerCase()}`, [1_000_000n, 0n]]]),
  });
}

const run = (chain: MockChain, accounts?: AccountSource) =>
  runLeaderboardIndexerOnce({ db: t!.db as never, publicClient: chain.client, chainId: CHAIN, contracts: [V4], chunkSize: 100, notifyFromBlock: F, sleep: noSleep, accounts }).then(
    (r) => r.contracts[0],
  );

async function fresh() {
  t = await createNotifyDb();
  await setCursor(t, V4.address, F - 1);
  await walletAccount(t, CAROL); // an account with no stake, so the account list is never empty
  return t;
}

const aliceId = async (db: NotifyDb) =>
  (await db.client.query<{ id: string }>(`SELECT id FROM users WHERE wallet_address = $1 OR email = 'alice@example.com'`, [ALICE])).rows[0]?.id;

describe('account membership: an account created while the batch runs (Codex R3 F1)', () => {
  it("Codex's test: a wallet account created after accountAddresses is read gets exactly one row after a retry", async () => {
    const db = await fresh();
    const { source, counts } = hooked('addresses', async (call) => {
      if (call === 1) await upsertWalletUser(ALICE, { tx: db.db as never });
    });
    const chain = chainFor(ALICE);
    const r = await run(chain, source);
    expect(counts.userIds).toBe(2);
    expect(r.rosterFromChain).toBe(1);
    expect(await notificationsOf(db, await aliceId(db))).toEqual([expect.objectContaining({ kind: 'claim', data: { t: 'pool', id: String(P), outcome: 'refund', why: 'refund' } })]);
    expect((await notifiedThrough(db, V4.address))!).toBeGreaterThanOrEqual(F + 10);
    await run(chain);
    expect(await notificationsOf(db)).toHaveLength(1);
  });

  it('a Safe row added later (the sign-in insert) counts', async () => {
    const db = await fresh();
    const alice = await emailAccount(db, null);
    const { source, counts } = hooked('addresses', async (call) => {
      if (call === 1) {
        await db.db.insert(userSafes).values({ userId: alice, chainId: CHAIN, safeAddress: NEW_SAFE }).onConflictDoNothing({ target: [userSafes.userId, userSafes.chainId] });
      }
    });
    await run(chainFor(NEW_SAFE), source);
    expect(counts.userIds).toBe(2);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('a Safe moved in place (ON CONFLICT DO UPDATE SET safe_address) counts', async () => {
    const db = await fresh();
    const alice = await emailAccount(db, OLD_SAFE);
    const { source, counts } = hooked('addresses', async (call) => {
      if (call === 1) {
        await db.db
          .insert(userSafes)
          .values({ userId: alice, chainId: CHAIN, safeAddress: NEW_SAFE })
          .onConflictDoUpdate({ target: [userSafes.userId, userSafes.chainId], set: { safeAddress: NEW_SAFE } });
      }
    });
    await run(chainFor(NEW_SAFE), source);
    expect(counts.userIds).toBe(2);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('ledger path: an account created after the mapping read is retried too, with no getUserBet call', async () => {
    const db = await fresh();
    const { source, counts } = hooked('userIds', async (call) => {
      if (call === 1) await upsertWalletUser(ALICE, { tx: db.db as never });
    });
    const chain = chainFor(ALICE, F + 2);
    await run(chain, source);
    expect(counts.userIds).toBe(2);
    expect(chain.calls.positionReads).toBe(0);
    expect(await notificationsOf(db, await aliceId(db))).toHaveLength(1);
  });

  it('the attempts run out: 3 attempts, nothing written, roster_changed; the next run notifies once', async () => {
    const db = await fresh();
    await walletAccount(db, ALICE);
    let k = 0;
    const { source, counts } = hooked('addresses', async () => {
      k += 1;
      await walletAccount(db, `0x${(0xbeef00 + k).toString(16).padStart(40, '0')}`);
    });
    const chain = chainFor(ALICE);
    const r = await run(chain, source);
    expect(counts.userIds).toBe(3);
    expect(r.mutex).toBe('error');
    expect(r.error).toBe('roster_changed');
    expect(r.upToDate).toBe(false);
    expect(await notificationsOf(db)).toHaveLength(0);
    expect((await notifiedThrough(db, V4.address)) ?? F - 1).toBeLessThan(F + 10);
    const r2 = await run(chain);
    expect(r2.upToDate).toBe(true);
    expect(await notificationsOf(db, await aliceId(db))).toHaveLength(1);
  });

  it('no address, no version change: re-sign-ins, a display-name save and a TOTP update', async () => {
    const db = await fresh();
    const email = await emailAccount(db, OLD_SAFE);
    await walletAccount(db, ALICE);
    const v = await version(db);
    await db.db.insert(userSafes).values({ userId: email, chainId: CHAIN, safeAddress: OLD_SAFE }).onConflictDoNothing({ target: [userSafes.userId, userSafes.chainId] });
    await upsertWalletUser(ALICE, { tx: db.db as never });
    await db.client.query(`UPDATE users SET display_name = 'Alice' WHERE id = $1`, [email]);
    await db.client.query(`UPDATE users SET totp_failed_attempts = 1, totp_locked_until = now() WHERE id = $1`, [email]);
    expect(await version(db)).toBe(v);
  });
});

describe('account removal while the batch runs (Codex R4 F1)', () => {
  it('a Safe row removed after the mapping read: the first attempt rolls back, Alice gets no row', async () => {
    const db = await fresh();
    const alice = await emailAccount(db, OLD_SAFE);
    const { source, counts } = hooked('userIds', async (call) => {
      if (call === 1) await db.db.delete(userSafes).where(eq(userSafes.userId, alice));
    });
    const chain = chainFor(OLD_SAFE);
    const r = await run(chain, source);
    expect(counts.userIds).toBe(2);
    expect(r.error).toBeUndefined();
    expect(await notificationsOf(db, alice)).toHaveLength(0);
    expect((await notifiedThrough(db, V4.address))!).toBeGreaterThanOrEqual(F + 10);
    await run(chain);
    expect(await notificationsOf(db)).toHaveLength(0);
  });

  it('through the cascade: deleting the email account removes its Safe row and counts', async () => {
    const db = await fresh();
    const alice = await emailAccount(db, OLD_SAFE);
    const { source, counts } = hooked('userIds', async (call) => {
      if (call === 1) await db.client.query(`DELETE FROM users WHERE id = $1`, [alice]);
    });
    await run(chainFor(OLD_SAFE), source);
    expect(counts.userIds).toBe(2);
    expect(await notificationsOf(db)).toHaveLength(0);
  });

  it('a wallet account removed after the mapping read gets no row', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const { source, counts } = hooked('userIds', async (call) => {
      if (call === 1) await db.client.query(`DELETE FROM users WHERE id = $1`, [alice]);
    });
    await run(chainFor(ALICE), source);
    expect(counts.userIds).toBe(2);
    expect(await notificationsOf(db)).toHaveLength(0);
  });

  it('a Safe moved by a delete then an insert in one transaction: the delete alone raises the version; one row', async () => {
    const db = await fresh();
    const alice = await emailAccount(db, OLD_SAFE);
    let afterDelete = -1;
    let before = -1;
    const { source, counts } = hooked('userIds', async (call) => {
      if (call !== 1) return;
      await db.client.transaction(async (tx) => {
        before = Number((await tx.query<{ v: string }>(`SELECT version AS v FROM account_address_version`)).rows[0].v);
        await tx.query(`DELETE FROM user_safes WHERE user_id = $1`, [alice]);
        afterDelete = Number((await tx.query<{ v: string }>(`SELECT version AS v FROM account_address_version`)).rows[0].v);
        await tx.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [alice, CHAIN, NEW_SAFE]);
      });
    });
    await run(chainFor(NEW_SAFE), source);
    expect(afterDelete).toBe(before + 1);
    expect(counts.userIds).toBe(2);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('every removal and move shape raises the version; a no-address delete and a refused delete do not', async () => {
    const db = await fresh();
    const bump = async (stmt: () => Promise<unknown>) => {
      const v = await version(db);
      await stmt();
      return (await version(db)) - v;
    };
    const e1 = await emailAccount(db, OLD_SAFE);
    expect(await bump(() => db.client.query(`DELETE FROM user_safes WHERE user_id = $1`, [e1]))).toBe(1);
    const w1 = await walletAccount(db, '0x00000000000000000000000000000000000000f1');
    expect(await bump(() => db.client.query(`DELETE FROM users WHERE id = $1`, [w1]))).toBe(1);
    const e2 = await emailAccount(db, NEW_SAFE);
    expect(await bump(() => db.client.query(`DELETE FROM users WHERE id = $1`, [e2]))).toBe(1);
    await emailAccount(db, OLD_SAFE);
    expect(await bump(() => db.client.query(`TRUNCATE user_safes`))).toBe(1);
    const e3 = await emailAccount(db, OLD_SAFE);
    const e4 = await emailAccount(db, null);
    expect(await bump(() => db.client.query(`UPDATE user_safes SET user_id = $2 WHERE user_id = $1`, [e3, e4]))).toBe(1);
    const w2 = await walletAccount(db, '0x00000000000000000000000000000000000000f2');
    expect(await bump(() => db.client.query(`UPDATE users SET id = gen_random_uuid() WHERE id = $1`, [w2]))).toBe(1);
    const e5 = await emailAccount(db, null);
    expect(await bump(() => db.client.query(`DELETE FROM users WHERE id = $1`, [e5]))).toBe(0);
    const w3 = await walletAccount(db, '0x00000000000000000000000000000000000000f3');
    await db.client.query(
      `INSERT INTO deposits (user_id, chain_id, tx_hash, log_index, amount_usdc, source) VALUES ($1, $2, '0xabc', 0, 1, 'crypto_direct')`,
      [w3, CHAIN],
    );
    const v = await version(db);
    await expect(db.client.query(`DELETE FROM users WHERE id = $1`, [w3])).rejects.toThrow();
    expect(await version(db)).toBe(v);
  });

  it('the migration holds exactly the seven version triggers and one version row', async () => {
    const db = await fresh();
    const names = (await db.client.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgfoid = 'account_address_version_bump'::regproc ORDER BY 1`)).rows.map((r) => r.tgname);
    expect(names).toEqual([
      'user_safes_address_delete',
      'user_safes_address_insert',
      'user_safes_address_truncate',
      'user_safes_address_update',
      'users_wallet_address_delete',
      'users_wallet_address_insert',
      'users_wallet_address_update',
    ]);
    expect((await db.client.query(`SELECT id, version FROM account_address_version`)).rows).toHaveLength(1);
  });
});
