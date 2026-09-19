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
  // Whole-run tests encode thousands of markets in the fake chain; the default
  // 5 s timed out once on a loaded machine (review r1, verification notes).
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
