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
 *
 * ---------------------------------------------------------------------
 * Shared authenticated state (Round B)
 * ---------------------------------------------------------------------
 *
 * `globalSetup` (e2e/global-setup.ts) runs once, after both servers above
 * are healthy, and produces one signed-in browser storage state that
 * create-mailbox/create-alias/change-mailbox-password specs load via
 * `test.use({ storageState: AUTH_STATE_PATH })` — so each starts on the
 * app shell rather than repeating login.spec.ts's own login+forced-
 * password-change flow. logout.spec.ts deliberately opts out and signs
 * itself in; see AUTH_STATE_PATH's doc comment in e2e/env.ts for why.
 *
 * ---------------------------------------------------------------------
 * Two projects (Round D)
 * ---------------------------------------------------------------------
 *
 * `FakeBrokerClient.running` (drivers/broker/fake-broker-client.ts) is one
 * boolean on the single `FakeBrokerClient` instance the whole server
 * process shares for this run's entire lifetime (`create-broker-client.ts`
 * picks it once at boot, and both `webServer` entries above start exactly
 * one server process) — not per-request, per-session or per-spec state.
 * `restart-container.spec.ts` and `backup-and-restore.spec.ts` both
 * genuinely need to drive that one boolean through both states (stop it,
 * observe "exited"; start it, observe "running"; restore additionally
 * *requires* it stopped and separately needs to observe it *running* to
 * prove its own refusal gate). Under `fullyParallel: true`'s default local
 * workers, those two files racing over that shared boolean would make
 * both flaky in a way no retry fixes, because the failure is a genuine
 * cross-file data race, not flakiness internal to either test — so this is
 * fixed structurally rather than with a retry, a timeout or a sleep.
 *
 * `chromium-serial` below is a dedicated project, limited to exactly the
 * two files above via `testMatch` (and excluded from `chromium` via the
 * mirror-image `testIgnore`, so neither file ever runs twice), with its
 * own `workers: 1`. Per Playwright's own documented semantics for
 * `testProject.workers`, that limits how many workers *that project*
 * consumes, not a lock shared with any other project — which is exactly
 * why the file split matters as much as the worker limit: `workers: 1` on
 * a project that still shared `restart-container.spec.ts` with the
 * default project would do nothing, since the default project could still
 * run that file concurrently, in its own worker, against
 * `chromium-serial`'s one worker running the other file — recreating the
 * exact race one level up. With both files exclusively inside
 * `chromium-serial` and that project capped at one worker, Playwright can
 * never schedule them at the same instant, however many workers the
 * default project (or a future CI worker-count bump) uses.
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
  globalSetup: './e2e/global-setup.ts',
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

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/restart-container\.spec\.ts$/, /backup-and-restore\.spec\.ts$/],
    },
    {
      name: 'chromium-serial',
      use: { ...devices['Desktop Chrome'] },
      testMatch: [/restart-container\.spec\.ts$/, /backup-and-restore\.spec\.ts$/],
      // See "Two projects (Round D)" above for why both the file split and
      // this limit are required together.
      fullyParallel: false,
      workers: 1,
    },
  ],

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
