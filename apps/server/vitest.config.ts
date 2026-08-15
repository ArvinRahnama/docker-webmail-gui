import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Resolve @dwg/shared straight to its TS source rather than its
    // built dist/. Without this, running `vitest` for apps/server before
    // `packages/shared` has been built (its package.json "main"/"exports"
    // point only at dist/) would fail or run against a stale build —
    // tests should not silently depend on build-order.
    alias: {
      '@dwg/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
