import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The plan and the end-to-end runs are tested in plain Node; the Durable Object in workerd (vitest.workers.config.ts).
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cf-workers-stub.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], exclude: ['test/**/*.workers.test.ts', 'node_modules/**'] },
});
