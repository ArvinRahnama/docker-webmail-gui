/**
 * Scheduled backups + remote destinations (M13) — the E2E half of the feature,
 * driven entirely through the real Backups page against a real server.
 *
 * Everything runs against fakes: `FakeBrokerClient.archiveGet` builds the real
 * (fixture) archive, and the upload/browse/import round-trips talk to an
 * in-process fake S3 (`e2e/fake-s3.ts`) and a fake FTP server (`e2e/fake-ftp.ts`)
 * on loopback — never a real S3, never a real FTP server, never the VPS. The
 * spec points the destination config at each fake's port through the UI, so
 * the real server signs/logs in and sends genuine S3/FTP requests to it.
 *
 * Why `describe.serial` in the `chromium-serial` project: this file drives the
 * backups module and the single global destination-config row on the shared
 * server, so it must never race `backup-and-restore.spec.ts` (whose first test
 * asserts an empty backup list). See `playwright.config.ts`. Both the S3 and
 * FTP tests create their backup in `cold` mode, so their rows are unambiguous
 * next to the sibling spec's `warm` one; `newestColdBackupRow` disambiguates
 * between the two `cold` rows this file itself leaves behind, by relying on
 * the backups table's default newest-first sort (its own creation happens
 * strictly after the S3 test's).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { AUTH_STATE_PATH } from './env.js';
import { startFakeS3, type FakeS3 } from './fake-s3.js';
import { startFakeFtp, type FakeFtp } from './fake-ftp.js';

test.use({ storageState: AUTH_STATE_PATH });

const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

let fake: FakeS3;
let fakeFtp: FakeFtp;

test.beforeAll(async () => {
  fake = await startFakeS3();
});
test.afterAll(async () => {
  await fake.close();
});
test.beforeAll(async () => {
  fakeFtp = await startFakeFtp();
});
test.afterAll(async () => {
  await fakeFtp.close();
});

/** The one `cold` row the S3 test creates, back when it is still the only one. */
function coldBackupRow(page: Page): Locator {
  return page.getByRole('row').filter({ hasText: 'Cold' });
}

/**
 * After the FTP test has also created a `cold` backup, two rows match the
 * filter above. The table sorts newest-first by default (`initialSort` in
 * `backups-page.tsx`) and neither test ever changes that, so `.first()`
 * reliably targets whichever `cold` backup was created most recently —
 * exactly the FTP test's own, since it always runs after the S3 test's.
 */
function newestColdBackupRow(page: Page): Locator {
  return page.getByRole('row').filter({ hasText: 'Cold' }).first();
}

/** Waits for a started job's progress card to reach a terminal status (the Dismiss button only renders then) — the same real-completion signal backup-and-restore.spec uses. */
async function waitForJobDismiss(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible({ timeout: 20_000 });
}

