// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-creator-fee-window.test.ts
//
// Adversary pass on 1e2f041 (creatorFeeOpMayHaveLanded + SUBMITTED_SETTLE_S). Spec point 3: the 600 s window uses the
// database clock only. The window's end is `now()` (database), but its start, status_updated_at, is written by every
// transition in aa-pending-user-ops.ts as `new Date()`, the application server's clock. When the app clock runs
// behind the database, a row that expired seconds ago (database time) already sits outside the window, so a second
// sponsored claim is built while the first submitted op may still land (spec 1). When the app clock runs ahead, a
// dropped op blocks a real claim for the skew on top of the window (spec 2).
//
// Real sponsor and send routes, real aa-pending-user-ops SQL on PGlite. Only the session, the daily count, Pimlico
// (buildSponsoredUserOp), the bundler send and the chain resolver are stubbed. Only `new Date()` is skewed, to model
// the app server's clock; the database's now() is checked to stay on real time.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

import { buildClaimCreatorFeeBody } from '../aa-client';
import { MONAD_TESTNET_ID } from '../chain';
import { MAKO_ADDRESS } from '../contract';

const USER = '11111111-1111-4111-8111-111111111111';
const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const USER_OP_HASH = ('0x' + 'cc'.repeat(32)) as Hex;
const TX_HASH = ('0x' + 'dd'.repeat(32)) as Hex;

const state = vi.hoisted(() => ({
  db: null as unknown,
  incrementOrReject: vi.fn(),
  decrementForRefund: vi.fn(),
  buildSponsoredUserOp: vi.fn(),
  sendSignedUserOp: vi.fn(),
  resolveSubmittedOp: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ userId: USER, email: 'a@b.com', magicEoa: MAGIC_EOA, sessionId: 's-1' }),
}));
vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: (a: unknown) => state.incrementOrReject(a),
  decrementForRefund: (a: unknown) => state.decrementForRefund(a),
}));
// The lagging node of this scenario: the sponsor route's own chain read still shows the fee unclaimed, so only the
// server's record can stop the second claim.
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({ readContract: async () => ({ creatorFeeClaimed: false }) }),
}));
vi.mock('@/lib/user-op', async (importActual) => ({
  ...(await importActual<typeof import('../user-op')>()),
  buildSponsoredUserOp: (a: unknown) => state.buildSponsoredUserOp(a),
  sendSignedUserOp: (a: unknown) => state.sendSignedUserOp(a),
  resolveSubmittedOp: (a: unknown) => state.resolveSubmittedOp(a),
}));

import { POST as sponsor } from '../../app/api/aa/sponsor/route';
import { POST as send } from '../../app/api/aa/send/route';
import { wrapperCallDataFor } from '../user-op-encode';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  state.db = drizzle(pg);
  await pg.exec(`
    CREATE TYPE aa_pending_status AS ENUM ('pending','sending','submitted','sent','reverted','failed_pre_submit','expired','ambiguous');
    CREATE TABLE user_safes (user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address text NOT NULL, deployed_at timestamptz);
    CREATE TABLE aa_pending_user_ops (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address varchar(42) NOT NULL, magic_eoa varchar(42) NOT NULL,
      user_op jsonb NOT NULL, nonce_hex varchar(66) NOT NULL, safe_op_hash varchar(66) NOT NULL,
      status aa_pending_status NOT NULL DEFAULT 'pending', user_op_hash varchar(66), tx_hash varchar(66), failure_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, sending_started_at timestamptz,
      status_updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX aa_pending_one_in_flight ON aa_pending_user_ops (chain_id, safe_address)
      WHERE status IN ('pending','sending','submitted','ambiguous');`);
  await pg.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [USER, MONAD_TESTNET_ID, SAFE]);
});
afterAll(async () => {
  await pg.close();
});

function req(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
}

const SKEW_S = 660; // app server clock 11 minutes behind the database

