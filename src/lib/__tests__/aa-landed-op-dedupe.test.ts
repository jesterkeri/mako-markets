// creatorFeeOpMayHaveLanded (Codex CREATOR_EARNINGS R2, adversary on 48c6c5b) on real Postgres (PGlite): the SQL runs
// against the jsonb user_op column; it matches an op with exactly this wrapper callData from this Safe on this chain
// that LANDED (`sent`, for good), or that was handed to the bundler (has a user-op hash) and did not end `reverted` or
// `failed_pre_submit`, within SUBMITTED_SETTLE_S of its last status change (database clock); letter case ignored.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));

const SAFE = '0x000000000000000000000000000000000000beef';
const OTHER = '0x000000000000000000000000000000000000cafe';
const DATA = '0x7bb37428' + 'ab'.repeat(64);

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  state.db = drizzle(pg);
  await pg.exec(`
    CREATE TYPE aa_pending_status AS ENUM ('pending','sending','submitted','sent','reverted','failed_pre_submit','expired','ambiguous');
    CREATE TABLE aa_pending_user_ops (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address varchar(42) NOT NULL, magic_eoa varchar(42) NOT NULL,
      user_op jsonb NOT NULL, nonce_hex varchar(66) NOT NULL, safe_op_hash varchar(66) NOT NULL,
      status aa_pending_status NOT NULL DEFAULT 'pending', user_op_hash varchar(66), tx_hash varchar(66), failure_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, sending_started_at timestamptz,
      status_updated_at timestamptz NOT NULL DEFAULT now()
    );`);
});
afterAll(async () => {
  await pg.close();
});

async function row(over: { chain?: number; safe?: string; status?: string; callData?: string; hash?: string | null; agoSec?: number }) {
  await pg.query(
    `INSERT INTO aa_pending_user_ops (user_id, chain_id, safe_address, magic_eoa, user_op, nonce_hex, safe_op_hash, status, expires_at, user_op_hash, status_updated_at)
     VALUES (gen_random_uuid(), $1, $2, '0x1', $3::jsonb, '0x0', '0x0', $4, now(), $5, now() - make_interval(secs => $6))`,
    [over.chain ?? 10143, over.safe ?? SAFE, JSON.stringify({ callData: over.callData ?? DATA }), over.status ?? 'sent', over.hash === undefined ? null : over.hash, over.agoSec ?? 0],
  );
}

describe('creatorFeeOpMayHaveLanded', () => {
  it('finds only a landed op with this exact callData, Safe and chain; any letter case', async () => {
    const { creatorFeeOpMayHaveLanded } = await import('../aa-pending-user-ops');
    const ask = (over: { chain?: number; safe?: string; callData?: string } = {}) =>
      creatorFeeOpMayHaveLanded({ chainId: over.chain ?? 10143, safeAddress: (over.safe ?? SAFE) as `0x${string}`, callData: (over.callData ?? DATA) as `0x${string}` });

    expect(await ask()).toBe(false);
    for (const status of ['pending', 'sending', 'submitted', 'reverted', 'failed_pre_submit', 'expired', 'ambiguous']) await row({ status });
    await row({ safe: OTHER });
    await row({ chain: 1 });
    await row({ callData: '0x7bb37428' + 'cd'.repeat(64) });
    expect(await ask()).toBe(false);

    await row({ status: 'sent', callData: DATA.toUpperCase().replace('0X', '0x') });
    expect(await ask()).toBe(true);
    expect(await ask({ safe: SAFE.toUpperCase().replace('0X', '0x') })).toBe(true);
    expect(await ask({ callData: DATA.toUpperCase().replace('0X', '0x') })).toBe(true);
    expect(await ask({ chain: 2 })).toBe(false); // chain 1 has its own landed row above; chain 2 has none
  });

  it('an op the bundler got (it has a hash) counts for 10 minutes after its row ended expired or ambiguous, then not; never if it reverted or failed before submission', async () => {
    await pg.exec('DELETE FROM aa_pending_user_ops');
    const { creatorFeeOpMayHaveLanded, SUBMITTED_SETTLE_S } = await import('../aa-pending-user-ops');
    const ask = () => creatorFeeOpMayHaveLanded({ chainId: 10143, safeAddress: SAFE as `0x${string}`, callData: DATA as `0x${string}` });
    const H = '0x' + 'cc'.repeat(32);
    await row({ status: 'expired', hash: null });
    await row({ status: 'reverted', hash: H });
    await row({ status: 'failed_pre_submit', hash: H });
    await row({ status: 'expired', hash: H, agoSec: SUBMITTED_SETTLE_S + 5 });
    expect(await ask()).toBe(false);
    await row({ status: 'expired', hash: H, agoSec: 30 });
    expect(await ask()).toBe(true);
    await pg.exec('DELETE FROM aa_pending_user_ops');
    await row({ status: 'ambiguous', hash: H, agoSec: 60 });
    expect(await ask()).toBe(true);
  });
});
