// Load env files in Next.js precedence order (highest priority first).
// `vercel env pull` writes to .env.development.local.
import { config } from 'dotenv';
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config({ path: '.env' });

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '',
  },
  // Stronger safety default: generate a migration file rather than pushing
  // schema changes directly to the DB. Run `pnpm db:generate` to create a
  // migration, review it, then `pnpm db:migrate` to apply.
  strict: true,
  verbose: true,
} satisfies Config;
