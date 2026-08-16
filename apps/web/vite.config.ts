import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// M6 — frontend foundation (UX_ARCHITECTURE.md). Tailwind v4's own Vite
// plugin (CSS-first config, no tailwind.config.js) plus a `@` -> `src`
// alias so imports read `@/components/...` instead of climbing `../../..`
// across the shell/routes/components tree.
//
// The dev-server proxy exists for one specific reason, not general
// convenience: apps/server's CSRF guard (auth.middleware.ts
// `isSameOriginRequest`) requires `Sec-Fetch-Site: same-origin` (or a
// same-*origin* Origin header). Vite's dev server and apps/server listen on
// different ports, and a cross-port request is same-*site* but not
// same-*origin* — the browser would send `Sec-Fetch-Site: same-site`, which
// the guard deliberately rejects. Proxying `/api` through Vite's own origin
// makes every request the browser issues genuinely same-origin, in dev
// exactly as it is in production (ARCHITECTURE.md §10 — server serves both
// the API and the built SPA from one origin).
const API_PROXY_TARGET = process.env['DWG_API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: false,
      },
    },
  },
});
