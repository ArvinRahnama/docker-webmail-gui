/**
 * View logs — an M9 exit criterion (IMPLEMENTATION_PLAN.md §3) and one of
 * the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts).
 *
 * Purely a read: there is no write to verify survives a reload the way
 * Round B's specs did. What this spec proves instead is that each of the
 * three tabs — container output, mail log, fail2ban log — genuinely
 * fetches its own distinct backend content
 * (`apps/server/src/drivers/broker/fixtures/logs.ts`), rather than the
 * three tabs all rendering the same (or static/placeholder) lines under
 * different labels: each fixture below is a line that appears in exactly
 * one of the three sources, so seeing the right one per tab — and *not*
 * the other two's — is what a real, source-parameterised
 * `GET /api/v1/docker/logs*` round trip looks like from the outside.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

// Not FIXTURE_LOG_LINES[0] — its text ("postfix/smtpd[142]: connect from
// unknown[203.0.113.7]") is also a substring of FIXTURE_MAIL_LOG_LINES[0]
// under a different syslog prefix (both fixtures narrate the same
// illustrative connection), so it doesn't distinguish the two sources.
// This line is unique to the container fixture.
const CONTAINER_LINE =
  'dovecot: imap-login: Login: user=<admin@example.com>, method=PLAIN, rip=203.0.113.7';
const MAIL_LOG_LINE = 'postfix/cleanup[145]: 4B2F1C0001: message-id=<a1b2c3@example.com>';
const FAIL2BAN_LINE = 'fail2ban.actions [1]: NOTICE [dovecot] Ban 203.0.113.9';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('view logs', () => {
  test('each tab shows its own distinct log content from the real backend', async ({ page }) => {
    await page.goto('/docker/logs');
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();

    // "Container output" is the default tab.
    await expect(page.getByText(CONTAINER_LINE)).toBeVisible();
    await expect(page.getByText(MAIL_LOG_LINE)).not.toBeVisible();
    await expect(page.getByText(FAIL2BAN_LINE)).not.toBeVisible();

    await page.getByRole('button', { name: 'Mail log' }).click();
    await expect(page.getByText(MAIL_LOG_LINE)).toBeVisible();
    await expect(page.getByText(CONTAINER_LINE)).not.toBeVisible();
    await expect(page.getByText(FAIL2BAN_LINE)).not.toBeVisible();

    await page.getByRole('button', { name: 'Fail2ban log' }).click();
    await expect(page.getByText(FAIL2BAN_LINE)).toBeVisible();
    await expect(page.getByText(CONTAINER_LINE)).not.toBeVisible();
    await expect(page.getByText(MAIL_LOG_LINE)).not.toBeVisible();

    // Refresh re-fetches the currently active source rather than only
    // ever showing the first response.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText(FAIL2BAN_LINE)).toBeVisible();
  });
});
