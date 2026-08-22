/**
 * Logout — M6's exit criterion, deferred from Round A, and one of the
 * twelve critical workflows IMPLEMENTATION_PLAN.md §2.4 lists.
 *
 * Signs itself in as a throwaway admin (`createThrowawayAdmin`,
 * api-helpers.ts) rather than loading the shared fixture session
 * (`AUTH_STATE_PATH`): this test's entire point is ending a session, and
 * revoking the *shared* one would break any other spec still relying on
 * it in a parallel worker for a reason that has nothing to do with
 * whatever that spec is actually testing. See AUTH_STATE_PATH's doc
 * comment in env.ts.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createThrowawayAdmin } from './api-helpers.js';
import { NEW_ADMIN_PASSWORD } from './env.js';

const THROWAWAY_ADMIN_TEMP_PASSWORD = 'a-throwaway-battery-staple';

test.describe('logout', () => {
  test('signs out and genuinely revokes the session, not just the client-side route', async ({
    page,
  }) => {
    const email = `e2e-logout-${randomUUID()}@example.test`;
    await createThrowawayAdmin(email, THROWAWAY_ADMIN_TEMP_PASSWORD);

    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(THROWAWAY_ADMIN_TEMP_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/change-password$/);
    await page.getByLabel('Current password', { exact: true }).fill(THROWAWAY_ADMIN_TEMP_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_ADMIN_PASSWORD);
    await page.getByLabel('Confirm new password', { exact: true }).fill(NEW_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/mail\/domains$/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Docker Webmail GUI' })).toBeVisible();

    // The half that actually proves it: a genuinely revoked session, not
    // merely a client-side navigation to /login. Requesting a protected
    // route directly, with whatever cookie the browser still has, must
    // bounce back to /login rather than render the app shell — logout's
    // clearSessionCookie (auth.routes.ts) has to have actually cleared
    // (or the server actually revoked) the cookie, not just told the SPA
    // to stop showing it.
    await page.goto('/mail/mailboxes');
    await expect(page).toHaveURL(/\/login$/);
  });
});
