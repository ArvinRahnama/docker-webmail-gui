/**
 * Small HTTP-client helpers shared between `global-setup.ts` (bootstrapping
 * the very first authenticated session there will ever be, once per run)
 * and any spec that needs a *fresh* administrator of its own on top of an
 * already-authenticated one — today, `login.spec.ts`'s forced-password-
 * change test, so it doesn't have to fight `global-setup.ts` over the one
 * bootstrap admin (see that file's header comment for why they'd collide:
 * both wanted to be the one process consuming its one-time forced password
 * change). Real HTTP calls against the real login/csrf-token/
 * change-password/admins endpoints throughout — every admin here,
 * including the throwaway one below, is created through
 * `POST /api/v1/admins`, never a hand-seeded database row.
 */
import { type APIRequestContext, request } from '@playwright/test';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { AUTH_STATE_PATH, WEB_ORIGIN } from './env.js';

/**
 * A `Sec-Fetch-Site` value a real browser sends on a same-origin
 * fetch/XHR request — spoofed by hand because these are plain HTTP calls,
 * not a browser. Same convention
 * `apps/server/src/modules/auth/auth.routes.test.ts` uses for the same
 * reason: `requireCsrf`'s same-origin check
 * (`apps/server/src/modules/auth/auth.middleware.ts`) looks for exactly
 * this header first.
 */
export const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' };

/** Logs in as `email`/`password`, storing the resulting session cookie in `api`'s own cookie jar (replacing whatever session, if any, was there before). */
export async function login(
  api: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const response = await api.post('/api/v1/auth/login', { data: { email, password } });
  if (!response.ok()) {
    throw new Error(`login: signing in as ${email} failed (${response.status()})`);
  }
}

/** Changes the password of whichever session `api`'s cookie jar currently holds. Works equally for a forced first-login change or an ordinary one — the endpoint doesn't distinguish (`auth.routes.ts`). */
export async function changePassword(
  api: APIRequestContext,
  csrfToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const response = await api.post('/api/v1/auth/change-password', {
    headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
    data: { currentPassword, newPassword },
  });
  if (!response.ok()) {
    throw new Error(`changePassword: failed (${response.status()}): ${await response.text()}`);
  }
}

/** Fetches a CSRF token for whichever session `api`'s cookie jar currently holds. */
export async function fetchCsrfToken(api: APIRequestContext): Promise<string> {
  const response = await api.get('/api/v1/auth/csrf-token', { headers: SAME_ORIGIN_HEADERS });
  if (!response.ok()) {
    throw new Error(`fetchCsrfToken: GET /auth/csrf-token failed (${response.status()})`);
  }
  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}

/** Creates an administrator as whichever (already-authenticated, `admins:manage`-permitted) session `api`'s cookie jar holds. Every admin-created account starts with `forcePasswordChange: true` (`admins.routes.ts`), same as bootstrap. */
export async function createAdmin(
  api: APIRequestContext,
  csrfToken: string,
  email: string,
  password: string,
): Promise<void> {
  const response = await api.post('/api/v1/admins', {
    headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: csrfToken },
    data: { email, password },
  });
  if (!response.ok()) {
    throw new Error(
      `createAdmin: creating ${email} failed (${response.status()}): ${await response.text()}`,
    );
  }
}

/**
 * Creates a throwaway forced-password-change administrator, authenticated
 * as whichever admin `AUTH_STATE_PATH` belongs to (`global-setup.ts`'s
 * shared fixture admin). For a spec that needs an admin distinct from that
 * shared one — because, like `login.spec.ts`, it is about to consume this
 * new admin's own one-time forced password change itself, which would
 * otherwise collide with any other spec relying on the shared session
 * still being valid.
 */
export async function createThrowawayAdmin(email: string, password: string): Promise<void> {
  const api = await request.newContext({ baseURL: WEB_ORIGIN, storageState: AUTH_STATE_PATH });
  try {
    const csrfToken = await fetchCsrfToken(api);
    await createAdmin(api, csrfToken, email, password);
  } finally {
    await api.dispose();
  }
}
