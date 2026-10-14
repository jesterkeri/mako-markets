import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The run lease, tested inside workerd with the real SchedulerState Durable Object from wrangler.toml.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: { include: ['test/**/*.workers.test.ts'], testTimeout: 30_000 },
});
