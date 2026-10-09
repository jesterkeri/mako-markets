#!/usr/bin/env node
// ----------------------------------------------------------------------------
// scripts/provision-stats-role.mjs
//
// Creates or re-keys the /stats read-only login `mako_stats_reader` on ONE Neon database, proves what it can and cannot
// do, and only if every check passes stores its direct connection string as STATS_DATABASE_URL in Vercel. Run by the
// operator from a clean checkout of the reviewed commit. Never prints a secret: the owner's and the new login's
// connection strings live only in this process and the Vercel CLI's stdin; diagnostics are codes and counts.
//
//   node scripts/provision-stats-role.mjs --neon-project <id> --expect-commit <sha> \
//        --target preview --git-branch feat/inbox-fix        # or --target production, or --target none (no Vercel write)
//   --neon-branch <name> runs against a scratch Neon branch (with --target none only), for the refusal proofs.
//
// Gates, all fail-closed (Codex RELEASE_R9 #2 to #4):
//   * checkout: HEAD is --expect-commit and the tree is clean, checked before the password exists and again before the
//     Vercel write; Postgres and Vercel run from this checkout; the Vercel project and team are pinned to the IDs below.
//   * role: every restrictive attribute set on create AND re-key; a role that owns anything is refused before re-key;
//     effective privileges (has_*_privilege, so grants to PUBLIC count) checked over every table, view, column,
//     sequence, schema, SECURITY DEFINER function and every database in the cluster, not only the role's grant rows.
//   * behaviour, from separate processes: two connect, a third is refused (53300), a read works after one closes;
//     other tables and writes refused; a 6 s query cut at 5 s.
//   * TLS: verify-full succeeds against the endpoint and a wrong server name is refused (ERR_TLS_CERT_ALTNAME_INVALID).
// ----------------------------------------------------------------------------

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const postgres = require('postgres');

/// The one Vercel project this login may be stored in (mako-markets, team jesterkeri). Not secrets.
const VERCEL_PROJECT_ID = 'prj_JQh1zEivOURd9RpDP33dIJ9rCBO6';
const VERCEL_ORG_ID = 'team_kXXQhD4pqG6KG2NfVVFlVOHi';

const ROLE = 'mako_stats_reader';
const OWNER_ROLE = 'neondb_owner';
const LIMIT = 2;
const TIMEOUT = '5s';
const TABLES = ['aa_pending_user_ops', 'user_safes'];
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];
/// What a provider-owned database (Neon: cloud_admin's `postgres`) grants to PUBLIC and this owner cannot revoke:
/// pg_stat_statements' views, read-only. Postgres hides other roles' query text from a role outside
/// pg_read_all_stats, which the behaviour check `pgss` proves. Anything else in such a database fails.
const PROVIDER_ALLOWED = new Set(['public.pg_stat_statements:SELECT', 'public.pg_stat_statements_info:SELECT']);

const log = (...a) => console.error('[stats-role]', ...a);
const codeOf = (e) => e?.code ?? e?.cause?.code ?? e?.name ?? 'unknown';
const die = (why) => {
  log('REFUSED:', why);
  process.exit(1);
};

