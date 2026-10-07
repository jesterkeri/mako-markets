// Adversary on 8b4caaf (Start over, /proof, /auth and /totp take turns on lockPrivyUser; owner decisions 2026-10-07).
//
// Spec: a first admission needs a checkpoint "UNEXPIRED when the binding commits"; Start over must "never act while
// any browser still holds an unexpired checkpoint"; and "a Privy user that Start over deleted is never the Privy user
// of any Mako account, by any ordering, route, retry or concurrent request". Production runs many server instances.
//
// The lock orders Start over and the sign-in, but each route judges expiry with its OWN instance's Date.now(), read
// after the wait. Two instances whose clocks differ (or one whose clock is stepped back by NTP) can disagree about
// the same checkpoint: Start over, on the instance whose clock reads past the expiry, finds no live checkpoint and
// deletes the Privy user; the sign-in that was waiting on the lock, on an instance whose clock still reads before the
// expiry, then finds the same checkpoint live and binds a new account to the deleted Privy user. The order the lock
// enforces in real time is not the order the two clocks report.
//
// Modelled here by switching the mocked Date.now() between the two requests: Start over reads 1 s past the expiry,
// the sign-in (which reads Privy before the delete lands, then waits on the lock) reads 1 s before it. The skew must
// exceed the time from Start over's clock read to its commit (its Privy delete), so in production it is a window of
// a few hundred milliseconds of skew around the moment a checkpoint expires.
//
// Harness copied from start-over-checkpoint-race-adversary-e0d63e9.test.ts: real Postgres (PGlite, every migration),
// the real routes, gate, proof, upsert, checkpoint and lock code; only Privy's network calls, the same-origin check,
// the allowlist and the cookie store are replaced. PGlite has one connection, so a second transaction waits for the
// first to commit, which is STRONGER than production (where only the advisory lock makes it wait): the interleaving
// below is the one the advisory lock produces, so this cannot create a false failure.
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
  clock: 0,
  /// The database's clock: one clock, true time. `clock` above is the serving instance's own, which may be skewed.
  dbClock: 0,
  privy: new Map<string, { email: string; enrolled: boolean; wallet: boolean; google: boolean }>(),
  cookieSet: vi.fn(),
  /// Runs inside Start over's Privy delete, before Privy has deleted the user (the request is in flight).
  duringDelete: null as null | (() => Promise<void>),
  /// Set when a request starts a transaction while another is open (it is now waiting for it).
  waiting: false,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
// The fix (db-clock.ts): every checkpoint is stamped and judged on the database's clock after the lock.
vi.mock('@/lib/db-clock', () => ({ databaseNowMs: async () => state.dbClock }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: state.cookieSet }) }));

// anvil's published development key: exists only on local test chains.
const PRIVY_WALLET = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const T = 1_791_222_000;
const EMAIL = 'owner@example.com';
const P = 'did:privy:owner';

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
    const hook = state.duringDelete;
    state.duringDelete = null;
    if (hook) await hook();
    if (!state.privy.delete(id)) throw new Error('privy: delete of a missing user');
  },
}));

const DIR = join(__dirname, '../../db/migrations');
let pg: PGlite;
type Db = ReturnType<typeof drizzle<typeof schema>>;

/// One PGlite connection standing in for a pool (see the header): statements from other requests run on the open
/// transaction's connection; a second transaction starts only after the open one has finished.
function pooled(base: Db): Db {
  let openTx: unknown = null;
  let idle: Promise<void> = Promise.resolve();
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'transaction') {
        return async (cb: (tx: unknown) => Promise<unknown>) => {
          if (openTx !== null) state.waiting = true;
          while (openTx !== null) await idle;
          let release!: () => void;
          idle = new Promise<void>((r) => (release = r));
          try {
            return await target.transaction(async (tx) => {
              openTx = tx;
              try {
                return await cb(tx);
              } finally {
                openTx = null;
              }
            });
          } finally {
            release();
          }
        };
      }
      const on = (openTx ?? target) as Record<string | symbol, unknown>;
      const v = on[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(on) : v;
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
  state.db = pooled(drizzle(pg, { schema }));
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

describe('Start over and a first admission judging one checkpoint on two clocks (spec 2026-10-07)', () => {
  it('never binds a Mako account to the Privy user Start over deleted', async () => {
    const C0 = Date.UTC(2026, 9, 6, 12, 0, 0);
    state.clock = C0;
    state.dbClock = C0;
    // Authenticator enrolled, no wallet yet: browser B records its checkpoint (expires 24 h later, at E).
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false, google: false });
    const B: Browser = { jar: new Map() };
    const cp = await post(B, '/api/user/auth/proof', { privyAccessToken: P, checkpoint: true });
    expect(cp.json).toEqual({ ok: false, status: 'wallet_required' });
    expect(B.jar.get('mako_enroll_cp')).toBeTruthy();
    const E = C0 + 24 * 60 * 60 * 1000;

    // The wallet is created; just before E, browser B asks for its sign-in nonce and signs it.
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: true, google: false });
    state.clock = E - 5_000;
    state.dbClock = E - 5_000;
    const step = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
    expect(step.json.status).toBe('proof_required');
    const message = buildProofMessage('localhost:3000', step.json.nonce as string, new Date(state.clock));
    const signature = await PRIVY_WALLET.signMessage({ message });

    // Another browser (no checkpoint) asks for Start over, served by instance S whose clock reads 1 s past E.
    let signIn: Promise<{ status: number; json: Record<string, unknown> }> | null = null;
    state.duringDelete = async () => {
      // While Start over holds the lock, B's sign-in arrives on instance A, whose clock reads 1 s before E. It reads
      // Privy (the user still exists) and waits on the lock.
      state.clock = E - 1_000;
      state.waiting = false;
      let settled = false;
      signIn = post(B, '/api/user/auth', { privyAccessToken: P, proof: { message, signature } }).finally(() => {
        settled = true;
      });
      // Either it now waits on the lock, or (151cad5: its pre-lock check also reads the database's clock) it is refused
      // before reaching it. Both are safe; the assertions below are on the outcome.
      for (let i = 0; i < 400 && !state.waiting && !settled; i++) await new Promise((r) => setTimeout(r, 5));
      expect(state.waiting || settled, 'the sign-in either waits on the lock or has already been refused').toBe(true);
    };
    // True time is now 1 s past E: the database's clock, and instance S's (accurate) clock. Instance A, which serves the
    // sign-in above, runs 2 s slow.
    state.clock = E + 1_000;
    state.dbClock = E + 1_000;
    const startOver = await post({ jar: new Map() }, '/api/user/auth/start-over', { privyAccessToken: P });
    const signInResult = signIn === null ? null : await signIn;

    const deleted = !state.privy.has(P);
    const bound = (await pg.query(`SELECT id FROM users WHERE privy_user_id = $1`, [P])).rows;
    console.info('[adversary] start-over:', JSON.stringify(startOver), 'sign-in:', JSON.stringify(signInResult), 'P deleted:', deleted, 'rows bound to P:', bound.length);

    // The spec invariant: a Privy user that Start over deleted is never the Privy user of any Mako account.
    if (deleted) expect(bound.length, 'accounts bound to the Privy user Start over deleted').toBe(0);
    // Not vacuous: the race really ran (Start over deleted, the sign-in waited and was then refused).
    expect(deleted, 'Start over deleted the expired, unfinished identity').toBe(true);
    expect((signInResult as { json: unknown } | null)?.json, 'the sign-in, judged on the database clock, finds the checkpoint expired').toEqual({ ok: false, status: 'account_locked' });
  });
});
