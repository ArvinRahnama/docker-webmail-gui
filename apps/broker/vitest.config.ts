import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Resolve @dwg/shared straight to its TS source rather than its built
    // dist/ — see apps/server/vitest.config.ts for why (build-order
    // independence for `vitest` runs).
    alias: {
      '@dwg/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
