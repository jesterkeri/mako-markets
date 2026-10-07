// The inbox-takeover gate's database and proof pieces (INBOX_GAP_PLAN r18 item 1, [J3]; build notes R18-F1), on a
// real Postgres (PGlite) with every migration in the journal applied, and real secp256k1 signatures.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbOrTx } from '@/db/client';
import * as schema from '@/db/schema';
import { readCheckpoint, recordCheckpoint } from '@/lib/privy-admission';
import { recordPrivyMismatchIn } from '@/lib/privy-mismatch';
import { checkProofSignature, consumeProofNonce, issueProofNonce } from '@/lib/privy-proof';
import { buildProofMessage, parseProofMessage, PROOF_TTL_MS } from '@/lib/privy-proof-message';

const DIR = join(__dirname, '../../db/migrations');
let pg: PGlite;
let pdb: ReturnType<typeof drizzle<typeof schema>>;
/// The PGlite driver's types differ from the app's postgres-js ones; the query builder is the same.
const asDb = (d: unknown) => d as DbOrTx;

beforeAll(async () => {
  pg = new PGlite();
  const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const e of journal.entries) {
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  pdb = drizzle(pg, { schema });
}, 60_000);

afterAll(async () => {
  await pg.close();
});

// anvil's published development key: exists only on local test chains.
const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SITE = 'makomarket.xyz';
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const NONCE = 'A'.repeat(43);

describe('migration 0013', () => {
  it('adds the four account columns and the nonce table, with their checks', async () => {
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN
       ('privy_totp_admitted_at','key_exported_at','privy_email_mismatch_at','privy_email_observed') ORDER BY 1`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['key_exported_at', 'privy_email_mismatch_at', 'privy_email_observed', 'privy_totp_admitted_at']);
    await expect(pg.query(`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at) VALUES ('short','u','0x${'a'.repeat(40)}', now())`)).rejects.toThrow();
    await expect(pg.query(`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at) VALUES ($1,'u','0xABC', now())`, [NONCE])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO users (email, magic_eoa, auth_type, privy_email_observed) VALUES ('x@y.z', '0x${'1'.repeat(40)}', 'magic', $1)`, ['a'.repeat(321)])).rejects.toThrow();
  });
});

describe('migration 0014: the enrollment checkpoint, bound to the browser', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);
  const LATER = new Date(NOW + 86_400_000);
  it('is found only by the hash of the browser secret it was recorded with, for its own Privy user, while unexpired', async () => {
    await recordCheckpoint(asDb(pdb), 'did:privy:cp1', { totpVerifiedAt: 1_791_367_000 }, H1, LATER);
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', H1, NOW)).toEqual({ totpVerifiedAt: 1_791_367_000 });
    // Another browser (another secret), no secret at all, or another Privy user: nothing.
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', H2, NOW)).toBeNull();
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', null, NOW)).toBeNull();
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp2', H1, NOW)).toBeNull();
    // Expired.
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', H1, LATER.getTime())).toBeNull();
  });
  it('is insert-only: the same hash again cannot change the row or move it to another user', async () => {
    await recordCheckpoint(asDb(pdb), 'did:privy:cp9', { totpVerifiedAt: 1_791_369_999 }, H1, LATER);
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', H1, NOW)).toEqual({ totpVerifiedAt: 1_791_367_000 });
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp9', H1, NOW)).toBeNull();
  });
  it('one Privy user can hold checkpoints from several browsers (each saw no wallet yet)', async () => {
    await recordCheckpoint(asDb(pdb), 'did:privy:cp1', { totpVerifiedAt: 1_791_367_500 }, H2, LATER);
    expect(await readCheckpoint(asDb(pdb), 'did:privy:cp1', H2, NOW)).toEqual({ totpVerifiedAt: 1_791_367_500 });
  });
  it('rejects a malformed hash, an empty Privy user id and a non-positive authenticator time', async () => {
    const exp = new Date(NOW).toISOString();
    await expect(pg.query(`INSERT INTO privy_enrollment_checkpoints (token_hash, privy_user_id, totp_verified_at, expires_at) VALUES ('raw-secret','u',5,$1)`, [exp])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO privy_enrollment_checkpoints (token_hash, privy_user_id, totp_verified_at, expires_at) VALUES ($1,'',5,$2)`, ['c'.repeat(64), exp])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO privy_enrollment_checkpoints (token_hash, privy_user_id, totp_verified_at, expires_at) VALUES ($1,'u',0,$2)`, ['d'.repeat(64), exp])).rejects.toThrow();
  });
});

describe('proof nonces', () => {
  it('are consumed once, only by their own Privy user and wallet, and only before they expire', async () => {
    const wallet = OWNER.address;
    const n1 = await issueProofNonce(asDb(pdb), 'did:privy:a', wallet, NOW);
    expect(n1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await consumeProofNonce(asDb(pdb), { nonce: n1, privyUserId: 'did:privy:b', wallet, nowMs: NOW })).toBe(false);
    expect(await consumeProofNonce(asDb(pdb), { nonce: n1, privyUserId: 'did:privy:a', wallet: OTHER.address, nowMs: NOW })).toBe(false);
    expect(await consumeProofNonce(asDb(pdb), { nonce: n1, privyUserId: 'did:privy:a', wallet, nowMs: NOW })).toBe(true);
    expect(await consumeProofNonce(asDb(pdb), { nonce: n1, privyUserId: 'did:privy:a', wallet, nowMs: NOW })).toBe(false);
    const n2 = await issueProofNonce(asDb(pdb), 'did:privy:a', wallet, NOW);
    expect(await consumeProofNonce(asDb(pdb), { nonce: n2, privyUserId: 'did:privy:a', wallet, nowMs: NOW + PROOF_TTL_MS })).toBe(false);
  });
});

