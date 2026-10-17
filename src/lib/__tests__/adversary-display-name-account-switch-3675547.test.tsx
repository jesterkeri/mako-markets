// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-account-switch-3675547.test.tsx
//
// Adversary pass on 3675547 (unique display names, a re-check drops the name's earlier answer). Owner spec (Joshua
// 2026-10-17): "a live availability check while typing that agrees with what Save will do". The name-available route
// answers per account ("The caller's own current name counts as available", name-available/route.ts), so a verdict
// is only true for the account it was asked for.
//
// useNameCheck keeps its last verdict as { key, check } and re-asks only when [skip, key, draft] change. The account
// and its current name are not part of either, so when they change under an open editor with the same draft, the old
// account's verdict stays and is never asked about again:
//   1. K (keeper of "Quill") has Me open, editing, draft "QUILL" (a case change of its own name): 'available'.
//   2. In another tab K signs out and L signs in; this tab refetches the user on focus. MeSignedIn has no key, so the
//      editor stays open with the same draft and the same hook state; only `current` changes ("Quill" -> "Rook").
//   3. L sees "Looks good" with Save enabled for "QUILL", and no request is made; Save as L returns 409 name_taken.
// The same happens for one account whose current name changes in another tab.
//
// Real migrations 0000..0017 on PGlite, the real GET and POST routes and the real hook; only session and CSRF are
// stubbed, and fetch is routed to the real GET handler. Own names, since answers are shared in module state.
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

const asked: string[] = [];

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries) await apply(pg, e.tag);
  state.db = drizzle(pg, { schema });
  await addUser('K', 31, 'Quill');
  await addUser('L', 32, 'Rook');
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url));
    return available(new Request(new URL(url, 'http://localhost').toString()));
  });
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

describe('the account behind an open editor changes, the draft does not', () => {
  it('L is not shown K\'s "available" for a name Save refuses to L', async () => {
    // K, keeper of "Quill", types a case change of its own name: available for K.
    as('K');
    const { result, rerender } = renderHook(({ draft, current }) => useNameCheck(draft, current, true), {
      initialProps: { draft: 'QUILL', current: 'Quill' as string | null },
    });
    await wait(600);
    expect(result.current).toBe('available');

    // Another tab switches the session to L; this tab's user refetch hands Me L's name, the editor stays open.
    as('L');
    rerender({ draft: 'QUILL', current: 'Rook' });
    await wait(600);

    // What Save does for L, and what the live check shows L.
    const saveStatus = await saveName('QUILL');
    expect({ saveStatus, check: result.current }).toEqual({ saveStatus: 409, check: expect.not.stringMatching(/^available$/) });
  });
});
