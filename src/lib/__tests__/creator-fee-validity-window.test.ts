// ----------------------------------------------------------------------------
// src/lib/__tests__/creator-fee-validity-window.test.ts
//
// Codex CREATOR_EARNINGS R4: a creator-fee op is built with a finite SafeOp validUntil (chain time + 300 s), and that
// window is part of the SafeOp hash the user signs. The sponsor response, a recovered pending response and the send
// route must all carry the window the op was built with, or the browser's hash binding refuses to sign and the send
// route's hash recompute refuses the signature.
//
// End to end with the real pieces: the real builder (buildSponsoredUserOp; only gas price, Pimlico sponsorship, the
// EntryPoint nonce and the bundler are stubbed at the RPC layer), the real browser runner and hash binding
// (runSponsoredRequest -> assertSignableOp), a real secp256k1 signature through the embedded-signer bridge, the real
// sponsor and send routes, the real aa-pending-user-ops SQL and the committed 0016 migration on PGlite.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverMessageAddress, type Address, type Hex } from 'viem';
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
  dailyOps: 0,
  sponsorships: 0,
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
    sponsorUserOperation: async () => {
      state.sponsorships += 1;
      return {
        paymaster: PAYMASTER,
        paymasterVerificationGasLimit: 60_000n,
        paymasterPostOpGasLimit: 1n,
        paymasterData: '0xabcd',
        callGasLimit: 120_000n,
        verificationGasLimit: 300_000n,
        preVerificationGas: 50_000n,
      };
    },
    sendUserOperation: async (a: { chainId: number; userOp: Parameters<typeof storedToPacked>[0]; signature: Hex }) => {
      state.bundlerSends.push({ userOp: a.userOp, signature: a.signature });
      return computeUserOpHash({ userOp: storedToPacked(a.userOp), chainId: a.chainId });
    },
    waitForUserOperationReceipt: async () => ({ success: true, transactionHash: TX_HASH }),
  };
});

import { POST as sponsor } from '../../app/api/aa/sponsor/route';
import { POST as send } from '../../app/api/aa/send/route';
import { buildClaimCreatorFeeBody, runSponsoredRequest } from '../aa-client';
import { VALIDITY_WINDOW_MAX_UINT48 } from '../aa-constants';
import { CREATOR_FEE_MIN_SIGNING_S, CREATOR_FEE_OP_TTL_S } from '../aa-pending-user-ops';
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
  state.dailyOps = 0;
  state.sponsorships = 0;
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

