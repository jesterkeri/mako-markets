// ----------------------------------------------------------------------------
// src/lib/comments/__tests__/test-db.ts
//
// In-memory Postgres harness for the #182 comments integration tests. Same
// pattern as the PM / leaderboard harnesses: @electric-sql/pglite (real
// Postgres compiled to WASM) so 0009's CHECK matrix (scope shape, lowercase
// contract, deleted pair, octet-length body), partial indexes, ON CONFLICT
// rate-limit upserts, and FOR SHARE parent locks behave exactly like prod.
//
// 0009_comments.sql FKs to both `users` and `pm_markets`, so those parents
// must exist before it loads. We:
//   - create a MINIMAL `users` stub carrying only the columns the comment code
//     reads (identity resolution + FK target). The real users table is spread
//     across 0000/0001/0003/0004/0005 with CHECKs the comment path never
//     exercises; stubbing keeps inserts terse without lowering fidelity of the
//     thing under test (market_comments itself).
//   - load the REAL 0006_private_markets.sql for `pm_markets` (full fidelity,
//     and 0009 ALTERs comments_enabled onto it exactly as prod does).
//   - load 0009_comments.sql verbatim.
//
// Each test gets a fresh instance; call close() from afterEach/afterAll.
// ----------------------------------------------------------------------------

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '@/db/schema';

export interface TestDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

// Parent for the market_comments.user_id FK + the identity resolver. Carries
// EVERY column the Drizzle `users` schema emits on insert (Drizzle names all
// columns explicitly, `default` for the ones it doesn't set), so tests can use
// db.insert(users) as-is. It stops short of the real CHECKs / partial unique
// indexes the comment path never exercises. If the real users schema gains a
// column, a comment test using db.insert(users) will fail loudly here — that's
// the intended signal to update this stub.
const USERS_STUB_SQL = `
  CREATE TABLE IF NOT EXISTS "users" (
    "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "email"                 text,
    "magic_eoa"             text,
    "wallet_address"        text,
    "auth_type"             text NOT NULL DEFAULT 'magic',
    "kyc_status"            text NOT NULL DEFAULT 'none',
    "created_at"            timestamptz NOT NULL DEFAULT now(),
    "last_email_changed_at" timestamptz,
    "display_name"          text,
    "avatar_url"            text,
    "totp_secret"           text,
    "totp_enabled_at"       timestamptz,
    "totp_failed_attempts"  integer NOT NULL DEFAULT 0,
    "totp_locked_until"     timestamptz,
    "totp_last_used_step"   bigint
  );
`;

const sqlCache = new Map<string, string>();
function loadSql(file: string): string {
  let s = sqlCache.get(file);
  if (s === undefined) {
    s = readFileSync(resolve(`src/db/migrations/${file}`), 'utf-8');
    sqlCache.set(file, s);
  }
  return s;
}

async function execScript(client: PGlite, sql: string): Promise<void> {
  // 0006 uses `--> statement-breakpoint` markers (drizzle-generated); 0009 is
  // hand-written with none. Splitting on the marker gives clear per-statement
  // errors for 0006; a marker-less file becomes a single chunk that exec runs
  // whole (pglite exec accepts multi-statement scripts).
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    await client.exec(trimmed);
  }
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  // pglite ships pgcrypto (gen_random_uuid); no extension setup needed.
  await client.exec(USERS_STUB_SQL);
  await execScript(client, loadSql('0006_private_markets.sql')); // pm_markets
  await execScript(client, loadSql('0008_leaderboard_events.sql')); // mako_market_events (badges)
  await execScript(client, loadSql('0009_comments.sql'));
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}
