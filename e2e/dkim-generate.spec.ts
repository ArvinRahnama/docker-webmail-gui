/**
 * DKIM generate — an M8 exit criterion (IMPLEMENTATION_PLAN.md §3) and one
 * of the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts).
 *
 * This is `FakeDmsDriver`'s side of DKIM (`generateDkim`/`getDkimRecord`,
 * backed by its own `dkimKeys` Map — mirrors `setup config dkim`), a
 * different subsystem from `drivers/dns/dkim-dns.ts`'s DNS-side presence
 * check dns-check.spec.ts already covers: this is "generate a key pair
 * and publish its record for an admin to copy," not "does DNS currently
 * have one." Uses its own domain, seeded with no DNS records at all — the
 * point is generation, not the separate DNS-matches-what-was-generated
 * comparison.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

const DKIM_TEST_DOMAIN = 'e2e-dkim.test';
const DKIM_SELECTOR = 'mail';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('DKIM generate', () => {
  test('generates a key pair whose public record survives a reload', async ({ page }) => {
    await page.goto(`/security/email-auth/${DKIM_TEST_DOMAIN}`);
    await expect(page.getByRole('heading', { name: DKIM_TEST_DOMAIN, exact: true })).toBeVisible();

    await expect(
      page.getByText(`No key has been generated yet for selector "${DKIM_SELECTOR}".`),
    ).toBeVisible();

    // Only one "Generate key" control exists before the dialog opens (the
    // trigger); once open, its own confirm button shares that label, so
    // later interactions are scoped to the dialog specifically.
    await page.getByRole('button', { name: 'Generate key' }).click();

    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog.getByRole('heading', { name: 'Generate DKIM key' })).toBeVisible();
    await expect(confirmDialog).toContainText(DKIM_TEST_DOMAIN);
    await confirmDialog.getByRole('button', { name: 'Generate key' }).click();

    await expect(
      page.getByText('DKIM key generated. Publish the new record, then verify once DNS updates.'),
    ).toBeVisible();
    await expect(confirmDialog).toBeHidden();

    const recordName = `${DKIM_SELECTOR}._domainkey.${DKIM_TEST_DOMAIN}`;
    await expect(page.getByText(recordName)).toBeVisible();
    await expect(page.getByText(/v=DKIM1/)).toBeVisible();
    // A key now exists, so the same control offers rotation instead.
    await expect(page.getByRole('button', { name: 'Rotate key' })).toBeVisible();

    // Reload discards every client-side cache and refetches from the
    // server. If generateDkimMutation had only updated an optimistic
    // client cache rather than FakeDmsDriver's own dkimKeys state, the
    // record would be gone and the page would be back to "No key has
    // been generated yet."
    await page.reload();
    await expect(page.getByText(recordName)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rotate key' })).toBeVisible();
  });
});
