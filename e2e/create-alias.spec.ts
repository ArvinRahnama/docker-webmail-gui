/**
 * Create alias — an M7 exit criterion (IMPLEMENTATION_PLAN.md §3) and one
 * of the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts):
 * this spec is about alias creation, not login.
 *
 * AGENT_BRIEF.md §4: "Aliases vs forwarding — one mechanism, one page with
 * a type column. Not two pages." This spec creates an alias whose one
 * destination is external, so it lands with type "external" — directly
 * exercising the "an alias whose destination is external is a forward"
 * claim the page's own description makes (aliases-page.tsx), rather than
 * just avoiding contradicting it.
 *
 * Backed by `FakeDmsDriver`, whose in-memory `aliases` array is genuinely
 * mutated by `putAlias()`/its `addAlias` route handler and read back by
 * `listAliases()` — same "reload, don't just trust the optimistic render"
 * verification as create-mailbox.spec.ts, for the same reason.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, E2E_MAIL_DOMAIN } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('create alias', () => {
  test('creates an external-forwarding alias that survives a reload', async ({ page }) => {
    const aliasAddress = `e2e-alias@${E2E_MAIL_DOMAIN}`;
    const externalRecipient = 'e2e-forward-target@external-e2e-mail.test';

    await page.goto('/mail/aliases');
    await expect(page.getByRole('heading', { name: 'Aliases' })).toBeVisible();

    await page.getByRole('button', { name: 'Add alias' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add alias' })).toBeVisible();

    await dialog.getByLabel('Alias address', { exact: true }).fill(aliasAddress);
    // The recipient input has no associated <label for> (aliases-page.tsx's
    // RecipientsEditor renders a bare <Label>Destinations</Label> beside
    // it, not wrapping or `htmlFor`-linked) — its placeholder is the only
    // reliable selector, and it's distinct from the alias-address field's
    // own placeholder.
    await dialog.getByPlaceholder('user@example.com').fill(externalRecipient);
    await dialog.getByRole('button', { name: 'Create alias' }).click();

    await expect(page.getByText(`${aliasAddress} created.`)).toBeVisible();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('row').filter({ hasText: aliasAddress });
    await expect(row).toContainText(externalRecipient);
    await expect(row).toContainText('external');

    // Reload discards every client-side cache and refetches from the
    // server — proof the write landed in FakeDmsDriver's own state, not
    // only in an optimistic client-side update.
    await page.reload();
    const rowAfterReload = page.getByRole('row').filter({ hasText: aliasAddress });
    await expect(rowAfterReload).toContainText(externalRecipient);
    await expect(rowAfterReload).toContainText('external');
  });
});
