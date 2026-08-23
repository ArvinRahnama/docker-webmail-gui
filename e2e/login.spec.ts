/**
 * Login — Round A of closing IMPLEMENTATION_PLAN.md §2.4's E2E gap and
 * this repository's first Playwright spec. See playwright.config.ts for
 * how the app under test is started and how each run gets isolated state.
 *
 * Covers the two load-bearing behaviours a login flow has to get right: a
 * real admin reaching the authenticated app shell, and a rejected login
 * telling nobody *why* it failed. What this file deliberately does not
 * re-assert, and why:
 *
 *  - Response status/body-shape uniformity for an unknown address vs. a
 *    wrong password — `apps/server/src/modules/auth/auth.routes.test.ts`
 *    ("POST /api/v1/auth/login — uniform failure") already covers this at
 *    the HTTP layer, more precisely than driving a browser could.
 *  - The *timing* half of that same defence (login verifies against a
 *    dummy Argon2 hash when no account exists, so an unknown address takes
 *    comparably long to reject as a real wrong password) —
 *    `apps/server/src/modules/auth/auth.service.test.ts` ("spends
 *    comparable time...") covers it where the cost actually lives. A
 *    browser round-trip adds enough of its own jitter that re-asserting a
 *    timing bound here would only be flaky, not more correct.
 *
 * What this file adds on top of that server-side coverage: proof the
 * *frontend* renders the server's uniform failure verbatim rather than
 * layering its own (possibly non-uniform) copy on top of it, and the one
 * thing no unit test can see — a real browser completing the real
 * first-login flow (sign in, mandatory password change, app shell).
 *
 * The forced-change test drives a *throwaway* admin
 * (`createThrowawayAdmin`, api-helpers.ts) rather than the bootstrap one
 * (BOOTSTRAP_ADMIN_EMAIL/PASSWORD) — global-setup.ts is the one place that
 * consumes the bootstrap admin's own one-time forced change (its header
 * comment explains why two consumers of one one-time gate would collide).
 * That's a difference in whose account is under test, not in what's being
 * tested: forcePasswordChange gates identically for every admin regardless
 * of how it came to exist, bootstrap-created or admin-created
 * (`auth.middleware.ts`'s `requireSession`, `auth-guard.tsx`'s
 * `RequireAuth`), and the bootstrap mechanism itself — env vars in,
 * exactly one admin out — is exercised for real by global-setup.ts on
 * every run (it fails the whole suite loudly if that breaks) and unit
 * tested directly in `apps/server/src/modules/auth/bootstrap.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createThrowawayAdmin } from './api-helpers.js';
import { BOOTSTRAP_ADMIN_EMAIL, NEW_ADMIN_PASSWORD } from './env.js';

const THROWAWAY_ADMIN_TEMP_PASSWORD = 'a-throwaway-battery-staple';

// The server's own copy (`apps/server/src/modules/auth/auth.routes.ts`'s
// `/login` handler) — login-page.tsx renders it verbatim rather than
// maintaining a second "generic" string that could drift from it, so
// asserting this exact text checks the frontend didn't reintroduce a
// account-existence leak on top of an already-uniform backend.
const GENERIC_LOGIN_FAILURE = 'Incorrect email or password.';

test.describe('login', () => {
  test('signs in, completes the mandatory first-login password change, and reaches the app shell', async ({
    page,
  }) => {
    // A fresh email per run (not per retry-safe by itself, but randomUUID()
    // makes a same-email CONFLICT on retry a non-issue too): this admin
    // exists solely to be logged into once, right here.
    const email = `e2e-forced-change-${randomUUID()}@example.test`;
    await createThrowawayAdmin(email, THROWAWAY_ADMIN_TEMP_PASSWORD);

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Docker Webmail GUI' })).toBeVisible();

    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(THROWAWAY_ADMIN_TEMP_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Every admin-created account starts forcePasswordChange: true
    // (admins.routes.ts), the same as the bootstrap admin
    // (bootstrap.ts) — so a *correct* first login lands on
    // /change-password, not the app shell directly (auth-guard.tsx's
    // RequireAuth). This is the real behaviour, not a detour around it.
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    await page.getByLabel('Current password', { exact: true }).fill(THROWAWAY_ADMIN_TEMP_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_ADMIN_PASSWORD);
    await page.getByLabel('Confirm new password', { exact: true }).fill(NEW_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    // "/" is the dashboard (M11 — App.tsx no longer redirects it to
    // /mail/domains) inside AppLayout — the app shell proper. Assert its
    // chrome, not just the URL: nav landmarks, the signed-in admin's own
    // email, sign-out, and the dashboard's own heading — proof this is a
    // real authenticated session landing on the real page, not merely a
    // route match.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Mail' })).toBeVisible();
    // Scoped to the banner deliberately. Unscoped, this matched the app
    // shell's identity display *and* every dashboard recent-activity row
    // mentioning this admin — and the login and forced password change this
    // test just performed each write one. How many exist when the assertion
    // runs depends on whether the dashboard's activity query has resolved,
    // so the unscoped locator was a strict-mode violation waiting on a race:
    // it passed locally (the assertion won) and failed deterministically in
    // CI on all three retries, resolving to 3 elements. The banner holds
    // exactly one — the one this test's own comment above says it asserts.
    await expect(page.getByRole('banner').getByText(email)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('rejects an unknown address and a wrong password with an identical, generic message', async ({
    page,
  }) => {
    await page.goto('/login');

    await page.getByLabel('Email', { exact: true }).fill('nobody@example.test');
    await page.getByLabel('Password', { exact: true }).fill('whatever-password-it-does-not-matter');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText(GENERIC_LOGIN_FAILURE);
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email', { exact: true }).fill(BOOTSTRAP_ADMIN_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill('not-the-actual-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText(GENERIC_LOGIN_FAILURE);
    await expect(page).toHaveURL(/\/login$/);

    // Neither failed attempt established a session — still on the login
    // form, not mid-redirect toward the app shell.
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  });
});
