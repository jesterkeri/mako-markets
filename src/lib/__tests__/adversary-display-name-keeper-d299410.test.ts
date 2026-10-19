// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-keeper-d299410.test.ts
//
// Adversary pass on d299410 (migration 0017 trigger also refuses a name a key-less, grandfathered account shows).
// Owner spec (Joshua 2026-10-17): accounts that already shared a name before this change: "the first to have set it
// keeps it, the others must pick a new name next time they edit".
//
// A (oldest) and B shared "Bob" before 0017. Backfill keys A ("bob"); B shows "bob" with no key. The new trigger
// check `o.display_name_key IS NULL AND key(o.display_name) = NEW.key` finds B whenever A writes its own name, so the
// account that KEEPS the name can no longer re-save it or change its case, from any writer. The new route refuses the
// same write earlier (nameHeldByOther compares shown names), so A gets 409 name_taken for its own name.
//
// Real migrations 0000..0017 on PGlite, real save route of d299410; only session and CSRF stubbed.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { POST as save } from '../../app/api/user/profile/update/route';

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
const post = (displayName: string) =>
  save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName }) }));

beforeAll(async () => {
  pg = new PGlite();
  // Before 0017: A set "Bob" first, B later set "bob".
  for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
  await addUser('A', 1, 'Bob', '2026-10-01T00:00:00Z');
  await addUser('B', 2, 'bob', '2026-10-02T00:00:00Z');
  await apply(pg, '0017_display_name_key');
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

describe('the account that keeps a shared name (first to set it) while a grandfathered duplicate remains', () => {
  it('backfill: A holds the key, B is grandfathered', async () => {
    const r = await pg.query<{ display_name_key: string | null }>(`SELECT display_name_key FROM users ORDER BY created_at`);
    expect(r.rows.map((x) => x.display_name_key)).toEqual(['bob', null]);
  });

  it('A can re-save its own name exactly as shown (plain UPDATE, as the previous app writes it)', async () => {
    let result = 'ok';
    try {
      await pg.query(`UPDATE users SET display_name = $1 WHERE id = $2`, ['Bob', ids.A]);
    } catch (e) {
      result = `refused: ${(e as Error).message}`;
    }
    expect(result).toBe('ok');
  });

  it('A can change the case of its own name on the new app', async () => {
    as('A');
    const res = await post('BOB');
    const body = (await res.json()) as { error?: string; displayName?: string };
    expect({ status: res.status, name: body.error ?? body.displayName }).toEqual({ status: 200, name: 'BOB' });
  });
});
