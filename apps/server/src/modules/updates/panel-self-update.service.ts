/**
 * The panel's own self-update surface (docs/design/self-update.md — SU-C),
 * deliberately a separate service from `UpdatesService` (which is entirely
 * about docker-mailserver — see that file's own header). Auto-latest only
 * (§9.1): `getStatus` resolves the newest published release itself via
 * `SelfUpdateReleaseSourcePort` and `apply` always targets it; there is no
 * field anywhere in this service, or in `PanelUpdateApplyAckSchema`'s
 * request, for a caller to name a different version.
 *
 * `apply` enqueues a `panel.selfUpdate` job (the existing `JobRunner`,
 * streamed over the existing `GET /api/v1/jobs/:id/stream` SSE) rather
 * than awaiting the recreate itself — consistent with every other
 * long-running operation in this codebase (ARCHITECTURE.md §7.5) — but
 * that job's own terminal status is **not** the self-update's real
 * verdict. In production the request that launched the updater is the
 * same process about to be replaced (docs/design/self-update.md §6): the
 * job's `execute()` typically never gets the chance to return before its
 * own process is torn down, so a restart leaves the row `running`, and
 * `JobsRepository.recoverInterruptedJobs()` then marks it `failed:
 * interrupted by a server restart...` at next boot — an accurate
 * description of what happened to *that request*, but not of whether the
 * update itself succeeded. The real verdict is discovered separately,
 * through `readLastResult` (`panel-self-update-status.ts`), which reads
 * the durable status file the updater itself wrote — this is exactly why
 * that file exists at all, and why nothing in this service ever answers
 * "did the last self-update succeed" by inspecting a job row.
 */
import type { Job, JsonValue, PanelUpdateCheckResponse, SelfUpdateResult } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';
import type { SelfUpdateReleaseSourcePort } from '../../drivers/self-update/types.js';
import { AppError } from '../../platform/errors.js';
import type { JobContext, JobRunner } from '../../platform/jobs/job-runner.js';
import type { JobsRepository } from '../../platform/jobs/jobs.repository.js';
import { readAndClearSelfUpdateResult } from './panel-self-update-status.js';

export interface PanelUpdateActor {
  readonly adminId: string | null;
  readonly label: string;
}

/** `apply()`'s return: the enqueued job, plus the auto-resolved target version the route needs for its audit row (the job's own `metadata` carries it too, but typed as `JsonValue` — returning it directly here avoids every caller re-deriving it from an untyped bag). */
export interface PanelUpdateApplyResult {
  readonly job: Job;
  readonly targetVersion: string;
}

export class PanelSelfUpdateService {
  constructor(
    private readonly broker: BrokerClient,
    private readonly releaseSource: SelfUpdateReleaseSourcePort,
    private readonly jobRunner: JobRunner,
    private readonly jobsRepository: JobsRepository,
    private readonly dataDir: string,
  ) {}

  /** Pure read — safe to poll from the Settings page. Combines the broker's own honest "what am I running, can I even recreate" answer with the auto-latest release lookup; see `PanelUpdateCheckResponseSchema`'s own doc comment (`@dwg/shared`) for exactly what each `null`/`false` means. */
  async getStatus(): Promise<PanelUpdateCheckResponse> {
    const [check, release] = await Promise.all([
      this.broker.panelSelfUpdateCheck(),
      this.releaseSource.resolveLatestRelease(),
    ]);

    if (!check.updatePossible) {
      return {
        currentVersion: check.serverVersion,
        latestVersion: release?.version ?? null,
        updateAvailable: false,
        updatePossible: false,
        reason: check.reason,
      };
    }

    if (release === null) {
      return {
        currentVersion: check.serverVersion,
        latestVersion: null,
        updateAvailable: false,
        updatePossible: false,
        reason:
          'Could not reach the release source to check for a newer version. Try again shortly.',
      };
    }

    return {
      currentVersion: check.serverVersion,
      latestVersion: release.version,
      updateAvailable: release.version !== check.serverVersion,
      updatePossible: true,
      reason: null,
    };
  }

  /**
   * Enqueues the self-update job, auto-targeting the newest resolved
   * release (§9.1). Refuses outright — before anything is enqueued — when
   * a backup or restore job is currently in flight (§9.5: two operations
   * that each expect exclusive control of the managed container/its data
   * must never overlap with recreating the panel's own containers out
   * from under them) or when the target/possibility cannot be resolved at
   * all.
   */
  async apply(actor: PanelUpdateActor): Promise<PanelUpdateApplyResult> {
    const conflicting = this.jobsRepository
      .listActive()
      .find((job) => job.type.startsWith('backup.'));
    if (conflicting !== undefined) {
      throw new AppError(
        'CONFLICT',
        `A backup or restore job (${conflicting.type}, ${conflicting.id}) is currently in flight. Wait for it to finish before starting a panel self-update.`,
      );
    }

    const release = await this.releaseSource.resolveLatestRelease();
    if (release === null) {
      throw new AppError(
        'CONFLICT',
        'Could not reach the release source to resolve the latest version. Try again shortly.',
      );
    }

    const targetVersion = release.version;

    const job = this.jobRunner.enqueue({
      type: 'panel.selfUpdate',
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      metadata: { targetVersion },
      execute: (ctx) => this.performApply(targetVersion, ctx),
    });

    return { job, targetVersion };
  }

  private async performApply(targetVersion: string, ctx: JobContext): Promise<JsonValue> {
    ctx.log('info', `Checking the panel's current state before updating to ${targetVersion}...`);
    // Re-checked fresh, immediately before anything is touched — the same
    // defense-in-depth `BackupsService.performRestore` applies for its own
    // pre-flight facts: state can change between `apply()` enqueuing this
    // job and this job actually starting.
    const check = await this.broker.panelSelfUpdateCheck();
    if (!check.updatePossible) {
      throw new Error(
        check.reason ?? "The panel cannot self-update right now (the broker's check refused).",
      );
    }

    // Pulling itself happens broker-side, inside the detached updater
    // `panel.selfUpdateApply` launches (`apps/broker/src/self-update/
    // updater.ts`) — there is no separate "pull" broker operation to call
    // here (docs/design/self-update.md §1: composing image references and
    // pulling belongs entirely to the updater state machine, never to a
    // caller-driven step). These two log lines announce that intent to
    // whoever is watching this job's SSE stream, matching the design's
    // "two ctx.log-tracked pull steps" ahead of the point of no return.
    ctx.log('info', `Pulling the target panel-server image (${targetVersion})...`);
    ctx.log('info', `Pulling the target panel-broker image (${targetVersion})...`);

    await this.broker.panelSelfUpdateApply(targetVersion);

    // Point of no return: the updater is launched and will recreate both
    // panel containers. This request — and, in production, the process
    // running it — will not survive that; see this file's own header.
    ctx.log('info', 'Recreating panel containers — this connection will drop shortly.');

    return { targetVersion, fromVersion: check.serverVersion };
  }

  /**
   * The self-update verdict an admin actually sees — see this file's own
   * header for why it is never sourced from a `panel.selfUpdate` job's
   * terminal status. Reading clears the file (§5): a second call with no
   * new self-update in between returns `null`.
   */
  async readLastResult(): Promise<SelfUpdateResult | null> {
    return readAndClearSelfUpdateResult(this.dataDir);
  }
}
