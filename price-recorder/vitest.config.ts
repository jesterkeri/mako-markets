import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with this package's wrangler.toml. The decoder is the resolver's own file
// (cf-worker/src/datastreams.ts, CHARTS_DS_PLAN 3.1), which lives outside this package and imports viem, so viem
// resolves to the copy here, pinned to the resolver's locked version (as keeper/ does with rounds-delivery/).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  resolve: { dedupe: ['viem'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
