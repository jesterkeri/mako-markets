// Adversary on 151cad5 (enrollment checkpoint judged on the database's clock; owner decisions 2026-10-07).
//
// Two defects, each against a sentence of the spec:
//
// 1. "A failed read or delete deletes nothing and returns 503" and "a refused Start over has deleted nothing".
//    Start over calls Privy's delete INSIDE its database transaction (to hold lockPrivyUser across it). If that
//    transaction then fails to commit (the pooled connection is dropped or timed out while it sat idle in transaction
//    during the Privy call), the route answers 503 'unavailable' although Privy has already deleted the user: the
//    browser is told nothing happened, keeps its checkpoint cookie, and its retry finds an identity that is gone.
//    Modelled by a pool whose COMMIT fails once: the transaction wrapper throws after the route's callback returned,
//    which is what postgres-js does when the COMMIT statement errors (the route sees db.transaction reject).
//
// 2. "An honest owner who signs up normally in one browser within 24 hours is admitted", with "many server instances
//    whose clocks may differ". /proof stamps the checkpoint's expiry on the DATABASE's clock, but /proof and /auth
//    still judge it before their transaction on the INSTANCE's Date.now() (proof/route.ts readCheckpoint(..., nowMs),
//    auth/route.ts readCheckpoint(..., Date.now())). On an instance whose clock runs ahead, the owner who returns in
//    the last seconds of the 24 hours is refused, though the database clock (the one the change says every instance
//    judges on) still holds the checkpoint live.
//
// Harness copied from start-over-clock-skew-adversary-8b4caaf.test.ts: real Postgres (PGlite, every migration), the
// real routes, gate, proof, upsert, checkpoint and lock code; only Privy's network calls, the same-origin check, the
// allowlist, the cookie store and the database clock are replaced. Neither test relies on PGlite running one
// transaction at a time: each request runs alone.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { buildProofMessage } from '@/lib/privy-proof-message';

const state = vi.hoisted(() => ({
  db: null as unknown,
  /// The serving instance's own clock (Date.now()), which may be skewed.
  clock: 0,
  /// The database's clock: one clock, true time.
  dbClock: 0,
  privy: new Map<string, { email: string; enrolled: boolean; wallet: boolean; google: boolean }>(),
  cookieSet: vi.fn(),
  /// When set, the next transaction's COMMIT fails after its callback has returned.
  failNextCommit: false,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('@/lib/db-clock', () => ({ databaseNowMs: async () => state.dbClock }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: state.cookieSet }) }));

// anvil's published development key: exists only on local test chains.
const PRIVY_WALLET = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const T = 1_791_222_000;

/// A Privy user read as src/lib/privy-server.ts builds it; throws when Privy has no such user (deleted).
function privyRead(id: string) {
  const u = state.privy.get(id);
  if (!u) throw new Error(`privy: user ${id} not found`);
  const linked: Record<string, unknown>[] = [{ type: 'email', address: u.email }];
  if (u.google) linked.push({ type: 'google_oauth', email: u.email, subject: 'g-1' });
  if (u.wallet) {
    linked.push({ type: 'wallet', id: 'w1', address: PRIVY_WALLET.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy', imported: false, delegated: false, verified_at: T + 5, first_verified_at: T + 5 });
  }
  const factorsOk = u.enrolled && !u.google;
  return {
    privyUserId: id,
    email: u.email,
    user: { id, mfa_methods: u.enrolled ? [{ type: 'totp', verified_at: T }] : [], linked_accounts: linked },
    wallet: factorsOk && u.wallet ? { id: 'w1', address: PRIVY_WALLET.address, exported_at: null, imported_at: null, additional_signers: [] } : null,
  };
}

vi.mock('@/lib/privy-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-server')>()),
  readPrivyAccount: async (token: string) => privyRead(token),
  readPrivyAccountById: async (id: string) => privyRead(id),
  deletePrivyUser: async (id: string) => {
    if (!state.privy.delete(id)) throw new Error('privy: delete of a missing user');
  },
}));

const DIR = join(__dirname, '../../db/migrations');
let pg: PGlite;
type Db = ReturnType<typeof drizzle<typeof schema>>;

