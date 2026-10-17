// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-live-check-1d2942f.test.tsx
//
// Adversary pass on 1d2942f (unique display names). Owner spec (Joshua 2026-10-17): accounts that already shared a
// name before this change: "the first to have set it keeps it, the others must pick a new name next time they edit";
// and "a live availability check while typing".
//
// A (oldest) and B shared "Joe" before 0017, so A keeps it and B is grandfathered with no key. When B edits and types
// "JOE" (a case change of the name B shows), the save route refuses it (409 name_taken) and so does the availability
// endpoint ("taken"), but the Me page's live check (useNameCheck) never asks: it treats any draft whose key equals the
// current name's key as "the caller's own name" and reports 'idle', which both editors render as "Looks good" with
// Save enabled. The live check and the save route disagree for exactly the accounts the spec says must pick a new name.
//
// Real migrations 0000..0017 on PGlite, the real GET and POST routes and the real hook; only session and CSRF are
// stubbed, and fetch is routed to the real GET handler.
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { act, renderHook } from '@testing-library/react';
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

import { GET as available } from '../../app/api/user/profile/name-available/route';
import { POST as save } from '../../app/api/user/profile/update/route';
import { useNameCheck } from '../../app/me/use-name-check';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
const ids: Record<string, string> = {};
const addUser = async (label: string, n: number, name: string, createdAt: string) => {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', $2, $3) RETURNING id`,
    [`0x${n.toString(16).padStart(40, '0')}`, name, createdAt],
  );
  ids[label] = r.rows[0].id;
};

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
  await addUser('A', 1, 'Joe', '2026-10-01T00:00:00Z');
  await addUser('B', 2, 'Joe', '2026-10-02T00:00:00Z');
  await apply(pg, '0017_display_name_key');
  state.db = drizzle(pg, { schema });
  state.session = { userId: ids.B, authType: 'wallet', walletAddress: `0x${(2).toString(16).padStart(40, '0')}` };
  // The hook's request goes to the real availability route, as B.
  vi.stubGlobal('fetch', async (url: string) => available(new Request(new URL(url, 'http://localhost').toString())));
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

describe('grandfathered account B (shares "Joe" with the older A) types a case change of its own name', () => {
  it('the save route refuses "JOE" for B', async () => {
    const res = await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName: 'JOE' }) }));
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: 'name_taken' } });
  });

  it('the availability endpoint says "JOE" is taken for B', async () => {
    const res = await available(new Request('http://localhost/api/user/profile/name-available?name=JOE'));
    expect(await res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('control: when the hook does ask, the routed endpoint answers taken (so the plumbing works)', async () => {
    const { result } = renderHook(() => useNameCheck('JOE', 'Someone else', true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1500));
    });
    expect(result.current).toBe('taken');
  });

  it('the live check on Me agrees with them and shows "JOE" as taken, not "Looks good"', async () => {
    const { result } = renderHook(() => useNameCheck('JOE', 'Joe', true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1500));
    });
    expect(result.current).toBe('taken');
  });
});
