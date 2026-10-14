import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the real KeeperState Durable Object from wrangler.toml. Every network call
// goes through an injected fake fetch, so nothing leaves the machine. rounds-delivery lives outside this
// package and imports viem, so resolution is pinned to the copy here (as watchdog/ does).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  resolve: { dedupe: ['viem'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
