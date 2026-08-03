import { describe, it, expect } from 'vitest';

import { isAppOwnedAvatarUrlForHost } from '@/lib/avatar-url';
import {
  planAvatarScrub,
  hostBreakdown,
  planFingerprint,
  redactDbUrl,
  describeErrorSafely,
  checkScrubGuards,
  applyScrub,
  runScrub,
  type AvatarRow,
  type ScrubDb,
  type ScrubRunnerDeps,
} from '@/lib/avatar-scrub';

// #189 avatar scrub — the planner must keep ONLY avatars this app produced
// (exact store host + this user's own /avatars/<id>/ path + https) and flag
// every legacy / attacker-controlled URL for nulling. It shares the exact rule
// the public comments filter uses (isAppOwnedAvatarUrlForHost), so these cases
// double as a guard that the shared rule doesn't drift.
//
// `rows` mirrors `SELECT id, avatar_url FROM users`: `id` is the users PK, so
// every row carries a DISTINCT id (a user has at most one avatar_url).

const HOST = 'store123.public.blob.vercel-storage.com';

// distinct uuids, one per row (users.id is unique)
const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const owned = (userId: string) => `https://${HOST}/avatars/${userId}/pic.webp`;

describe('isAppOwnedAvatarUrlForHost', () => {
  const A = id(1);
  const B = id(2);

  it('accepts this app host + this user path + https', () => {
    expect(isAppOwnedAvatarUrlForHost(owned(A), A, HOST)).toBe(true);
  });

  it('accepts a host in different casing (hostnames are case-insensitive)', () => {
    const upper = `https://${HOST.toUpperCase()}/avatars/${A}/pic.webp`;
    expect(isAppOwnedAvatarUrlForHost(upper, A, HOST)).toBe(true);
  });

  it("rejects an attacker's OWN blob store (any-tenant is not enough)", () => {
    const attacker = `https://attacker.public.blob.vercel-storage.com/avatars/${A}/pic.webp`;
    expect(isAppOwnedAvatarUrlForHost(attacker, A, HOST)).toBe(false);
  });

  it("rejects another user's path on the app host (BOLA)", () => {
    const foreignPath = `https://${HOST}/avatars/${B}/pic.webp`;
    expect(isAppOwnedAvatarUrlForHost(foreignPath, A, HOST)).toBe(false);
  });

  it('rejects non-https', () => {
    expect(isAppOwnedAvatarUrlForHost(`http://${HOST}/avatars/${A}/x.webp`, A, HOST)).toBe(false);
  });

  it('rejects an arbitrary third-party host', () => {
    expect(isAppOwnedAvatarUrlForHost('https://evil.example/pic.png', A, HOST)).toBe(false);
  });

  it('rejects an unparseable url without throwing', () => {
    expect(isAppOwnedAvatarUrlForHost('not a url', A, HOST)).toBe(false);
  });
});

describe('planAvatarScrub', () => {
  it('keeps owned rows and flags every non-owned row', () => {
    const rows: AvatarRow[] = [
      { id: id(1), avatarUrl: owned(id(1)) }, // owned → keep
      { id: id(2), avatarUrl: owned(id(2)) }, // owned → keep
      { id: id(3), avatarUrl: 'https://evil.example/x.png' }, // foreign host → null
      { id: id(4), avatarUrl: `https://attacker.public.blob.vercel-storage.com/avatars/${id(4)}/x.webp` }, // attacker store → null
      { id: id(5), avatarUrl: `https://${HOST}/avatars/${id(99)}/x.webp` }, // foreign path → null
      { id: id(6), avatarUrl: `http://${HOST}/avatars/${id(6)}/x.webp` }, // non-https → null
      { id: id(7), avatarUrl: 'garbage' }, // unparseable → null
    ];
    const plan = planAvatarScrub(rows, HOST);
    expect(plan.keptOwned).toBe(2);
    expect(plan.toNull).toHaveLength(5);
    expect(plan.toNull.map((r) => r.id)).toEqual([id(3), id(4), id(5), id(6), id(7)]);
  });

  it('flags EVERYTHING against an empty host (why the runner must fail closed)', () => {
    const rows: AvatarRow[] = [
      { id: id(1), avatarUrl: owned(id(1)) },
      { id: id(2), avatarUrl: owned(id(2)) },
    ];
    const plan = planAvatarScrub(rows, '');
    expect(plan.keptOwned).toBe(0);
    expect(plan.toNull).toHaveLength(2);
  });

  it('has nothing to do on an all-owned set', () => {
    const rows: AvatarRow[] = [{ id: id(1), avatarUrl: owned(id(1)) }];
    expect(planAvatarScrub(rows, HOST).toNull).toHaveLength(0);
  });
});

