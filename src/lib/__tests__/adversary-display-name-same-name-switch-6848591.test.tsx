// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-same-name-switch-6848591.test.tsx
//
// Adversary pass on 6848591 (the name check is keyed by the account's current name plus the typed name). Owner spec
// (Joshua 2026-10-17): "accounts that already shared a name before this change: the first to have set it keeps it, the
// others must pick a new name next time they edit" and "a live availability check while typing that agrees with what
// Save will do".
//
// The verdict depends on the account (the keeper may change its name's case, a grandfathered sharer may not), but the
// hook keys it by the current NAME, not the account. Two accounts that shared a name before 0017 show the same current
// name, so switching between them leaves the key unchanged and the keeper's verdict is kept for the other account:
//   1. K (oldest, keeper of "Wren") has Me open, editing, draft "WREN": 'available' for K.
//   2. In another tab K signs out and L (shared "Wren" before 0017, no key) signs in; this tab refetches the user, the
//      editor stays open, `current` is "Wren" again, so key, skip and draft are all unchanged: no new request.
//   3. L sees "Looks good" with Save enabled for "WREN"; Save as L returns 409 name_taken.
//
// Real migrations 0000..0017 on PGlite (K and L inserted before 0017), the real GET and POST routes and the real hook;
// only session and CSRF are stubbed, and fetch is routed to the real GET handler. Own names, since answers are shared
// in module state.
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
const addUser = async (label: string, n: number, name: string | null, createdAt: string) => {
  const wallet = `0x${n.toString(16).padStart(40, '0')}`;
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', $2, $3) RETURNING id`,
    [wallet, name, createdAt],
  );
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
  const last = journal.entries[journal.entries.length - 1];
  expect(last.tag).toBe('0017_display_name_key');
  for (const e of journal.entries.slice(0, -1)) await apply(pg, e.tag);
  // Before 0017: K set "Wren" first, L later set the same name.
  await addUser('K', 41, 'Wren', '2026-01-01T00:00:00Z');
  await addUser('L', 42, 'Wren', '2026-02-01T00:00:00Z');
  await apply(pg, last.tag);
  state.db = drizzle(pg, { schema });
  vi.stubGlobal('fetch', async (url: string) => available(new Request(new URL(url, 'http://localhost').toString())));
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

describe('two accounts that shared a name before 0017 swap behind an open editor', () => {
  it('L is not shown the keeper\'s "available" for a case change Save refuses to L', async () => {
    as('K');
    const { result, rerender } = renderHook(({ draft, current, account }) => useNameCheck(draft, current, true, account), {
      initialProps: { draft: 'WREN', current: 'Wren' as string | null, account: (sessions.K as { walletAddress: string }).walletAddress },
    });
    await wait(600);
    expect(result.current).toBe('available');

    // Another tab switches the session to L; this tab's user refetch hands Me L's name, which is the same string.
    as('L');
    rerender({ draft: 'WREN', current: 'Wren', account: (sessions.L as { walletAddress: string }).walletAddress }); // (builder: the editors now pass the account)
    await wait(600);

    const saveStatus = await saveName('WREN');
    expect({ saveStatus, check: result.current }).toEqual({ saveStatus: 409, check: expect.not.stringMatching(/^available$/) });
  });
});
