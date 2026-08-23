/**
 * Backup + restore — an M10 exit criterion ("Backup + restore E2E green",
 * IMPLEMENTATION_PLAN.md §3) and two of the twelve critical workflows
 * §2.4 lists. Round D.
 *
 * ---------------------------------------------------------------------
 * Why this file is one `describe.serial` block, not independent tests
 * ---------------------------------------------------------------------
 * Every other write spec in this suite (create-mailbox, create-alias,
 * dkim-generate...) is self-contained on purpose. This one deliberately
 * is not: restore's four-tier gate genuinely depends on real backend
 * state — whether *any* backup anywhere has ever been verified
 * (`BackupsRepository.mostRecentVerified()` is global, not per-backup;
 * see `backups.repository.ts`) and whether the managed container is
 * currently running (`BrokerClient.containerInspect()`). This file is the
 * only spec in the whole suite that ever touches the backups module, so
 * it owns that global fact outright and can drive it through both states
 * on purpose: create an unverified backup, prove the "no recent verified
 * backup" gate actually refuses, then verify it and prove the gate's
 * other branch. Splitting that into independent tests would mean either
 * duplicating a create+verify cycle per test (slower, and it still
 * wouldn't fix the ordering problem below) or leaving the "unverified"
 * branch untestable once anything has ever been verified. `test.describe.serial`
 * (Playwright's documented, if discouraged-by-default, escape hatch for
 * genuinely dependent tests) keeps the three tests below in one worker,
 * strictly in order — each builds on the real backend state the previous
 * one left behind, the same backup row throughout, identified by its
 * "Warm" mode badge (this file creates exactly one backup, ever).
 *
 * ---------------------------------------------------------------------
 * The parallelism hazard (playwright.config.ts's `chromium-serial` project)
 * ---------------------------------------------------------------------
 * `FakeBrokerClient.running` (fake-broker-client.ts) is one boolean on the
 * one `FakeBrokerClient` instance the whole server process shares for the
 * life of this run (`create-broker-client.ts` picks it once at boot) — not
 * per-request, per-session or per-spec state. `restart-container.spec.ts`
 * already mutates it; restore's precondition needs the container
 * genuinely stopped, and this file's second test needs it genuinely
 * *running* to prove the "container running" gate actually refuses rather
 * than merely rendering a warning. Two spec files racing over that one
 * shared boolean under `fullyParallel: true`'s default local workers would
 * make both flaky in a way no retry fixes, because the failure is a real
 * cross-file data race, not flakiness internal to either file. Rather than
 * a retry, a timeout or a sleep, `playwright.config.ts` gives both files
 * that touch `running` — this one and `restart-container.spec.ts` — their
 * own `workers: 1` project (`chromium-serial`), so Playwright can never
 * schedule them at the same instant; see that config's own comment for
 * why `workers: 1` alone (without also moving both files out of the
 * default project via `testMatch`/`testIgnore`) would not have been
 * enough.
 *
 * ---------------------------------------------------------------------
 * Waiting for genuine job completion (ARCHITECTURE.md §7.5, §8)
 * ---------------------------------------------------------------------
 * Create/verify/restore all return a job id immediately — an
 * accepted-and-queued response, not a finished one. This is the first
 * spec in the suite to touch a stream: `backups-page.tsx` renders
 * `JobProgress` fed by `useJobStream`, a real browser `EventSource`
 * against `GET /api/v1/jobs/:id/stream` (`platform/sse.ts`,
 * `job-runner.ts`'s `publish()`). The "Dismiss" button only renders once
 * `runningJob.status` is a *terminal* status (`!isActiveJobStatus`,
 * derived from that live stream, with the one-shot `useJobQuery` as a
 * fallback for a job that had already finished before the stream
 * connected) — so every `waitForJobDismiss()` call below is this spec
 * waiting on the real backend's own report of completion via the
 * browser's own stream connection, never on the POST response, a fixed
 * delay, or a client-side timer.
 *
 * ---------------------------------------------------------------------
 * What genuinely executes underneath (AGENT_BRIEF.md working agreement #8)
 * ---------------------------------------------------------------------
 * `FakeBrokerClient.archiveGet`/`archivePut` are real implementations
 * against small hand-built tars (`drivers/broker/fixtures/archive.ts`,
 * labelled there as constructed rather than captured — there is no daemon
 * here to capture from). `backup-archive.ts`'s manifest generation,
 * `verify`'s checksum recomputation, and restore's extract-and-rewrite
 * round trip all genuinely run against those tars through this spec's
 * real HTTP calls; nothing here is mocked at the service layer.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

/** The one backup this whole file ever creates — every test locates it by this stable filter rather than a captured id, since ConfirmDialog resets between opens anyway. */
function backupRow(page: Page): Locator {
  return page.getByRole('row').filter({ hasText: 'Warm' });
}

