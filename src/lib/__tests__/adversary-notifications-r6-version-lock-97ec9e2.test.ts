// Adversary on 97ec9e2 (Codex NOTIFICATIONS_S1 R6 F1 fix). Spec, item 3: a sign-in that fires an
// account_address_version trigger after `t` takes that row before `t`; a sign-in that fires none of them after `t`
// must not take it (owner decision: sign-ins that write no address never queue on that row).
//
// Real /api/user/auth on PGlite carrying every migration (0020 included), the same edges stood in as
// remembered-browser-flow.test.ts, remembered browsers off. lockAddressVersion is the real helper wrapped in a spy, and
// the version row is read before and after: a moved version means a trigger fired, an unmoved one means none did.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const PRIVY = 'did:privy:adv-r6';
const EMAIL = 'adv-r6@example.com';
const EOA = `0x${'7'.repeat(40)}`;
const OTHER_EOA = `0x${'5'.repeat(40)}`;

const h = vi.hoisted(() => ({
  db: null as unknown,
  nonce: '',
  lockVersionCalls: 0,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: () => {}, get: () => undefined }),
}));
vi.mock('@/lib/user-session', async (orig) => {
  const real = await orig<typeof import('@/lib/user-session')>();
  const { sessions } = await import('@/db/schema');
  type Ins = { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } };
  return {
    ...real,
    createSession: async (userId: string, opts?: { tx?: Ins }) => {
      await (opts?.tx ?? (h.db as Ins)).insert(sessions).values({ id: randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
      return 'session-token';
    },
  };
});
vi.mock('@/lib/privy-server', () => {
  const read = (withToken: boolean) => ({
    privyUserId: PRIVY,
    email: EMAIL,
    user: { id: PRIVY, mfa_methods: [{ type: 'totp', verified_at: 1 }], linked_accounts: [{ type: 'email', address: EMAIL, latest_verified_at: 1 }] },
    wallet: null,
    ...(withToken ? { token: { sessionId: 'sid', issuedAt: 2 } } : {}),
  });
  return {
    PrivyConfigError: class PrivyConfigError extends Error {},
    PrivyIdentityError: class PrivyIdentityError extends Error {},
    readPrivyAccount: async () => read(true),
    readPrivyAccountById: async () => read(false),
    judgeAccount: () => ({ ok: true, wallet: EOA, walletId: 'w', totpVerifiedAt: 1_790_000_000, exportedAtMs: null }),
    checkIdentity: () => ({ ok: true }),
  };
});
vi.mock('@/lib/privy-proof', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-proof')>()),
  checkProofSignature: async () => ({ ok: true, nonce: h.nonce }),
}));
vi.mock('@/lib/account-locks', async (orig) => {
  const real = await orig<typeof import('@/lib/account-locks')>();
  return {
    ...real,
    lockAddressVersion: async (...a: Parameters<typeof real.lockAddressVersion>) => {
      h.lockVersionCalls += 1;
      return real.lockAddressVersion(...a);
    },
  };
});

let pg: PGlite;
const q = async <T,>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;
const version = async () => Number((await q<{ v: number | string }>(`SELECT version AS v FROM account_address_version`))[0].v);

beforeEach(async () => {
  vi.stubEnv('REMEMBERED_BROWSER_ENABLED', '');
  const m = await migratedPglite();
  pg = m.client;
  h.db = m.db;
  h.lockVersionCalls = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

async function signIn() {
  h.nonce = randomUUID().replace(/-/g, '').padEnd(43, 'n').slice(0, 43);
  await pg.query(`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '5 minutes')`, [
    h.nonce,
    PRIVY,
    EOA,
  ]);
  const { POST } = await import('@/app/api/user/auth/route');
  const res = await POST(
    new Request('https://makomarket.xyz/api/user/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://makomarket.xyz' },
      body: JSON.stringify({ privyAccessToken: 't', proof: { message: 'm', signature: 's' } }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function userRow(cols: { magicEoa: string; privy: string | null; totp: boolean }): Promise<string> {
  return (
    await q<{ id: string }>(
      `INSERT INTO users (email, magic_eoa, auth_type, privy_user_id, privy_totp_admitted_at, totp_secret, totp_enabled_at)
       VALUES ($1, $2, 'magic', $3, $4, $5, $6) RETURNING id`,
      [EMAIL, cols.magicEoa, cols.privy, cols.privy ? 1790000000 : null, cols.totp ? 'enc-secret' : null, cols.totp ? new Date() : null],
    )
  )[0].id;
}
async function safes(userId: string, chains: number[]) {
  for (const c of chains) await q(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [userId, c, '0x' + '9'.repeat(40)]);
}

/// The rule under test: the version row is taken iff a trigger fired.
async function expectLockIffTriggerFired(run: () => Promise<{ body: Record<string, unknown> }>, expectedBody: Record<string, unknown>) {
  const v0 = await version();
  const out = await run();
  expect(out.body).toMatchObject(expectedBody);
  const fired = (await version()) !== v0;
  return { fired, locked: h.lockVersionCalls > 0 };
}

describe('[adversary 97ec9e2] the address version row is taken before t exactly when a sign-in writes an address', () => {
  it('control: a returning bound account with both Safe rows fires nothing and takes nothing', async () => {
    const id = await userRow({ magicEoa: EOA, privy: PRIVY, totp: false });
    await safes(id, [10143, 84532]);
    const r = await expectLockIffTriggerFired(signIn, { ok: true, authed: true });
    expect(r).toEqual({ fired: false, locked: false });
  });

  it('control: a bound account missing a Safe row adds it after t and took the row first', async () => {
    const id = await userRow({ magicEoa: EOA, privy: PRIVY, totp: false });
    await safes(id, [10143]);
    const r = await expectLockIffTriggerFired(signIn, { ok: true, authed: true });
    expect(r).toEqual({ fired: true, locked: true });
  });

  it('a Magic-era account whose signer is already its Privy wallet (direct move, from === to) writes no address but queues on the row', async () => {
    const id = await userRow({ magicEoa: EOA, privy: null, totp: false });
    await safes(id, [10143, 84532]);
    const r = await expectLockIffTriggerFired(signIn, { ok: true, authed: true });
    // applyEmbeddedMove returns before the Safe upsert when from === to, and users.wallet_address is untouched.
    expect(r.fired).toBe(false);
    expect(r.locked).toBe(false);
  });

  it('a Magic-era 2FA account missing a Safe row (pending move) answers totp_required, writes no address, but queues on the row', async () => {
    const id = await userRow({ magicEoa: OTHER_EOA, privy: null, totp: true });
    await safes(id, [10143]);
    const r = await expectLockIffTriggerFired(signIn, { ok: true, status: 'totp_required' });
    expect(r.fired).toBe(false);
    expect(r.locked).toBe(false);
  });
});
