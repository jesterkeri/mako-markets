// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-shared-check-5e7f241.test.tsx
//
// Adversary pass on 5e7f241 (unique display names, the shared live check on Me). Owner spec (Joshua 2026-10-17): "a
// live availability check while typing that agrees with what Save will do".
//
// 5e7f241 keeps each name's answer in module state for 2 s after it arrives (use-name-check.ts `inflight`, keyed by
// the name's key only). A check made inside that window is answered from the old reply without asking the server,
// so a name that changed hands in the meantime is still reported with its old answer:
//   1. B types "Zara" (available), moves on to "Zarax", A saves "Zara", B goes back to "Zara": the live check says
//      'available' ("Looks good", Save enabled) while Save as B now returns 409 name_taken. A fresh request (what the
//      hook did before 5e7f241) answers 'taken'.
//   2. Same tab, another account: the cache key carries no account, so A's answer for A's own name ('available', A is
//      the keeper) is handed to B, for whom the server and Save say taken.
//
// Real migrations 0000..0017 on PGlite, the real GET and POST routes and the real hook; only session and CSRF are
// stubbed, and fetch is routed to the real GET handler. Each case uses its own names (the 2 s answers are module
// state).
// ----------------------------------------------------------------------------
import { PGlite } from '@electric-sql/pglite';
import { act, renderHook } from '@testing-library/react';
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

import { GET as available } from '../../app/api/user/profile/name-available/route';
import { POST as save } from '../../app/api/user/profile/update/route';
import { useNameCheck } from '../../app/me/use-name-check';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
const sessions: Record<string, unknown> = {};
const addUser = async (label: string, n: number, name: string | null) => {
  const wallet = `0x${n.toString(16).padStart(40, '0')}`;
  const r = await pg.query<{ id: string }>(`INSERT INTO users (wallet_address, auth_type, display_name) VALUES ($1, 'wallet', $2) RETURNING id`, [wallet, name]);
  sessions[label] = { userId: r.rows[0].id, authType: 'wallet', walletAddress: wallet };
};
const as = (label: string) => {
  state.session = sessions[label];
};
const saveName = async (displayName: string) =>
  (await save(new Request('http://localhost/api/user/profile/update', { method: 'POST', body: JSON.stringify({ displayName }) }))).status;
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) await apply(pg, e.tag);
  state.db = drizzle(pg, { schema });
  await addUser('A', 1, 'Alder');
  await addUser('B', 2, 'Birch');
  await addUser('K', 3, 'Kip');
  await addUser('L', 4, 'Larch');
  vi.stubGlobal('fetch', async (url: string) => available(new Request(new URL(url, 'http://localhost').toString())));
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

describe('the 2 s shared answer and a name that changes hands', () => {
  it('B goes back to "Zara" after A saved it: the live check agrees with Save (taken), not "Looks good"', async () => {
    as('B');
    const { result, rerender } = renderHook(({ draft }) => useNameCheck(draft, 'Birch', true), { initialProps: { draft: 'Zara' } });
    await wait(600);
    expect(result.current).toBe('available');

    rerender({ draft: 'Zarax' });
    await wait(600);
    expect(result.current).toBe('available');

    // A takes "Zara" (about 1.2 s after B's first answer arrived).
    as('A');
    expect(await saveName('Zara')).toBe(200);

    as('B');
    rerender({ draft: 'Zara' });
    await wait(600);
    // What Save does for B now:
    const saveStatus = await saveName('Zara');
    expect(saveStatus).toBe(409);
    expect(result.current).toBe('taken');
  });

  it('same tab, another account: K\'s answer for K\'s own name is not shown to L', async () => {
    // K (keeper of "Kip") types a case change of its own name: available for K.
    as('K');
    const k = renderHook(() => useNameCheck('KIP', 'Kip', true));
    await wait(600);
    expect(k.result.current).toBe('available');
    k.unmount();

    // K signs out, L signs in on the same tab and types "kip" within 2 s.
    as('L');
    const l = renderHook(() => useNameCheck('kip', 'Larch', true));
    await wait(600);
    expect(await saveName('kip')).toBe(409);
    expect(l.result.current).toBe('taken');
  });
});