/** Reads the exact string the tier-4 dialog's "Type X to confirm" requires, straight from the dialog's own label text — never assumed or reconstructed, so this spec adapts if the id format ever changes. */
async function readRestoreConfirmationText(dialog: Locator): Promise<string> {
  const labelText = (await dialog.getByText(/^Type .+ to confirm$/).innerText()).trim();
  const captured = /^Type (.+) to confirm$/.exec(labelText)?.[1];
  if (captured === undefined) {
    throw new Error(`readRestoreConfirmationText: unexpected label text "${labelText}"`);
  }
  return captured;
}

/** Waits for a started job's progress card to reach a terminal status — see this file's header on why this, and not the POST response, is "done". */
async function waitForJobDismiss(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible({ timeout: 15_000 });
}

/** Arranges a known container state through the real controls on `/docker/containers` — mirrors restart-container.spec.ts's own "through the real control, not a shortcut" arrange step. */
async function ensureManagedContainerRunning(page: Page): Promise<void> {
  await page.goto('/docker/containers');
  await expect(page.getByRole('heading', { name: 'Mail container' })).toBeVisible();
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  if (await startButton.isEnabled()) {
    await startButton.click();
    await expect(page.getByText('Mail container started')).toBeVisible();
  }
  await expect(startButton).toBeDisabled();
}

async function ensureManagedContainerStopped(page: Page): Promise<void> {
  await page.goto('/docker/containers');
  await expect(page.getByRole('heading', { name: 'Mail container' })).toBeVisible();
  const stopButton = page.getByRole('button', { name: 'Stop' });
  if (await stopButton.isEnabled()) {
    await stopButton.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Mail container stopped')).toBeVisible();
  }
  await expect(stopButton).toBeDisabled();
}

