// Adversary on 5c8d81c (self-service Start over, Codex SIGNIN_R1 A1; owner decision 2026-10-07).
//
// Spec: Start over "must never delete the Privy user of an account that ever signed in (a Mako users row bound to
// that Privy user), never act while any browser still holds an unexpired enrollment checkpoint for that Privy user
// (that browser could still finish, and a first admission needs one)". src/lib/start-over.ts rule 4 claims the
// live-checkpoint check "also rules out a race with a first admission, which needs one".
//
// It does not. POST /api/user/auth reads the clock ONCE (nowMs, before the proof check and the allowlist read) and
// judges the checkpoint inside its transaction against that stale clock. A sign-in that started a moment before the
// checkpoint expired is still admitted after it expired, and Start over, run in that gap, sees no live checkpoint and
// no bound account, so it deletes the Privy user. The admission then commits: the account is bound to a Privy user
// that no longer exists.
//
// Shown here on a Magic-era account (a users row with this email, not yet bound to a Privy user, the legitimate move
// path): the sign-in binds it to the deleted Privy user and repoints its Safe to the deleted Privy wallet. Every later
// sign-in with that email (a new Privy user, which is all Privy can now give) is refused as email_changed (C4).
//
// Interleaving: Start over runs inside the allowlist read of /api/user/auth (an awaited database read in production,
// between the clock read and the transaction). Real Postgres (PGlite, every migration in the journal), the real gate,
// proof, upsert, admission and checkpoint code. Only Privy's network calls, the same-origin check, the allowlist and
// the cookie store are replaced.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { ENROLL_CHECKPOINT_TTL_SEC } from '@/lib/enrollment-checkpoint';
import { buildProofMessage } from '@/lib/privy-proof-message';

const state = vi.hoisted(() => ({
  db: null as unknown,
  clock: 0,
  /// Privy users that exist, by id, with what Privy currently shows for each.
  privy: new Map<string, { email: string; enrolled: boolean; wallet: boolean }>(),
  cookieSet: vi.fn(),
  /// Runs inside /api/user/auth's allowlist read, once.
  duringAllowlist: null as null | (() => Promise<void>),
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
// One clock in this test: the database's (db-clock.ts) reads the same time as the instance's.
vi.mock('@/lib/db-clock', () => ({ databaseNowMs: async () => state.clock }));
vi.mock('@/lib/allowlist', () => ({
  isAllowedForCurrentStage: async () => {
    const hook = state.duringAllowlist;
    state.duringAllowlist = null;
    if (hook) await hook();
    return true;
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: state.cookieSet }) }));

// anvil's published development keys: exist only on local test chains.
const PRIVY_WALLET = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const MAGIC_EOA = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80').address.toLowerCase();
const T = 1_791_222_000;
const EMAIL = 'owner@example.com';
const P = 'did:privy:owner';
const P2 = 'did:privy:fresh';

/// A Privy user read as src/lib/privy-server.ts builds it; throws when Privy has no such user (deleted).
function privyRead(id: string) {
  const u = state.privy.get(id);
  if (!u) throw new Error(`privy: user ${id} not found`);
  const linked = u.wallet
    ? [{ type: 'wallet', id: 'w1', address: PRIVY_WALLET.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy', imported: false, delegated: false, verified_at: T + 5, first_verified_at: T + 5 }]
    : [];
  return {
    privyUserId: id,
    email: u.email,
    user: { id, mfa_methods: u.enrolled ? [{ type: 'totp', verified_at: T }] : [], linked_accounts: [{ type: 'email', address: u.email }, ...linked] },
    wallet: u.wallet ? { id: 'w1', address: PRIVY_WALLET.address, exported_at: null, imported_at: null, additional_signers: [] } : null,
  };
}

vi.mock('@/lib/privy-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-server')>()),
  // The access token is the Privy user id here; a deleted user's token no longer verifies.
  readPrivyAccount: async (token: string) => privyRead(token),
  readPrivyAccountById: async (id: string) => privyRead(id),
  deletePrivyUser: async (id: string) => {
    if (!state.privy.delete(id)) throw new Error('privy: delete of a missing user');
  },
}));