describe('hostBreakdown', () => {
  it('counts to-null rows per hostname, and never the kept (owned) rows', () => {
    const rows: AvatarRow[] = [
      { id: id(1), avatarUrl: owned(id(1)) }, // kept — must NOT appear in the breakdown
      { id: id(2), avatarUrl: 'https://evil.example/1.png' },
      { id: id(3), avatarUrl: 'https://evil.example/2.png' },
      { id: id(4), avatarUrl: 'https://tracker.test/3.gif' },
      { id: id(5), avatarUrl: 'garbage' },
    ];
    const plan = planAvatarScrub(rows, HOST);
    const breakdown = hostBreakdown(plan.toNull);
    expect(breakdown.get('evil.example')).toBe(2);
    expect(breakdown.get('tracker.test')).toBe(1);
    expect(breakdown.get('<unparseable>')).toBe(1);
    // the owned row's host must NOT appear (it was kept, not flagged)
    expect(breakdown.has(HOST)).toBe(false);
  });
});

describe('planFingerprint (binds the --confirm token to db + host + exact plan)', () => {
  const base = {
    dbIdentity: 'ep-x.region.aws.neon.tech/appdb',
    appHost: HOST,
    keptOwned: 2,
    toNull: [
      { id: id(1), avatarUrl: 'https://evil.example/a.png' },
      { id: id(2), avatarUrl: 'https://evil.example/b.png' },
    ] as AvatarRow[],
  };

  it('is deterministic for the same plan', () => {
    expect(planFingerprint(base)).toBe(planFingerprint(base));
  });

  it('is independent of the order rows arrive in (sorted internally)', () => {
    expect(planFingerprint({ ...base, toNull: [...base.toNull].reverse() })).toBe(
      planFingerprint(base),
    );
  });

  it('changes when a to-null url changes (bound to the exact CAS target)', () => {
    const changed: AvatarRow[] = [
      { id: id(1), avatarUrl: 'https://evil.example/DIFFERENT.png' },
      base.toNull[1],
    ];
    expect(planFingerprint({ ...base, toNull: changed })).not.toBe(planFingerprint(base));
  });

  it('changes when the app host changes', () => {
    expect(
      planFingerprint({ ...base, appHost: 'other.public.blob.vercel-storage.com' }),
    ).not.toBe(planFingerprint(base));
  });

  it('changes when the target db identity changes (no cross-db replay)', () => {
    expect(planFingerprint({ ...base, dbIdentity: 'ep-x.region.aws.neon.tech/OTHERdb' })).not.toBe(
      planFingerprint(base),
    );
  });

  it('changes when keptOwned changes', () => {
    expect(planFingerprint({ ...base, keptOwned: 3 })).not.toBe(planFingerprint(base));
  });

  it('is UNAMBIGUOUS when a legacy url embeds tab/newline separators (Codex r4)', () => {
    const prod = 'https://prodstore.public.blob.vercel-storage.com/avatars/x/p.webp';
    const legacy = 'https://evil.example/legacy.png';
    const other = 'https://evil.example/other.png';
    // Plan A: id(1)'s url embeds "\n<id2>\t<prod>" — under a raw "id\turl\n…"
    // join this streamed identically to Plan B, colliding the fingerprints.
    const planA = {
      dbIdentity: 'db',
      appHost: HOST,
      keptOwned: 1,
      toNull: [
        { id: id(1), avatarUrl: `not a url\n${id(2)}\t${prod}` },
        { id: id(3), avatarUrl: legacy },
        { id: id(4), avatarUrl: other },
      ] as AvatarRow[],
    };
    // Plan B: the SAME bytes split across different record boundaries — a
    // genuinely different plan (its breakdown contains the prod host).
    const planB = {
      dbIdentity: 'db',
      appHost: HOST,
      keptOwned: 1,
      toNull: [
        { id: id(1), avatarUrl: 'not a url' },
        { id: id(2), avatarUrl: prod },
        { id: id(3), avatarUrl: `${legacy}\n${id(4)}\t${other}` },
      ] as AvatarRow[],
    };
    expect(planFingerprint(planA)).not.toBe(planFingerprint(planB));
  });
});

