/**
 * IMPLEMENTATION_PLAN.md §2.4's accessibility row: "Zero critical/serious
 * violations per route; keyboard-only completion of critical paths."
 * Against `chromium-security`'s real, *built* SPA — served by a real
 * `apps/server` with `STATIC_DIR` set, from the same origin as its API,
 * exactly as the shipped image does (playwright.config.ts's "A third
 * project" section explains why this project rather than the main one).
 * The first time this project has had a real browser to run axe-core
 * against at all.
 *
 * This sweep is the direct reason `main.tsx`'s missing stylesheet import
 * (fixed earlier in M12) had to be found and fixed *before* this file
 * could mean anything: axe's colour-contrast and several other rules
 * need real computed styles to check against. Run against the unstyled
 * build that shipped before that fix, this sweep would have been
 * checking the wrong artifact — passing or failing almost by accident,
 * never actually exercising this app's real design tokens.
 *
 * The route list is `command-palette.tsx`'s `NAV_GROUPS` flattened by
 * hand, not imported — `e2e/`'s tsconfig project has no reference to
 * apps/web's React/JSX/`@/`-aliased module graph, and pulling
 * command-palette.tsx in as a dependency of a Node-side Playwright spec
 * would drag its whole component tree along for no benefit.
 * `apps/web/src/command-palette/command-palette.route-coverage.test.ts`
 * is what actually keeps `NAV_GROUPS` itself honest against `App.tsx`;
 * keeping this list in sync with `NAV_GROUPS` by hand is a smaller,
 * bounded risk than that file's own subject (a missing route here costs
 * this milestone's accessibility coverage one page, not a security
 * property).
 */
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { SECURITY_AUTH_STATE_PATH } from '../env.js';

const AUTHENTICATED_ROUTES = [
  '/',
  '/mail/domains',
  '/mail/mailboxes',
  '/mail/aliases',
  '/mail/storage',
  '/mail/queue',
  '/security/email-auth',
  '/security/tls',
  '/security/rspamd',
  '/security/clamav',
  '/security/fail2ban',
  '/security/sieve',
  '/security/autoresponder',
  '/docker/containers',
  '/docker/images',
  '/docker/volumes',
  '/docker/networks',
  '/docker/logs',
  '/docker/monitoring',
  '/docker/health',
  '/docker/console',
  '/maintenance/jobs',
  '/maintenance/backups',
  '/maintenance/updates',
  '/maintenance/config',
];

/** axe reports `impact` as `null` only for a check with no pass/fail semantics of its own; every real violation carries one of the four documented levels. `minor`/`moderate` are real findings too, just not this row's bar — surfaced in the failure message so they're visible without failing the run over them. */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

async function assertNoBlockingViolations(page: Page, routeLabel: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact !== undefined && BLOCKING_IMPACTS.has(violation.impact ?? ''),
  );
  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join('\n');
    throw new Error(
      `${routeLabel}: ${blocking.length} critical/serious a11y violation(s):\n${summary}`,
    );
  }
  expect(blocking).toEqual([]);
}

test.describe('accessibility — unauthenticated', () => {
  test('/login has zero critical/serious violations', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Docker Webmail GUI' })).toBeVisible();
    await assertNoBlockingViolations(page, '/login');
  });
});

test.describe('accessibility — every nav-level route, authenticated', () => {
  test.use({ storageState: SECURITY_AUTH_STATE_PATH });

  for (const route of AUTHENTICATED_ROUTES) {
    test(`${route} has zero critical/serious violations`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('navigation', { name: 'Mail' })).toBeVisible();
      await assertNoBlockingViolations(page, route);
    });
  }
});

test.describe('keyboard-only completion of critical paths — login', () => {
  test('no mouse, tab order alone reaches every field, Enter submits', async ({ page }) => {
    await page.goto('/login');

    // The email field is autofocused (login-page.tsx) — a real keyboard
    // user reaching this page starts here without pressing Tab at all.
    await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
    await page.keyboard.type('nobody@example.test');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await page.keyboard.type('whatever-it-does-not-matter');
    // A real `<form>`'s native Enter-submits behaviour, from inside the
    // password field — never a click, never `page.keyboard.press` aimed
    // at a button that had to be found and focused first.
    await page.keyboard.press('Enter');

    await expect(page.getByRole('alert')).toBeVisible();
  });
});

test.describe('keyboard-only completion of critical paths — in-app navigation', () => {
  test.use({ storageState: SECURITY_AUTH_STATE_PATH });

  test('command palette: Ctrl+K, type, Enter navigates — no mouse anywhere', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Mail' })).toBeVisible();

    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder('Search or jump to…')).toBeFocused();
    await page.keyboard.type('mailboxes');
    // command-palette.tsx renders `<Command shouldFilter={false}>` — the
    // *caller* decides which items exist (its own `matchedNavGroups`
    // filter), so cmdk never sees a "list changed" event through its own
    // filtering path and does not auto-highlight anything, unlike a
    // default `Command`. A real keyboard user reaching for this single
    // result presses the arrow key exactly once, the same as they would
    // for any of several results — this is that keypress, not a
    // workaround.
    //
    // The retry loop, not a single press-then-check: `mailboxesOption`
    // being visible is not proof the dialog has finished settling — this
    // view also fires three live-search queries (domains/mailboxes/
    // aliases) alongside the debounced nav filter, and a single
    // press-then-assert was observed to race that settling and land on
    // an unselected item. Retrying the press until `aria-selected`
    // actually sticks sidesteps pinning down every source of that
    // re-render rather than hardcoding a guess at its timing.
    const mailboxesOption = page.getByRole('option', { name: 'Mailboxes' });
    await expect(mailboxesOption).toBeVisible();
    await expect(async () => {
      await page.keyboard.press('ArrowDown');
      await expect(mailboxesOption).toHaveAttribute('aria-selected', 'true');
    }).toPass();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/mail\/mailboxes$/);
    await expect(page.getByRole('heading', { name: 'Mailboxes' })).toBeVisible();
  });
});