test.describe.serial('scheduled backups and remote destinations', () => {
  test('configures a scheduled backup and the next run survives a reload', async ({ page }) => {
    await page.goto('/maintenance/backups');
    await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();

    await page.getByLabel('Frequency').selectOption('daily');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByText('Schedule saved')).toBeVisible();
    await expect(page.getByText(/Next run/)).toBeVisible();

    // The next run is a real persisted row, not a client-side flip.
    await page.reload();
    await expect(page.getByText(/Next run/)).toBeVisible();

    // Reset to off so no scheduled run is left armed on the shared server.
    await page.getByLabel('Frequency').selectOption('off');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByText('Schedule saved')).toBeVisible();
  });

  test('configures S3, uploads a backup, browses the remote, and imports it back', async ({
    page,
  }) => {
    test.setTimeout(90_000); // create + upload + import, each a real job.

    await page.goto('/maintenance/backups');

    // 1. Configure the S3 destination through the UI, pointed at the fake.
    await page.getByLabel('Destination', { exact: true }).selectOption('s3');
    await page.getByLabel('Endpoint').fill(`http://127.0.0.1:${fake.port}`);
    await page.getByLabel('Region').fill('us-east-1');
    await page.getByLabel('Bucket').fill('e2e-bucket');
    await page.getByLabel('Prefix (optional)').fill('backups');
    await page.getByLabel('Access key ID').fill('AKIAE2EEXAMPLE');
    await page.getByLabel('Secret access key').fill('e2e-secret-access-key');
    await page.getByRole('button', { name: 'Save destination' }).click();
    await expect(page.getByText('Remote destination saved')).toBeVisible();
    await expect(page.getByText('Configured')).toBeVisible();

    // 2. Test connection — a real signed request to the fake.
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText(/Connected to the remote/)).toBeVisible();

    // 3. Create a cold backup (distinct badge for unambiguous targeting).
    await page.getByRole('button', { name: 'Create backup' }).first().click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByRole('radio', { name: /Cold/ }).click();
    await createDialog.getByRole('button', { name: 'Create backup' }).click();
    await expect(page.getByText('Backup started')).toBeVisible();
    await waitForJobDismiss(page);

    const row = coldBackupRow(page);
    await expect(row).toBeVisible();

    // 4. Upload it to the remote — signs and streams to the fake, then verifies
    //    the remote copy by pulling it back (verifyBackupArchive).
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Upload to remote' }).click();
    await expect(page.getByText('Upload started')).toBeVisible();
    await waitForJobDismiss(page);

    // Uploaded and the local (VPS) copy reclaimed — the staging model.
    await page.reload();
    await expect(coldBackupRow(page).getByText('Uploaded')).toBeVisible();
    await expect(coldBackupRow(page).getByText('Remote only')).toBeVisible();

    // 5. Accessibility: zero critical/serious on the fully-populated page
    //    (S3 form expanded, uploaded row, both cards).
    const axe = await new AxeBuilder({ page }).analyze();
    const blocking = axe.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
    expect(blocking, JSON.stringify(blocking.map((v) => v.id))).toEqual([]);

    // 6. Browse the remote and import the backup back down (restore-from-remote
    //    step one — the server pulls and verifies before it re-registers).
    await page.getByRole('button', { name: 'Browse remote' }).click();
    const browseDialog = page.getByRole('dialog');
    await expect(
      browseDialog.getByRole('heading', { name: 'Backups on the remote' }),
    ).toBeVisible();
    await browseDialog.getByRole('button', { name: 'Import' }).first().click();
    await expect(page.getByText(/Import started/)).toBeVisible();
    await waitForJobDismiss(page);

    // The backup is local again — its "Remote only" hint is gone.
    await page.reload();
    await expect(coldBackupRow(page)).toBeVisible();
    await expect(coldBackupRow(page).getByText('Remote only')).toHaveCount(0);

    // 7. Clean up the global config so it never points at the closing fake.
    await page.getByLabel('Destination', { exact: true }).selectOption('none');
    await page.getByRole('button', { name: 'Save destination' }).click();
    await expect(page.getByText('Remote destination removed')).toBeVisible();
  });

  test('configures FTP, uploads a backup, browses the remote, and imports it back', async ({
    page,
  }) => {
    test.setTimeout(90_000); // create + upload + import, each a real job.

    await page.goto('/maintenance/backups');

    // 1. Configure the FTP destination through the UI, pointed at the fake.
    // The fake speaks plaintext FTP only (no AUTH TLS — e2e/fake-ftp.ts), so
    // FTPS must be turned off; that also exercises the plaintext-warning copy
    // and the FTPS switch itself.
    await page.getByLabel('Destination', { exact: true }).selectOption('ftp');
    await page.getByLabel('Host').fill('127.0.0.1');
    await page.getByLabel('Port').fill(String(fakeFtp.port));
    await page.getByLabel('Username').fill('e2e-ftp-user');
    await page.getByLabel('Path (optional)').fill('backups');
    await page.getByLabel('Password').fill('e2e-ftp-password');
    await page.getByRole('switch', { name: 'Use FTPS (explicit TLS)' }).click();
    await expect(page.getByText(/Plaintext FTP sends the password/)).toBeVisible();
    await page.getByRole('button', { name: 'Save destination' }).click();
    await expect(page.getByText('Remote destination saved')).toBeVisible();
    await expect(page.getByText('Configured')).toBeVisible();

    // 2. Test connection — a real FTP login to the fake.
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText(/Connected to the remote/)).toBeVisible();

    // 3. Create a second cold backup (distinct from the S3 test's own).
    await page.getByRole('button', { name: 'Create backup' }).first().click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByRole('radio', { name: /Cold/ }).click();
    await createDialog.getByRole('button', { name: 'Create backup' }).click();
    await expect(page.getByText('Backup started')).toBeVisible();
    await waitForJobDismiss(page);

    const row = newestColdBackupRow(page);
    await expect(row).toBeVisible();

    // 4. Upload it to the remote — a real STOR to the fake, then verified by
    //    pulling it back (RETR + verifyBackupArchive), exactly like the S3 path.
    await row.getByRole('button', { name: 'Actions for backup' }).click();
    await page.getByRole('menuitem', { name: 'Upload to remote' }).click();
    await expect(page.getByText('Upload started')).toBeVisible();
    await waitForJobDismiss(page);

    // Uploaded and the local (VPS) copy reclaimed — the staging model.
    await page.reload();
    await expect(newestColdBackupRow(page).getByText('Uploaded')).toBeVisible();
    await expect(newestColdBackupRow(page).getByText('Remote only')).toBeVisible();

    // 5. Accessibility: zero critical/serious on the fully-populated page with
    //    the FTP form expanded (host/port/user/path/password + FTPS switch).
    const axe = await new AxeBuilder({ page }).analyze();
    const blocking = axe.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
    expect(blocking, JSON.stringify(blocking.map((v) => v.id))).toEqual([]);

    // 6. Browse the remote — the upload really landed there — and import the
    //    backup back down (restore-from-remote step one). The server re-pulls
    //    and re-verifies the archive's checksums before it re-registers, so a
    //    successful import here is the byte-for-byte round-trip guarantee.
    await page.getByRole('button', { name: 'Browse remote' }).click();
    const browseDialog = page.getByRole('dialog');
    await expect(
      browseDialog.getByRole('heading', { name: 'Backups on the remote' }),
    ).toBeVisible();
    await browseDialog.getByRole('button', { name: 'Import' }).first().click();
    await expect(page.getByText(/Import started/)).toBeVisible();
    await waitForJobDismiss(page);

    // The backup is local again — its "Remote only" hint is gone.
    await page.reload();
    await expect(newestColdBackupRow(page)).toBeVisible();
    await expect(newestColdBackupRow(page).getByText('Remote only')).toHaveCount(0);

    // 7. Clean up the global config so it never points at the closing fake.
    await page.getByLabel('Destination', { exact: true }).selectOption('none');
    await page.getByRole('button', { name: 'Save destination' }).click();
    await expect(page.getByText('Remote destination removed')).toBeVisible();
  });
});