test.describe.serial('backup and restore', () => {
  test('creates a warm backup that survives a reload', async ({ page }) => {
    await page.goto('/maintenance/backups');
    await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();

    // Wait for the list query to settle before touching anything.
    //
    // `DATA_DIR` is a fresh `mkdtemp` per run (playwright.config.ts), so
    // this page always starts with no backups — and the first-run empty
    // state renders its *own* "Create backup" call to action alongside the
    // page header's (backups-page.tsx: `PageHeader`'s `action`, and the
    // `EmptyState`'s; `domains-list-page.test.tsx` asserts the same
    // duplication is deliberate on the mailbox pages). Before the query
    // resolves only the header button exists; after it, two do.
    //
    // Clicking without waiting is therefore a race between one match and
    // two, and `getByRole` is strict — which is exactly how this line
    // failed intermittently, as a strict-mode violation rather than a
    // timeout, and only when the machine was busy enough for the query to
    // win the race. Asserting the empty state first makes the DOM
    // deterministic, and is real coverage this test did not previously
    // have.
    await expect(page.getByRole('heading', { name: 'No backups yet' })).toBeVisible();

    // `.first()` is the page header's button in either state — it precedes
    // the table in source order. Same idiom as the radio below.
    await page.getByRole('button', { name: 'Create backup' }).first().click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByRole('heading', { name: 'Create backup' })).toBeVisible();

    // No mode is pre-selected (backups-page.tsx's own rule: "this choice
    // has no default") — Create stays refused until one is picked.
    const confirmCreate = createDialog.getByRole('button', { name: 'Create backup' });
    await expect(confirmCreate).toBeDisabled();
    await createDialog.getByRole('radio').first().click(); // "Warm" — the first radio in source order.
    await expect(confirmCreate).toBeEnabled();
    await confirmCreate.click();

    await expect(page.getByText('Backup started')).toBeVisible();
    await expect(createDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Creating backup' })).toBeVisible();

    await waitForJobDismiss(page);

    const row = backupRow(page);
    await expect(row).toBeVisible();
    await expect(row.getByText('Not verified')).toBeVisible();

    // The half that actually proves the write reached BackupsRepository's
    // own SQLite row, not just React Query's cache: a full reload discards
    // every client-side cache and refetches from the server.
    await page.reload();
    await expect(backupRow(page)).toBeVisible();
    await expect(backupRow(page).getByText('Not verified')).toBeVisible();
  });

  test('refuses restore via the type-to-confirm gate, the backup-acknowledgement gate, and a running container', async ({
    page,
  }) => {
    // Arrange: a known-running container, through the real Start control —
    // this test's subject is restore's *refusal*, not this control.
    await ensureManagedContainerRunning(page);

    await page.goto('/maintenance/backups');
    const row = backupRow(page);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Restore from this backup…' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: 'Restore from this backup?' })).toBeVisible();

    // Pre-flight is real and reports the container running, honestly —
    // the same fact `preflight()` will refuse `restore()` on server-side.
    await expect(dialog.getByText(/managed container is still running/i)).toBeVisible();

    // The backup gate: unverified, so the checkbox path is the only one
    // that can satisfy it.
    await expect(
      dialog.getByText(/No recent verified backup of the current data exists/),
    ).toBeVisible();
    const checkbox = dialog.getByRole('checkbox');
    await expect(checkbox).toBeVisible();

    const confirmButton = dialog.getByRole('button', { name: 'Restore', exact: true });
    const input = dialog.getByRole('textbox');
    const expectedText = await readRestoreConfirmationText(dialog);

    // Gate 1: type-to-confirm. Nothing typed yet.
    await expect(confirmButton).toBeDisabled();

    // Wrong text never satisfies it, however close.
    await input.fill(`${expectedText}-wrong`);
    await expect(confirmButton).toBeDisabled();

    // Gate 2: the exact text alone is still not enough — the backup gate
    // (unticked) independently blocks Confirm even though typedMatches is
    // now true.
    await input.fill(expectedText);
    await expect(confirmButton).toBeDisabled();

    // Ticking the acknowledgement satisfies both gates the dialog itself
    // enforces — but a third one, enforced server-side and re-checked by
    // the page before it ever calls the mutation, is not a UI gate at all.
    await checkbox.click();
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // Refused: the container is running. No mutation was ever sent — the
    // dialog stays open, and no restore job starts.
    await expect(page.getByText('Stop the managed container before restoring.')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Restoring backup' })).not.toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('stops the container, restores via explicit acknowledgement, verifies the backup, then restores again on a satisfied gate', async ({
    page,
  }) => {
    test.setTimeout(60_000); // Two full restore round trips plus one verify — see this file's header on why each is a real job, not a stub.

    // Restore's one non-acknowledgeable, non-overridable precondition —
    // exercised through the real Stop control, which is itself Tier 2 and
    // not this test's subject.
    await ensureManagedContainerStopped(page);

    await page.goto('/maintenance/backups');
    const row = backupRow(page);
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Restore from this backup…' }).click();

    let dialog = page.getByRole('alertdialog');
    // Pre-flight now reports the container stopped and the archive
    // compatible (both fixture inspect responses share one `image` value —
    // containers.ts) — no blockers, the positive-path sentence instead.
    await expect(
      dialog.getByText('Container stopped and archive compatible with the running image.'),
    ).toBeVisible();
    await expect(dialog.getByText(/managed container is still running/i)).not.toBeVisible();

    // The backup gate is unchanged by fixing the container — still
    // unverified, still needs the checkbox. Proves the two gates are
    // independent, not that fixing one silently satisfies the other.
    await expect(
      dialog.getByText(/No recent verified backup of the current data exists/),
    ).toBeVisible();
    let confirmButton = dialog.getByRole('button', { name: 'Restore', exact: true });
    let input = dialog.getByRole('textbox');
    await input.fill(await readRestoreConfirmationText(dialog));
    await expect(confirmButton).toBeDisabled();
    await dialog.getByRole('checkbox').click();
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.getByText('Restore started')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Restoring backup' })).toBeVisible();
    await waitForJobDismiss(page);

    // Now verify the same backup — genuinely recomputes checksums against
    // the archive on disk (backup-archive.ts's verifyBackupArchive).
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Verify archive' }).click();
    await expect(page.getByText('Verification started')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verifying backup' })).toBeVisible();
    await waitForJobDismiss(page);

    // Survives a reload: verification status is a real repository row, not
    // an optimistic client-side flip.
    await page.reload();
    await expect(row.getByText('Verified', { exact: true })).toBeVisible();
    await expect(row.getByText(/Checked/)).toBeVisible();

    // Restore once more — this time the backup gate's *other* branch:
    // a verified backup now exists, so the dialog offers no checkbox at
    // all, and Confirm needs only the typed match.
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Restore from this backup…' }).click();
    dialog = page.getByRole('alertdialog');
    await expect(
      dialog.getByText(/A recent verified backup of the current data exists/),
    ).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);

    confirmButton = dialog.getByRole('button', { name: 'Restore', exact: true });
    input = dialog.getByRole('textbox');
    await expect(confirmButton).toBeDisabled();
    await input.fill(await readRestoreConfirmationText(dialog));
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.getByText('Restore started')).toBeVisible();
    await waitForJobDismiss(page);

    // Leaves the managed container running — FakeBrokerClient's own
    // default, and the state restart-container.spec.ts (this project's
    // other file) also leaves it in, so neither is a surprise to whichever
    // of the two runs in this worker next.
    await ensureManagedContainerRunning(page);
  });
});
