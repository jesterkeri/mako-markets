import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with this package's wrangler.toml, against a local D1 (miniflare's SQLite) built from
// migrations/ by test/apply-migrations.ts, with storage isolated per test. The decoder is the resolver's own file
// (cf-worker/src/datastreams.ts, CHARTS_DS_PLAN 3.1), which lives outside this package and imports viem, so viem
// resolves to the copy here, pinned to the resolver's locked version (as keeper/ does with rounds-delivery/).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
    })),
  ],
  resolve: { dedupe: ['viem'] },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
