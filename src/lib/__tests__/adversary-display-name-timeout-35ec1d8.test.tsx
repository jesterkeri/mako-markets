// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-timeout-35ec1d8.test.tsx
//
// Adversary pass on 35ec1d8 (unique display names, the live check gives each request a 10 s timeout). Owner spec
// (Joshua 2026-10-17): "a live availability check while typing that agrees with what Save will do". The hook's own
// contract (src/app/me/use-name-check.ts): "null = no verdict (offline, signed out, bad reply): the check stays
// 'checking' rather than showing 'Looks good', and the save route still decides".
//
// useNameCheck keeps its last verdict as { key, check } and shows it whenever the draft's key equals that key. A
// re-check of the same key that times out returns null, and null never replaces the old verdict. So:
//   1. B types "Wren": 'available'.
//   2. A saves "Wren" (200).
//   3. B types "x" and deletes it within 400 ms (no request for "Wrenx"): the draft is "Wren" again and the hook
//      immediately shows the old 'available'; it re-asks after the pause.
//   4. That re-check times out (AbortSignal.timeout fires): null, the old 'available' stays for good.
// B now sees "Looks good" with Save enabled for a name Save refuses (409 name_taken), and the hook never asks again
// until B types.
//
// Real migrations 0000..0017 on PGlite, the real GET and POST routes and the real hook; only session and CSRF are
// stubbed. fetch is routed to the real GET handler; for the re-check it hangs until its signal aborts, and
// AbortSignal.timeout is spied so the test fires the 10 s timeout itself instead of waiting for it.
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

// The network: answered by the real GET handler, or (hang) never answered until the request's signal aborts.
const net = { hang: false, asked: [] as string[] };
const timeouts: AbortController[] = [];

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) await apply(pg, e.tag);
  state.db = drizzle(pg, { schema });
  await addUser('A', 11, 'Aspen');
  await addUser('B', 12, 'Beech');
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const c = new AbortController();
    timeouts.push(c);
    return c.signal;
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    net.asked.push(String(url));
    if (!net.hang) return available(new Request(new URL(url, 'http://localhost').toString()));
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')));
    });
  });
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await pg.close();
});

describe('a re-check of the same name that times out', () => {
  it('does not leave an old "available" showing for a name Save now refuses', async () => {
    as('B');
    const { result, rerender } = renderHook(({ draft }) => useNameCheck(draft, 'Beech', true), { initialProps: { draft: 'Wren' } });
    await wait(600);
    expect(result.current).toBe('available');

    // A takes "Wren".
    as('A');
    expect(await saveName('Wren')).toBe(200);

    // B types "x" and deletes it inside one pause: no request for "Wrenx", one re-check for "Wren", which hangs.
    as('B');
    net.hang = true;
    const before = net.asked.length;
    rerender({ draft: 'Wrenx' });
    await wait(100);
    rerender({ draft: 'Wren' });
    await wait(600);
    expect(net.asked.slice(before)).toEqual(['/api/user/profile/name-available?name=Wren']);

    // The 10 s timeout fires on the re-check.
    await act(async () => {
      for (const c of timeouts) c.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    });
    await wait(50);

    // What Save does for B now, and what the live check shows.
    const saveStatus = await saveName('Wren');
    expect({ saveStatus, check: result.current }).toEqual({ saveStatus: 409, check: expect.not.stringMatching(/^available$/) });
  });
});
