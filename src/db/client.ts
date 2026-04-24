import 'server-only';

// ----------------------------------------------------------------------------
// src/db/client.ts
//
// Postgres + Drizzle client. Uses the postgres.js driver (provider-agnostic;
// works on Vercel Marketplace Postgres, Neon, Supabase, or local Postgres).
//
// POSTGRES_URL is expected to be the pooled connection string. Vercel
// Marketplace integrations provision POSTGRES_URL automatically; for local
// development, point it at a Postgres instance you run yourself.
//
// `import 'server-only'` at the top makes Next.js throw at build time if this
// module ever gets pulled into a client bundle — the connection string + DB
// credentials must never leave the server.
//
// The singleton is cached on `globalThis` rather than a module-scoped `let`
// so it survives Next.js dev/HMR reloads. Without this, every source edit in
// dev would open a fresh pool; the old pool's connections would leak until
// GC, and Neon's concurrent-connection limit would be exhausted within a few
// hot reloads.
// ----------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
type PgClient = ReturnType<typeof postgres>;

// `globalThis` cache: survives HMR in dev, no-op in production (each Vercel
// function instance starts fresh anyway).
const globalForDb = globalThis as unknown as {
  __makoPostgres?: PgClient;
  __makoDrizzle?: DrizzleDb;
};

function client(): DrizzleDb {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      'POSTGRES_URL is not set. See .env.local.example for the Phase-1 env vars.',
    );
  }
  if (!globalForDb.__makoDrizzle) {
    globalForDb.__makoPostgres = postgres(connectionString, { prepare: false });
    globalForDb.__makoDrizzle = drizzle(globalForDb.__makoPostgres, { schema });
  }
  return globalForDb.__makoDrizzle;
}

/// Drizzle instance, typed against the full schema. Call this at the top of
/// any server-only module that needs DB access. Next.js route handlers that
/// import this file MUST be marked dynamic or explicitly uncached — the client
/// is stateful and will not survive build-time static prerender.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
});

export { schema };
