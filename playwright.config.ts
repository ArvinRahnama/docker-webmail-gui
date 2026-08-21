/**
 * Playwright harness (IMPLEMENTATION_PLAN.md §2.4's E2E row). Round A of
 * closing this repository's E2E gap ships this file plus one spec,
 * `e2e/login.spec.ts` — later rounds add the rest of the twelve critical
 * workflows that row lists.
 *
 * ---------------------------------------------------------------------
 * How the app under test is started
 * ---------------------------------------------------------------------
 *
 * Two `webServer` entries, mirroring how a developer runs this app locally
 * (the root `npm run dev` starts both apps/server and apps/web): the real
 * Fastify server, and the Vite dev server in front of it. Every request the
 * browser makes goes through Vite's `/api` proxy to the real server —
 * fake Docker/DMS/DNS/TLS/Rspamd/registry drivers underneath (APP_MODE
 * defaults to "development" and DANGEROUSLY_USE_REAL_DOCKER is left unset
 * below, so every driver's "create" factory picks its fake implementation —
 * see e.g. apps/server/src/drivers/dms/create-dms-driver.ts). No Docker
 * daemon, no live docker-mailserver, no outbound network call of any kind.
 *
 * Two things worth recording about *why* it's built this way, not just
 * that it is:
 *
 * 1. The backend runs `node apps/server/dist/index.js` — a built server —
 *    not the "dev" script (`node --watch src/index.ts`). That script does
 *    not actually start: this codebase writes NodeNext-style relative
 *    imports (`import './config.js'` from a `.ts` file, resolved to a
 *    sibling `.ts` file by tsc's module resolution at typecheck time), but
 *    `node --watch src/index.ts` asks the real Node.js module loader to
 *    resolve those same specifiers, which only understands an *actual*
 *    `config.js` on disk — one that doesn't exist until `tsc --build` has
 *    run. Confirmed by running it directly on this machine (Node 24.19.0):
 *    `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../config.js'`.
 *    `node dist/index.js` (what `npm start` runs, and what production
 *    actually executes) is therefore not just the available option here
 *    but the more faithful one regardless.
 *
 * 2. The frontend runs the Vite dev server, not `vite build` + `vite
 *    preview` serving the built SPA. The genuinely production-faithful
 *    setup — the built SPA served by Fastify from the same origin as the
 *    API, which is what `@fastify/static` is a server dependency *for*
 *    (ARCHITECTURE.md §10, `.env.example`'s PORT comment) — is not wired
 *    up in `apps/server/src/app.ts` yet; there is no `@fastify/static`
 *    registration anywhere in that file. That is packaging work (M13),
 *    not something to bolt on inside a test harness. Between the two
 *    options this file's task description actually offered, `vite
 *    preview` was the closer-sounding one but doesn't work either: it has
 *    no equivalent of vite.config.ts's `server.proxy`, so a built SPA
 *    served that way would call `/api/*` with no backend behind it, and
 *    apps/server's CSRF guard (`auth.middleware.ts`'s
 *    `isSameOriginRequest`) requires a genuinely same-origin
 *    `Sec-Fetch-Site`, which only the dev-server proxy (or the
 *    not-yet-built static-serving path) actually produces. So this is the
 *    faithful option available in the current codebase, not a speed
 *    shortcut — see vite.config.ts's own comment on the proxy for the CSRF
 *    reasoning this relies on.
 *
 * ---------------------------------------------------------------------
 * State isolation
 * ---------------------------------------------------------------------
 *
 * `DATA_DIR` below is a fresh `mkdtemp` directory outside the repository
 * entirely, created once per `playwright test` invocation (this file is
 * evaluated once per run). Never a developer's real `./data`; nothing here
 * is ever committed since it's not under the repo tree at all. The single
 * admin in it is created through the real bootstrap path
 * (`modules/auth/bootstrap.ts`) by setting BOOTSTRAP_ADMIN_EMAIL/
 * BOOTSTRAP_ADMIN_PASSWORD, exactly as an operator would (`.env.example`),
 * never by seeding a hand-written admin row (AGENT_BRIEF.md working
 * agreement #8's spirit, if not its letter — see e2e/env.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  SERVER_ORIGIN,
  SERVER_PORT,
  WEB_ORIGIN,
  WEB_PORT,
} from './e2e/env.js';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dwg-e2e-data-'));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Shared CI runners commonly have two cores; racing every test against
  // the two servers above with unlimited workers trades reliability for a
  // speed-up neither runner nor local machine reliably has to give. Omitted
  // rather than set to `undefined` locally — Playwright's own config type
  // has `workers?: string | number`, and this project's
  // exactOptionalPropertyTypes (AGENT_BRIEF.md §5) rejects passing
  // `undefined` where a key must instead be absent.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm run build --workspace apps/server && node apps/server/dist/index.js',
      cwd: ROOT_DIR,
      url: `${SERVER_ORIGIN}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        APP_MODE: 'development',
        HOST: '127.0.0.1',
        PORT: String(SERVER_PORT),
        DATA_DIR,
        // The E2E origin is plain http://127.0.0.1 — forcing `Secure`
        // would stop the browser from ever storing the session cookie
        // (same reasoning as config.ts's own doc comment on this flag).
        COOKIE_SECURE: 'false',
        BOOTSTRAP_ADMIN_EMAIL,
        BOOTSTRAP_ADMIN_PASSWORD,
      },
    },
    {
      command: `npm run dev --workspace apps/web -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: ROOT_DIR,
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ...process.env,
        DWG_API_PROXY_TARGET: SERVER_ORIGIN,
      },
    },
  ],
});
