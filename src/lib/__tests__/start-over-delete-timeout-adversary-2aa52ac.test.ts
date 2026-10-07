// Adversary on 2aa52ac (Start over clears checkpoints, survives a failed commit; owner decisions 2026-10-07).
//
// Spec: "A failed read or a failed delete deletes nothing and returns 503; once Privy has deleted the user, the answer
// is success."
//
// The route takes ANY error from deletePrivyUser as "nothing was deleted" (start-over/route.ts: the delete's catch
// throws StartOverUnavailable('delete'), privyDeleted stays false, the answer is 503 and the checkpoint clear rolls
// back). It never asks Privy whether the user is gone. Two ordinary ways the delete errors although Privy has deleted
// the user:
//   1. the delete call times out (or its connection drops) after Privy carried it out;
//   2. two Start over requests for the same Privy user (a double click, two tabs) both read Privy before either
//      deletes; the second waits on lockPrivyUser, re-checks (still eligible: nothing bound, no live checkpoint) and
//      its delete fails with "not found", because the first already deleted the user.
// In both the browser is told 503 'unavailable' for an identity Privy has deleted, and keeps its checkpoint cookie.
//
// Harness copied from start-over-commit-and-skew-adversary-151cad5.test.ts: real Postgres (PGlite, every migration), the
// real routes, gate, upsert, checkpoint and lock code; only Privy's network calls, the same-origin check, the allowlist,
// the cookie store and the database clock are replaced. Neither test relies on PGlite running one transaction at a
// time: each request runs alone, and the second test models the earlier Privy read by replaying a read taken before
// the delete.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const state = vi.hoisted(() => ({
  db: null as unknown,
  clock: 0,
  dbClock: 0,
  privy: new Map<string, { email: string; enrolled: boolean; wallet: boolean }>(),
  /// Privy reads taken earlier, replayed for a token: a request that read Privy before another request's delete.
  staleReads: new Map<string, unknown>(),
  cookieSet: vi.fn(),
  /// When set, the next Privy delete is carried out at Privy and then the call fails (a timeout after the fact).
  deleteThenTimeout: false,
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
  if (u.wallet) {
    linked.push({ type: 'wallet', id: 'w1', address: PRIVY_WALLET.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy', imported: false, delegated: false, verified_at: T + 5, first_verified_at: T + 5 });
  }
  return {
    privyUserId: id,
    email: u.email,
    user: { id, mfa_methods: u.enrolled ? [{ type: 'totp', verified_at: T }] : [], linked_accounts: linked },
    wallet: u.enrolled && u.wallet ? { id: 'w1', address: PRIVY_WALLET.address, exported_at: null, imported_at: null, additional_signers: [] } : null,
  };
}

vi.mock('@/lib/privy-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-server')>()),
  readPrivyAccount: async (token: string) => (state.staleReads.has(token) ? state.staleReads.get(token) : privyRead(token)),
  readPrivyAccountById: async (id: string) => privyRead(id),
  // Privy's own answer to "does this user exist" (the fix asks it after a delete that errored).
  privyUserExists: async (id: string) => state.privy.has(id),
  deletePrivyUser: async (id: string) => {
    if (!state.privy.delete(id)) throw new Error('privy: delete of a missing user (404)');
    if (state.deleteThenTimeout) {
      state.deleteThenTimeout = false;
      throw new Error('privy: request timed out');
    }
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
  vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
}, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await pg.close();
});

type Browser = { jar: Map<string, string> };
function req(browser: Browser, path: string, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  if (browser.jar.size) headers.cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return new Request(`http://localhost:3000${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function post(browser: Browser, path: string, body: Record<string, unknown>) {
  const mod = path === '/api/user/auth/proof' ? await import('../../app/api/user/auth/proof/route') : await import('../../app/api/user/auth/start-over/route');
  const before = state.cookieSet.mock.calls.length;
  const res = await mod.POST(req(browser, path, body));
  for (const call of state.cookieSet.mock.calls.slice(before)) browser.jar.set(call[0] as string, call[1] as string);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/// An unfinished, locked sign-up: authenticator and wallet, no checkpoint anywhere, never admitted. Start over is offered.
async function lockedSignUp(id: string, email: string, browser: Browser) {
  state.privy.set(id, { email, enrolled: true, wallet: true });
  const hint = await post(browser, '/api/user/auth/proof', { privyAccessToken: id });
  expect(hint.json).toEqual({ ok: false, status: 'account_locked', startOver: true });
}

describe('Start over whose Privy delete errors after Privy deleted the user (spec 2026-10-07)', () => {
  it('a delete that times out after Privy carried it out is answered as success, not 503', async () => {
    const C0 = Date.UTC(2026, 9, 7, 9, 0, 0);
    state.clock = C0;
    state.dbClock = C0;
    const P = 'did:privy:timeout';
    const B: Browser = { jar: new Map() };
    await lockedSignUp(P, 'timeout@example.com', B);

    state.deleteThenTimeout = true;
    const res = await post(B, '/api/user/auth/start-over', { privyAccessToken: P });
    const deleted = !state.privy.has(P);
    console.info('[adversary] start-over with a delete that timed out after the fact:', JSON.stringify(res), 'P deleted:', deleted);

    // Not vacuous: the injected timeout fired, after Privy deleted the user.
    expect(state.deleteThenTimeout, 'the injected timeout fired').toBe(false);
    expect(deleted, 'Privy deleted the user').toBe(true);
    // The spec: once Privy has deleted the user, the answer is success.
    expect({ status: res.status, privyUserDeleted: deleted }, 'a 503 Start over for a Privy user that is deleted').not.toEqual({
      status: 503,
      privyUserDeleted: true,
    });
  });

  it('the second of two Start over requests that both read Privy before the delete is not answered 503', async () => {
    const C0 = Date.UTC(2026, 9, 7, 10, 0, 0);
    state.clock = C0;
    state.dbClock = C0;
    const P = 'did:privy:twotabs';
    const B: Browser = { jar: new Map() };
    await lockedSignUp(P, 'twotabs@example.com', B);

    // Request 2 read Privy before request 1's delete (it then waits on lockPrivyUser until request 1 commits).
    state.staleReads.set(P, privyRead(P));
    const first = await post(B, '/api/user/auth/start-over', { privyAccessToken: P });
    expect(first).toEqual({ status: 200, json: { ok: true } });
    expect(state.privy.has(P)).toBe(false);

    const second = await post(B, '/api/user/auth/start-over', { privyAccessToken: P });
    console.info('[adversary] second Start over after the first deleted the user:', JSON.stringify(second));
    expect({ status: second.status, privyUserDeleted: !state.privy.has(P) }, 'a 503 Start over for a Privy user that is deleted').not.toEqual({
      status: 503,
      privyUserDeleted: true,
    });
  });
});
