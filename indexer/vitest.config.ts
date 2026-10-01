import { defineConfig } from 'vitest/config';

// The indexer is its own package inside the app's repo: this config stops Vitest from picking up the app's root
// vitest.config.ts (and its include list and PostCSS setup).
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { include: ['src/**/*.test.ts'], testTimeout: 20_000 },
});