describe('creator-fee claim: the finite SafeOp window travels sponsor -> sign -> send (Codex CREATOR_EARNINGS R4)', () => {
  it('a claim built with validUntil = chain time + 300 is signed by the browser and accepted by send before expiry', async () => {
    state.chainNow = nowS();
    const outcome = await runSponsoredRequest(claim(), account.address);
    expect(outcome.kind).toBe('sent');

    const validUntil = state.chainNow + BigInt(CREATOR_FEE_OP_TTL_S);
    expect(state.bundlerSends).toHaveLength(1);
    const { userOp, signature } = state.bundlerSends[0];
    // The signature the bundler received covers the finite window, not the default max.
    const envelope = parseSafeOpEnvelope(signature);
    expect({ validAfter: envelope.validAfter, validUntil: envelope.validUntil }).toEqual({ validAfter: 0n, validUntil });
    const packed = storedToPacked(userOp as StoredSplitFormUserOp);
    const finiteHash = computeSafeOpHash({ userOp: packed, validAfter: 0n, validUntil, chainId: MONAD_TESTNET_ID });
    const maxHash = computeSafeOpHash({ userOp: packed, validAfter: 0n, validUntil: VALIDITY_WINDOW_MAX_UINT48, chainId: MONAD_TESTNET_ID });
    expect(finiteHash).not.toBe(maxHash);
    const ecdsa = (envelope.r + envelope.s.slice(2) + (envelope.safeV - 4).toString(16).padStart(2, '0')) as Hex;
    expect(await recoverMessageAddress({ message: { raw: finiteHash }, signature: ecdsa })).toBe(account.address);

    // And the row holds the window the op was built with.
    const rows = await pg.query<{ id: string }>(`SELECT id FROM aa_pending_user_ops`);
    expect(await rowWindow(rows.rows[0].id)).toEqual({ valid_after: '0', valid_until: validUntil.toString(), status: 'sent' });
  });

  it('the first sponsor response carries the built window, and so does a recovered pending response; the recovered op signs and sends', async () => {
    state.chainNow = nowS();
    const validUntil = state.chainNow + BigInt(CREATOR_FEE_OP_TTL_S);

    // First sponsor call: the op is built and left pending (the tab closed before signing).
    const r1 = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
    expect(r1.status).toBe(200);
    const first = (await r1.json()) as SponsorBody;
    expect({ validAfter: BigInt(first.validAfter), validUntil: BigInt(first.validUntil) }).toEqual({ validAfter: 0n, validUntil });
    expect(await rowWindow(first.pendingUserOpId)).toMatchObject({ valid_after: '0', valid_until: validUntil.toString(), status: 'pending' });

    // A later chain time must not leak into the recovered response: it is the stored window, not a fresh one.
    state.chainNow = state.chainNow + 30n;
    const r2 = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
    expect(r2.status).toBe(200);
    const recovered = (await r2.json()) as SponsorBody;
    expect({
      recovered: recovered.recovered,
      id: recovered.pendingUserOpId,
      safeOpHash: recovered.safeOpHash,
      validUntil: BigInt(recovered.validUntil),
    }).toEqual({ recovered: true, id: first.pendingUserOpId, safeOpHash: first.safeOpHash, validUntil });

    // The browser path end to end against the recovered response: binding passes, signature accepted, op sent.
    const outcome = await runSponsoredRequest(claim(), account.address);
    expect(outcome.kind).toBe('sent');
    expect(state.bundlerSends).toHaveLength(1);
    expect(parseSafeOpEnvelope(state.bundlerSends[0].signature).validUntil).toBe(validUntil);
    expect(await rowWindow(first.pendingUserOpId)).toMatchObject({ status: 'sent' });
  });

  it('a signed claim whose validUntil has passed is expired by send (410) and never reaches the bundler', async () => {
    // Built from a chain head 100 s behind: validUntil = now + 200, while the row's own 5-minute TTL (app clock) ends
    // at now + 300. The signature is sent at validUntil + 1 s, so only the SafeOp window can stop it.
    state.chainNow = nowS() - 100n;
    const r1 = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
    expect(r1.status).toBe(200);
    const sponsored = (await r1.json()) as SponsorBody;
    const signature = await signFor(sponsored);

    const late = vi.spyOn(Date, 'now').mockReturnValue((Number(BigInt(sponsored.validUntil)) + 1) * 1000);
    try {
      const s = await send(req('http://localhost/api/aa/send', { pendingUserOpId: sponsored.pendingUserOpId, signature }));
      expect(s.status).toBe(410);
    } finally {
      late.mockRestore();
    }
    expect(state.bundlerSends).toHaveLength(0);
    expect(await rowWindow(sponsored.pendingUserOpId)).toMatchObject({ status: 'expired' });

    // The slot is free: the next tap builds a fresh claim with a fresh window, which sends.
    state.chainNow = nowS();
    const outcome = await runSponsoredRequest(claim(), account.address);
    expect(outcome.kind).toBe('sent');
    expect(parseSafeOpEnvelope(state.bundlerSends[0].signature).validUntil).toBe(state.chainNow + BigInt(CREATOR_FEE_OP_TTL_S));
  });

  it('a chain head too stale to leave a minute of signing is refused before the daily count or a sponsorship is spent', async () => {
    const t = nowS();
    const lagLimit = BigInt(CREATOR_FEE_OP_TTL_S - CREATOR_FEE_MIN_SIGNING_S); // 240 s
    const at = vi.spyOn(Date, 'now').mockReturnValue(Number(t) * 1000 + 999);
    try {
      // One second past the limit: refused, nothing counted, nothing sponsored, no row.
      state.chainNow = t - lagLimit - 1n;
      const stale = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
      expect({ status: stale.status, body: await stale.json() }).toEqual({
        status: 502,
        body: { error: 'VALIDATE_FAILED', reason: 'chain_head_stale' },
      });
      expect({ dailyOps: state.dailyOps, sponsorships: state.sponsorships }).toEqual({ dailyOps: 0, sponsorships: 0 });
      expect((await pg.query(`SELECT 1 FROM aa_pending_user_ops`)).rows).toHaveLength(0);

      // Exactly at the limit (60 s left to sign): built.
      state.chainNow = t - lagLimit;
      const ok = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
      expect(ok.status).toBe(200);
      expect(BigInt(((await ok.json()) as SponsorBody).validUntil)).toBe(t + BigInt(CREATOR_FEE_MIN_SIGNING_S));
      expect({ dailyOps: state.dailyOps, sponsorships: state.sponsorships }).toEqual({ dailyOps: 1, sponsorships: 1 });
    } finally {
      at.mockRestore();
    }
  });

  it('send refuses a signature over the default max window for a finite-window row (no window substitution)', async () => {
    state.chainNow = nowS();
    const r1 = await sponsor(req('http://localhost/api/aa/sponsor', claim()));
    const sponsored = (await r1.json()) as SponsorBody;
    const signature = await signFor({ ...sponsored, validUntil: `0x${VALIDITY_WINDOW_MAX_UINT48.toString(16)}` as Hex });

    const s = await send(req('http://localhost/api/aa/send', { pendingUserOpId: sponsored.pendingUserOpId, signature }));
    expect(s.status).toBe(400);
    expect(((await s.json()) as { error: string }).error).toBe('SIG_VALIDATION');
    expect(state.bundlerSends).toHaveLength(0);
    expect(await rowWindow(sponsored.pendingUserOpId)).toMatchObject({ status: 'pending' });
  });

  it('the migration refuses an inverted or out-of-range window, and its defaults are the default window', async () => {
    await pg.exec(aaPendingValidityWindowSql()); // a re-run is harmless (IF NOT EXISTS / DROP IF EXISTS)
    const base = `INSERT INTO aa_pending_user_ops (user_id, chain_id, safe_address, magic_eoa, user_op, nonce_hex, safe_op_hash, expires_at`;
    const vals = `'${USER}', 1, '${SAFE.toLowerCase()}', '${account.address.toLowerCase()}', '{}', '0x0', '0x${'ab'.repeat(32)}', now()`;
    await pg.exec(`${base}) VALUES (${vals})`);
    const d = await pg.query<{ valid_after: string; valid_until: string }>(`SELECT valid_after::text, valid_until::text FROM aa_pending_user_ops`);
    expect(d.rows[0]).toEqual({ valid_after: '0', valid_until: VALIDITY_WINDOW_MAX_UINT48.toString() });
    await pg.exec(`DELETE FROM aa_pending_user_ops`);
    await expect(pg.exec(`${base}, valid_after, valid_until) VALUES (${vals}, 10, 10)`)).rejects.toThrow(/aa_pending_validity_window/);
    await expect(pg.exec(`${base}, valid_after, valid_until) VALUES (${vals}, 0, 281474976710656)`)).rejects.toThrow(/aa_pending_validity_window/);
    await expect(pg.exec(`${base}, valid_after, valid_until) VALUES (${vals}, -1, 5)`)).rejects.toThrow(/aa_pending_validity_window/);
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
