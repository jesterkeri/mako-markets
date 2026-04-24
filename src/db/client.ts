// ----------------------------------------------------------------------------
// src/db/client.ts
//
// Postgres + Drizzle client. Uses the postgres.js driver (provider-agnostic;
// works on Vercel Marketplace Postgres, Neon, Supabase, or local Postgres).
//
// POSTGRES_URL is expected to be the pooled connection string. Vercel
// Marketplace integrations provision POSTGRES_URL automatically; for local
// development, point it at a Postgres instance you run yourself.
// ----------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.POSTGRES_URL;

// Lazy-initialized singleton so that importing this module doesn't crash a
// route that doesn't actually touch the DB during a Phase-1 partial rollout
// where some env vars are still empty.
let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function client() {
  if (!connectionString) {
    throw new Error(
      'POSTGRES_URL is not set. See .env.local.example for the Phase-1 env vars.',
    );
  }
  if (!_sql) {
    _sql = postgres(connectionString, { prepare: false });
    _db = drizzle(_sql, { schema });
  }
  return _db!;
}

/// Drizzle instance, typed against the full schema. Call this at the top of
/// any server-only module that needs DB access. Next.js route handlers that
/// import this file MUST be marked dynamic or explicitly uncached — the client
/// is stateful and will not survive build-time static prerender.
export const db = new Proxy({} as ReturnType<typeof client>, {
  get(_target, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
});

export { schema };
