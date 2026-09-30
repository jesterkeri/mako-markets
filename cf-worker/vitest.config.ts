// Unit tests for the Worker's pure settlement logic (src/settlement.ts).
// Plain Node environment: nothing here needs workerd, a chain or a network.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
