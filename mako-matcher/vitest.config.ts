import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the real MatcherMarket and MatcherSettler Durable Objects from wrangler.toml.
// Every network call in a test goes through an injected fake fetch, so nothing leaves the machine. The bindings
// below are test values only (a made-up exchange address that matches the shared vectors, an RPC host that does
// not exist, a throwaway cancel secret); the committed wrangler.toml leaves the exchange address unset.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          EXCHANGE_ADDRESS: '0xe8c0000000000000000000000000000000000001',
          PRIMARY_RPC_URL: 'https://rpc.test/',
          CANCEL_SECRET: 'test-cancel-secret',
        },
      },
    }),
  ],
  resolve: { dedupe: ['viem'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
