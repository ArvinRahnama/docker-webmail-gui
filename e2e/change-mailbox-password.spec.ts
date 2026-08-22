/**
 * Change a mailbox password — an M7 exit criterion (IMPLEMENTATION_PLAN.md
 * §3) and one of the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts).
 * Creates its own dedicated mailbox as an arrange step rather than relying
 * on one from another spec: `FakeDmsDriver` is one shared instance for the
 * whole run (one server process backs every spec — see env.ts's
 * `E2E_MAIL_DOMAIN` comment), so a spec that depended on another spec's
 * mailbox still existing would only pass by accident of file/worker
 * ordering. (create-mailbox.spec.ts owns asserting *that* creation flow
 * itself; this file reuses it purely as setup.)
 *
 * What "verify the write really landed" can and can't mean here: unlike a
 * created mailbox (visible in a list) or an admin's own password (provable
 * by logging in again — login.spec.ts), a *mailbox's* password changing
 * has no admin-facing read path at all, by design — SECURITY.md and
 * working agreement #5 ("secrets never enter... responses") mean the API
 * never echoes a hash, and this panel authenticates administrators, not
 * mail users, so there's no "log in as the mailbox" check available
 * either. The strongest verification actually available from outside the
 * server process: the real PATCH request reached the real endpoint and
 * got back the real (contentless-by-design) success contract — not a
 * client-side no-op — and the mailbox's own page still loads cleanly after
 * a full reload afterward.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, E2E_MAIL_DOMAIN } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('change mailbox password', () => {
  test('changes a mailbox password through a real round trip to the server', async ({ page }) => {
    const email = `e2e-password-test@${E2E_MAIL_DOMAIN}`;
    const initialPassword = 'the-initial-mailbox-password';
    const newPassword = 'the-replacement-mailbox-password';

    // Arrange: a dedicated mailbox for this spec alone.
    await page.goto('/mail/mailboxes');
    await page.getByRole('button', { name: 'Add mailbox' }).click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('Email address', { exact: true }).fill(email);
    await createDialog.getByLabel('Password', { exact: true }).fill(initialPassword);
    await createDialog.getByLabel('Confirm password', { exact: true }).fill(initialPassword);
    await createDialog.getByRole('button', { name: 'Create mailbox' }).click();
    await expect(createDialog).toBeHidden();

    await page.getByRole('button', { name: email, exact: true }).click();
    await expect(page.getByRole('heading', { name: email })).toBeVisible();

    await page.getByRole('button', { name: 'Change password' }).click();
    const passwordDialog = page.getByRole('dialog');
    await expect(passwordDialog.getByRole('heading', { name: 'Change password' })).toBeVisible();

    await passwordDialog.getByLabel('New password', { exact: true }).fill(newPassword);
    await passwordDialog.getByLabel('Confirm new password', { exact: true }).fill(newPassword);

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          res.url().includes(`/api/v1/mailboxes/${encodeURIComponent(email)}/password`),
      ),
      passwordDialog.getByRole('button', { name: 'Change password' }).click(),
    ]);

    // { changed: true } is the entire response contract
    // (ChangeMailboxPasswordResponseSchema, packages/shared/src/mail.ts) —
    // see this file's header comment for why nothing stronger is
    // observable from outside the server process.
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ changed: true });

    await expect(page.getByText('Password changed.')).toBeVisible();
    await expect(passwordDialog).toBeHidden();

    // Reload discards every client-side cache. If the round trip above had
    // left FakeDmsDriver's account record for this mailbox corrupted
    // (rather than genuinely, cleanly updated), this is where it would
    // show up — the detail page failing to load, or the mailbox missing
    // its "Change password" control.
    await page.reload();
    await expect(page.getByRole('heading', { name: email })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
  });
});