describe('redactDbUrl (password-only redaction of the routing identity)', () => {
  // ok:true → the identity string; throws if the input was rejected. Used for
  // the redaction cases; the rejection cases assert the { ok:false } result.
  const ident = (u: string): string => {
    const r = redactDbUrl(u);
    if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(u)}, got ${r.reason}`);
    return r.identity;
  };

  it('redacts a simple userinfo password', () => {
    expect(ident('postgres://user:secretpass@host:5432/app')).toBe(
      'postgres://user:<redacted>@host:5432/app',
    );
  });

  it('redacts a password containing a LITERAL @ (userinfo ends at the LAST @) — Codex r5', () => {
    // postgres.js reads the password as "@secret"; anchoring on the FIRST @
    // leaked it. Must redact through the last @ of the authority.
    const out = ident('postgres://u:@secret@host/db');
    expect(out).toBe('postgres://u:<redacted>@host/db');
    expect(out).not.toContain('secret');
  });

  it('redacts a %40-encoded password', () => {
    const out = ident('postgres://u:p%40ss@host/db');
    expect(out).toBe('postgres://u:<redacted>@host/db');
    expect(out).not.toContain('p%40ss');
  });

  it('preserves a multi-host authority verbatim (postgres.js `a,b`)', () => {
    expect(ident('postgres://u:secretpass@a:5432,b:5432/app')).toBe(
      'postgres://u:<redacted>@a:5432,b:5432/app',
    );
  });

  it('preserves ?options (search_path) so distinct tenants stay distinct', () => {
    const a = ident('postgres://u:p@host/app?options=-csearch_path%3Dtenant_a');
    const b = ident('postgres://u:p@host/app?options=-csearch_path%3Dtenant_b');
    expect(a).not.toBe(b);
    expect(a).not.toContain(':p@');
  });

  it('preserves a username that itself contains @, redacting only the password', () => {
    expect(ident('postgres://u@ser:secretpass@host/db')).toBe(
      'postgres://u@ser:<redacted>@host/db',
    );
  });

  it('preserves an IPv6 host', () => {
    expect(ident('postgres://u:p@[::1]:5432/db')).toBe('postgres://u:<redacted>@[::1]:5432/db');
  });

  it('leaves a password-less URL unchanged', () => {
    expect(ident('postgres://user@host/db')).toBe('postgres://user@host/db');
    expect(ident('postgres://host:5432/db')).toBe('postgres://host:5432/db');
  });

  it('handles an uppercase scheme', () => {
    expect(ident('POSTGRES://u:secretpass@host/db')).toBe('POSTGRES://u:<redacted>@host/db');
  });

  it('redacts despite leading/trailing whitespace the client tolerates (Codex r6)', () => {
    for (const ws of ['  ', '\t', '\r\n', '\n', ' \t ']) {
      const out = ident(`${ws}postgres://u:secretpass@host/db${ws}`);
      expect(out).toBe('postgres://u:<redacted>@host/db');
      expect(out).not.toContain('secretpass');
    }
  });

  it('FAILS CLOSED (ok:false) on a non-URL string carrying userinfo — never echoes a password', () => {
    expect(redactDbUrl('user:secretpass@host/db')).toEqual({ ok: false, reason: 'unredactable' });
  });

  it('FAILS CLOSED (ok:false) on a C0-control prefix trim() cannot strip (Codex r7)', () => {
    // postgres.js accepts a leading U+0001–U+0008 / U+000E–U+001F, but String
    // .trim() leaves them (they are NOT whitespace), so the URL does not parse →
    // must NOT collapse to a shared placeholder identity (which would let a
    // token replay across distinct C0-prefixed cloned targets). Abort instead.
    for (const code of [0x01, 0x04, 0x08, 0x0e, 0x1f]) {
      const r = redactDbUrl(`${String.fromCharCode(code)}postgres://u:secretpass@host/db`);
      expect(r).toEqual({ ok: false, reason: 'unredactable' });
    }
  });
});

