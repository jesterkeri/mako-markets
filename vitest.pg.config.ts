// ----------------------------------------------------------------------------
// vitest.pg.config.ts
//
// The real-PostgreSQL suite (src/lib/__pg_tests__, SIGNIN_REMEMBERED_BROWSER_PLAN r29 section 4): lock-wait timing
// proofs PGlite cannot run. Needs PG_TEST_URL pointing at a throwaway local PostgreSQL 16 (a CI service container,
// or `docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16` locally); without it every case
// skips. One file at a time, one test at a time: the cases share one database and time real lock waits.
// ----------------------------------------------------------------------------

import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/__pg_tests__/**/*.pg.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    globals: false,
  },
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./src/lib/__tests__/server-only-stub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