/// A pool whose next COMMIT can be made to fail: the callback has run and returned, then the transaction rolls back
/// and db.transaction rejects, as postgres-js does when the COMMIT statement errors.
function failingCommit(base: Db): Db {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'transaction') {
        return async (cb: (tx: unknown) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            const out = await cb(tx);
            if (state.failNextCommit) {
              state.failNextCommit = false;
              throw new Error('write CONNECTION_CLOSED (COMMIT)');
            }
            return out;
          });
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

beforeAll(async () => {
  pg = new PGlite();
  const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const e of journal.entries) {
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  state.db = failingCommit(drizzle(pg, { schema }));
  // A test-only session HMAC key (not a real secret), so the sign-in can mint its session row.
  vi.stubEnv('USER_SESSION_SECRET', 'adversary-test-only-session-secret-0123456789abcdef');
  vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg.close();
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

describe('Start over whose transaction fails to commit after the Privy delete (spec 2026-10-07)', () => {
  it('never answers 503 (nothing deleted) for a Privy user it has deleted', async () => {
    const C0 = Date.UTC(2026, 9, 7, 9, 0, 0);
    state.clock = C0;
    state.dbClock = C0;
    // An unfinished sign-up: authenticator and wallet, no checkpoint anywhere, never admitted. Start over is offered.
    const P = 'did:privy:unfinished';
    state.privy.set(P, { email: 'unfinished@example.com', enrolled: true, wallet: true, google: false });
    const B: Browser = { jar: new Map() };
    const hint = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
    expect(hint.json).toEqual({ ok: false, status: 'account_locked', startOver: true });

    // The pooled connection is lost while the transaction sits idle during Privy's delete: COMMIT fails.
    state.failNextCommit = true;
    const res = await post(B, '/api/user/auth/start-over', { privyAccessToken: P });
    const deleted = !state.privy.has(P);
    console.info('[adversary] start-over:', JSON.stringify(res), 'P deleted:', deleted);

    // Not vacuous: the failure was injected at the commit, after the route's callback ran.
    expect(state.failNextCommit, 'the injected COMMIT failure fired').toBe(false);
    // The spec: a refused (503) Start over has deleted nothing.
    expect({ status: res.status, privyUserDeleted: deleted }, 'a 503 Start over that deleted the Privy user').not.toEqual({
      status: 503,
      privyUserDeleted: true,
    });
  });
});

describe('An honest owner served by an instance whose clock runs ahead (spec 2026-10-07)', () => {
  it('admits the owner who finishes within 24 hours of the checkpoint, by the database clock', async () => {
    const C0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    state.clock = C0;
    state.dbClock = C0;
    const P = 'did:privy:honest';
    // Authenticator enrolled, no wallet yet: browser B records its checkpoint, stamped on the database clock.
    state.privy.set(P, { email: 'honest@example.com', enrolled: true, wallet: false, google: false });
    const B: Browser = { jar: new Map() };
    const cp = await post(B, '/api/user/auth/proof', { privyAccessToken: P, checkpoint: true });
    expect(cp.json).toEqual({ ok: false, status: 'wallet_required' });
    expect(B.jar.get('mako_enroll_cp')).toBeTruthy();
    const E = C0 + 24 * 60 * 60 * 1000;

    // The wallet is created and the owner finishes in the same browser 1 s before the 24 hours are up (true time,
    // the database's clock). The instance serving these requests runs 2 s fast.
    state.privy.set(P, { email: 'honest@example.com', enrolled: true, wallet: true, google: false });
    state.dbClock = E - 1_000;
    state.clock = E + 1_000;
    const step = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
    console.info('[adversary] /proof at true time E - 1 s on an instance 2 s fast:', JSON.stringify(step));
    expect(step.json.status, 'the owner is offered the sign-in nonce (checkpoint live on the database clock)').toBe('proof_required');

    const message = buildProofMessage('localhost:3000', step.json.nonce as string, new Date(state.clock));
    const signature = await PRIVY_WALLET.signMessage({ message });
    const signIn = await post(B, '/api/user/auth', { privyAccessToken: P, proof: { message, signature } });
    console.info('[adversary] /auth:', JSON.stringify(signIn));
    expect(signIn.json.ok, 'the honest owner is admitted').toBe(true);
    const bound = (await pg.query(`SELECT id FROM users WHERE privy_user_id = $1`, [P])).rows;
    expect(bound.length).toBe(1);
  });
});