describe('describeErrorSafely (never logs the DB password) — Codex r8', () => {
  const url = 'postgres://u:SYNTHETIC_SECRET@host:5432/db';

  it('does NOT surface an ERR_INVALID_URL `.input` (raw error object is never dumped)', () => {
    // new URL() on a bad port throws with `.input` = the raw connection string.
    const e = Object.assign(new TypeError('Invalid URL'), {
      code: 'ERR_INVALID_URL',
      input: url,
    });
    const out = describeErrorSafely(e, url);
    expect(out).not.toContain('SYNTHETIC_SECRET');
    expect(out).toContain('ERR_INVALID_URL');
    expect(out).toContain('Invalid URL');
  });

  it('scrubs the connection string when it appears in the message', () => {
    const out = describeErrorSafely(new Error(`failed to connect to ${url}`), url);
    expect(out).not.toContain('SYNTHETIC_SECRET');
    expect(out).toContain('Error');
  });

  it('scrubs the bare password token, not just the full URL', () => {
    const out = describeErrorSafely(new Error('auth failed: password SYNTHETIC_SECRET rejected'), url);
    expect(out).not.toContain('SYNTHETIC_SECRET');
  });

  it('scrubs a non-Error throw too', () => {
    const out = describeErrorSafely(`boom ${url}`, url);
    expect(out).not.toContain('SYNTHETIC_SECRET');
    expect(out).toContain('Non-Error thrown');
  });

  it('handles a password containing a literal @ (userinfo ends at the LAST @)', () => {
    const u2 = 'postgres://user:@weird@host/db';
    const out = describeErrorSafely(new Error(`bad password @weird here`), u2);
    expect(out).not.toContain('@weird');
  });

  it('scrubs the DECODED form of a percent-encoded password (postgres.js decodes it) — Codex r9', () => {
    // stored as p%40ss, but the client uses the decoded credential p@ss; a
    // backend/proxy error echoing the effective password must still be masked.
    const u3 = 'postgres://u:p%40ss@host/db';
    const out = describeErrorSafely(new Error('auth failed: password p@ss rejected'), u3);
    expect(out).not.toContain('p@ss');
  });
});

describe('checkScrubGuards (safety gate before any DB write)', () => {
  it('rejects when the app host cannot be resolved (no/garbled token)', () => {
    expect(checkScrubGuards(null, HOST)).toEqual({ ok: false, reason: 'no_host' });
  });

  it('rejects when the operator did not supply --expect-host', () => {
    expect(checkScrubGuards(HOST, null)).toEqual({
      ok: false,
      reason: 'no_expected_host',
    });
  });

  it('rejects a valid-but-WRONG token (derived host != expected) — the #189 MAJOR', () => {
    // e.g. a dev token exported next to a prod DATABASE_URL derives the dev host
    const derivedDevHost = 'devstore.public.blob.vercel-storage.com';
    expect(checkScrubGuards(derivedDevHost, HOST)).toEqual({
      ok: false,
      reason: 'host_mismatch',
    });
  });

  it('passes only when derived host matches expected (case-insensitive, trimmed)', () => {
    expect(checkScrubGuards(HOST, `  ${HOST.toUpperCase()}  `)).toEqual({
      ok: true,
      appHost: HOST,
    });
  });
});

describe('applyScrub (CAS accounting)', () => {
  const flagged: AvatarRow[] = [
    { id: id(1), avatarUrl: 'https://evil.example/a.png' },
    { id: id(2), avatarUrl: 'https://evil.example/b.png' },
    { id: id(3), avatarUrl: 'https://evil.example/c.png' },
  ];

  it('nulls every flagged row when each CAS matches, calling nullOne with (id, url)', async () => {
    const seen: Array<[string, string]> = [];
    const res = await applyScrub(flagged, {
      nullOne: async (rowId, url) => {
        seen.push([rowId, url]);
        return 1;
      },
    });
    expect(res).toEqual({ nulled: 3, skipped: 0 });
    expect(seen).toEqual(flagged.map((r) => [r.id, r.avatarUrl]));
  });

  it('counts CAS skips when a row changed since the read (0 rows affected)', async () => {
    const res = await applyScrub(flagged, {
      // id(2) "changed" between read and write → 0 affected → skipped, not nulled
      nullOne: async (rowId) => (rowId === id(2) ? 0 : 1),
    });
    expect(res).toEqual({ nulled: 2, skipped: 1 });
  });

  it('does nothing (no DB calls) on an empty flagged set', async () => {
    let calls = 0;
    const res = await applyScrub([], {
      nullOne: async () => {
        calls++;
        return 1;
      },
    });
    expect(res).toEqual({ nulled: 0, skipped: 0 });
    expect(calls).toBe(0);
  });
});