// ---- child mode: one independent process per connection ---------------------------------------------------------
if (process.argv[2] === 'child') {
  const [, , , action, holdMs] = process.argv;
  const u = new URL(process.env.ROLE_URL);
  const opts = { host: u.hostname, port: 5432, database: action === 'pgss' ? 'postgres' : u.pathname.slice(1), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0 };
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sql = postgres({ ...opts, ssl: action === 'tls-wrong-name' ? { rejectUnauthorized: true, servername: 'wrong-name.invalid' } : 'verify-full' });
  try {
    if (action === 'hold') {
      const c = await sql.reserve();
      await c`select 1`;
      out({ held: true });
      await new Promise((r) => setTimeout(r, Number(holdMs)));
      c.release();
    } else if (action === 'read' || action === 'tls' || action === 'tls-wrong-name') {
      await sql`select (select count(*) from aa_pending_user_ops) as a, (select count(*) from user_safes) as b`;
      out({ ok: true });
    } else if (action === 'forbidden') {
      await sql`select count(*) from users`;
      out({ ok: true });
    } else if (action === 'write') {
      await sql`update user_safes set chain_id = chain_id where false`;
      out({ ok: true });
    } else if (action === 'slow') {
      await sql`select pg_sleep(6)`;
      out({ ok: true });
    } else if (action === 'pgss') {
      const [r] = await sql`select count(*)::int as n from pg_stat_statements where userid <> (select oid from pg_roles where rolname = current_user) and query <> '<insufficient privilege>'`;
      out({ ok: true, n: r.n });
    } else if (action === 'temp') {
      await sql`create temp table t (x int)`;
      out({ ok: true });
    }
  } catch (e) {
    out({ ok: false, code: codeOf(e) });
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  process.exit(0);
}

// ---- arguments and checkout gate ----------------------------------------------------------------------------------
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const neonProject = arg('neon-project');
const neonBranch = arg('neon-branch');
const expectCommit = arg('expect-commit');
const target = arg('target');
const gitBranch = arg('git-branch');
if (!neonProject || !/^[a-z0-9-]+$/.test(neonProject)) die('--neon-project missing');
if (!expectCommit || !/^[0-9a-f]{7,40}$/.test(expectCommit)) die('--expect-commit missing');
if (neonBranch !== undefined && !/^[A-Za-z0-9_-]+$/.test(neonBranch)) die('--neon-branch is not a branch name');
if (neonBranch !== undefined && target !== 'none') die('--neon-branch is for proofs on a scratch branch: use --target none');
if (!['preview', 'production', 'none'].includes(target ?? '')) die('--target must be preview, production or none');
if (target === 'preview' && !gitBranch) die('--git-branch is required for preview');

function checkoutGate() {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!head.startsWith(expectCommit)) die(`checkout is at ${head.slice(0, 12)}, not ${expectCommit}`);
  const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) die('checkout has uncommitted changes');
  const linked = join(ROOT, '.vercel', 'project.json');
  if (existsSync(linked)) {
    const p = JSON.parse(readFileSync(linked, 'utf8'));
    if (p.projectId !== VERCEL_PROJECT_ID || p.orgId !== VERCEL_ORG_ID) die('this checkout is linked to another Vercel project');
  }
  return head;
}
const head = checkoutGate();
log('checkout', head.slice(0, 12), 'clean; target', target, gitBranch ?? '');

