// pglite for the competition tests: the real 0008 ledger plus a minimal mirror of users/user_safes with the columns
// the competition reads (as leaderboard/__tests__/identity.test.ts does). Raw SQL inserts, because Drizzle's insert
// builder names every column of the full users table.

import { COMPETITION_START } from '@/lib/competition/config';
import { CONTRACT_LOWER } from '@/lib/competition/referrals';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

export const CHAIN = 10143;
export const HOUR = 60 * 60 * 1000;
/// An instant `hours` after the competition start (negative = before).
export const at = (hours: number) => new Date(COMPETITION_START.getTime() + hours * HOUR);
/// A lowercase address from a short hex tag: `addr('a1')` = 0xa1a1…, so its code is distinct per tag.
export const addr = (tag: string) => `0x${tag.repeat(40 / tag.length)}` as `0x${string}`;
export const codeOf = (a: string) => `r-${a.toLowerCase().slice(2, 32)}`;

export async function competitionDb(): Promise<TestDb> {
  const t = await createTestDb();
  await t.client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      wallet_address text,
      display_name text,
      avatar_url text,
      ref text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE user_safes (user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address text NOT NULL);
  `);
  return t;
}

/// A wallet account (lowercase wallet_address), or an email account with a CHECKSUMMED Safe as production stores it.
export async function account(
  t: TestDb,
  o: { wallet?: string; safe?: string; ref?: string | null; createdAt?: Date; name?: string },
): Promise<string> {
  const res = await t.client.query<{ id: string }>(
    `INSERT INTO users (email, wallet_address, ref, created_at, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [o.safe ? 'never-selected@example.com' : null, o.wallet ?? null, o.ref ?? null, (o.createdAt ?? at(1)).toISOString(), o.name ?? null],
  );
  const id = res.rows[0].id;
  if (o.safe) await t.client.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [id, CHAIN, o.safe]);
  return id;
}

let log = 0;
/// One ledger row on the live contract.
export async function event(
  t: TestDb,
  o: { actor: string; market: number; kind: 'bet' | 'claim'; amount: bigint; when: Date; yes?: boolean; contract?: string },
): Promise<void> {
  log += 1;
  await t.client.query(
    `INSERT INTO mako_market_events (chain_id, contract_address, version, market_id, kind, actor, is_yes, amount, block_number, block_timestamp, tx_hash, log_index)
     VALUES ($1, $2, 'v4', $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
    [CHAIN, o.contract ?? CONTRACT_LOWER, String(o.market), o.kind, o.actor.toLowerCase(), o.kind === 'bet' ? (o.yes ?? true) : null, o.amount.toString(), log, o.when.toISOString(), `0x${log.toString(16).padStart(64, '0')}`],
  );
}
