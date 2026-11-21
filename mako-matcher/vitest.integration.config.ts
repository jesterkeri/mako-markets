import { defineConfig } from 'vitest/config';

// The real-node integration test: plain Node (not workerd), a local anvil in Monad mode, the settler's own code.
// CI does not run it; the review does (`pnpm test:integration`).
export default defineConfig({
  resolve: { dedupe: ['viem'] },
  test: { include: ['integration/**/*.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 180_000 },
});
