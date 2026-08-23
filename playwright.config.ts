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
 * 2. This *first* pair's frontend runs the Vite dev server, not the built
 *    SPA. That is a deliberate split, not a gap: a strict CSP with no
 *    `unsafe-inline`/`unsafe-eval` is incompatible with Vite's own HMR
 *    client, so the security project below runs against the built SPA
 *    instead (see "A third project", and `e2e/security/csp.spec.ts`'s own
 *    header). For everything else, the dev server is what a developer
 *    actually runs, and its `/api` proxy produces the genuinely
 *    same-origin `Sec-Fetch-Site` apps/server's CSRF guard
 *    (`auth.middleware.ts`'s `isSameOriginRequest`) requires — see
 *    vite.config.ts's own comment on the proxy. `vite preview` would not:
 *    it has no equivalent of `server.proxy`, so a built SPA served that
 *    way would call `/api/*` with no backend behind it at all.
 *
 * ---------------------------------------------------------------------
 * Why `reuseExistingServer` is false, even locally
 * ---------------------------------------------------------------------
 *
 * Playwright's default for a local run is to adopt whatever is already
 * listening on a `webServer` port instead of starting one. That is a
 * sensible default when the port might hold something you deliberately
 * started — and it is the wrong default here, because these four ports
 * (`e2e/env.ts`: 3900, 3901, 3910, 3911) are used by nothing but this
 * harness. There is no scenario in which a process on port 3900 is
 * something a run should want to keep; there is only the scenario where a
 * previous run was killed and left one behind, built from different
 * source.
 *
 * Adopting that server means a green suite that never executed the code
 * under test — the same false-confidence family as a test asserting a
 * value against itself, and harder to notice, because nothing fails.
 * `e2e/env.ts`'s own comment on these ports already states the intent:
 * fixed ports exist to make a stuck process "a loud, obvious failure
 * instead of a silent reuse of the wrong server". `reuseExistingServer:
 * !process.env.CI` quietly defeated that intent on every local run. With
 * it off, a leftover process makes the run fail to start, loudly, which
 * is the outcome that comment was asking for.
 *
 * This is not what caused the intermittent cut-short runs that prompted
 * the change — those were a strict-mode locator ambiguity in
 * `backup-and-restore.spec.ts`, reproduced and fixed separately, with the
 * ports verified free beforehand. This is a latent hazard found while
 * investigating that one.
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
 *
 * ---------------------------------------------------------------------
 * A third project, and a second, independent server pair (M12)
 * ---------------------------------------------------------------------
 *
 * `chromium-security` runs `e2e/security/*.spec.ts` — CSP-against-the-
 * real-build and the accessibility sweep — against an entirely separate
 * origin (`SECURITY_WEB_ORIGIN`) backed by its own server process and
 * `DATA_DIR` (`SECURITY_DATA_DIR` below), never `WEB_ORIGIN`'s Vite dev
 * server. See `e2e/env.ts`'s doc comment on `SECURITY_SERVER_PORT` for
 * why it is a fully separate process rather than a third project sharing
 * the pair above.
 *
 * That instance is a plain `apps/server` with `STATIC_DIR` pointed at
 * `apps/web/dist`: one process serving the built SPA and its own API from
 * one origin, which is exactly the production topology
 * (docker/server/Dockerfile's `ENV STATIC_DIR`, ARCHITECTURE.md §10). It
 * used to need a test-only static+proxy server in front of it, because
 * `apps/server` could not serve static files at all; that harness had to
 * re-implement this project's security-header set in order to attach a
 * real CSP to a document it served itself, so the CSP spec was asserting
 * a duplicate of the header rather than the header. M13 wired
 * `@fastify/static` into `apps/server`, so the harness is gone and the
 * specs now see what the shipped image actually sends.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  SECURITY_SERVER_ORIGIN,
  SECURITY_SERVER_PORT,
  SECURITY_WEB_ORIGIN,
  SERVER_ORIGIN,
  SERVER_PORT,
  WEB_ORIGIN,
  WEB_PORT,
} from './e2e/env.js';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dwg-e2e-data-'));
const SECURITY_DATA_DIR = mkdtempSync(join(tmpdir(), 'dwg-e2e-security-data-'));

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
      testIgnore: [
        /restart-container\.spec\.ts$/,
        /backup-and-restore\.spec\.ts$/,
        /security\/.*\.spec\.ts$/,
      ],
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
    {
      // M12 — SECURITY.md Part 5 check 7's second half and the
      // accessibility sweep, both against `SECURITY_WEB_ORIGIN`'s
      // static+proxy harness (see e2e/env.ts's doc comment) rather than
      // `WEB_ORIGIN`'s Vite dev server.
      name: 'chromium-security',
      use: { ...devices['Desktop Chrome'], baseURL: SECURITY_WEB_ORIGIN },
      testMatch: [/security\/.*\.spec\.ts$/],
    },
  ],

  webServer: [
    {
      // No build step here (or on any entry below that runs a built
      // artifact) — `npm run test:e2e`'s `pretest:e2e` hook builds
      // packages/shared, apps/server and apps/web exactly once, up
      // front. Necessary as soon as a second entry needed the *same*
      // apps/server build (below): two `tsc --build` invocations racing
      // against the one dist/ directory intermittently crashed with
      // `Cannot find module '.../dist/index.js'`, caught while adding
      // that second entry. Running `npx playwright test` directly,
      // bypassing `npm run test:e2e`, now requires a prior manual build.
      command: 'node apps/server/dist/index.js',
      cwd: ROOT_DIR,
      url: `${SERVER_ORIGIN}/api/v1/health`,
      reuseExistingServer: false,
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
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        DWG_API_PROXY_TARGET: SERVER_ORIGIN,
      },
    },
    // M12 — a second, independent server instance (own port, own
    // DATA_DIR, own process) dedicated to `chromium-security`; see
    // `SECURITY_SERVER_PORT`'s doc comment in e2e/env.ts for why this is
    // a separate process rather than reusing the pair above.
    //
    // `STATIC_DIR` is the whole difference from the first entry: this one
    // serves the *built* SPA (`vite build`'s output, produced by
    // `pretest:e2e`) from its own origin alongside its own API — one
    // process, one origin, the production topology. It replaces the
    // test-only static+proxy server this project needed before M13; see
    // the "A third project" section of this file's header.
    {
      command: 'node apps/server/dist/index.js',
      cwd: ROOT_DIR,
      url: `${SECURITY_SERVER_ORIGIN}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        APP_MODE: 'development',
        HOST: '127.0.0.1',
        PORT: String(SECURITY_SERVER_PORT),
        DATA_DIR: SECURITY_DATA_DIR,
        STATIC_DIR: join(ROOT_DIR, 'apps/web/dist'),
        COOKIE_SECURE: 'false',
        BOOTSTRAP_ADMIN_EMAIL,
        BOOTSTRAP_ADMIN_PASSWORD,
      },
    },
  ],
});
