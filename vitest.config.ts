// ----------------------------------------------------------------------------
// vitest.config.ts
//
// Sub-phase B introduces a vitest suite for the AA (ERC-4337) primitives.
// Scope is intentionally narrow: only `src/lib/__tests__/**` runs through
// this config. Component / page / API tests (if/when added) get their own
// config so the AA suite stays fast and frontend deps don't bleed in.
//
// Node environment (no jsdom) — every helper under test is pure and runs
// in the browser via the same module path, but the tests don't touch
// `window`.
// ----------------------------------------------------------------------------

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/__tests__/**/*.test.ts'],
    globals: false,
  },
});
