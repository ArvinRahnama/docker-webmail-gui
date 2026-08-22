/**
 * Runs once per `playwright test` invocation, after both `webServer`
 * entries report healthy and before any spec runs (Playwright's documented
 * order for combining the two) — see playwright.config.ts's `globalSetup`.
 *
 * Produces one thing: a signed-in, past-the-forced-password-change browser
 * storage state at `AUTH_STATE_PATH`, for the specs that just need *some*
 * authenticated admin and aren't themselves testing login
 * (create-mailbox.spec.ts, create-alias.spec.ts,
 * change-mailbox-password.spec.ts — see AUTH_STATE_PATH's own doc comment
 * in env.ts for why logout.spec.ts deliberately opts out).
 *
 * That storage state deliberately belongs to a *second* administrator this
 * function creates, not the bootstrap one. Reusing the bootstrap admin here
 * was the first thing tried, and it broke login.spec.ts: both wanted to be
 * the one process consuming the bootstrap account's one-time forced
 * password change, and whichever ran second found the password already
 * rotated out from under it, indistinguishable from a wrong-password
 * login. There is exactly one bootstrap admin per server, so it stays
 * reserved for login.spec.ts's *own* forced-change test — which, for the
 * identical reason, now drives a throwaway admin of its own
 * (`createThrowawayAdmin` in api-helpers.ts) rather than the bootstrap one
 * either, once one exists to create it with. This function creates an
 * ordinary second admin through `POST /api/v1/admins` — itself only
 * reachable once the bootstrap admin's own forced change is done, so that
 * step still has to happen here, the one place it's safe to — and
 * completes *its* forced change instead.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { request } from '@playwright/test';
import { changePassword, createAdmin, fetchCsrfToken, login } from './api-helpers.js';
import {
  AUTH_STATE_PATH,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  NEW_ADMIN_PASSWORD,
  WEB_ORIGIN,
} from './env.js';

/** Only ever exists inside this one throwaway server for the life of one test run — see AUTH_STATE_PATH's doc comment in env.ts. */
const SHARED_ADMIN_EMAIL = 'e2e-shared@example.test';
const SHARED_ADMIN_TEMP_PASSWORD = 'a-temporary-battery-staple';
const SHARED_ADMIN_PASSWORD = 'a-settled-battery-staple';

export default async function globalSetup(): Promise<void> {
  // Routed through the Vite dev-server proxy (WEB_ORIGIN), not straight to
  // the server (SERVER_ORIGIN) — the resulting cookie must be scoped to
  // the same origin every spec's `page` actually navigates to, or no
  // browser would ever send it back.
  const api = await request.newContext({ baseURL: WEB_ORIGIN });

  try {
    // 1. The bootstrap admin's own mandatory first-login change — a
    //    prerequisite for calling POST /api/v1/admins below (that route's
    //    requireSession has no allowPasswordChangeRequired allowance,
    //    unlike csrf-token/change-password/logout/session), not the thing
    //    this setup is actually for.
    await login(api, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD);
    let csrfToken = await fetchCsrfToken(api);
    await changePassword(api, csrfToken, BOOTSTRAP_ADMIN_PASSWORD, NEW_ADMIN_PASSWORD);

    // 2. Create the second admin the shared storage state actually
    //    belongs to, while still holding the bootstrap admin's
    //    now-unblocked session.
    await createAdmin(api, csrfToken, SHARED_ADMIN_EMAIL, SHARED_ADMIN_TEMP_PASSWORD);

    // 3. Switch to the new admin (login() overwrites the session cookie in
    //    this context's own cookie jar) and complete its own mandatory
    //    first-login change — every admin-created account starts forced,
    //    same as bootstrap (admins.routes.ts).
    await login(api, SHARED_ADMIN_EMAIL, SHARED_ADMIN_TEMP_PASSWORD);
    csrfToken = await fetchCsrfToken(api);
    await changePassword(api, csrfToken, SHARED_ADMIN_TEMP_PASSWORD, SHARED_ADMIN_PASSWORD);

    // Now a clean, non-forced session — exactly what a spec loading this
    // storage state should land on the app shell with.
    mkdirSync(dirname(AUTH_STATE_PATH), { recursive: true });
    await api.storageState({ path: AUTH_STATE_PATH });
  } finally {
    await api.dispose();
  }
}
