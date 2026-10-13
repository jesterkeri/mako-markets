// hasLandedOpWithCallData (Codex CREATOR_EARNINGS R2) on real Postgres (PGlite): the SQL runs against the jsonb
// user_op column, matches only a LANDED (`sent`) op with exactly this wrapper callData from this Safe on this chain,
// and ignores letter case.
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

async function row(over: { chain?: number; safe?: string; status?: string; callData?: string }) {
  await pg.query(
    `INSERT INTO aa_pending_user_ops (user_id, chain_id, safe_address, magic_eoa, user_op, nonce_hex, safe_op_hash, status, expires_at)
     VALUES (gen_random_uuid(), $1, $2, '0x1', $3::jsonb, '0x0', '0x0', $4, now())`,
    [over.chain ?? 10143, over.safe ?? SAFE, JSON.stringify({ callData: over.callData ?? DATA }), over.status ?? 'sent'],
  );
}

describe('hasLandedOpWithCallData', () => {
  it('finds only a landed op with this exact callData, Safe and chain; any letter case', async () => {
    const { hasLandedOpWithCallData } = await import('../aa-pending-user-ops');
    const ask = (over: { chain?: number; safe?: string; callData?: string } = {}) =>
      hasLandedOpWithCallData({ chainId: over.chain ?? 10143, safeAddress: (over.safe ?? SAFE) as `0x${string}`, callData: (over.callData ?? DATA) as `0x${string}` });

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
});
