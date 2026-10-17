// POST /api/user/chart-colors writes only to the account the change was made on (adversary r4 on 90ff30f: a save
// queued before a sign-in elsewhere was written to the new account). Real migrations on PGlite, real route; only the
// session and same-origin check are stubbed. Covers both identity branches: a wallet account (users.wallet_address,
// lowercase) and an email account (user_safes.safe_address, stored checksummed).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { DEFAULT_CHART_COLORS } from '@/lib/chart-colors';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => state.session }));

import { POST } from '../../app/api/user/chart-colors/route';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
const WALLET = `0x${'a'.repeat(40)}`;
const SAFE = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const SET = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
let pg: PGlite;
const ids: Record<string, string> = {};

beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries)
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
  ids.wallet = (await pg.query<{ id: string }>(`INSERT INTO users (wallet_address, auth_type) VALUES ($1, 'wallet') RETURNING id`, [WALLET])).rows[0].id;
  ids.email = (await pg.query<{ id: string }>(`INSERT INTO users (email, magic_eoa, auth_type) VALUES ('e@x.y', $1, 'magic') RETURNING id`, [`0x${'7'.repeat(40)}`])).rows[0].id;
  await pg.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, 10143, $2)`, [ids.email, SAFE]);
  state.db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => pg.close());

const save = (who: 'wallet' | 'email', account: string) => {
  state.session = { userId: ids[who] };
  return POST(new Request('http://localhost/api/user/chart-colors', { method: 'POST', body: JSON.stringify({ account, colors: SET }) }));
};
const stored = async (who: string) => (await pg.query<{ chart_colors: unknown }>(`SELECT chart_colors FROM users WHERE id = $1`, [ids[who]])).rows[0].chart_colors;

describe('a save lands only on the account it was made on', () => {
  it('wallet account, its own address (any case): saved', async () => {
    expect((await save('wallet', WALLET.toUpperCase().replace('0X', '0x'))).status).toBe(200);
    expect(await stored('wallet')).toEqual(SET);
  });
  it('email account, its own Safe address (stored checksummed, sent lower case): saved', async () => {
    expect((await save('email', SAFE.toLowerCase())).status).toBe(200);
    expect(await stored('email')).toEqual(SET);
  });
  it("made on the wallet account, sent under the email account's session: 409, nothing written", async () => {
    await pg.query(`UPDATE users SET chart_colors = NULL WHERE id = $1`, [ids.email]);
    expect((await save('email', WALLET)).status).toBe(409);
    expect(await stored('email')).toBeNull();
  });
  it("made on the email account, sent under the wallet account's session: 409, nothing written", async () => {
    await pg.query(`UPDATE users SET chart_colors = NULL WHERE id = $1`, [ids.wallet]);
    expect((await save('wallet', SAFE)).status).toBe(409);
    expect(await stored('wallet')).toBeNull();
  });
});
