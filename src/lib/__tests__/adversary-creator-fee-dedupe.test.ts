// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-creator-fee-dedupe.test.ts
//
// Adversary pass on step 6b of /api/aa/sponsor (Codex CREATOR_EARNINGS R2). Spec point 1: after a sponsored
// creator-fee claim for pool N lands, no further sponsored claim for pool N from that Safe is built, whatever the
// browser does. Step 6b trusts only rows in status `sent`. A row can reach `expired` while its signed op (valid until
// max uint48) is still with the bundler: a browser re-POST of /api/aa/send for a `submitted` row runs the resolver at
// once, and with no receipt yet and an unchanged nonce on a lagging node it answers `safe_to_expire`. The op then lands
// and the server's record still says `expired`, so a second claim for the same pool is counted and built.
//
// Real sponsor and send routes, real aa-pending-user-ops SQL on PGlite. Only the session, the daily count, Pimlico
// (buildSponsoredUserOp), the bundler send and the chain resolver are stubbed.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  getAaPublicClient: () => ({ readContract: async () => ({ creatorFeeClaimed: false }), getBlock: async () => ({ timestamp: 1_800_000_000n }) }),
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
import { aaPendingValidityWindowSql } from './aa-pending-migrations';

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
  await pg.exec(aaPendingValidityWindowSql());
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

describe('adversary: creator-fee dedupe vs a landed op recorded as expired', () => {
  it('a claim that lands after a browser re-POST marked its row expired is not sponsored a second time (spec 1)', async () => {
    state.incrementOrReject.mockResolvedValue({ kind: 'within_cap', count: 1 });
    // Pimlico stand-in: the stored callData is exactly what the real builder puts in the op.
    state.buildSponsoredUserOp.mockImplementation(async (a: { call: { to: Address; value: bigint; data: Hex } }) => ({
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
    }));
    // The bundler took the op but the transport lost its answer: the route records `submitted`.
    state.sendSignedUserOp.mockImplementation(async (a: { onUserOpHashComputed: (h: Hex) => Promise<void> }) => {
      await a.onUserOpHashComputed(USER_OP_HASH);
      return { outcome: 'send_unknown', userOpHash: USER_OP_HASH };
    });
    // First resolver run: no receipt yet, the lagging node still shows the old nonce. Every later read: it landed.
    state.resolveSubmittedOp
      .mockResolvedValueOnce({ final: 'safe_to_expire' })
      .mockResolvedValue({ final: 'sent', txHash: TX_HASH });

    const claim = buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 41n });

    // 1. First claim: sponsored and stored.
    const r1 = await sponsor(req('http://localhost/api/aa/sponsor', claim));
    expect(r1.status).toBe(200);
    const { pendingUserOpId } = (await r1.json()) as { pendingUserOpId: string };

    // 2. Signed and sent: bundler accepted, answer lost.
    const sig = ('0x' + '11'.repeat(77)) as Hex;
    const s1 = await send(req('http://localhost/api/aa/send', { pendingUserOpId, signature: sig }));
    expect(((await s1.json()) as { status: string }).status).toBe('submitted');

    // 3. The browser polls the same op again (reload, other tab): the resolver runs at once and expires the row.
    const s2 = await send(req('http://localhost/api/aa/send', { pendingUserOpId, signature: sig }));
    expect(s2.status).toBe(410);

    // 4. The op, signed and valid until max uint48, is then included: the claim has landed and the fee is paid.
    //    (resolveSubmittedOp now answers `sent` for it.) The server's row still reads `expired`.
    const rows = await pg.query<{ status: string }>(`SELECT status FROM aa_pending_user_ops WHERE id = $1`, [pendingUserOpId]);
    expect(rows.rows[0].status).toBe('expired');

    // 5. A second claim for the same pool from the same Safe must not be counted or built.
    const r2 = await sponsor(req('http://localhost/api/aa/sponsor', claim));
    expect({
      secondClaimSponsored: r2.status === 200,
      builds: state.buildSponsoredUserOp.mock.calls.length,
      dailyOps: state.incrementOrReject.mock.calls.length,
    }).toEqual({ secondClaimSponsored: false, builds: 1, dailyOps: 1 });
  });
});