// ---- owner connection (direct endpoint only) ----------------------------------------------------------------------
let owner;
try {
  owner = execFileSync('neon', ['connection-string', ...(neonBranch ? [neonBranch] : []), '--project-id', neonProject, '--role-name', OWNER_ROLE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  die('neon connection-string failed');
}
const ownerUrl = new URL(owner);
if (ownerUrl.hostname.split('.')[0].includes('pooler')) die('owner URL is the pooler; a direct endpoint is required');
const dbName = ownerUrl.pathname.slice(1);
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const adminOpts = { host: ownerUrl.hostname, port: 5432, database: dbName, username: decodeURIComponent(ownerUrl.username), password: decodeURIComponent(ownerUrl.password), ssl: 'verify-full', max: 1, prepare: false, onnotice: () => {} };
const admin = postgres(adminOpts);

/// Every table, view and foreign table privilege the login effectively holds in the connected database (PUBLIC included).
const relationPrivileges = (db) => db`
  select n.nspname as s, c.relname as t, p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
  where c.relkind in ('r','v','m','f','p') and n.nspname <> all(${SYSTEM_SCHEMAS}) and n.nspname not like 'pg_temp%'
    and has_table_privilege(${ROLE}, c.oid, p.priv)`;
/// The same for column-level grants, which has_table_privilege does not see.
const columnPrivileges = (db) => db`
  select n.nspname as s, c.relname as t, p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) as p(priv)
  where c.relkind in ('r','v','m','f','p') and n.nspname <> all(${SYSTEM_SCHEMAS}) and n.nspname not like 'pg_temp%'
    and has_any_column_privilege(${ROLE}, c.oid, p.priv)`;
const password = randomBytes(24).toString('hex');

const results = {};
const expect = (name, ok) => {
  results[name] = ok;
  log(ok ? 'PASS' : 'FAIL', name);
};

try {
  const [{ server_version: v }] = await admin`show server_version`;
  log('server', v.split(' ')[0], 'database', dbName);
  const [db] = await admin`select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`;
  if (db.owner !== OWNER_ROLE) die(`database owner is not ${OWNER_ROLE}`);

  // A role that already exists and owns anything is refused BEFORE it is re-keyed or published.
  const existing = await admin`select oid from pg_roles where rolname = ${ROLE}`;
  if (existing.length) {
    const [owns] = await admin`select count(*)::int as n from pg_shdepend where refobjid = ${existing[0].oid} and deptype = 'o'`;
    if (owns.n !== 0) die(`existing ${ROLE} owns ${owns.n} object(s)`);
  }
  // NOSUPERUSER can only be written by a superuser, even unchanged, so the re-key leaves it out; the attribute check
  // below still requires rolsuper false, and a non-superuser owner could never have granted it.
  const attrs = `login nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit ${LIMIT} password '${password}'`;
  await admin.begin(async (tx) => {
    await tx.unsafe(existing.length ? `alter role ${ident(ROLE)} with ${attrs}` : `create role ${ident(ROLE)} with nosuperuser ${attrs}`);
    await tx.unsafe(`alter role ${ident(ROLE)} set statement_timeout = '${TIMEOUT}'`);
    // Drop anything the role was given before, then grant exactly the three things it needs.
    for (const g of await tx`select roleid::regrole::text as r from pg_auth_members where member = (select oid from pg_roles where rolname = ${ROLE})`) {
      await tx.unsafe(`revoke ${g.r} from ${ident(ROLE)}`);
    }
    await tx.unsafe(`revoke all on database ${ident(dbName)} from ${ident(ROLE)}`);
    for (const { s } of await tx`select nspname as s from pg_namespace where nspname <> all(${SYSTEM_SCHEMAS}) and nspname not like 'pg_temp%' and nspname not like 'pg_toast%'`) {
      await tx.unsafe(`revoke all on schema ${ident(s)} from ${ident(ROLE)}`);
      await tx.unsafe(`revoke all on all tables in schema ${ident(s)} from ${ident(ROLE)}`);
      await tx.unsafe(`revoke all on all sequences in schema ${ident(s)} from ${ident(ROLE)}`);
    }
    // PUBLIC holds TEMPORARY on a new database by default; the login must not have it (the owner keeps it as owner).
    await tx.unsafe(`revoke temporary on database ${ident(dbName)} from public`);
    await tx.unsafe(`grant connect on database ${ident(dbName)} to ${ident(ROLE)}`);
    await tx.unsafe(`grant usage on schema public to ${ident(ROLE)}`);
    for (const t of TABLES) await tx.unsafe(`grant select on table public.${ident(t)} to ${ident(ROLE)}`);
  });

  // ---- effective privileges, not grant rows ----
  const [r] = await admin`select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit, rolconfig, oid from pg_roles where rolname = ${ROLE}`;
  expect('attributes: login only, every restrictive flag set, limit 2', r.rolcanlogin && !r.rolsuper && !r.rolinherit && !r.rolcreaterole && !r.rolcreatedb && !r.rolreplication && !r.rolbypassrls && r.rolconnlimit === LIMIT);
  expect('statement_timeout 5s on the role', (r.rolconfig ?? []).includes(`statement_timeout=${TIMEOUT}`));
  const [mem] = await admin`select count(*)::int as n from pg_auth_members where member = ${r.oid}`;
  expect('member of no role', mem.n === 0);
  const [owns] = await admin`select count(*)::int as n from pg_shdepend where refobjid = ${r.oid} and deptype = 'o'`;
  expect('owns nothing', owns.n === 0);
  const rel = await relationPrivileges(admin);
  const allowed = rel.filter((x) => x.s === 'public' && TABLES.includes(x.t) && x.priv === 'SELECT');
  expect(`tables and views: SELECT on the two stats tables only (${rel.length} effective privileges)`, rel.length === TABLES.length && allowed.length === TABLES.length);
  // Column grants are invisible to has_table_privilege (adversary on 5a64557): any column privilege counts.
  const cols = await columnPrivileges(admin);
  const colAllowed = cols.filter((x) => x.s === 'public' && TABLES.includes(x.t) && x.priv === 'SELECT');
  expect(`columns: SELECT on the two stats tables only (${cols.length} effective column privileges)`, cols.length === TABLES.length && colAllowed.length === TABLES.length);
  const [seq] = await admin`
    select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname <> all(${SYSTEM_SCHEMAS})
      and (has_sequence_privilege(${ROLE}, c.oid, 'USAGE') or has_sequence_privilege(${ROLE}, c.oid, 'SELECT') or has_sequence_privilege(${ROLE}, c.oid, 'UPDATE'))`;
  expect('no sequence privileges', seq.n === 0);
  const sch = await admin`
    select nspname as s, has_schema_privilege(${ROLE}, oid, 'USAGE') as u, has_schema_privilege(${ROLE}, oid, 'CREATE') as c
    from pg_namespace where nspname <> all(${SYSTEM_SCHEMAS}) and nspname not like 'pg_temp%' and nspname not like 'pg_toast%'`;
  expect('schemas: USAGE on public only, CREATE nowhere', sch.every((x) => !x.c && x.u === (x.s === 'public')));
  const [dbp] = await admin`select has_database_privilege(${ROLE}, current_database(), 'CONNECT') as conn, has_database_privilege(${ROLE}, current_database(), 'CREATE') as cr, has_database_privilege(${ROLE}, current_database(), 'TEMP') as tmp`;
  expect('database: CONNECT only (no CREATE, no TEMP)', dbp.conn && !dbp.cr && !dbp.tmp);
  // Every other database in the cluster (PUBLIC holds CONNECT and TEMP on new ones by default).
  const others = await admin`select datname, pg_get_userbyid(datdba) as owner, datallowconn,
      has_database_privilege(${ROLE}, datname, 'CONNECT') as conn, has_database_privilege(${ROLE}, datname, 'TEMP') as tmp,
      has_database_privilege(${ROLE}, datname, 'CREATE') as cr
    from pg_database where datname <> current_database()`;
  expect('no CREATE on any database', others.every((d) => !d.cr));
  expect('no other database of ours accepts the login', others.filter((d) => d.owner === OWNER_ROLE).every((d) => !d.conn && !d.tmp));
  for (const d of others.filter((x) => x.owner !== OWNER_ROLE && x.datallowconn && x.conn)) {
    // The provider's own databases (Neon: cloud_admin's postgres, template1) cannot be revoked by this owner. The
    // role cap is per login across the cluster and statement_timeout is set on the role, so they do not widen the
    // bound; what must hold is that the login can read or change nothing in them.
    const other = postgres({ ...adminOpts, database: d.datname });
    try {
      const held = [...(await relationPrivileges(other)), ...(await columnPrivileges(other))].map((x) => `${x.s}.${x.t}:${x.priv}`);
      const extra = held.filter((k) => !PROVIDER_ALLOWED.has(k));
      expect(`${d.datname} (provider-owned: CONNECT${d.tmp ? ', TEMP' : ''} accepted): only pg_stat_statements read (${extra.length} other privileges)`, extra.length === 0);
    } catch (e) {
      expect(`${d.datname} inspected (${codeOf(e)})`, false);
    } finally {
      await other.end({ timeout: 1 }).catch(() => {});
    }
  }
  const [definer] = await admin`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname <> all(${SYSTEM_SCHEMAS}) and has_function_privilege(${ROLE}, p.oid, 'EXECUTE')`;
  expect('no SECURITY DEFINER function executable', definer.n === 0);
} catch (e) {
  log('setup failed:', codeOf(e));
  process.exit(1);
} finally {
  await admin.end({ timeout: 1 }).catch(() => {});
}

// ---- behaviour and TLS, each from its own process ----
const roleUrl = new URL(owner);
roleUrl.username = ROLE;
roleUrl.password = password;
roleUrl.search = '?sslmode=verify-full';
const url = roleUrl.toString();

function child(action, holdMs = 0) {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', action, String(holdMs)], { env: { ...process.env, ROLE_URL: url }, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = [];
  const waiters = [];
  p.stdout.on('data', (d) => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      lines.push(JSON.parse(l));
      waiters.forEach((w) => w());
    }
  });
  const done = new Promise((res) => p.on('exit', res));
  const until = (pred) => new Promise((res) => { const check = () => { const hit = lines.find(pred); if (hit) res(hit); }; waiters.push(check); check(); });
  return { done, until, lines };
}