const DIR = join(__dirname, '../../db/migrations');
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const e of journal.entries) {
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  state.db = drizzle(pg, { schema });
  // A test-only session HMAC key (not a real secret), so the sign-in can mint its session row.
  vi.stubEnv('USER_SESSION_SECRET', 'adversary-test-only-session-secret-0123456789abcdef');
  vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg.close();
});
afterEach(() => {
  state.cookieSet.mockClear();
});

type Browser = { jar: Map<string, string> };
function req(browser: Browser, path: string, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  if (browser.jar.size) headers.cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return new Request(`http://localhost:3000${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function post(browser: Browser, path: string, body: Record<string, unknown>) {
  const mod =
    path === '/api/user/auth'
      ? await import('../../app/api/user/auth/route')
      : path === '/api/user/auth/proof'
        ? await import('../../app/api/user/auth/proof/route')
        : await import('../../app/api/user/auth/start-over/route');
  const before = state.cookieSet.mock.calls.length;
  const res = await mod.POST(req(browser, path, body));
  for (const call of state.cookieSet.mock.calls.slice(before)) browser.jar.set(call[0] as string, call[1] as string);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('Start over racing a first admission across the checkpoint expiry (spec 2026-10-07)', () => {
  it('never leaves an account bound to the Privy user it deleted', async () => {
    const db = state.db as ReturnType<typeof drizzle<typeof schema>>;
    // A Magic-era account with this email: not bound to any Privy user yet, so its first Privy sign-in moves it.
    const [acct] = await db.insert(schema.users).values({ email: EMAIL, magicEoa: MAGIC_EOA, authType: 'magic' }).returning();

    // Browser A: Privy email code, authenticator enrolled, no wallet yet. The dialog asks for the checkpoint.
    const t0 = Date.UTC(2026, 9, 6, 12, 0, 0);
    const expiry = t0 + ENROLL_CHECKPOINT_TTL_SEC * 1000;
    state.clock = t0;
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false });
    const A: Browser = { jar: new Map() };
    expect((await post(A, '/api/user/auth/proof', { privyAccessToken: P, checkpoint: true })).json).toEqual({ ok: false, status: 'wallet_required' });
    expect(A.jar.get('mako_enroll_cp')).toBeTruthy();

    // The wallet is created after the checkpoint. A day later, one second before the checkpoint expires, browser A
    // resumes: /proof gives it a nonce, and it signs in.
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: true });
    state.clock = expiry - 1_000;
    const step = await post(A, '/api/user/auth/proof', { privyAccessToken: P });
    expect(step.json.status).toBe('proof_required');
    const message = buildProofMessage('localhost:3000', step.json.nonce as string, new Date(state.clock));
    const signature = await PRIVY_WALLET.signMessage({ message });

    // While that sign-in is between its clock read and its transaction, the checkpoint expires and Start over is
    // called for the same Privy user (a second tab, or anyone holding the inbox) from a browser with no checkpoint.
    let startOver: { status: number; json: Record<string, unknown> } | null = null;
    state.duringAllowlist = async () => {
      state.clock = expiry + 1_000;
      startOver = await post({ jar: new Map() }, '/api/user/auth/start-over', { privyAccessToken: P });
    };
    const signIn = await post(A, '/api/user/auth', { privyAccessToken: P, proof: { message, signature } });

    const row = (await pg.query(`SELECT privy_user_id, magic_eoa, privy_totp_admitted_at FROM users WHERE id = $1`, [acct.id])).rows[0] as {
      privy_user_id: string | null;
      magic_eoa: string;
      privy_totp_admitted_at: number | null;
    };
    const deleted = !state.privy.has(P);
    console.info('[adversary] start-over:', JSON.stringify(startOver), 'sign-in:', JSON.stringify(signIn), 'row:', JSON.stringify(row), 'P deleted:', deleted);

    // The spec invariant: a Privy user that Start over deleted is never the Privy user of a Mako account.
    if (deleted) {
      expect.soft(row.privy_user_id, 'the account is bound to the Privy user Start over deleted').not.toBe(P);

      // And the fresh sign-up Start over exists for (Privy gives the email a new user) is not refused as C4.
      state.privy.set(P2, { email: EMAIL, enrolled: false, wallet: false });
      const fresh = await post({ jar: new Map() }, '/api/user/auth/proof', { privyAccessToken: P2 });
      expect.soft(fresh.json.status, 'the fresh sign-up after Start over').not.toBe('email_changed');
    }
  });
});
