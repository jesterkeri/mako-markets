// Reserved display names are refused by the database too (Codex UNIQUE_NAMES R1 M1): migration 0017's trigger holds the
// app's RESERVED_PATTERN, so the previous app version, which writes display_name with no reserved check, cannot save
// "Mako Official" during the overlap. Real migrations on PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isReservedDisplayName, RESERVED_PATTERN } from '@/lib/display-name';

const DIR = join(__dirname, '../../db/migrations');
const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
const MIGRATION = readFileSync(join(DIR, '0017_display_name_key.sql'), 'utf8');

let pg: PGlite;
let n = 0;
beforeAll(async () => {
  pg = new PGlite();
  for (const e of journal.entries)
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
}, 60_000);
afterAll(async () => pg.close());

/// Sign a new wallet account in with this name, as any writer would; null if the database accepted it, else its error.
const write = async (name: string): Promise<{ code?: string; constraint?: string } | null> => {
  n += 1;
  try {
    await pg.query(`INSERT INTO users (wallet_address, auth_type, display_name) VALUES ($1, 'wallet', $2)`, [`0x${n.toString(16).padStart(40, '0')}`, name]);
    return null;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
};

describe('reserved display names in the database', () => {
  it("the trigger holds exactly the app's pattern", () => {
    expect(MIGRATION).toContain(`'${RESERVED_PATTERN}'`);
  });

  it('the database refuses exactly what the app calls reserved', async () => {
    const names = [
      'Mako', 'mako official', 'Mako_Official', 'MAKO-SUPPORT', 'Mako.Team', 'Support Team', 'makomarket', 'Mako Markets HQ',
      'admin', 'Bot', 'mod', 'Help', '  Mako   Official  ', 'Makoto', 'Happy', 'Kemi', 'Mako Fan', 'Official Kemi', 'Teamwork',
      'hqx', 'mak0 official', 'Joshua',
    ];
    const mismatches: string[] = [];
    for (const name of names) {
      const err = await write(name);
      const refused = err?.code === '23514' && err.constraint === 'users_display_name_reserved';
      if (refused !== isReservedDisplayName(name)) mismatches.push(`${name}: db ${refused ? 'refused' : `accepted (${err?.code ?? 'ok'})`}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('the previous app renaming an existing account to a reserved name is refused, and an existing reserved name cannot be re-saved', async () => {
    n += 1;
    const wallet = `0x${n.toString(16).padStart(40, '0')}`;
    await pg.query(`INSERT INTO users (wallet_address, auth_type, display_name) VALUES ($1, 'wallet', 'Zubair')`, [wallet]);
    await expect(pg.query(`UPDATE users SET display_name = 'Mako Official' WHERE wallet_address = $1`, [wallet])).rejects.toMatchObject({
      code: '23514',
      constraint: 'users_display_name_reserved',
    });
    // An account that showed a reserved name before 0017 (the trigger was not there yet) keeps it until it writes again.
    await pg.query(`ALTER TABLE users DISABLE TRIGGER users_display_name_key_sync`);
    await pg.query(`UPDATE users SET display_name = 'Mako' WHERE wallet_address = $1`, [wallet]);
    await pg.query(`ALTER TABLE users ENABLE TRIGGER users_display_name_key_sync`);
    await expect(pg.query(`UPDATE users SET display_name = 'MAKO' WHERE wallet_address = $1`, [wallet])).rejects.toMatchObject({ code: '23514' });
  });
});