const tls = child('tls');
await tls.done;
expect('TLS verify-full against the endpoint', tls.lines[0]?.ok === true);
const wrong = child('tls-wrong-name');
await wrong.done;
expect(`TLS refuses a wrong server name (${wrong.lines[0]?.code ?? 'connected'})`, wrong.lines[0]?.ok === false && wrong.lines[0]?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');

const a = child('hold', 6000);
const b = child('hold', 15000);
await Promise.all([a.until((l) => l.held || l.ok === false), b.until((l) => l.held || l.ok === false)]);
expect('two processes connect', a.lines[0]?.held === true && b.lines[0]?.held === true);
const c = child('read');
await c.done;
expect(`a third is refused while two are open (${c.lines[0]?.code ?? 'connected'})`, c.lines[0]?.ok === false && c.lines[0]?.code === '53300');
await a.done;
const d = child('read');
await d.done;
expect('a read works after one closes', d.lines[0]?.ok === true);
await b.done;
for (const [action, name, want] of [
  ['forbidden', 'other tables refused (users)', '42501'],
  ['write', 'writes refused', '42501'],
  ['temp', 'temporary tables refused', '42501'],
  ['slow', 'a 6 s query is cut at 5 s', '57014'],
]) {
  const p = child(action);
  await p.done;
  expect(`${name} (${p.lines[0]?.code ?? 'no error'})`, p.lines[0]?.ok === false && p.lines[0]?.code === want);
}

const pgss = child('pgss');
await pgss.done;
expect(`provider pg_stat_statements shows no other role's query text (${pgss.lines[0]?.ok ? pgss.lines[0].n : pgss.lines[0]?.code})`, pgss.lines[0]?.ok === true ? pgss.lines[0].n === 0 : pgss.lines[0]?.code === '42P01');

const failed = Object.entries(results).filter(([, ok]) => !ok);
if (failed.length) die(`${failed.length} check(s) failed; nothing stored`);
if (target === 'none') {
  log(`all ${Object.keys(results).length} checks passed; --target none, nothing stored`);
  process.exit(0);
}

// ---- store, from the same checkout, pinned to the project ----
checkoutGate();
const args = ['env', 'add', 'STATS_DATABASE_URL', target, ...(target === 'preview' ? [gitBranch] : []), '--force', '--sensitive', '--yes'];
const v = spawn('vercel', args, { cwd: ROOT, env: { ...process.env, VERCEL_PROJECT_ID, VERCEL_ORG_ID }, stdio: ['pipe', 'ignore', 'ignore'] });
v.stdin.end(url);
const code = await new Promise((res) => v.on('exit', res));
if (code !== 0) die(`vercel env add failed (exit ${code})`);
log(`all ${Object.keys(results).length} checks passed; stored STATS_DATABASE_URL (${target}${gitBranch ? ' ' + gitBranch : ''}) in ${VERCEL_PROJECT_ID}`);
