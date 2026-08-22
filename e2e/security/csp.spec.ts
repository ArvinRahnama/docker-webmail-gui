/// <reference lib="dom" />
/**
 * SECURITY.md Part 5 check 7, second half: "the CSP not broken by the
 * real app." `apps/server/src/security/security-headers.security.test.ts`
 * already proves the header itself is correct on every server response;
 * what only a real browser can prove is whether *enforcing* that policy
 * breaks anything React/Tailwind v4/shadcn's actual rendered output does
 * — an inline `<style>` tag, an inline event handler, an `eval`, a CDN
 * asset. That needs a real browser applying a real CSP to the real
 * *built* bundle, which is exactly what `chromium-security`
 * (playwright.config.ts) and `static-proxy-server.mjs` exist to provide;
 * see that script's own header for why this can't just reuse the main
 * harness's Vite dev server (its own HMR client is not CSP-clean, for
 * reasons that have nothing to do with this app's code).
 *
 * Every navigation below listens for the browser's own
 * `securitypolicyviolation` event — fired by the browser itself the
 * instant it *blocks* something the policy forbids, which is a strictly
 * stronger signal than scraping console output (a blocked inline script
 * also logs a console error, but not every console error is a CSP
 * violation, and relying on message-text matching would be exactly the
 * brittle-parsing thing this project avoids elsewhere).
 */
import { expect, test } from '@playwright/test';
import { buildCspHeaderValue } from '@dwg/shared';
import { BOOTSTRAP_ADMIN_EMAIL, SECURITY_AUTH_STATE_PATH } from '../env.js';

interface CspViolation {
  readonly blockedURI: string;
  readonly violatedDirective: string;
  readonly sourceFile: string;
}

/** Attaches a `securitypolicyviolation` listener before any navigation happens, so a violation on the very first paint is still captured. Returns a function that reads back everything collected so far. */
async function trackCspViolations(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: CspViolationLike[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __cspViolations: CspViolationLike[] }).__cspViolations.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
        sourceFile: event.sourceFile,
      });
    });
  });
  return async (): Promise<CspViolation[]> =>
    page.evaluate(() => (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations);
}

// Only used inside the page context above — kept as a same-shape local
// type rather than importing the DOM lib's `SecurityPolicyViolationEvent`
// into this Node-side file's type space.
interface CspViolationLike {
  readonly blockedURI: string;
  readonly violatedDirective: string;
  readonly sourceFile: string;
}

test.describe('CSP header, on the real built app', () => {
  test("the response carries exactly this project's documented policy", async ({ page }) => {
    const response = await page.goto('/login');
    expect(response).not.toBeNull();
    const header = response!.headers()['content-security-policy'];
    expect(header).toBe(buildCspHeaderValue());
  });
});

test.describe('CSP enforcement does not break the real app — unauthenticated', () => {
  test('the login page loads and is usable with zero CSP violations', async ({ page }) => {
    const readViolations = await trackCspViolations(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Docker Webmail GUI' })).toBeVisible();

    // Deliberately the *wrong* password, not BOOTSTRAP_ADMIN_PASSWORD: by
    // the time this spec runs, global-setup.ts has already consumed the
    // bootstrap admin's real password rotating it away (the same reason
    // login.spec.ts drives a throwaway admin for its own success case).
    // A real, uniform-failure round trip — form submit, the rendered
    // alert, no redirect — exercises exactly as much real interaction as
    // a successful one for this file's purpose (CSP compliance), without
    // this spec needing its own admin.
    await page.getByLabel('Email', { exact: true }).fill(BOOTSTRAP_ADMIN_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    expect(await readViolations()).toEqual([]);
  });
});

test.describe('CSP enforcement does not break the real app — authenticated', () => {
  test.use({ storageState: SECURITY_AUTH_STATE_PATH });

  // A representative cross-section, not every route — this is a
  // real-browser CSP smoke sweep; `accessibility.spec.ts` is the file
  // that visits every nav-level route exhaustively, and there is no
  // reason CSP behaviour would vary per route the way accessibility
  // violations can (the policy is a static, global response header, not
  // something a single page's markup could opt out of).
  const ROUTES = [
    '/',
    '/mail/domains',
    '/mail/mailboxes',
    '/mail/aliases',
    '/security/rspamd',
    '/security/sieve',
    '/docker/containers',
    '/maintenance/backups',
    '/maintenance/config',
  ];

  for (const route of ROUTES) {
    test(`${route} renders with zero CSP violations`, async ({ page }) => {
      const readViolations = await trackCspViolations(page);
      await page.goto(route);
      // Every one of these routes lives inside AppLayout — its nav landmark
      // is real, rendered chrome, not just "the URL changed."
      await expect(page.getByRole('navigation', { name: 'Mail' })).toBeVisible();
      expect(await readViolations()).toEqual([]);
    });
  }

  test('opening the command palette (dialog, live search, keyboard shortcut) triggers zero CSP violations', async ({
    page,
  }) => {
    const readViolations = await trackCspViolations(page);
    await page.goto('/');
    // The app shell (and its keydown listener) must be mounted before a
    // keyboard shortcut means anything — the route-sweep tests above wait
    // on this same landmark for the same reason.
    await expect(page.getByRole('navigation', { name: 'Mail' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder('Search or jump to…')).toBeVisible();
    await page.keyboard.type('dashboard');
    await page.keyboard.press('Escape');
    expect(await readViolations()).toEqual([]);
  });
});
