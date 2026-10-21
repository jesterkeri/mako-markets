// Migration 0019 (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.1): the ceremony and remembered-browser tables, the challenge's
// rb_ columns and users.privy_email_verified_seen, applied with every earlier migration, and the CHECKs that keep each
// row's shape honest.
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const H = (c: string) => c.repeat(64);
let pg: PGlite;
let userId: string;

beforeEach(async () => {
  ({ client: pg } = await migratedPglite());
  userId = (
    await pg.query<{ id: string }>(`INSERT INTO users (email, magic_eoa) VALUES ('a@example.com', '0x${'1'.repeat(40)}') RETURNING id`)
  ).rows[0].id;
});
afterEach(async () => {
  await pg.close();
});

async function ceremony(verified = true): Promise<string> {
  const r = await pg.query<{ id: string }>(
    verified
      ? `INSERT INTO email_ceremonies (secret_hash, verified_at, verified_sid_hash, verified_privy_user_id, verified_value)
         VALUES ($1, clock_timestamp(), $2, 'did:privy:a', 1790000000) RETURNING id`
      : `INSERT INTO email_ceremonies (secret_hash) VALUES ($1) RETURNING id`,
    verified ? [H(String(Math.floor(Math.random() * 10))), H('b')] : [H('c')],
  );
  return r.rows[0].id;
}

describe('migration 0019', () => {
  it('adds the users mark, nullable and positive', async () => {
    expect((await pg.query(`SELECT privy_email_verified_seen FROM users WHERE id = $1`, [userId])).rows[0]).toEqual({ privy_email_verified_seen: null });
    await expect(pg.query(`UPDATE users SET privy_email_verified_seen = 0 WHERE id = $1`, [userId])).rejects.toThrow();
  });

  it('a ceremony is verified all at once or not at all, and only a verified one is spent', async () => {
    const id = await ceremony(false);
    await expect(pg.query(`UPDATE email_ceremonies SET verified_at = now() WHERE id = $1`, [id])).rejects.toThrow();
    await expect(pg.query(`UPDATE email_ceremonies SET used_at = now() WHERE id = $1`, [id])).rejects.toThrow();
    await expect(pg.query(`UPDATE email_ceremonies SET attempts = 11 WHERE id = $1`, [id])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO email_ceremonies (secret_hash) VALUES ('not-hex')`)).rejects.toThrow();
    await expect(pg.query(`INSERT INTO email_ceremonies (secret_hash) VALUES ($1)`, [H('c')])).rejects.toThrow(); // unique
    const created = (await pg.query<{ created_at: Date }>(`SELECT created_at FROM email_ceremonies WHERE id = $1`, [id])).rows[0];
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it('a remembered row is unique per (user, sid), revoked with a known reason, and expires after it is created', async () => {
    const c = await ceremony();
    const insert = (sid: string, extra = '') =>
      pg.query(
        `INSERT INTO remembered_browsers (user_id, privy_sid_hash, device_secret_hash, ceremony_id, factor_fingerprint, created_at, expires_at${extra ? ', revoked_at, revoke_reason' : ''})
         VALUES ($1, $2, $3, $4, 1790000000, now(), now() + interval '30 days'${extra})`,
        [userId, sid, H('d'), c],
      );
    await insert(H('e'));
    await expect(insert(H('e'))).rejects.toThrow();
    await expect(insert(H('f'), `, now(), 'because'`)).rejects.toThrow();
    await insert(H('f'), `, now(), 'forget_browser'`);
    await expect(pg.query(`UPDATE remembered_browsers SET revoke_reason = NULL WHERE privy_sid_hash = $1`, [H('f')])).rejects.toThrow();
  });

  it('a challenge names a ceremony or a row, never both, and always the sid hash and fingerprint with it', async () => {
    const c = await ceremony();
    const base = `INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at, rb_ceremony_id, rb_row_id, rb_sid_hash, rb_factor_fingerprint)
                  VALUES ($1, '0x${'1'.repeat(40)}', 'totp_signin', now() + interval '5 minutes', $2, $3, $4, $5)`;
    await pg.query(base, [userId, null, null, null, null]);
    await pg.query(base, [userId, c, null, H('a'), 1790000000]);
    await expect(pg.query(base, [userId, c, null, null, 1790000000])).rejects.toThrow();
    await expect(pg.query(base, [userId, c, null, H('a'), null])).rejects.toThrow();
    const row = (
      await pg.query<{ id: string }>(
        `INSERT INTO remembered_browsers (user_id, privy_sid_hash, device_secret_hash, ceremony_id, factor_fingerprint, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 1790000000, now(), now() + interval '30 days') RETURNING id`,
        [userId, H('a'), H('d'), c],
      )
    ).rows[0].id;
    await expect(pg.query(base, [userId, c, row, H('a'), 1790000000])).rejects.toThrow();
    await pg.query(base, [userId, null, row, H('a'), 1790000000]);
  });
});
