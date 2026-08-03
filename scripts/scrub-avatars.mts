// ----------------------------------------------------------------------------
// scripts/scrub-avatars.mts  (#189)
//
// Re-runnable scrub of non-owned `users.avatar_url` values. Legacy rows
// (pre-upload "https-only paste", migration 0004) can hold arbitrary attacker
// URLs — even ones on an attacker's OWN Vercel Blob store. The public comments
// wire already filters at read time; this NULLs them at rest so no surface can
// serve one, and cleans any legacy rows re-imported from the old DB.
//
// SAFETY (all enforced in src/lib/avatar-scrub.ts::runScrub, BEFORE/around DB
// access — this file is just wiring):
//   - FAIL CLOSED if the app Blob host can't be resolved from
//     BLOB_READ_WRITE_TOKEN.
//   - REQUIRE `--expect-host=<host>` and abort unless it EXACTLY matches the
//     token-derived host (independent cross-check that the token belongs with
//     this DB). The operator must supply the host from their OWN knowledge
//     (Vercel dashboard) — this script never suggests the derived value.
//   - TWO-STEP CONFIRM (the real gate): `--apply` requires `--confirm=<token>`
//     equal to the plan token a PRIOR dry-run printed. One command can't both
//     discover and execute a plan; a token can't be replayed against a
//     different db/host/row-set. Forces the operator to READ the breakdown
//     (their real host in the "to null" list = the wrong-host alarm) first.
//   - `--force-empty-kept` is a SECONDARY extra ack for the total-wipe case
//     (plan keeps ZERO owned); it is NOT the primary defense (a single stray
//     owned-looking row bypasses it — Codex #189 r3).
//   - DRY-RUN by default; only `--apply` (with a valid `--confirm`) writes.
//
// Invoke (needs DATABASE_URL/POSTGRES_URL + BLOB_READ_WRITE_TOKEN in env):
//   # 1. dry-run — prints the plan + a confirm token bound to it:
//   pnpm scrub:avatars -- --expect-host=<storeId>.public.blob.vercel-storage.com
//   # 2. review the "to null" host breakdown, then apply THAT exact plan:
//   pnpm scrub:avatars -- --expect-host=<host> --apply --confirm=<token-from-step-1>
// ----------------------------------------------------------------------------

// Load env files in Next.js precedence order (highest priority first), matching
// scripts/db-migrate.mts.
import { config } from 'dotenv';
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config({ path: '.env' });

import postgres from 'postgres';

import { getAppBlobPublicHost } from '../src/lib/avatar-url.js';
import {
  applyScrub,
  describeErrorSafely,
  redactDbUrl,
  runScrub,
  type AvatarRow,
  type ScrubDb,
} from '../src/lib/avatar-scrub.js';

const APPLY = process.argv.includes('--apply');
const FORCE_EMPTY_KEPT = process.argv.includes('--force-empty-kept');

const EXPECT_FLAG = '--expect-host=';
const expectArg = process.argv.find((a) => a.startsWith(EXPECT_FLAG));
// Treat an empty `--expect-host=` as absent so it can't accidentally satisfy
// the guard; a blank string would never match a real host anyway.
const expectedHost = expectArg
  ? expectArg.slice(EXPECT_FLAG.length).trim() || null
  : null;

const CONFIRM_FLAG = '--confirm=';
const confirmArg = process.argv.find((a) => a.startsWith(CONFIRM_FLAG));
// Empty `--confirm=` is treated as absent (→ confirm_required, not a false pass).
const confirmToken = confirmArg
  ? confirmArg.slice(CONFIRM_FLAG.length).trim() || null
  : null;

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error(
    'No Postgres connection string found. Set DATABASE_URL or POSTGRES_URL. See .env.local.example.',
  );
  process.exit(1);
}

