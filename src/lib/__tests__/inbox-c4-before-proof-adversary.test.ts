// Adversary pass on the inbox fix (INBOX_GAP_PLAN r18, diff 3ca7864..a2743cb): C4 must be decided BEFORE the
// enrollment and the sign-in proof, not only after them.
//
// Spec, item 1 of "What the app changes": "The order is: Privy email code, then enrollment if needed ..., then the
// challenge and its signature (Privy's MFA prompt), then exchangePrivyToken with the signature ... [J2] A Privy email
// that differs from the account's admitted one is `email_changed`, decided before any of this."
// And [J2] 1: "Both cases return { status: 'email_changed' } (403, no cookie) ... from /api/user/auth".
//
// The person who moved the login email (C4) holds only the email code, so they can never produce the proof. If the
// mismatch is decided only after the proof, their sign-in is never `email_changed`, the mismatch is never recorded and
// the account's sessions are never deleted (R18-F1). The owner at the old inbox lands in a NEW Privy user and is told to
// enroll an authenticator and create a wallet on it before learning the account is locked.
//
// Real Postgres (PGlite, every migration in the journal), the real gate, upsert, admission and mismatch code; only
// Privy's network reads, the same-origin check, the allowlist and the cookie store are replaced.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const state = vi.hoisted(() => ({ db: null as unknown, read: vi.fn(), readById: vi.fn(), cookieSet: vi.fn() }));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('@/lib/privy-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-server')>()),
  readPrivyAccount: state.read,
  readPrivyAccountById: state.readById,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: state.cookieSet }) }));

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
}, 60_000);
afterAll(async () => {
  await pg.close();
});

// anvil's published development key: exists only on local test chains.
const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const WALLET = OWNER.address.toLowerCase();
const T = 1_791_222_000;
const ADMITTED = 'owner@example.com';
const P1 = 'did:privy:owner';

/// A Privy user read as src/lib/privy-server.ts builds it.
function privyRead(o: { id: string; email: string; enrolled: boolean; wallet: boolean }) {
  const linked = o.wallet
    ? [{ type: 'wallet', id: 'w1', address: OWNER.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy', imported: false, delegated: false, verified_at: T + 5, first_verified_at: T + 5 }]
    : [];
  return {
    privyUserId: o.id,
    email: o.email,
    user: { id: o.id, mfa_methods: o.enrolled ? [{ type: 'totp', verified_at: T }] : [], linked_accounts: [{ type: 'email', address: o.email }, ...linked] },
    wallet: o.wallet ? { id: 'w1', address: OWNER.address, exported_at: null, imported_at: null, additional_signers: [] } : null,
  };
}

let userId: string;
beforeEach(async () => {
  await pg.exec('DELETE FROM sessions; DELETE FROM user_safes; DELETE FROM privy_proof_nonces; DELETE FROM users;');
  // The owner's account, admitted under the gate: bound to P1 and its wallet, with one live session.
  const db = state.db as ReturnType<typeof drizzle<typeof schema>>;
  const [u] = await db
    .insert(schema.users)
    .values({ email: ADMITTED, magicEoa: WALLET, authType: 'magic', privyUserId: P1, privyTotpAdmittedAt: T })
    .returning();
  userId = u.id;
  await db.insert(schema.sessions).values({ userId, expiresAt: new Date(Date.now() + 86_400_000) });
});
afterEach(() => {
  vi.clearAllMocks();
});

const req = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify(body) });
async function call(path: '/api/user/auth' | '/api/user/auth/proof') {
  const mod = path === '/api/user/auth' ? await import('../../app/api/user/auth/route') : await import('../../app/api/user/auth/proof/route');
  const res = await mod.POST(req(path, { privyAccessToken: 'tok' }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const audit = async () =>
  (await pg.query(`SELECT privy_email_mismatch_at AS at FROM users WHERE id = $1`, [userId])).rows[0] as { at: Date | null };
const liveSessions = async () => ((await pg.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [userId])).rows[0] as { n: number }).n;

describe('C4 is decided before the enrollment and the proof (item 1, [J2])', () => {
  it('the inbox holder at the NEW inbox (same Privy user, moved email), who cannot sign the proof: /api/user/auth says email_changed and records it', async () => {
    state.read.mockResolvedValue(privyRead({ id: P1, email: 'attacker@example.net', enrolled: true, wallet: true }));
    const r = await call('/api/user/auth');
    expect(r.json).toEqual({ ok: false, status: 'email_changed' });
    expect(r.status).toBe(403);
    expect((await audit()).at).not.toBeNull();
    expect(await liveSessions()).toBe(0);
    expect(state.cookieSet).not.toHaveBeenCalled();
  });

  it('the same inbox holder asking /api/user/auth/proof for the challenge gets email_changed, not a nonce', async () => {
    state.read.mockResolvedValue(privyRead({ id: P1, email: 'attacker@example.net', enrolled: true, wallet: true }));
    const r = await call('/api/user/auth/proof');
    expect(r.json.nonce).toBeUndefined();
    expect(r.json.status).toBe('email_changed');
  });

  it('the owner at the OLD inbox (a new Privy user, not enrolled) is told email_changed, not sent to enroll on a dead Privy user', async () => {
    state.read.mockResolvedValue(privyRead({ id: 'did:privy:new', email: ADMITTED, enrolled: false, wallet: false }));
    const r = await call('/api/user/auth/proof');
    expect(r.json.status).toBe('email_changed');
  });
});
