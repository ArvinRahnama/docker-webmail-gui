import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Separate from vite.config.ts, matching the other workspaces
// (apps/server, apps/broker, packages/shared) rather than merging test
// config into the dev/build config. `jsdom` is the default environment
// because most suites here render React components (contrast.test.ts
// overrides to `node` per-file — it only parses CSS text and does OKLCH
// math, no DOM involved).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
