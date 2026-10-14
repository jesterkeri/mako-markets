// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-validity-window-edges.test.ts
//
// Adversary pass on 379949f (Codex CREATOR_EARNINGS R4: the SafeOp validity window is stored with each pending op).
// Edges the committed suite does not pin: the send route's expiry guard exactly at validUntil and one second before,
// a pending row written by an older app version (no window columns named, so the 0016 defaults apply) recovered by
// the new sponsor route and sent, and a non-creator-fee kind keeping the default window end to end.
// Same harness as creator-fee-validity-window.test.ts: real routes, real builder, real browser binding, PGlite + 0016.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// A throwaway key generated for this test only; it holds nothing on any chain.
const account = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const USER = '11111111-1111-4111-8111-111111111111';
const TX_HASH = ('0x' + 'dd'.repeat(32)) as Hex;
const PAYMASTER: Address = '0x3333333333333333333333333333333333333333';

const state = vi.hoisted(() => ({
  db: null as unknown,
  chainNow: 0n,
  bundlerSends: [] as Array<{ userOp: unknown; signature: Hex }>,
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
  incrementOrReject: async () => ({ kind: 'within_cap', count: 1 }),
  decrementForRefund: async () => undefined,
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
vi.mock('@/lib/aa-rpc', async (importActual) => {
  const actual = await importActual<typeof import('../aa-rpc')>();
  const { computeUserOpHash } = await import('../user-op-hash');
  const { storedToPacked } = await import('../user-op-types');
  return {
    ...actual,
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
    sendUserOperation: async (a: { chainId: number; userOp: Parameters<typeof storedToPacked>[0]; signature: Hex }) => {
      state.bundlerSends.push({ userOp: a.userOp, signature: a.signature });
      return computeUserOpHash({ userOp: storedToPacked(a.userOp), chainId: a.chainId });
    },
    waitForUserOperationReceipt: async () => ({ success: true, transactionHash: TX_HASH }),
  };
});

import { POST as sponsor } from '../../app/api/aa/sponsor/route';
import { POST as send } from '../../app/api/aa/send/route';
import { buildClaimBody, buildClaimCreatorFeeBody, runSponsoredRequest } from '../aa-client';
import { VALIDITY_WINDOW_MAX_UINT48 } from '../aa-constants';
import { parseSafeOpEnvelope } from '../aa-signature';
import { MONAD_TESTNET_ID } from '../chain';
import { MAKO_ADDRESS } from '../contract';
import { clearEmbeddedSigner, registerEmbeddedSigner } from '../embedded-signer';
import { deriveSafeAddress } from '../safe';
import { computeSafeOpHash } from '../safe-op-hash';
import { storedToPacked, type StoredSplitFormUserOp } from '../user-op-types';
import { aaPendingValidityWindowSql } from './aa-pending-migrations';

const SAFE = deriveSafeAddress(account.address);

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

  // The browser half: runSponsoredRequest posts to the real route handlers and signs through the real embedded-signer
  // bridge, backed by a local key answering personal_sign the way the Privy wallet does.
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', async (path: string, init: { body: string }) => {
    const handler = path === '/api/aa/sponsor' ? sponsor : path === '/api/aa/send' ? send : null;
    if (!handler) throw new Error(`unexpected fetch ${path}`);
    return handler(req(`http://localhost${path}`, JSON.parse(init.body)));
  });
  registerEmbeddedSigner(account.address, {
    request: async ({ method, params }) => {
      if (method !== 'personal_sign') throw new Error(`unexpected wallet call ${method}`);
      return account.signMessage({ message: { raw: (params as [Hex])[0] } });
    },
  });
});
afterAll(async () => {
  clearEmbeddedSigner();
  vi.unstubAllGlobals();
  await pg.close();
});
beforeEach(async () => {
  state.bundlerSends = [];
  await pg.exec(`DELETE FROM aa_pending_user_ops`);
});

function req(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
}

const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const claim = () => buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 42n });

type SponsorBody = {
  pendingUserOpId: string;
  userOp: StoredSplitFormUserOp;
  safeOpHash: Hex;
  validAfter: Hex;
  validUntil: Hex;
  recovered?: boolean;
};

