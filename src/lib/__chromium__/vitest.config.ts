// Real-browser checks (headless Chromium), kept OUT of the CI glob on purpose: they need the local Chromium under
// ~/.cache/ms-playwright and playwright-core under ~/.cache/mako-shots, which CI does not have. Run by hand:
//   corepack pnpm@10.32.1 exec vitest run --config src/lib/__chromium__/vitest.config.ts

import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

import base from '../../../vitest.config';

export default mergeConfig(
  { ...base, test: { ...base.test, include: [], environmentMatchGlobs: [] } },
  defineConfig({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    test: {
      include: ['src/lib/__chromium__/**/*.test.tsx'],
      environmentMatchGlobs: [['src/lib/__chromium__/**/*.test.tsx', 'happy-dom']],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
