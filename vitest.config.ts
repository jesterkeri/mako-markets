// ----------------------------------------------------------------------------
// vitest.config.ts
//
// Sub-phase B introduces a vitest suite for the AA (ERC-4337) primitives.
// Sub-phase C extends the suite to cover server-only modules (cron auth,
// allowlist). Phase 1G Group 4 Sub-A extends to component-DOM tests
// (`*.test.tsx`) for the modal-close-arbitrator + use-focus-trap
// primitives that are too DOM-driven for pure-logic extraction.
//
// Default environment is `node` — fast for the existing pure-helper +
// route tests. `*.test.tsx` files run under `happy-dom` via the
// `environmentMatchGlobs` rule below; that's where component + hook
// tests live. (We swapped from jsdom to happy-dom during Sub-A
// because jsdom@29 has an ESM/CJS conflict with html-encoding-sniffer
// that breaks under vitest 2.x.)
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
    include: [
      'src/lib/__tests__/**/*.test.ts',
      'src/lib/__tests__/**/*.test.tsx',
    ],
    environmentMatchGlobs: [
      ['src/lib/__tests__/**/*.test.tsx', 'happy-dom'],
    ],
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
