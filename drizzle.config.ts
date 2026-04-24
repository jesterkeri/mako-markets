import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? '',
  },
  // Stronger safety default: generate a migration file rather than pushing
  // schema changes directly to the DB. Run `pnpm db:generate` to create a
  // migration, review it, then `pnpm db:migrate` to apply.
  strict: true,
  verbose: true,
} satisfies Config;
