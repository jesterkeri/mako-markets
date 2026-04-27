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

/// Either the top-level `db` instance or the transaction client passed into a
/// `db.transaction(async (tx) => ...)` callback. Use this as the parameter
/// type for helpers that should be callable from inside or outside a tx —
/// pass the `tx` argument when atomicity matters, or fall back to `db` when
/// the helper stands alone.
export type DbOrTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0] | DrizzleDb;

// `globalThis` cache: survives HMR in dev, no-op in production (each Vercel
// function instance starts fresh anyway).
const globalForDb = globalThis as unknown as {
  __makoPostgres?: PgClient;
  __makoDrizzle?: DrizzleDb;
};

function client(): DrizzleDb {
  // Vercel + Neon's newer integration provisions DATABASE_URL; the older
  // first-party Vercel Postgres product used POSTGRES_URL. Accept either —
  // priority is DATABASE_URL because that's what `vercel env pull` injects
  // for any new project, and the older name remains available so legacy
  // `.env.local` files keep working.
  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      'No Postgres connection string found. Set DATABASE_URL (preferred) or POSTGRES_URL in .env.local. See .env.local.example for Phase-1 env vars.',
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
