import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite: runs against a real docker-mailserver (IMAP + SMTP).
 * Requires the MCP_IT_* environment variables described in
 * src/mail/imap-smtp.integration.test.ts; .github/workflows/mcp-integration.yml
 * provisions them in CI.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    alias: {
      '@dwg/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
