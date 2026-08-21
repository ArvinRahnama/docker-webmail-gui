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
