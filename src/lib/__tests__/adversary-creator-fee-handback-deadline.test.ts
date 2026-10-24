// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-creator-fee-handback-deadline.test.ts
//
// Adversary pass on Codex CREATOR_EARNINGS R5 (diff 92b785d..5233406). The spec: the sponsor route must never hand back
// (HTTP 200 + a stored pending row) a creator-fee op that leaves less than CREATOR_FEE_MIN_SIGNING_S to sign, measured
// at the moment it is handed back.
//
// The route's last deadline check runs right after the build. Step 8b (retire a superseded op) and step 9 (INSERT the
// pending row) are database round trips that run after that check with no deadline of their own. A slow write (a Neon
// cold start after autosuspend) therefore hands back an op with under a minute left to sign.
//
// Same harness as creator-fee-validity-window.test.ts: real sponsor route, real builder, real aa-pending-user-ops SQL
// on PGlite with the committed 0016 migration; RPCs stubbed at the RPC layer. The only addition is that insertPending
// moves the (mocked) wall clock forward, standing in for a slow database write.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// A throwaway key generated for this test only; it holds nothing on any chain.
const account = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const USER = '11111111-1111-4111-8111-111111111111';
const PAYMASTER: Address = '0x3333333333333333333333333333333333333333';

const state = vi.hoisted(() => ({
  db: null as unknown,
  chainNow: 0n,
  clockMs: 0,
  insertDelayMs: 0,
  dailyOps: 0,
  refunds: 0,
  markSendingAfterInsert: false,
  pg: null as unknown,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ userId: USER, email: 'a@b.com', magicEoa: account.address, sessionId: 's-1' }),
}));
vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: async () => ({ kind: 'within_cap', count: ++state.dailyOps }),
  decrementForRefund: async () => {
    state.refunds += 1;
  },
}));
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    readContract: async (a: { functionName: string }) => {
      if (a.functionName === 'getMarket') return { creatorFeeClaimed: false };
      if (a.functionName === 'getNonce') return 7n;
      throw new Error(`unexpected read ${a.functionName}`);
    },
    getBlock: async () => ({ timestamp: state.chainNow }),
  }),
}));
vi.mock('@/lib/safe-init', async (importActual) => ({
  ...(await importActual<typeof import('../safe-init')>()),
  getInitCodeForFirstOp: async () => null,
}));
vi.mock('@/lib/aa-rpc', async (importActual) => ({
  ...(await importActual<typeof import('../aa-rpc')>()),
  getUserOperationGasPrice: async () => ({ standard: { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n } }),
  sponsorUserOperation: async () => ({
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: 60_000n,
    paymasterPostOpGasLimit: 1n,
    paymasterData: '0xabcd',
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 50_000n,
  }),
}));
// The real insert, preceded by a slow database round trip: the wall clock advances by insertDelayMs.
vi.mock('@/lib/aa-pending-user-ops', async (importActual) => {
  const actual = await importActual<typeof import('../aa-pending-user-ops')>();
  return {
    ...actual,
    insertPending: async (...a: Parameters<typeof actual.insertPending>) => {
      state.clockMs += state.insertDelayMs;
      const out = await actual.insertPending(...a);
      // Another tab recovered this op and began sending it while the insert's round trip finished.
      if (state.markSendingAfterInsert && out.kind === 'inserted') {
        await (state.pg as { query: (q: string, p: unknown[]) => Promise<unknown> }).query(
          `UPDATE aa_pending_user_ops SET status = 'sending', user_op_hash = $2, sending_started_at = now() WHERE id = $1`,
          [out.id, '0x' + 'ee'.repeat(32)],
        );
      }
      return out;
    },
  };
});

import { POST as sponsor } from '../../app/api/aa/sponsor/route';
import { buildClaimCreatorFeeBody } from '../aa-client';
import { CREATOR_FEE_MIN_SIGNING_S, CREATOR_FEE_OP_TTL_S } from '../aa-pending-user-ops';
import { MONAD_TESTNET_ID } from '../chain';
import { MAKO_ADDRESS } from '../contract';
import { deriveSafeAddress } from '../safe';
import { aaPendingValidityWindowSql } from './aa-pending-migrations';

const SAFE = deriveSafeAddress(account.address);

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  state.db = drizzle(pg);
  state.pg = pg;
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
  vi.restoreAllMocks();
  await pg.close();
});

function req(body: unknown): Request {
  return new Request('http://localhost/api/aa/sponsor', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-mako-eoa': account.address },
    body: JSON.stringify(body),
  });
}

const claim = () => req(buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 42n }));
const pendingRows = async () =>
  (await pg.query<{ id: string; valid_until: string }>(`SELECT id, valid_until::text FROM aa_pending_user_ops WHERE status IN ('pending','sending')`)).rows;

