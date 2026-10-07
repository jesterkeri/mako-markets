// Unit tests for the Worker's pure settlement logic (src/settlement.ts).
// Plain Node environment: nothing here needs workerd, a chain or a network.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // An inline (empty) PostCSS config stops Vite searching upward, where it would load the Next app's
  // postcss.config.mjs from the repo root and fail in CI, which installs only this package (the Tailwind plugin
  // it needs is not here).
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