// NON-SECRET routing identity of the target: the connection string with ONLY
// the userinfo password redacted (shared redactDbUrl). Everything routing-
// relevant is preserved verbatim — host LIST (postgres.js multi-host `a,b`),
// ports, database, user, and `?options`. A lossy `new URL().host+pathname`
// parse was NOT enough: it threw on multi-host URLs and dropped the query
// string, collapsing distinct targets (Codex #189 r4 MAJOR). runScrub folds
// this with the server-authoritative identify() below.
//
// FAIL CLOSED (before ANY DB access): if the string doesn't parse into a
// scheme://authority URL we can redact, abort rather than fall back to a
// placeholder identity — a collapsed identity would let a confirm token replay
// across distinct-but-unparseable targets (Codex #189 r7 MAJOR).
const redactedUrl = redactDbUrl(url);
if (!redactedUrl.ok) {
  console.error(
    'Refusing to run: could not derive a trustworthy routing identity from the\n' +
      'connection string (not a parseable scheme://user:password@host URL after\n' +
      'trimming — e.g. a stray leading control character). Fix DATABASE_URL /\n' +
      'POSTGRES_URL and retry. Failing closed here keeps a confirm token from\n' +
      'binding to an ambiguous identity that could replay across targets.',
  );
  process.exit(1);
}
const dbIdentity = redactedUrl.identity;

const appHost = getAppBlobPublicHost();

interface ResolvedRelation {
  db: string;
  schema: string;
  relation: string;
  oid: string;
}

// The connection is created HERE but only ever opened when runScrub calls it,
// which happens strictly after the guards pass — so a guard failure never
// touches the database.
function connect(): Promise<ScrubDb> {
  const sql = postgres(url!, { max: 1, prepare: false });

  // Resolve — ONCE per connection — the ACTUAL relation that the unqualified
  // name `users` maps to under the live search_path (to_regclass), and its OID.
  // current_schemas() reports the search PATH, not the resolved relation: with
  // search_path=tenant_a,public and no tenant_a.users, `users` resolves to
  // public.users, but creating tenant_a.users later silently retargets it while
  // current_schemas() is unchanged (Codex #189 r5 MAJOR). We capture the OID +
  // schema, bind them into the token via identify(), and SCHEMA-QUALIFY every
  // read/write below so nothing can re-resolve mid-run. Fails closed if `users`
  // resolves to nothing.
  let resolved: ResolvedRelation | null = null;
  async function resolveTarget(): Promise<ResolvedRelation> {
    if (resolved) return resolved;
    const [row] = (await sql`
      SELECT current_database() AS db,
             n.nspname          AS schema,
             c.relname          AS relation,
             c.oid::text        AS oid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('users')::oid
    `) as unknown as ResolvedRelation[];
    if (!row) {
      throw new Error(
        'Refusing to run: `users` does not resolve to any relation under the current ' +
          'search_path for this connection. Check DATABASE_URL / search_path.',
      );
    }
    resolved = row;
    return row;
  }

  const db: ScrubDb = {
    // Authoritative identity of the RESOLVED relation (db + schema + name + OID),
    // as structured JSON. Folded into the confirm token so a token minted while
    // `users` resolved to one table won't validate once it resolves to another
    // (different OID/schema) — the exact r5 retarget scenario.
    identify: async () => {
      const r = await resolveTarget();
      return JSON.stringify({ db: r.db, schema: r.schema, relation: r.relation, oid: r.oid });
    },
    loadRows: async () => {
      const r = await resolveTarget();
      const rows = (await sql`
        SELECT id, avatar_url FROM ${sql(r.schema)}.${sql(r.relation)}
        WHERE avatar_url IS NOT NULL
      `) as unknown as { id: string; avatar_url: string }[];
      return rows.map((x) => ({ id: x.id, avatarUrl: x.avatar_url }));
    },
    applyInTx: (toNull: readonly AvatarRow[]) =>
      sql.begin(async (tx) => {
        const r = await resolveTarget();
        // PIN the relation for the whole transaction. Caching the OID is not
        // enough: a rename/replace of schema.relation between identify() and
        // here would make the schema-qualified UPDATE resolve a look-alike
        // table BY NAME (Codex #189 r6 MINOR). Lock it (SHARE ROW EXCLUSIVE
        // blocks the ACCESS EXCLUSIVE that DROP/ALTER/RENAME need, until commit)
        // then re-read its live OID and abort if it no longer matches what
        // identify() bound the token to.
        await tx`LOCK TABLE ${tx(r.schema)}.${tx(r.relation)} IN SHARE ROW EXCLUSIVE MODE`;
        const [chk] = (await tx`
          SELECT c.oid::text AS oid
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${r.schema} AND c.relname = ${r.relation}
        `) as unknown as { oid: string }[];
        if (!chk || chk.oid !== r.oid) {
          throw new Error(
            `Aborting scrub: ${r.schema}.${r.relation} OID changed since identify() ` +
              `(was ${r.oid}, now ${chk?.oid ?? 'missing'}) — the relation was replaced mid-run.`,
          );
        }
        return applyScrub(toNull, {
          nullOne: async (id, avatarUrl) => {
            const res = await tx`
              UPDATE ${tx(r.schema)}.${tx(r.relation)} SET avatar_url = NULL
              WHERE id::text = ${id} AND avatar_url = ${avatarUrl}
            `;
            return res.count;
          },
        });
      }) as Promise<{ nulled: number; skipped: number }>,
    end: () => sql.end(),
  };
  return Promise.resolve(db);
}