function opFor(a: { call: { to: Address; value: bigint; data: Hex } }) {
  return {
    userOp: {
      sender: SAFE,
      nonce: '0x0',
      initCode: '0x',
      callData: wrapperCallDataFor({ call: a.call }),
      callGasLimit: '0x186a0',
      verificationGasLimit: '0x186a0',
      preVerificationGas: '0x186a0',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
      paymaster: '0x3333333333333333333333333333333333333333',
      paymasterVerificationGasLimit: '0x186a0',
      paymasterPostOpGasLimit: '0x186a0',
      paymasterData: '0x',
    },
    safeOpHash: ('0x' + 'aa'.repeat(32)) as Hex,
    userOpHash: USER_OP_HASH,
    validAfter: 0n,
    validUntil: 0xffffffffffffn,
  };
}

describe('adversary: creator-fee window start is stamped with the app clock, not the database clock', () => {
  const RealDate = Date;
  afterEach(() => {
    globalThis.Date = RealDate;
  });

  it('an op expired seconds ago (database clock) still blocks a second claim when the app clock lags (spec 1, 3)', async () => {
    state.incrementOrReject.mockResolvedValue({ kind: 'within_cap', count: 1 });
    state.buildSponsoredUserOp.mockImplementation(async (a: { call: { to: Address; value: bigint; data: Hex } }) => opFor(a));
    state.sendSignedUserOp.mockImplementation(async (a: { onUserOpHashComputed: (h: Hex) => Promise<void> }) => {
      await a.onUserOpHashComputed(USER_OP_HASH);
      return { outcome: 'send_unknown', userOpHash: USER_OP_HASH };
    });
    // Lagging node: no receipt yet, nonce unchanged, so the resolver gives up on an op the bundler still holds.
    state.resolveSubmittedOp.mockResolvedValue({ final: 'safe_to_expire' });

    const claim = buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 42n });

    // 1. First claim sponsored, signed and handed to the bundler (answer lost: `submitted`).
    const r1 = await sponsor(req('http://localhost/api/aa/sponsor', claim));
    expect(r1.status).toBe(200);
    const { pendingUserOpId } = (await r1.json()) as { pendingUserOpId: string };
    const sig = ('0x' + '11'.repeat(77)) as Hex;
    const s1 = await send(req('http://localhost/api/aa/send', { pendingUserOpId, signature: sig }));
    expect(((await s1.json()) as { status: string }).status).toBe('submitted');

    // 2. The app server's clock is 11 minutes behind the database's (NTP step, a bad host). The database clock is not.
    const realNow = Date.now();
    // Only `new Date()` (what every transition stamps status_updated_at with) reads the skewed app clock. Date.now()
    // stays real, because PGlite's own now() is driven by it (faking it moves the database clock too).
    class AppClockDate extends RealDate {
      constructor(...a: ConstructorParameters<DateConstructor> | []) {
        if (a.length === 0) super(RealDate.now() - SKEW_S * 1000);
        else super(...(a as [string | number | Date]));
      }
    }
    globalThis.Date = AppClockDate as DateConstructor;
    const dbNow = await pg.query<{ s: number }>(`SELECT extract(epoch from now())::float8 AS s`);
    expect(Math.abs(dbNow.rows[0].s * 1000 - realNow)).toBeLessThan(60_000);

    // 3. Browser re-POSTs send: the resolver expires the row now (database time).
    const s2 = await send(req('http://localhost/api/aa/send', { pendingUserOpId, signature: sig }));
    expect(s2.status).toBe(410);
    const age = await pg.query<{ age_s: number; status: string }>(
      `SELECT status, extract(epoch from now() - status_updated_at)::float8 AS age_s FROM aa_pending_user_ops WHERE id = $1`,
      [pendingUserOpId],
    );

    // 4. Seconds later on the database clock, the same claim again. The first op may still land (the chain read shows
    //    the fee unclaimed only because it has not landed yet), so no second claim may be counted or built.
    const r2 = await sponsor(req('http://localhost/api/aa/sponsor', claim));
    expect({
      rowStatus: age.rows[0].status,
      secondsSinceExpiryOnDbClockLessThanWindow: age.rows[0].age_s < 600,
      secondClaimSponsored: r2.status === 200,
      builds: state.buildSponsoredUserOp.mock.calls.length,
      dailyOps: state.incrementOrReject.mock.calls.length,
    }).toEqual({
      rowStatus: 'expired',
      secondsSinceExpiryOnDbClockLessThanWindow: true,
      secondClaimSponsored: false,
      builds: 1,
      dailyOps: 1,
    });
  });
});
