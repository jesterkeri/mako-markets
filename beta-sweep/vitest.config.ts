import { defineConfig } from 'vitest/config';

// Plain Node tests of the one request this worker makes; the fetch is injected, so nothing leaves the machine.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