async function rowWindow(id: string) {
  const r = await pg.query<{ valid_after: string; valid_until: string; status: string }>(
    `SELECT valid_after::text, valid_until::text, status::text FROM aa_pending_user_ops WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

describe('adversary on 379949f: validity window edges', () => {
  it('send refuses a row exactly at validUntil and accepts it one second earlier', async () => {
    const t0 = nowS();
    // Built from a chain head 100 s behind (under the sponsor's stale-head limit): validUntil = t0 + 200, accepted while
    // the server clock reads t0 + 199.5. (Rebased from the adversary's original t0 + 1, which the stale-head refusal
    // added after 379949f now refuses at sponsor time.)
    state.chainNow = t0 - 100n;
    const a = (await (await sponsor(req('http://localhost/api/aa/sponsor', claim()))).json()) as SponsorBody;
    expect(BigInt(a.validUntil)).toBe(t0 + 200n);
    const sigA = await signFor(a);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Number(t0 + 199n) * 1000 + 500);
    try {
      const s = await send(req('http://localhost/api/aa/send', { pendingUserOpId: a.pendingUserOpId, signature: sigA }));
      expect(s.status).toBe(200);
      expect(state.bundlerSends).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }

    // A fresh claim whose validUntil equals the server's current second: refused, never reaches the bundler.
    await pg.exec(`DELETE FROM aa_pending_user_ops`);
    state.bundlerSends = [];
    const t1 = nowS();
    state.chainNow = t1 - 100n;
    const b = (await (await sponsor(req('http://localhost/api/aa/sponsor', claim()))).json()) as SponsorBody;
    expect(BigInt(b.validUntil)).toBe(t1 + 200n);
    const sigB = await signFor(b);
    const spy2 = vi.spyOn(Date, 'now').mockReturnValue(Number(t1 + 200n) * 1000);
    try {
      const s = await send(req('http://localhost/api/aa/send', { pendingUserOpId: b.pendingUserOpId, signature: sigB }));
      expect(s.status).toBe(410);
      expect(state.bundlerSends).toHaveLength(0);
    } finally {
      spy2.mockRestore();
    }
  });

  it('a pending row written by the older app (no window columns named, defaults apply) is recovered with the default window and sends', async () => {
    state.chainNow = nowS();
    const built = (await (await sponsor(req('http://localhost/api/aa/sponsor', claim()))).json()) as SponsorBody;
    // Rewrite it as the older app would have written it: the same op hashed over the default window, re-inserted with
    // no window columns named, so the 0016 column defaults produce the window.
    const packed = storedToPacked(built.userOp);
    const legacyHash = computeSafeOpHash({ userOp: packed, validAfter: 0n, validUntil: VALIDITY_WINDOW_MAX_UINT48, chainId: MONAD_TESTNET_ID });
    const r = await pg.query<Record<string, unknown>>(`SELECT * FROM aa_pending_user_ops WHERE id = $1`, [built.pendingUserOpId]);
    const row = r.rows[0];
    await pg.exec(`DELETE FROM aa_pending_user_ops`);
    await pg.query(
      `INSERT INTO aa_pending_user_ops (id, user_id, chain_id, safe_address, magic_eoa, user_op, nonce_hex, safe_op_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, row.user_id, row.chain_id, row.safe_address, row.magic_eoa, JSON.stringify(row.user_op), row.nonce_hex, legacyHash.toLowerCase(), row.expires_at],
    );

    const recovered = (await (await sponsor(req('http://localhost/api/aa/sponsor', claim()))).json()) as SponsorBody;
    expect(recovered.recovered).toBe(true);
    expect(recovered.validAfter).toBe('0x0');
    expect(recovered.validUntil).toBe('0xffffffffffff');
    const outcome = await runSponsoredRequest(claim(), account.address);
    expect(outcome.kind).toBe('sent');
    expect(parseSafeOpEnvelope(state.bundlerSends[0].signature).validUntil).toBe(VALIDITY_WINDOW_MAX_UINT48);
  });

  it('a plain claim (not creator fee) keeps the default window end to end', async () => {
    state.chainNow = nowS();
    const body = buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 42n });
    const outcome = await runSponsoredRequest(body, account.address);
    expect(outcome.kind).toBe('sent');
    expect(parseSafeOpEnvelope(state.bundlerSends[0].signature).validUntil).toBe(VALIDITY_WINDOW_MAX_UINT48);
    const rows = await pg.query<{ id: string }>(`SELECT id FROM aa_pending_user_ops`);
    expect(await rowWindow(rows.rows[0].id)).toEqual({ valid_after: '0', valid_until: VALIDITY_WINDOW_MAX_UINT48.toString(), status: 'sent' });
  });
});

async function signFor(s: SponsorBody): Promise<Hex> {
  const { signSafeOpHash } = await import('../embedded-signer');
  return signSafeOpHash({
    hash: s.safeOpHash,
    magicEoa: account.address,
    validAfter: BigInt(s.validAfter),
    validUntil: BigInt(s.validUntil),
  });
}
