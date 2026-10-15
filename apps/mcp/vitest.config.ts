import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real-IMAP/SMTP integration tests need a running docker-mailserver and
    // run through vitest.integration.config.ts instead (see docs/mcp-integration.md).
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
    // Same rationale as apps/server/vitest.config.ts: resolve @dwg/shared to
    // its TS source so tests never depend on build order.
    alias: {
      '@dwg/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
