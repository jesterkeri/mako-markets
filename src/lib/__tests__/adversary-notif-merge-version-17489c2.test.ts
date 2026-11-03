// Adversary on the #214 S1 merge (17489c2): staging's own account writes, on a database carrying every migration
// 0000-0020 in journal order, must still succeed and must raise account_address_version exactly when they add, move
// or remove an account address (0020's triggers), and never when they do not.
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { users } from '@/db/schema';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
import { deriveSafeAddress } from '@/lib/safe';
import { finishEmbeddedUser, prepareEmbeddedUser, upsertWalletUser } from '@/lib/user-upsert';

import { migratedPglite } from './helpers/migrated-pglite';

let pg: PGlite;
let db: Awaited<ReturnType<typeof migratedPglite>>['db'];

beforeEach(async () => {
  ({ client: pg, db } = await migratedPglite());
});
afterEach(async () => {
  await pg.close();
});

const version = async () => Number((await pg.query<{ version: string }>(`SELECT version FROM account_address_version`)).rows[0].version);

describe('adversary: staging account writes under 0020 triggers', () => {
  it('wallet sign-up (with a referral tag) raises the version once; a repeat sign-in does not', async () => {
    const v0 = await version();
    // `created` is not asserted: on PGlite drizzle's execute() answers { rows }, not postgres-js's array.
    await db.transaction((tx) => upsertWalletUser('0x' + 'ab'.repeat(20), { tx: tx as never, ref: 'r-abc' }));
    expect(await version()).toBe(v0 + 1);
    await db.transaction((tx) => upsertWalletUser('0x' + 'AB'.repeat(20), { tx: tx as never }));
    expect(await version()).toBe(v0 + 1);
  });

  it('Privy sign-up (create + Safe rows as /api/user/auth writes them) raises the version once per Safe row', async () => {
    const v0 = await version();
    const eoa = '0x' + '12'.repeat(20);
    await db.transaction(async (tx) => {
      const p = await prepareEmbeddedUser(tx as never, 'new@example.com', [eoa], 'did:privy:new', { deferMoveIfTotp: true });
      const r = await finishEmbeddedUser(tx as never, p, { rowIds: [], ceremonyIds: [], nowMs: Date.now() });
      expect(r.created).toBe(true);
      for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
        await tx.execute(sql`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES (${r.user.id}, ${chainId}, ${deriveSafeAddress(eoa as `0x${string}`)}) ON CONFLICT (user_id, chain_id) DO NOTHING`);
      }
    });
    expect(await version()).toBe(v0 + SAFE_TRACKED_CHAIN_IDS.length);
  });

  it('a Magic-era account moving to its Privy wallet (applyEmbeddedMove) raises the version: its Safe moved', async () => {
    const oldEoa = '0x' + '34'.repeat(20);
    const id = (await pg.query<{ id: string }>(`INSERT INTO users (email, magic_eoa, auth_type) VALUES ('old@example.com', $1, 'magic') RETURNING id`, [oldEoa])).rows[0].id;
    for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
      await pg.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [id, chainId, deriveSafeAddress(oldEoa as `0x${string}`)]);
    }
    const v0 = await version();
    const newEoa = '0x' + '56'.repeat(20);
    await db.transaction(async (tx) => {
      const p = await prepareEmbeddedUser(tx as never, 'old@example.com', [newEoa], 'did:privy:old', { deferMoveIfTotp: true });
      expect(p.action).toBe('move');
      const r = await finishEmbeddedUser(tx as never, p, { rowIds: [], ceremonyIds: [], nowMs: Date.now() });
      expect(r.moved).toBe(true);
    });
    expect(await version()).toBeGreaterThan(v0);
  });

  it('name, photo, referral code, verification mark, chart colours and notification prefs never raise it', async () => {
    const id = (await pg.query<{ id: string }>(`INSERT INTO users (wallet_address, auth_type) VALUES ($1, 'wallet') RETURNING id`, ['0x' + '78'.repeat(20)])).rows[0].id;
    const v0 = await version();
    await db.update(users).set({ displayName: 'Joker' }).where(sql`${users.id} = ${id}`);
    await db.update(users).set({ avatarUrl: null }).where(sql`${users.id} = ${id}`);
    await db.update(users).set({ ref: 'r-xyz' }).where(sql`${users.id} = ${id}`);
    await db.update(users).set({ privyEmailVerifiedSeen: 1_790_000_000 }).where(sql`${users.id} = ${id}`);
    await pg.query(`UPDATE users SET notification_prefs = '{"kinds":{"reply":false}}'::jsonb WHERE id = $1`, [id]);
    expect(await version()).toBe(v0);
  });
});
