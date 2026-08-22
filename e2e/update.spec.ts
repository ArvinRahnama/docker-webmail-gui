/**
 * Update — the third of Round D's three specs, and the last of the twelve
 * critical workflows IMPLEMENTATION_PLAN.md §2.4 lists (backup and
 * restore are `backup-and-restore.spec.ts`). M10 exit criteria.
 *
 * The workflow *is* the refusal (IMPLEMENTATION_PLAN.md §2.2,
 * `updates.service.ts`'s header): applying an update needs to recreate
 * the managed container, which decomposes into stop/remove/create/start,
 * and neither `container.create` nor `container.remove` exists in
 * `BROKER_OPERATIONS` — withholding `POST /containers/create` is the
 * reason the broker exists at all (AGENT_BRIEF.md §2). So
 * `POST /api/v1/updates/apply` always throws `CAPABILITY_UNSUPPORTED`,
 * and this spec's job is to prove the *page* surfaces that real refusal
 * rather than a hard-coded client-side string — the same distinction
 * `updates-page.test.tsx` already draws at the unit level (its own
 * "surfaces the server's own refusal rather than a hard-coded message"
 * test) — by asserting on `container.create`, a detail that exists only
 * in the server's `APPLY_REFUSED_MESSAGE` (`updates.service.ts`), never
 * in anything `updates-page.tsx` writes itself.
 *
 * Unlike `backup-and-restore.spec.ts`, this file touches neither
 * `FakeBrokerClient.running` nor the backups repository's global
 * "has anything ever been verified" fact, so it needs none of that file's
 * `chromium-serial` isolation and stays in the default parallel project.
 * The one place it *could* observe another spec's state is the "recent
 * verified backup" line in the rollback-caveat card, which reuses that
 * same global fact — this spec deliberately asserts the caveat is present
 * without asserting which of the two backup-line variants is showing,
 * since `backup-and-restore.spec.ts` verifying a backup elsewhere in this
 * run is a legitimate possibility this file must not be flaky against.
 *
 * ---------------------------------------------------------------------
 * "Could not check" is this environment's genuine, deterministic default
 * ---------------------------------------------------------------------
 * AGENT_BRIEF.md §4 / this task's own framing: "a registry that cannot be
 * reached yields Unknown, never up to date." `FakeRegistryClient` never
 * actually fails — the reachable-vs-unreachable case Round C's DNS specs
 * exercise (a resolver timing out) has no equivalent lever here, since
 * `resolveTagDigest` "never throws" by contract and the fake always
 * succeeds. What *does* reliably reach `available: null` in this exact
 * environment is `updates.service.ts`'s join one step earlier:
 * `currentDigest` comes from `containerInspect().image`, which the fixture
 * container sets to a tag reference
 * (`ghcr.io/docker-mailserver/docker-mailserver:latest`,
 * `drivers/broker/fixtures/containers.ts`) rather than a content digest,
 * so it never equals any `imageList()` entry's `id` (all `sha256:...`,
 * `drivers/broker/fixtures/images.ts`). No matching local image means no
 * repo tag to look up, so the registry call never happens and `available`
 * stays `null` — "Could not check", never a false "Up to date". This is
 * not a bug this spec is routing around: `updates.routes.test.ts` already
 * names and locks in exactly this scenario ("reports Unknown
 * (available: null), not a crash, when no local image matches the running
 * digest"), so the unmodified fakes this E2E harness runs against
 * (`create-broker-client.ts`/`create-registry-client.ts`'s development
 * defaults) make this the natural, deterministic state of this page —
 * regardless of run order, workers, or anything any other spec does.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('update', () => {
  test("reports the registry as unreachable-for-comparison, never as up to date, and the page surfaces the server's own apply refusal", async ({
    page,
  }) => {
    await page.goto('/maintenance/updates');
    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();

    // The three-state verdict (AGENT_BRIEF.md §4's DNS-state discipline,
    // applied to registry comparison by updates-page.tsx's own
    // updateStatusOf): neither of the other two labels ever appears
    // alongside "Could not check".
    await expect(page.getByText('Could not check')).toBeVisible();
    await expect(page.getByText('Up to date')).not.toBeVisible();
    await expect(page.getByText('Update available')).not.toBeVisible();
    await expect(page.getByText(/registry could not be reached/i)).toBeVisible();

    // Both halves of the comparison are server-derived, not placeholders:
    // the real running image reference, and "Could not be resolved" for
    // the registry side specifically (never a blank cell) plus "None
    // recorded" for tags — the direct consequence of the join this file's
    // header explains.
    await expect(
      page.getByText('ghcr.io/docker-mailserver/docker-mailserver:latest'),
    ).toBeVisible();
    await expect(page.getByText('Could not be resolved')).toBeVisible();
    await expect(page.getByText('None recorded')).toBeVisible();

    await expect(page.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://github.com/docker-mailserver/docker-mailserver/releases',
    );

    // The rollback caveat: unconditional, next to the version comparison,
    // regardless of whether an update is even available (it is not, here)
    // and regardless of the backup-gate line beside it, which this spec
    // does not pin to one branch — see this file's header.
    await expect(page.getByText(/cannot undo/i)).toBeVisible();
    await expect(
      page.getByText(/A verified backup exists|No recent verified backup is on record/),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Apply update' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: 'Apply update' })).toBeVisible();
    // Tier 3 (not 4): the request is refused server-side regardless, but
    // the typed-confirmation friction is real — updates-page.tsx's own
    // comment: "an admin should meet the same friction whether or not
    // today's broker happens to refuse it."
    await expect(dialog.getByText(/broker cannot create or remove containers/i)).toBeVisible();

    const confirmButton = dialog.getByRole('button', { name: 'Apply update', exact: true });
    await expect(confirmButton).toBeDisabled();
    await dialog.getByRole('textbox').fill('docker-mailserver');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // The refusal reaching the page is the server's own message, not a
    // client-side fallback: `container.create` is a detail that exists
    // only in `updates.service.ts`'s `APPLY_REFUSED_MESSAGE`, never in
    // anything updates-page.tsx writes itself, and it names the concrete
    // host command an admin should run instead.
    await expect(page.getByText(/container\.create/)).toBeVisible();
    await expect(page.getByText(/docker compose pull && docker compose up -d/)).toBeVisible();
    await expect(dialog).toBeHidden();
  });
});
