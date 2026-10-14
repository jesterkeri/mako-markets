import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the real WatchdogState Durable Object from
// wrangler.toml. Every network call in a test goes through an injected fake
// fetch, so nothing leaves the machine.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  // test/mirror-differential.test.ts imports the resolver's own parsers from
  // cf-worker/, and the app's cutoff copy from src/lib/, to check the mirror by
  // behaviour (slice-1 review r8). Those files import viem from OUTSIDE this
  // package, and CI installs this package alone (--ignore-workspace), so
  // resolution is pinned to the copy here instead of walking up to a
  // node_modules that will not exist.
  resolve: { dedupe: ['viem'] },
  // Whole-run tests encode thousands of markets in the fake chain; the default
  // 5 s timed out once on a loaded machine (review r1, verification notes).
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
