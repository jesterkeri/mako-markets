// Unique display names, case-insensitively (Joshua 2026-10-17): migration 0017 on a real Postgres (PGlite), the shared
// rules in src/lib/display-name.ts, and the Me page's availability route.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { displayNameKey, isReservedDisplayName } from '../display-name';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
const apply = async (pg: PGlite, tag: string) => {
  for (const stmt of readFileSync(join(DIR, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
};

let pg: PGlite;
let n = 0;
const addUser = async (name: string | null, createdAt: string) => {
  n += 1;
  const r = await pg.query<{ id: string }>(
    `INSERT INTO users (wallet_address, auth_type, display_name, created_at) VALUES ($1, 'wallet', $2, $3) RETURNING id`,
    [`0x${n.toString(16).padStart(40, '0')}`, name, createdAt],
  );
  return r.rows[0].id;
};
const keyOf = async (id: string) => (await pg.query<{ k: string | null }>(`SELECT display_name_key AS k FROM users WHERE id = $1`, [id])).rows[0].k;

describe('migration 0017 on Postgres: the oldest holder keeps a shared name', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    pg = new PGlite();
    for (const e of journal.entries) if (e.idx < 17) await apply(pg, e.tag);
    // Existing data before 0017: "jester" three ways (oldest is "Jester"), a unique name, and no name.
    ids.newer = await addUser('jester', '2026-10-02T00:00:00Z');
    ids.oldest = await addUser('Jester', '2026-10-01T00:00:00Z');
    ids.spaced = await addUser('  JESTER ', '2026-10-03T00:00:00Z');
    ids.zed = await addUser('Joshua  Z', '2026-10-01T00:00:00Z');
    ids.none = await addUser(null, '2026-10-01T00:00:00Z');
    await apply(pg, '0017_display_name_key');
  }, 60_000);
  afterAll(async () => pg.close());

  it('backfill: the oldest account keeps "jester"; later duplicates get no key; names themselves are untouched', async () => {
    expect(await keyOf(ids.oldest)).toBe('jester');
    expect(await keyOf(ids.newer)).toBeNull();
    expect(await keyOf(ids.spaced)).toBeNull();
    expect(await keyOf(ids.zed)).toBe('joshua z');
    expect(await keyOf(ids.none)).toBeNull();
    const names = (await pg.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [ids.newer])).rows[0];
    expect(names.display_name).toBe('jester');
  });
  it('the SQL key equals displayNameKey for the same names', async () => {
    for (const name of ['Jester', '  JESTER ', 'Joshua  Z', 'a.b_c-D 1']) {
      const r = await pg.query<{ k: string }>(`SELECT lower(regexp_replace(btrim($1::text, ' '), ' +', ' ', 'g')) AS k`, [name]);
      expect(r.rows[0].k, name).toBe(displayNameKey(name));
    }
  });
  it('after 0017 a name is free only once nobody shows it: the keyed holder and every grandfathered one', async () => {
    const take = (id: string) => pg.query(`UPDATE users SET display_name = 'jester' WHERE id = $1`, [id]);
    await expect(take(ids.newer)).rejects.toThrow(/users_display_name_key_uniq|unique|shown by another/);
    await pg.query(`UPDATE users SET display_name = NULL WHERE id = $1`, [ids.oldest]);
    // "  JESTER " (grandfathered, no key) still shows it.
    await expect(take(ids.newer)).rejects.toThrow(/shown by another/);
    await pg.query(`UPDATE users SET display_name = 'spaced one' WHERE id = $1`, [ids.spaced]);
    await take(ids.newer);
    expect(await keyOf(ids.newer)).toBe('jester');
    expect(await keyOf(ids.spaced)).toBe('spaced one'); // the trigger keys every name write
  });
  it('re-running 0017 changes nothing (IF NOT EXISTS, and only NULL keys are filled)', async () => {
    await apply(pg, '0017_display_name_key');
    expect(await keyOf(ids.newer)).toBe('jester');
    expect(await keyOf(ids.spaced)).toBe('spaced one');
  });
});

describe('shared rules', () => {
  it('displayNameKey: trim, collapse inner spaces, lower case', () => {
    expect(displayNameKey('  Jester   Z ')).toBe('jester z');
    expect(displayNameKey('JESTER')).toBe(displayNameKey('jester'));
  });
  it('reserved names, with spaces, dots, underscores and dashes ignored; ordinary names are not', () => {
    for (const r of ['mako', 'Mako Market', 'mako_market', 'MAKO-MARKETS', 'Admin', 'support', 'Official', 'mod', 'Team'])
      expect(isReservedDisplayName(r), r).toBe(true);
    for (const ok of ['jester', 'makoman', 'mako fan', 'teamwork', 'administrators club', 'Makoto Tomoda', 'Makoto Happy', 'the mako app'])
      expect(isReservedDisplayName(ok), ok).toBe(false);
    for (const r of ['Mako_Official', 'mako team', 'MakoSupport', 'Mako HQ', 'Mako Bot', 'Support Team', 'mako-market-official'])
      expect(isReservedDisplayName(r), r).toBe(true);
  });
});

const mocks = vi.hoisted(() => ({ session: vi.fn(), holder: vi.fn() }));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.session }));
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.holder() }) }) }) } }));

describe('GET /api/user/profile/name-available', () => {
  const ask = async (name: string) => {
    const { GET } = await import('@/app/api/user/profile/name-available/route');
    const res = await GET(new Request(`http://localhost/api/user/profile/name-available?name=${encodeURIComponent(name)}`));
    return { status: res.status, body: await res.json() };
  };
  it('signed out: 401', async () => {
    mocks.session.mockResolvedValue(null);
    expect((await ask('jester')).status).toBe(401);
  });
  it('free, own, taken, reserved, invalid', async () => {
    mocks.session.mockResolvedValue({ userId: 'me' });
    mocks.holder.mockResolvedValueOnce([]);
    expect((await ask('jester')).body).toEqual({ available: true });
    mocks.holder.mockResolvedValueOnce([]); // the query excludes the caller, so the caller's own name finds nobody
    expect((await ask('Jester')).body).toEqual({ available: true });
    mocks.holder.mockResolvedValueOnce([{ id: 'someone' }]);
    expect((await ask('JESTER')).body).toEqual({ available: false, reason: 'taken' });
    expect((await ask('Mako Market')).body).toEqual({ available: false, reason: 'reserved' });
    expect((await ask('bad<name>')).body).toEqual({ available: false, reason: 'invalid' });
  });
});
