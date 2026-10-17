// (Adversary on 88a11e5; fixed in the next commit: the shown name counts whatever the key says.) ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-stale-key-88a11e5.test.ts
//
// Adversary pass on unique display names (88a11e5). Owner spec (Joshua 2026-10-17): "two users must not be able to
// have the same display name", compared case-insensitively.
//
// docs/db-migration-policy.md ("Expand", then "Deploy the app") runs a new nullable column's migration BEFORE the app
// that writes it, and notes Preview and Production share one DB, so the previous save route (f1af01c
// src/app/api/user/profile/update/route.ts, SET display_name only) keeps serving after 0017. A keyed account that
// renames through it keeps its OLD key with its NEW name. nameHeldByOther only compares the shown name on rows whose
// key IS NULL, so the new name is invisible to it and to the unique index: a second account can take it.
//
// Real migrations 0000..0017 on PGlite, real save and availability routes of 88a11e5; only session and CSRF stubbed.
// The old route's write is reproduced with drizzle exactly as f1af01c issues it (update users set display_name).
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

// (Builder: the per-account name-check cap, Codex UNIQUE_NAMES R1 M2, is its own test; here it always allows.)
vi.mock('@/lib/name-check-budget', () => ({ reserveNameCheck: async () => 'ok' }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { POST as save } from '../../app/api/user/profile/update/route';
import { GET as available } from '../../app/api/user/profile/name-available/route';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
const wallets: Record<string, string> = {};
const ids: Record<string, string> = {};
const addUser = async (label: string, n: number, name: string | null, createdAt: string) => {
  wallets[label] = `0x${n.toString(16).padStart(40, '0')}`;
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', $2, $3) RETURNING id`,
    [wallets[label], name, createdAt],
  );
  ids[label] = r.rows[0].id;
};
const as = (label: string) => {
  state.session = { userId: ids[label], authType: 'wallet', walletAddress: wallets[label], sessionId: `00000000-0000-4000-8000-${label.charCodeAt(0).toString(16).padStart(12, '0')}` };
};
const saveName = async (displayName: string) => {
  const res = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName }) }));
  return { status: res.status, body: (await res.json()) as { error?: string; displayName?: string } };
};

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
  await addUser('A', 1, 'Jo', '2026-10-01T00:00:00Z');
  await addUser('C', 3, null, '2026-10-02T00:00:00Z');
  await apply(pg, '0017_display_name_key'); // A now holds key "jo"
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

describe('a rename written by the previous app version leaves a stale key', () => {
  it('a second account cannot take the name A now shows', async () => {
    // The previous save route (f1af01c), still serving between `db:migrate` and the new deploy, renames A.
    const db = state.db as ReturnType<typeof drizzle<typeof schema>>;
    await db.update(schema.users).set({ displayName: 'Bob' }).where(eq(schema.users.id, ids.A));

    // The new app is live. C asks for and saves A's shown name in another case.
    as('C');
    const check = await available(new Request('http://localhost/api/user/profile/name-available?name=BOB'));
    const res = await saveName('BOB');

    const holders = await pg.query<{ id: string }>(`SELECT id FROM users WHERE lower(display_name) = 'bob'`);
    expect({ live: await check.json(), save: res.status, holders: holders.rows.length }).toEqual({
      live: { available: false, reason: 'taken' },
      save: 409,
      holders: 1,
    });
  });
});