function printGuardError(
  reason: 'no_host' | 'no_expected_host' | 'host_mismatch',
): void {
  if (reason === 'no_host') {
    console.error(
      'FAIL CLOSED: could not resolve the app Blob host from BLOB_READ_WRITE_TOKEN.\n' +
        'Refusing to run — without it every avatar_url would be classified non-owned\n' +
        'and nulled. Set BLOB_READ_WRITE_TOKEN (the store the target DB uploads to) and retry.',
    );
  } else if (reason === 'no_expected_host') {
    console.error(
      'Refusing to run without --expect-host. Pass the EXACT public Blob host that the\n' +
        "TARGET database's avatars live on — look it up in the Vercel dashboard for that\n" +
        'project (Storage -> your Blob store -> the *.public.blob.vercel-storage.com host).\n' +
        'Do NOT copy it from this env: the point is an INDEPENDENT check that the token\n' +
        "here belongs to the target DB's store.\n" +
        '  pnpm scrub:avatars -- --expect-host=<storeId>.public.blob.vercel-storage.com',
    );
  } else {
    // host_mismatch: the operator already committed to a value; showing both is
    // diagnostic (their token is for a different store), not a suggested answer.
    console.error(
      'ABORT: the token-derived Blob host does NOT match --expect-host.\n' +
        `  token in this env derives: ${appHost}\n` +
        `  --expect-host you passed:  ${expectedHost}\n` +
        'The BLOB_READ_WRITE_TOKEN here belongs to a different store than you expect —\n' +
        'running would misclassify avatars. Fix the env/token and retry.',
    );
  }
}

async function main() {
  const result = await runScrub({
    appHost,
    expectedHost,
    apply: APPLY,
    forceEmptyKept: FORCE_EMPTY_KEPT,
    dbIdentity,
    confirmToken,
    connect,
    log: (m) => console.log(m),
  });

  if (result.status === 'guard_failed') {
    printGuardError(result.reason);
    process.exit(1);
  }
  if (result.status === 'confirm_required') {
    // runScrub already logged how to obtain + pass the token
    console.error('Refused: --apply requires --confirm=<token> from a prior dry-run.');
    process.exit(1);
  }
  if (result.status === 'confirm_mismatch') {
    console.error(
      'Refused: --confirm did not match the current plan. Re-run a dry-run for a fresh token.',
    );
    process.exit(1);
  }
  if (result.status === 'refused_empty_kept') {
    // non-zero exit so automation/CI notices the refusal
    process.exitCode = 1;
  }
  if (result.status === 'applied' && result.remainingNonOwned !== 0) {
    console.error('WARNING: non-owned rows still present after apply.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // NEVER dump the raw error: a pg-client failure (e.g. ERR_INVALID_URL on a bad
  // port) can carry the whole connection string + password in `.input`/stack.
  console.error(describeErrorSafely(err, url));
  process.exit(1);
});