describe('runScrub (orchestration — the destructive path)', () => {
  const DB_ID = 'ep-test.region.aws.neon.tech/appdb';
  const ownedRow = (n: number): AvatarRow => ({ id: id(n), avatarUrl: owned(id(n)) });
  const foreignRow = (n: number): AvatarRow => ({
    id: id(n),
    avatarUrl: `https://evil.example/${n}.png`,
  });

  function makeRun(opts: {
    rows: AvatarRow[];
    appHost?: string | null;
    expectedHost?: string | null;
    apply?: boolean;
    forceEmptyKept?: boolean;
    confirmToken?: string | null;
    dbIdentity?: string;
    resolvedIdentity?: string;
  }) {
    const calls = { connect: 0, identify: 0, loadRows: 0, applyInTx: 0, end: 0 };
    const appliedWith: AvatarRow[][] = [];
    const deps: ScrubRunnerDeps = {
      appHost: opts.appHost === undefined ? HOST : opts.appHost,
      expectedHost: opts.expectedHost === undefined ? HOST : opts.expectedHost,
      apply: opts.apply ?? false,
      forceEmptyKept: opts.forceEmptyKept ?? false,
      dbIdentity: opts.dbIdentity ?? DB_ID,
      confirmToken: opts.confirmToken ?? null,
      connect: async () => {
        calls.connect++;
        const db: ScrubDb = {
          identify: async () => {
            calls.identify++;
            return (
              opts.resolvedIdentity ??
              JSON.stringify({ db: 'appdb', schema: 'public', relation: 'users', oid: '16400' })
            );
          },
          loadRows: async () => {
            calls.loadRows++;
            return opts.rows;
          },
          applyInTx: async (toNull) => {
            calls.applyInTx++;
            appliedWith.push([...toNull]);
            return { nulled: toNull.length, skipped: 0 };
          },
          end: async () => {
            calls.end++;
          },
        };
        return db;
      },
      log: () => {},
    };
    return { deps, calls, appliedWith };
  }

  // Run the two-step flow as an operator would: dry-run to obtain the token
  // bound to this exact db/host/plan, then return it for a real --apply.
  async function tokenFor(opts: Parameters<typeof makeRun>[0]): Promise<string> {
    const { deps } = makeRun({ ...opts, apply: false });
    const res = await runScrub(deps);
    if (res.status !== 'dry_run') throw new Error(`expected dry_run, got ${res.status}`);
    return res.fingerprint;
  }

  it('a missing --expect-host guard failure NEVER connects to the DB', async () => {
    const { deps, calls } = makeRun({ rows: [foreignRow(1)], expectedHost: null });
    const res = await runScrub(deps);
    expect(res).toEqual({ status: 'guard_failed', reason: 'no_expected_host' });
    expect(calls.connect).toBe(0);
    expect(calls.loadRows).toBe(0);
    expect(calls.applyInTx).toBe(0);
  });

  it('a wrong-store token (host_mismatch) NEVER connects — the #189 r1 MAJOR', async () => {
    const { deps, calls } = makeRun({
      rows: [foreignRow(1)],
      appHost: 'devstore.public.blob.vercel-storage.com',
      expectedHost: HOST,
    });
    const res = await runScrub(deps);
    expect(res).toEqual({ status: 'guard_failed', reason: 'host_mismatch' });
    expect(calls.connect).toBe(0);
  });

  it('dry run reads, emits a plan token, never applies, and closes the connection', async () => {
    const { deps, calls } = makeRun({ rows: [ownedRow(1), foreignRow(2)], apply: false });
    const res = await runScrub(deps);
    expect(res.status).toBe('dry_run');
    if (res.status === 'dry_run') expect(res.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(calls.loadRows).toBe(1);
    expect(calls.applyInTx).toBe(0);
    expect(calls.end).toBe(1);
  });

  it('REFUSES --apply with NO confirm token — never writes (the r3 gate)', async () => {
    const { deps, calls } = makeRun({ rows: [ownedRow(1), foreignRow(2)], apply: true });
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_required');
    expect(calls.applyInTx).toBe(0);
    expect(calls.end).toBe(1); // still cleaned up
  });

  it('REFUSES --apply with a WRONG confirm token — never writes', async () => {
    const { deps, calls } = makeRun({
      rows: [ownedRow(1), foreignRow(2)],
      apply: true,
      confirmToken: 'deadbeefdeadbeef',
    });
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_mismatch');
    expect(calls.applyInTx).toBe(0);
  });

  it('REJECTS a token minted for a DIFFERENT row set (bound to the plan)', async () => {
    // token computed for a single foreign row, then replayed against two
    const stale = await tokenFor({ rows: [foreignRow(1)] });
    const { deps, calls } = makeRun({
      rows: [foreignRow(1), foreignRow(2)],
      apply: true,
      confirmToken: stale,
    });
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_mismatch');
    expect(calls.applyInTx).toBe(0);
  });

  it('REJECTS a token minted against a DIFFERENT routing string (bound to db identity)', async () => {
    const rows = [ownedRow(1), foreignRow(2)];
    const otherDbToken = await tokenFor({ rows, dbIdentity: 'ep-other.region.aws.neon.tech/otherdb' });
    const { deps, calls } = makeRun({
      rows,
      apply: true,
      dbIdentity: 'ep-prod.region.aws.neon.tech/proddb',
      confirmToken: otherDbToken,
    });
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_mismatch');
    expect(calls.applyInTx).toBe(0);
  });

  it('REJECTS a token when `users` resolves to a DIFFERENT relation — same URL, new OID/schema (Codex r5)', async () => {
    const rows = [ownedRow(1), foreignRow(2)];
    // Identical routing string, but the live connection resolves `users` to a
    // different relation (e.g. a tenant_a.users created after the dry-run, or a
    // drop+recreate → new OID). identify() reports the resolved relation, so the
    // token minted against public.users must NOT validate against tenant_a.users.
    const publicUsers = JSON.stringify({ db: 'appdb', schema: 'public', relation: 'users', oid: '16400' });
    const tenantUsers = JSON.stringify({ db: 'appdb', schema: 'tenant_a', relation: 'users', oid: '17777' });
    const tokenForPublic = await tokenFor({ rows, resolvedIdentity: publicUsers });
    const { deps, calls } = makeRun({
      rows,
      apply: true,
      resolvedIdentity: tenantUsers,
      confirmToken: tokenForPublic,
    });
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_mismatch');
    expect(calls.applyInTx).toBe(0);
  });

  it('applies ONLY the non-owned rows once confirmed with the dry-run token', async () => {
    const rows = [ownedRow(1), foreignRow(2)];
    const token = await tokenFor({ rows });
    const { deps, calls, appliedWith } = makeRun({ rows, apply: true, confirmToken: token });
    const res = await runScrub(deps);
    expect(res.status).toBe('applied');
    expect(calls.applyInTx).toBe(1);
    expect(appliedWith[0].map((r) => r.id)).toEqual([id(2)]);
  });

  it('STILL refuses a confirmed --apply that keeps ZERO owned unless forced', async () => {
    const rows = [foreignRow(1), foreignRow(2)];
    const token = await tokenFor({ rows });
    const { deps, calls } = makeRun({ rows, apply: true, confirmToken: token });
    const res = await runScrub(deps);
    expect(res.status).toBe('refused_empty_kept');
    expect(calls.applyInTx).toBe(0);
    expect(calls.end).toBe(1);
  });

  it('--force-empty-kept + a valid token overrides the zero-kept refusal', async () => {
    const rows = [foreignRow(1)];
    const token = await tokenFor({ rows });
    const { deps, calls } = makeRun({ rows, apply: true, forceEmptyKept: true, confirmToken: token });
    const res = await runScrub(deps);
    expect(res.status).toBe('applied');
    expect(calls.applyInTx).toBe(1);
  });

  it('reports nothing_to_scrub (no apply, no token needed) when every row is owned', async () => {
    const { deps, calls } = makeRun({ rows: [ownedRow(1)], apply: true });
    const res = await runScrub(deps);
    expect(res.status).toBe('nothing_to_scrub');
    expect(calls.applyInTx).toBe(0);
  });
});

// Codex #189 r3 MAJOR: the r2 `keptOwned > 0` empty-kept guard is defeated by a
// single stray owned-looking row (legacy rows are arbitrary, so a prod DB can
// hold one dev-store URL on the user's own path). With a wrong-but-consistent
// (dev token, --expect-host=dev) pair, keptOwned becomes 1 and the empty-kept
// refusal is bypassed — the r2 code would have wiped the REAL prod avatars. The
// r3 fix is the two-step confirm token: --apply can't proceed without the
// operator running a dry-run (seeing their prod host in the "to null" list) and
// authorizing that exact plan.
describe('runScrub — Codex #189 r3 mixed-host regression', () => {
  const DB_ID = 'ep-prod.region.aws.neon.tech/proddb';
  const PROD = 'prodstore.public.blob.vercel-storage.com';
  const DEV = 'devstore.public.blob.vercel-storage.com';

  // Real prod avatars on the PROD store + ONE stale dev-store row on the same
  // user's own path (e.g. imported test data). Operator MISTAKENLY runs with the
  // DEV token, so appHost === DEV.
  const rows: AvatarRow[] = [
    { id: id(1), avatarUrl: `https://${PROD}/avatars/${id(1)}/pic.webp` },
    { id: id(2), avatarUrl: `https://${PROD}/avatars/${id(2)}/pic.webp` },
    { id: id(3), avatarUrl: `https://${DEV}/avatars/${id(3)}/pic.webp` }, // stray owned-looking
  ];

  function make(opts: { apply?: boolean; confirmToken?: string | null }) {
    const calls = { connect: 0, loadRows: 0, applyInTx: 0, end: 0 };
    const appliedWith: AvatarRow[][] = [];
    const deps: ScrubRunnerDeps = {
      appHost: DEV,
      expectedHost: DEV,
      apply: opts.apply ?? false,
      forceEmptyKept: false,
      dbIdentity: DB_ID,
      confirmToken: opts.confirmToken ?? null,
      connect: async () => {
        calls.connect++;
        return {
          identify: async () =>
            JSON.stringify({ db: 'proddb', schema: 'public', relation: 'users', oid: '16400' }),
          loadRows: async () => {
            calls.loadRows++;
            return rows;
          },
          applyInTx: async (toNull) => {
            calls.applyInTx++;
            appliedWith.push([...toNull]);
            return { nulled: toNull.length, skipped: 0 };
          },
          end: async () => {
            calls.end++;
          },
        } satisfies ScrubDb;
      },
      log: () => {},
    };
    return { deps, calls, appliedWith };
  }

  it('a single stray owned row makes keptOwned=1 — the r2 empty-kept guard would be BYPASSED', () => {
    const plan = planAvatarScrub(rows, DEV);
    expect(plan.keptOwned).toBe(1); // the stray dev row
    expect(plan.toNull.map((r) => r.id)).toEqual([id(1), id(2)]); // the REAL prod avatars
  });

  it("the dry-run surfaces the operator's REAL prod host in the 'to null' breakdown (the alarm)", () => {
    expect(hostBreakdown(planAvatarScrub(rows, DEV).toNull).get(PROD)).toBe(2);
  });

  it('r3 fix: --apply is REFUSED without a confirm token — prod avatars are NOT wiped', async () => {
    const { deps, calls } = make({ apply: true }); // keptOwned=1, but no token
    const res = await runScrub(deps);
    expect(res.status).toBe('confirm_required');
    expect(calls.applyInTx).toBe(0);
  });

  it('accepted residual: an operator who dry-runs then confirms the exact token CAN still apply', async () => {
    // Deliberate residual — the token forces review; it cannot PROVE the host is
    // right (no authoritative store metadata exists). This documents the bound.
    const dry = make({ apply: false });
    const dryRes = await runScrub(dry.deps);
    if (dryRes.status !== 'dry_run') throw new Error(`expected dry_run, got ${dryRes.status}`);

    const wet = make({ apply: true, confirmToken: dryRes.fingerprint });
    const res = await runScrub(wet.deps);
    expect(res.status).toBe('applied');
    expect(wet.appliedWith[0].map((r) => r.id)).toEqual([id(1), id(2)]);
  });
});
