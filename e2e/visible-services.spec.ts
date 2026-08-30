/**
 * The webmail-services visibility filter (FEATURE_MATRIX.md §22-26). On a
 * shared host the panel must list only the webmail stack; the broker
 * filters each list before it reaches the web tier. Against the real built
 * flow with `FakeBrokerClient`, whose shared-host fixture
 * (apps/server/src/drivers/broker/fixtures/containers.ts) includes two
 * unrelated host containers/images that must never appear.
 *
 * Starts authenticated via the shared fixture session (read-only reads —
 * safe to run in parallel with other specs).
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('visible-services filter', () => {
  test('the containers list shows the webmail stack and hides unrelated host containers', async ({
    page,
  }) => {
    await page.goto('/docker/containers');
    await expect(page.getByRole('heading', { name: 'Mail container' })).toBeVisible();

    // Visible webmail services appear as rows.
    await expect(page.getByRole('row').filter({ hasText: 'mailserver' }).first()).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'roundcube' }).first()).toBeVisible();

    // Unrelated host containers are never listed — not merely hidden, but
    // never sent to the web tier at all.
    await expect(page.getByText('nginx-proxy-manager')).toHaveCount(0);
    await expect(page.getByText('owner-website')).toHaveCount(0);
  });

  test('the images list hides unrelated host images', async ({ page }) => {
    await page.goto('/docker/images');
    await expect(page.getByRole('heading', { name: 'Images' })).toBeVisible();

    await expect(page.getByText('roundcube/roundcubemail:latest')).toBeVisible();
    // The nginx-proxy-manager image belongs to a hidden container and
    // matches no pattern, so it never appears.
    await expect(page.getByText('jc21/nginx-proxy-manager:latest')).toHaveCount(0);
  });
});