describe('adversary: creator-fee op handed back after the signing deadline (Codex CREATOR_EARNINGS R5)', () => {
  beforeEach(async () => {
    await pg.exec(`DELETE FROM aa_pending_user_ops`);
    Object.assign(state, { insertDelayMs: 0, dailyOps: 0, refunds: 0, markSendingAfterInsert: false });
  });
  it('a slow pending-row INSERT after the build must not yield 200 with under CREATOR_FEE_MIN_SIGNING_S left', async () => {
    const t = Math.floor(Date.now() / 1000);
    state.clockMs = t * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => state.clockMs);

    // Head 230 s behind: validUntil = t + 70, so the op must be handed back by t + 10 to leave 60 s to sign.
    state.chainNow = BigInt(t - (CREATOR_FEE_OP_TTL_S - CREATOR_FEE_MIN_SIGNING_S - 10));
    // The build itself is instant (passes every builder and route check at t); the INSERT takes 15 s.
    state.insertDelayMs = 15_000;

    const r = await sponsor(req(buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 42n })));
    const handedBackAtMs = Date.now();
    const body = (await r.json()) as { validUntil?: Hex; pendingUserOpId?: string };
    const rows = (await pg.query<{ status: string }>(`SELECT status::text FROM aa_pending_user_ops WHERE status = 'pending'`)).rows;

    if (r.status === 200) {
      const secondsLeftToSign = (Number(BigInt(body.validUntil!)) * 1000 - handedBackAtMs) / 1000;
      // Spec: never 200 + a stored pending row with under CREATOR_FEE_MIN_SIGNING_S left at hand-back.
      expect(rows).toHaveLength(1);
      expect(secondsLeftToSign, 'seconds left to sign when the 200 was handed back').toBeGreaterThanOrEqual(CREATOR_FEE_MIN_SIGNING_S);
    } else {
      // A refusal is the correct outcome, and then: nothing stored, no net daily count spent.
      expect({ pendingRows: rows.length, net: state.dailyOps - state.refunds }).toEqual({ pendingRows: 0, net: 0 });
    }
  });

  it('a slow INSERT while another tab already began sending the op: 409 IN_FLIGHT, no refund, the send keeps it', async () => {
    const t = Math.floor(Date.now() / 1000);
    state.clockMs = t * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => state.clockMs);
    state.chainNow = BigInt(t - (CREATOR_FEE_OP_TTL_S - CREATOR_FEE_MIN_SIGNING_S - 10));
    state.insertDelayMs = 15_000;
    state.markSendingAfterInsert = true;
    const r = await sponsor(claim());
    expect({ status: r.status, error: ((await r.json()) as { error: string }).error }).toEqual({ status: 409, error: 'IN_FLIGHT' });
    expect({ dailyOps: state.dailyOps, refunds: state.refunds }).toEqual({ dailyOps: 1, refunds: 0 });
    expect(await pendingRows()).toHaveLength(1);
  });

  it('a stored creator-fee op with under a minute left is replaced by a fresh build, not handed back', async () => {
    const t = Math.floor(Date.now() / 1000);
    state.clockMs = t * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => state.clockMs);
    state.chainNow = BigInt(t - (CREATOR_FEE_OP_TTL_S - CREATOR_FEE_MIN_SIGNING_S - 10)); // validUntil = t + 70
    const first = (await (await sponsor(claim())).json()) as { pendingUserOpId: string; validUntil: Hex };
    expect(BigInt(first.validUntil)).toBe(BigInt(t + 70));

    // 15 s later (55 s left on the stored op) the same claim again, now with a fresh head.
    state.clockMs += 15_000;
    state.chainNow = BigInt(t + 15);
    const r = await sponsor(claim());
    const second = (await r.json()) as { pendingUserOpId: string; validUntil: Hex; recovered?: boolean };
    expect({ status: r.status, recovered: second.recovered ?? false, fresh: second.pendingUserOpId !== first.pendingUserOpId }).toEqual({
      status: 200, recovered: false, fresh: true,
    });
    expect(BigInt(second.validUntil)).toBe(BigInt(t + 15 + CREATOR_FEE_OP_TTL_S));
    const old = await pg.query<{ status: string }>(`SELECT status::text FROM aa_pending_user_ops WHERE id = $1`, [first.pendingUserOpId]);
    expect(old.rows[0].status).toBe('expired');

    // With a minute or more left, the stored op is still handed back as before.
    state.clockMs += 1_000;
    const again = (await (await sponsor(claim())).json()) as { pendingUserOpId: string; recovered?: boolean };
    expect({ id: again.pendingUserOpId, recovered: again.recovered }).toEqual({ id: second.pendingUserOpId, recovered: true });
  });

  it('a chain head stamped more than a minute ahead of the server clock is refused before any count (faulty read)', async () => {
    const t = Math.floor(Date.now() / 1000);
    state.clockMs = t * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => state.clockMs);
    state.chainNow = BigInt(t + 61);
    const far = await sponsor(claim());
    expect({ status: far.status, body: await far.json() }).toEqual({ status: 502, body: { error: 'VALIDATE_FAILED', reason: 'chain_head_invalid' } });
    expect({ dailyOps: state.dailyOps, rows: (await pendingRows()).length }).toEqual({ dailyOps: 0, rows: 0 });

    state.chainNow = BigInt(t + 60); // exactly the allowance: built
    expect((await sponsor(claim())).status).toBe(200);

    // Weeks ahead (beyond any timer): refused the same way, and no sponsorship-bound build starts.
    await pg.exec(`DELETE FROM aa_pending_user_ops`);
    state.chainNow = BigInt(t + 30 * 86_400);
    expect((await sponsor(claim())).status).toBe(502);
    expect(state.dailyOps).toBe(1);
  });
});
