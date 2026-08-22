/**
 * Shared test-only values for the Playwright suite (IMPLEMENTATION_PLAN.md
 * §2.4's E2E row; `docs/AGENT_BRIEF.md` working agreement #8 on fixtures).
 *
 * `playwright.config.ts` passes the bootstrap pair below to the server as
 * `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`, which drives the real
 * first-administrator path (`apps/server/src/modules/auth/bootstrap.ts`) —
 * not a hand-seeded admin row. `login.spec.ts` types the identical values
 * into the UI, so config and spec can never drift apart. Working agreement
 * #8 ("fixtures are captured, never invented") is about DMS/broker fixture
 * *data* standing in for a real mail server's output; these are ordinary
 * test credentials for an account this suite creates and controls itself,
 * the same role `EMAIL`/`PASSWORD` play in
 * `apps/server/src/modules/auth/auth.routes.test.ts`.
 */
import { fileURLToPath } from 'node:url';

/** Only ever sent to a throwaway server bound to 127.0.0.1 for the lifetime of one test run — see DATA_DIR in playwright.config.ts. */
export const BOOTSTRAP_ADMIN_EMAIL = 'e2e-admin@example.test';
export const BOOTSTRAP_ADMIN_PASSWORD = 'correct-horse-battery-staple';

/**
 * What the "successful login" spec changes the bootstrap password to,
 * exercising the mandatory first-login change that `bootstrapFirstAdmin`
 * always sets (`forcePasswordChange: true`). Must differ from
 * BOOTSTRAP_ADMIN_PASSWORD — `ChangePasswordRequestSchema` refuses a new
 * password equal to the current one — and be at least
 * `PASSWORD_MIN_LENGTH` (12; `packages/shared/src/auth.ts`) characters.
 */
export const NEW_ADMIN_PASSWORD = 'a-new-battery-staple';

/**
 * Fixed, uncommon ports rather than letting the OS pick — a webServer
 * health-check URL needs to know the port up front, and fixed ports make a
 * stuck process from a previous run ("address already in use") a loud,
 * obvious failure instead of a silent reuse of the wrong server.
 */
export const SERVER_PORT = 3900;
export const WEB_PORT = 3901;
export const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/**
 * A second, fully independent `apps/server` instance, used only by the
 * `e2e/security/*.spec.ts` specs (CSP-against-the-real-build, and the
 * accessibility sweep — SECURITY.md Part 5 check 7's second half and
 * IMPLEMENTATION_PLAN.md §2.4's accessibility row). Deliberately a
 * separate port, a separate DATA_DIR (`playwright.config.ts`) and a
 * separate process from `SERVER_PORT`/`WEB_PORT` above — those two
 * already share one `FakeBrokerClient`'s process-wide `running` boolean
 * between two specs that must never race it (`playwright.config.ts`'s
 * "Two projects" comment); this instance never touches that state at
 * all, in a different process entirely, so it cannot introduce a third
 * contender for the same race by construction, not by convention.
 *
 * This instance runs with `STATIC_DIR` set, so it serves the *built* SPA
 * from the same origin as its own API — the production topology
 * (ARCHITECTURE.md §10, docker/server/Dockerfile), which is why the
 * browser origin and the API origin below are deliberately one value and
 * not two. Until M13 wired `@fastify/static` into `apps/server`, this
 * pair needed a test-only static+proxy server in front
 * (`e2e/security/static-proxy-server.mjs`, since removed) which had to
 * re-implement this project's security-header set to attach the real CSP
 * to a document it was serving itself; the real server now attaches its
 * own, so the specs assert the header the shipped image actually sends
 * rather than a duplicate that could drift from it.
 */
export const SECURITY_SERVER_PORT = 3910;
export const SECURITY_SERVER_ORIGIN = `http://127.0.0.1:${SECURITY_SERVER_PORT}`;
/** The origin `chromium-security`'s browser talks to. Identical to `SECURITY_SERVER_ORIGIN` on purpose — see above: one origin serving both the SPA and the API is the property under test, not an accident of the harness. */
export const SECURITY_WEB_ORIGIN = SECURITY_SERVER_ORIGIN;

/** `AUTH_STATE_PATH`'s counterpart for the security project — a signed-in, past-forced-change storage state scoped to `SECURITY_WEB_ORIGIN`, produced by `global-setup.ts` the same way. Never shared with `AUTH_STATE_PATH`: a cookie scoped to one origin is simply never sent to the other. */
export const SECURITY_AUTH_STATE_PATH = fileURLToPath(
  new URL('./.auth/security-admin-state.json', import.meta.url),
);

// ---------------------------------------------------------------------------
// Shared authenticated state (Round B)
// ---------------------------------------------------------------------------

/**
 * Where `global-setup.ts` writes a signed-in browser storage state (the
 * session cookie, post first-login password change) for specs that need to
 * start already authenticated — create-mailbox, create-alias and
 * change-mailbox-password all just need *some* logged-in admin, not to
 * re-prove login itself (`login.spec.ts` already does that). A fixed path,
 * not a per-run `mkdtemp` one: `global-setup.ts` (one process) writes it and
 * every spec file (each its own worker process) reads the same path back —
 * a `mkdtemp` directory computed independently in each process would give
 * each of them a *different* path. Regenerated at the start of every run
 * (global-setup.ts runs once, before any test, and always overwrites it), so
 * reusing the path across runs never reuses stale state. Gitignored
 * (`/e2e/.auth/`) — it holds a live, if synthetic, session cookie.
 *
 * `logout.spec.ts` deliberately does NOT use this: it logs itself in, so
 * that revoking its session by logging out can never race a *different*
 * spec still relying on this same shared cookie in a parallel worker.
 */
export const AUTH_STATE_PATH = fileURLToPath(new URL('./.auth/admin-state.json', import.meta.url));

/**
 * Test-only mail addresses. Namespaced under a distinct `.test` domain
 * (RFC 2606 — reserved, never a real registrable TLD) with per-spec local
 * parts, so no spec can ever collide with another spec's data or with the
 * fixture accounts `FakeDmsDriver` seeds itself
 * (`admin@example.com`, `user1@example.com`, `sales@example.com`,
 * `info@otherdomain.tld`, `user1@domainone.tld` —
 * `apps/server/src/drivers/dms/fixtures/postfix-accounts.ts`). One shared
 * `FakeDmsDriver` instance backs the whole run (`buildApp` builds it once
 * per server process), so every spec's writes land in the same in-memory
 * state as every other spec's — distinct addresses are what keeps them from
 * interfering with each other under parallel execution, not test isolation
 * the harness provides for free.
 */
export const E2E_MAIL_DOMAIN = 'dwg-e2e.test';
