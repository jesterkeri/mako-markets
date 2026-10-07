// Adversary on e0d63e9 (Start over and a first admission take turns on lockPrivyUser; owner decision 2026-10-07).
//
// Spec: Start over must "never act while any browser still holds an unexpired checkpoint for that Privy user", and
// "a Privy user that Start over deleted is never the Privy user of any Mako account, by any ordering, route, retry or
// concurrent request". The change serialises Start over with POST /api/user/auth and /totp through lockPrivyUser.
//
// It does not serialise Start over with the route that WRITES the checkpoint: POST /api/user/auth/proof calls
// recordCheckpoint on the bare db, without lockPrivyUser. So a checkpoint can be committed after Start over has read
// "no live checkpoint" under the lock and before its Privy delete lands. A sign-in from the browser holding that
// checkpoint reads Privy before the delete lands, waits on the lock, and once Start over commits it finds a live
// checkpoint and binds a new account to the Privy user that was just deleted.
//
// Privy state flip used (a user action Privy allows): the Privy user starts with an authenticator, no wallet and a
// linked Google account, so the gate says account_locked (linked_google_oauth) and Start over is eligible. While Start
// over's delete is in flight, the user unlinks Google in another tab, asks /proof for the checkpoint, creates the
// wallet and signs in.
//
// Harness: real Postgres (PGlite, every migration in the journal), the real routes, gate, proof, upsert, checkpoint
// and lock code. Only Privy's network calls, the same-origin check, the allowlist and the cookie store are replaced
// (as in start-over-race-adversary.test.ts). PGlite has one connection, so the production interleaving is modelled by
// a small db wrapper: while a transaction is open, a statement from another request runs on that connection (in
// production it runs on its own pooled connection and autocommits; Start over writes nothing, so what each statement
// sees is the same), and a second transaction waits for the first to commit (STRONGER than production, where only
// the advisory lock makes it wait, so this cannot create a false failure).
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
vi.mock('next/headers', () => ({ cookies: async () => ({ set: state.cookieSet }) }));

// anvil's published development key: exists only on local test chains.
const PRIVY_WALLET = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const T = 1_791_222_000;
const EMAIL = 'owner@example.com';
const P = 'did:privy:owner';
const P2 = 'did:privy:fresh';

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

describe('Start over racing a checkpoint written by /proof (spec 2026-10-07)', () => {
  it('never deletes a Privy user that a Mako account is then bound to', async () => {
    state.clock = Date.UTC(2026, 9, 7, 12, 0, 0);
    // Authenticator enrolled, no wallet, a linked Google account: locked, never admitted, no checkpoint anywhere.
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false, google: true });
    const B: Browser = { jar: new Map() };
    const hint = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
    expect(hint.json).toEqual({ ok: false, status: 'account_locked', startOver: true });

    // While Start over's Privy delete is in flight (it already passed its re-check under the lock), the same person
    // in another tab unlinks Google, gets the checkpoint, creates the wallet and signs in. The sign-in reads Privy
    // now, before the delete lands, then waits on the lock Start over holds.
    // If the checkpoint write is ever made to wait for Start over (the lock), the steps continue after it instead.
    const waitFor = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
    };
    let cpDone = false;
    let cp: Promise<{ status: number; json: Record<string, unknown> }> | null = null;
    let signIn: Promise<{ status: number; json: Record<string, unknown> }> | null = null;
    const rest = async () => {
      // The wallet is created, if the Privy user still exists (a deleted one is never brought back).
      if (state.privy.has(P)) state.privy.set(P, { email: EMAIL, enrolled: true, wallet: true, google: false });
      const step = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
      if (step.json.status !== 'proof_required') return step;
      const message = buildProofMessage('localhost:3000', step.json.nonce as string, new Date(state.clock));
      const signature = await PRIVY_WALLET.signMessage({ message });
      state.waiting = false;
      signIn = post(B, '/api/user/auth', { privyAccessToken: P, proof: { message, signature } });
      // Let the sign-in run up to the point where it waits for its transaction (its Privy read is done by then).
      await waitFor(() => state.waiting);
      return null;
    };
    state.duringDelete = async () => {
      state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false, google: false });
      state.waiting = false;
      cp = post(B, '/api/user/auth/proof', { privyAccessToken: P, checkpoint: true }).finally(() => (cpDone = true));
      await waitFor(() => cpDone || state.waiting);
      if (!cpDone) return; // the checkpoint write waits for Start over: the delete lands first
      expect((await cp).json).toEqual({ ok: false, status: 'wallet_required' });
      expect(B.jar.get('mako_enroll_cp')).toBeTruthy();
      await rest();
      expect(state.waiting, 'the sign-in reached its transaction while Start over held the lock').toBe(true);
    };
    const startOver = await post({ jar: new Map() }, '/api/user/auth/start-over', { privyAccessToken: P });
    expect(cp).not.toBeNull();
    await cp;
    if (signIn === null) await rest();
    const signInResult = signIn === null ? null : await signIn;

    const deleted = !state.privy.has(P);
    const bound = (await pg.query(`SELECT id FROM users WHERE privy_user_id = $1`, [P])).rows;
    console.info('[adversary] start-over:', JSON.stringify(startOver), 'sign-in:', JSON.stringify(signInResult), 'P deleted:', deleted, 'rows bound to P:', bound.length);

    // The spec invariant: a Privy user that Start over deleted is never the Privy user of any Mako account.
    if (deleted) {
      expect.soft(bound.length, 'accounts bound to the Privy user Start over deleted').toBe(0);
      // And the fresh sign-up Start over exists for (Privy gives the email a new user) is not refused as C4.
      state.privy.set(P2, { email: EMAIL, enrolled: false, wallet: false, google: false });
      const fresh = await post({ jar: new Map() }, '/api/user/auth/proof', { privyAccessToken: P2 });
      expect.soft(fresh.json.status, 'the fresh sign-up after Start over').not.toBe('email_changed');
    }
  });
});
