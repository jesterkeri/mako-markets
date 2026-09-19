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
});
