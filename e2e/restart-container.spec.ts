/**
 * Restart container — an M9 exit criterion (IMPLEMENTATION_PLAN.md §3) and
 * one of the twelve critical workflows §2.4 lists. Also covers the
 * companion honesty check: lifecycle actions are Tier 2
 * (FEATURE_MATRIX.md §22-23) and must state the operational consequence,
 * and dismissing the confirmation must restart nothing.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts). Safe
 * to share: this is the only Round B/C spec that mutates
 * `FakeBrokerClient`'s running/stopped state, so nothing else running in
 * a parallel worker is affected by it.
 *
 * `FakeBrokerClient.containerRestart()` just sets `running = true`
 * (apps/server/src/drivers/broker/fake-broker-client.ts) — restarting an
 * *already-running* container is a same-state no-op with nothing new to
 * observe. This spec stops the managed container first specifically so
 * restart's effect (stopped -> running again) is something a reload can
 * actually verify, the same "prove the write landed in the fake driver's
 * own state, not just the client cache" standard Round B's specs used.
 *
 * Start/Stop are the only two buttons this page renders for the managed
 * container (`isManagedRunning` gates each one's `disabled`) — a more
 * precise signal than matching "running"/"exited" text, which also appears
 * for the other visible webmail services the list now shows (roundcube and
 * the panel's own containers) regardless of the managed one's state. The
 * managed container's own state is read from its row, found by name
 * ("mailserver").
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('restart container', () => {
  test('requires confirmation — dismissing it restarts nothing — and a confirmed restart brings a stopped container back up', async ({
    page,
  }) => {
    await page.goto('/docker/containers');
    await expect(page.getByRole('heading', { name: 'Mail container' })).toBeVisible();

    // exact: true on "Start" — "Restart" contains "start" as a substring,
    // and Playwright's default text matching is case-insensitive substring
    // matching, so an unqualified getByRole('button', { name: 'Start' })
    // resolves to both buttons.
    const startButton = page.getByRole('button', { name: 'Start', exact: true });
    const stopButton = page.getByRole('button', { name: 'Stop' });
    const mailserverRow = page.getByRole('row').filter({ hasText: 'mailserver' });

    // Arrange: stop it first (its own Tier 2 confirmation — not this
    // spec's subject, just how a known "stopped" starting point is
    // reached honestly, through the real control, not a shortcut).
    await expect(stopButton).toBeEnabled();
    await stopButton.click();
    const stopDialog = page.getByRole('alertdialog');
    await stopDialog.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Mail container stopped')).toBeVisible();
    await expect(startButton).toBeEnabled();
    await expect(stopButton).toBeDisabled();
    await expect(mailserverRow).toContainText('exited');

    // The confirmation itself states the operational consequence, not
    // just "are you sure?".
    await page.getByRole('button', { name: 'Restart' }).click();
    const restartDialog = page.getByRole('alertdialog');
    await expect(
      restartDialog.getByRole('heading', { name: 'Restart the mail container?' }),
    ).toBeVisible();
    await expect(restartDialog).toContainText(/unavailable while the container restarts/i);

    // Dismiss it — nothing below must change.
    await restartDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(restartDialog).toBeHidden();
    await page.reload();
    await expect(startButton).toBeEnabled();
    await expect(stopButton).toBeDisabled();
    await expect(mailserverRow).toContainText('exited');

    // Confirm it for real this time.
    await page.getByRole('button', { name: 'Restart' }).click();
    const restartDialog2 = page.getByRole('alertdialog');
    await restartDialog2.getByRole('button', { name: 'Restart' }).click();
    await expect(page.getByText('Mail container restarted')).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(stopButton).toBeEnabled();

    // Reload discards every client-side cache and refetches from the
    // server — proof the restart reached FakeBrokerClient's own state,
    // not only an optimistic client-side update.
    await page.reload();
    await expect(startButton).toBeDisabled();
    await expect(stopButton).toBeEnabled();
    await expect(mailserverRow).toContainText('running');
  });
});
