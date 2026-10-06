import { defineConfig } from 'vitest/config';

// The plan is pure, so its tests run in plain Node; nothing here touches the network.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
