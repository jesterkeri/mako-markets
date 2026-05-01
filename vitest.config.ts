// ----------------------------------------------------------------------------
// vitest.config.ts
//
// Sub-phase B introduces a vitest suite for the AA (ERC-4337) primitives.
// Sub-phase C extends the suite to cover server-only modules (cron auth,
// allowlist). Scope is intentionally narrow: only `src/lib/__tests__/**`
// runs through this config. Component / page / API tests (if/when added)
// get their own config so the AA suite stays fast and frontend deps don't
// bleed in.
//
// Node environment (no jsdom) — every helper under test is pure and runs
// in the browser via the same module path, but the tests don't touch
// `window`.
//
// `server-only` is aliased to an empty stub so vitest can import modules
// like `cron-auth.ts` and `aa-call-allowlist.ts` that ship with `import
// 'server-only'`. The Next.js bundler enforces the real boundary at build
// time; vitest only cares about runtime behaviour.
//
// `@/*` is aliased to `src/*` to match tsconfig.json so route + DAO
// modules can resolve their imports under vitest the same way Next does.
// ----------------------------------------------------------------------------

import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/__tests__/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      'server-only': fileURLToPath(
        new URL('./src/lib/__tests__/server-only-stub.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
