// Codex SIGNIN_R2 B1 (2026-10-07): Start over held a transaction-scoped advisory lock across Privy's delete. If the
// function or the transaction ended while Privy was still deleting, the lock was released, and a first admission
// waiting on it could bind the account to a Privy user that Privy then deleted. The fix commits a Start over FENCE
// (migration 0015) before the delete is sent; no checkpoint of a fenced user counts again.
//
// Modelled here: Start over is eligible (an unfinished sign-up locked by a linked Google account, no wallet, no live
// checkpoint), fences, and sends the delete. The invocation then dies (the delete never returns to it, so no catch or
// follow-up runs). While Privy has not deleted yet, the owner removes the Google link, records a fresh checkpoint,
// creates the wallet and signs in. Privy then carries the delete out. Invariant: no Mako account is bound to the
// deleted Privy user. Harness copied from start-over-checkpoint-race-adversary-e0d63e9.test.ts (real Postgres via
// PGlite, every migration, the real routes; only Privy's network calls, the same-origin check, the allowlist, the
// cookie store and the database clock are replaced).
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
// One clock in this test: the database's (db-clock.ts) reads the same time as the instance's.
vi.mock('@/lib/db-clock', () => ({ databaseNowMs: async () => state.clock }));
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

describe('Start over whose invocation dies while Privy is still deleting (Codex SIGNIN_R2 B1)', () => {
  it('the fence keeps a later first admission from binding the Privy user Privy then deletes', async () => {
    const C0 = Date.UTC(2026, 9, 7, 12, 0, 0);
    state.clock = C0;
    // Authenticator enrolled, a linked Google account (locked), no wallet, no checkpoint: Start over is offered.
    state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false, google: true });
    const B: Browser = { jar: new Map() };
    expect((await post(B, '/api/user/auth/proof', { privyAccessToken: P })).json).toEqual({ ok: false, status: 'account_locked', startOver: true });

    let signIn: { status: number; json: Record<string, unknown> } | null = null;
    let proofAfterWallet: Record<string, unknown> | null = null;
    // The delete is in flight at Privy; the Start over invocation is gone (modelled by never letting the call return to
    // it). Meanwhile the owner finishes setting up in browser B.
    let releaseDelete!: () => void;
    const deleteLands = new Promise<void>((r) => (releaseDelete = r));
    state.duringDelete = async () => {
      state.clock = C0 + 60_000;
      state.privy.set(P, { email: EMAIL, enrolled: true, wallet: false, google: false }); // Google link removed
      await post(B, '/api/user/auth/proof', { privyAccessToken: P, checkpoint: true });
      state.privy.set(P, { email: EMAIL, enrolled: true, wallet: true, google: false }); // wallet created
      const step = await post(B, '/api/user/auth/proof', { privyAccessToken: P });
      proofAfterWallet = step.json;
      if (step.json.status === 'proof_required') {
        const message = buildProofMessage('localhost:3000', step.json.nonce as string, new Date(state.clock));
        signIn = await post(B, '/api/user/auth', { privyAccessToken: P, proof: { message, signature: await PRIVY_WALLET.signMessage({ message }) } });
      }
      releaseDelete();
    };
    const startOver = post({ jar: new Map() }, '/api/user/auth/start-over', { privyAccessToken: P });
    await deleteLands; // the owner's whole sign-in ran while the delete was in flight
    await startOver; // Privy's delete lands (the invocation's own answer is irrelevant: it is dead)

    const bound = (await pg.query(`SELECT id FROM users WHERE privy_user_id = $1`, [P])).rows;
    const fence = (await pg.query(`SELECT privy_user_id FROM privy_start_over_fences WHERE privy_user_id = $1`, [P])).rows;
    console.info('[B1] proof after wallet:', JSON.stringify(proofAfterWallet), 'sign-in:', JSON.stringify(signIn), 'P deleted:', !state.privy.has(P), 'bound:', bound.length);

    expect(state.privy.has(P), 'Privy deleted the user').toBe(false);
    expect(fence.length, 'the fence was committed before the delete').toBe(1);
    expect(bound.length, 'accounts bound to the Privy user Start over deleted').toBe(0);
    // And the reason: a fenced user's fresh checkpoint does not count, so no proof nonce was ever offered.
    expect(proofAfterWallet).toEqual({ ok: false, status: 'account_locked', startOver: true });
  });
});
