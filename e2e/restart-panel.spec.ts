/**
 * Restart panel (FEATURE_MATRIX.md §22) — the self-restart flow on the
 * Settings page. The broker's `panel.restart` restarts the panel's own
 * server; because that drops the request, the UI shows a reconnecting
 * overlay and polls `/api/v1/health` until the server answers.
 *
 * Under `FakeBrokerClient` the server never actually goes down, so the
 * poll finds it healthy after the brief grace and the overlay clears —
 * which is exactly the recovery path this asserts. Authenticated via the
 * shared fixture session; `panel.restart` mutates no shared driver state
 * (the fake's panelRestart is a no-op), so it is parallel-safe.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('restart panel', () => {
  test('confirms, shows the reconnecting overlay, and recovers via the health poll', async ({
    page,
  }) => {
    await page.goto('/maintenance/config');
    await expect(page.getByRole('heading', { name: 'Server controls' })).toBeVisible();

    await page.getByRole('button', { name: 'Restart panel' }).click();

    const confirm = page.getByRole('alertdialog', { name: /Restart the panel/ });
    await expect(confirm).toBeVisible();
    // Tier-2 confirmation states the operational consequence.
    await expect(confirm).toContainText(/disconnected for a few seconds/i);
    await confirm.getByRole('button', { name: 'Restart panel' }).click();

    // The reconnecting overlay appears while the health poll runs.
    await expect(page.getByRole('alertdialog', { name: /Restarting the panel/ })).toBeVisible();

    // Once /api/v1/health answers, the overlay clears and a toast confirms.
    await expect(page.getByText('The panel is back online.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alertdialog', { name: /Restarting the panel/ })).toBeHidden();
  });
});
