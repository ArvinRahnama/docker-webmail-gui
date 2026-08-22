/**
 * Create mailbox — an M7 exit criterion (IMPLEMENTATION_PLAN.md §3) and one
 * of the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts):
 * this spec is about mailbox creation, not login, which login.spec.ts
 * already covers.
 *
 * The write is backed by `FakeDmsDriver`, whose in-memory `accounts` array
 * is genuinely mutated by `addMailbox()` and read back by
 * `listMailboxes()` (`apps/server/src/drivers/dms/fake-dms-driver.ts`) — a
 * mailbox that only appeared in the table because of an optimistic client
 * update, with the write itself silently failing, would vanish on the
 * full-page reload this test does after creating it. That's the class of
 * bug this harness is for (Round A found two of exactly this shape in the
 * login flow).
 *
 * AGENT_BRIEF.md §4: "Domains are not first-class in DMS... derived from
 * address parts... No create, delete or enable." Creating the first
 * mailbox at a never-before-seen domain is the *only* way a domain ever
 * "appears" (CreateMailboxDialog's own description text says so), so this
 * spec checks that happens too — as an observed side effect, never by
 * calling a domain-creation control, because none exists.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, E2E_MAIL_DOMAIN } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('create mailbox', () => {
  test('creates a mailbox that survives a reload, and its domain appears as a derived domain', async ({
    page,
  }) => {
    const email = `e2e-new-mailbox@${E2E_MAIL_DOMAIN}`;
    const password = 'a-fresh-mailbox-password';

    await page.goto('/mail/mailboxes');
    await expect(page.getByRole('heading', { name: 'Mailboxes' })).toBeVisible();

    await page.getByRole('button', { name: 'Add mailbox' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add mailbox' })).toBeVisible();

    await dialog.getByLabel('Email address', { exact: true }).fill(email);
    await dialog.getByLabel('Password', { exact: true }).fill(password);
    await dialog.getByLabel('Confirm password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Create mailbox' }).click();

    await expect(page.getByText(`Mailbox ${email} created.`)).toBeVisible();
    await expect(dialog).toBeHidden();

    // Visible without a reload — React Query's own cache. The weaker half
    // of the claim; a purely-optimistic update would look identical here.
    await expect(page.getByRole('button', { name: email, exact: true })).toBeVisible();

    // The half that actually proves it: a full reload discards every
    // client-side cache and refetches from the server. If addMailbox()
    // hadn't genuinely mutated FakeDmsDriver's state, this is exactly
    // where the mailbox would disappear.
    await page.reload();
    await expect(page.getByRole('button', { name: email, exact: true })).toBeVisible();

    await page.goto('/mail/domains');
    await expect(page.getByText(E2E_MAIL_DOMAIN)).toBeVisible();
  });
});
