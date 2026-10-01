// Ref tags (migration 0011) on a real Postgres: every migration in the journal applies in order, and the CHECK
// users_ref_format_chk agrees with parseRefTag. The code's output is always accepted (a tag the code keeps never
// fails a sign-in on the CHECK), and a raw value the code would rewrite or drop is refused by the database.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRefTag } from '../ref-tag';

const DIR = join(__dirname, '../../db/migrations');

let pg: PGlite;
let n = 0;

beforeAll(async () => {
  pg = new PGlite();
  const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  for (const e of journal.entries) {
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
}, 60_000);

afterAll(async () => {
  await pg.close();
});

async function insertRef(ref: string | null): Promise<boolean> {
  n += 1;
  const wallet = `0x${n.toString(16).padStart(40, '0')}`;
  try {
    await pg.query(`INSERT INTO users (wallet_address, auth_type, ref) VALUES ($1, 'wallet', $2)`, [wallet, ref]);
    return true;
  } catch {
    return false;
  }
}

describe('migration 0011 on Postgres', () => {
  const raws = [
    'a',
    'a'.repeat(32),
    'a'.repeat(33),
    ' Launch-Thread ',
    'POST3',
    'K', // Kelvin sign, lower-cases to ASCII "k"
    'İ', // dotted capital I, lower-cases to two code points
    'abc\n',
    '\nabc',
    'ab_c',
    '-',
    '',
    'pöst',
    ' post ',
    '﻿post',
  ];

  it('accepts every tag the code keeps', async () => {
    for (const raw of raws) {
      const tag = parseRefTag(raw);
      if (tag === null) continue;
      expect(await insertRef(tag), JSON.stringify(raw)).toBe(true);
    }
    expect(await insertRef(null)).toBe(true);
  });

  it('refuses every raw value the code would rewrite or drop', async () => {
    for (const raw of raws) {
      if (parseRefTag(raw) === raw) continue;
      expect(await insertRef(raw), JSON.stringify(raw)).toBe(false);
    }
  });
});