describe('recording a C4 mismatch (R18-F1: one transaction)', () => {
  async function account(email: string) {
    const [u] = await pdb.insert(schema.users).values({ email, magicEoa: `0x${email.length.toString(16).padStart(40, '0')}`, authType: 'magic' }).returning();
    const exp = new Date(NOW + 86_400_000);
    await pdb.insert(schema.sessions).values([{ userId: u.id, expiresAt: exp }, { userId: u.id, expiresAt: exp }]);
    return u.id;
  }
  const sessionCount = async (id: string) => (await pg.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [id])).rows[0] as { n: number };
  const audit = async (id: string) =>
    (await pg.query(`SELECT privy_email_mismatch_at AS at, privy_email_observed AS obs FROM users WHERE id = $1`, [id])).rows[0] as { at: Date | null; obs: string | null };

  it('writes the first detection and deletes every session; a later detection keeps the first', async () => {
    const id = await account('owner1@example.com');
    await pdb.transaction((tx) => recordPrivyMismatchIn(asDb(tx), id, 'attacker@example.com'));
    expect((await sessionCount(id)).n).toBe(0);
    const first = await audit(id);
    expect(first.at).not.toBeNull();
    expect(first.obs).toBe('attacker@example.com');
    await pdb.transaction((tx) => recordPrivyMismatchIn(asDb(tx), id, 'second@example.com'));
    const again = await audit(id);
    expect(again.at?.getTime()).toBe(first.at?.getTime());
    expect(again.obs).toBe('attacker@example.com');
  });

  it('a failure after the record rolls back BOTH the audit and the session deletion', async () => {
    const id = await account('owner22@example.com');
    await expect(
      pdb.transaction(async (tx) => {
        await recordPrivyMismatchIn(asDb(tx), id, 'attacker@example.com');
        throw new Error('forced failure after the record');
      }),
    ).rejects.toThrow('forced failure');
    expect((await sessionCount(id)).n).toBe(2);
    expect((await audit(id)).at).toBeNull();
  });

  it('bounds an attacker-chosen observed email to 320 characters', async () => {
    const id = await account('owner333@example.com');
    await pdb.transaction((tx) => recordPrivyMismatchIn(asDb(tx), id, `${'x'.repeat(400)}@example.com`));
    expect((await audit(id)).obs?.length).toBe(320);
  });
});

describe('the proof message and signature', () => {
  const issued = new Date(NOW - 30_000);
  const msg = buildProofMessage(SITE, NONCE, issued);

  it('round-trips, and parsing is exact', () => {
    expect(parseProofMessage(msg)).toEqual({ site: SITE, nonce: NONCE, issued });
    expect(parseProofMessage(`${msg}\n`)).toBeNull();
    expect(parseProofMessage(msg.replace('Mako Market sign-in', 'Mako sign-in'))).toBeNull();
    expect(parseProofMessage(msg.replace(NONCE, 'A'.repeat(42)))).toBeNull();
    expect(() => buildProofMessage(SITE, 'not-a-nonce', issued)).toThrow();
  });

  it('a signature by the session wallet over this site and a fresh message passes, and names its nonce', async () => {
    const signature = await OWNER.signMessage({ message: msg });
    expect(await checkProofSignature({ message: msg, signature, wallet: OWNER.address, site: SITE, nowMs: NOW })).toEqual({ ok: true, nonce: NONCE });
  });

  it('another signer, another site, a stale or future message, or a tampered message is refused', async () => {
    const signature = await OWNER.signMessage({ message: msg });
    const check = (o: Partial<Parameters<typeof checkProofSignature>[0]>) =>
      checkProofSignature({ message: msg, signature, wallet: OWNER.address, site: SITE, nowMs: NOW, ...o }).then((r) => (r.ok ? 'ok' : r.reason));
    expect(await check({ wallet: OTHER.address })).toBe('wrong_signer');
    expect(await check({ site: 'evil.example' })).toBe('wrong_site');
    expect(await check({ nowMs: NOW + PROOF_TTL_MS })).toBe('stale');
    expect(await check({ nowMs: issued.getTime() - 61_000 })).toBe('stale');
    expect(await check({ message: msg.replace(NONCE, 'B'.repeat(43)) })).toBe('wrong_signer');
    expect(await check({ signature: '0x1234' })).toBe('bad_signature');
  });

  it('a signature over a 32-byte hash (what a taken-over server would ask for) is not a proof [B2]', async () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const signature = await OWNER.signMessage({ message: { raw: hash } });
    expect((await checkProofSignature({ message: hash, signature, wallet: OWNER.address, site: SITE, nowMs: NOW })).ok).toBe(false);
  });
});
