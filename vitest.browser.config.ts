// ----------------------------------------------------------------------------
// vitest.browser.config.ts
//
// LOCAL ONLY: tests under `src/browser-tests/` drive a real headless Chromium (layout, focus scrolling, CSS animation
// state), which happy-dom cannot compute. They need playwright-core and Chromium outside the repo, the same ones the
// local screenshot tooling uses (~/.cache/mako-shots, ~/.cache/ms-playwright), so they cannot run in CI. Run them with
// `pnpm test:browser`. The default config (vitest.config.ts) never collects this folder, so `pnpm test:aa` and CI skip
// it.
// ----------------------------------------------------------------------------

import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/browser-tests/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
