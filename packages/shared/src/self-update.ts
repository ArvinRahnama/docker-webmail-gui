/**
 * The `apps/server`-facing half of panel self-update (docs/design/
 * self-update.md §3, §4, §6, §9.1 — SU-C). Distinct from `broker.ts`'s
 * `PanelSelfUpdateCheckResponseSchema`/`PanelSelfUpdateApplyResponseSchema`,
 * which are the *broker protocol* shapes `apps/server`'s `BrokerClient`
 * speaks to reach `dwg-broker`: those report only what Docker state
 * alone can say (current versions, whether a recreate is even possible
 * for this install). The schemas here are the *REST API* shapes
 * `apps/web` actually renders — `GET /api/v1/updates/panel` additionally
 * folds in the auto-latest release lookup (§9.1: the server resolves the
 * target version, never the client), and `POST .../apply` /
 * `GET .../last-result` have no broker-protocol equivalent at all (job
 * ack, and the durable status-file verdict, respectively).
 *
 * `SelfUpdateResultSchema` deliberately models only the *finished* shape
 * of `/app/data/self-update-result.json`
 * (`apps/broker/src/self-update/updater.ts`'s `SelfUpdateResultFile`,
 * `phase: 'done'`). That file's `phase: 'in-progress'` half additionally
 * carries each container's full recreate spec (`RawContainerRecreateSpec`
 * — `hostConfig`, mounts, the rest) for a human operator's own manual
 * recovery only (§9.7) — broker-internal data that must never reach this
 * tier (ARCHITECTURE.md §2's invariant, applied here even though this is
 * a local file read, not a broker request, because the *data* is exactly
 * the kind this project never lets past the broker boundary). That shape
 * is intentionally not modelled anywhere in `@dwg/shared`, and
 * `apps/server`'s own status-file reader
 * (`modules/updates/panel-self-update-status.ts`) never parses a record
 * whose `phase` is not `'done'` into anything typed — see that file's
 * header.
 */
import { z } from 'zod';

export const SELF_UPDATE_OUTCOMES = ['success', 'rolled-back', 'failed'] as const;
export type SelfUpdateOutcome = (typeof SELF_UPDATE_OUTCOMES)[number];
export const SelfUpdateOutcomeSchema = z.enum(SELF_UPDATE_OUTCOMES);

export const SELF_UPDATE_FAILURE_POINTS = ['pre-flight', 'server-health', 'broker-health'] as const;
export type SelfUpdateFailurePoint = (typeof SELF_UPDATE_FAILURE_POINTS)[number];
export const SelfUpdateFailurePointSchema = z.enum(SELF_UPDATE_FAILURE_POINTS);

/** The finished-verdict shape of the status file — see this module's header. */
export const SelfUpdateResultSchema = z.object({
  outcome: SelfUpdateOutcomeSchema,
  /** `null` when it could not be determined (e.g. a pull failed before anything was inspected) — never a fabricated placeholder; see `updater.ts`'s own doc comment. */
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  failedAt: SelfUpdateFailurePointSchema.nullable(),
  reason: z.string().nullable(),
});
export type SelfUpdateResult = z.infer<typeof SelfUpdateResultSchema>;

/**
 * `GET /api/v1/updates/panel/last-result`'s response.
 * `result: null` means there is no verdict to report — either no
 * self-update has run since the last time one was read, or the file
 * currently on disk is a `phase: 'in-progress'` record (still running,
 * or the updater crashed before writing a final verdict) rather than a
 * finished one.
 */
export const SelfUpdateLastResultResponseSchema = z.object({
  result: SelfUpdateResultSchema.nullable(),
});
export type SelfUpdateLastResultResponse = z.infer<typeof SelfUpdateLastResultResponseSchema>;

/**
 * `GET /api/v1/updates/panel`'s response. `currentVersion` and
 * `latestVersion` are independently `null`-able: the former when the
 * broker cannot determine the running version from local image tags
 * (`updatePossible: false` — a build-mode install, §9.8), the latter
 * when `SelfUpdateReleaseSourcePort.resolveLatestRelease()` could not
 * reach the release source (Unknown, not "no update" — the same
 * discipline `UpdateStatusResponseSchema.available` already follows for
 * the unrelated docker-mailserver comparison).
 */
export const PanelUpdateCheckResponseSchema = z.object({
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** Whether this install *could* self-update at all right now — independent of whether one is actually available. `false` whenever the broker's own check says so (§9.8), or the latest release could not be resolved. */
  updatePossible: z.boolean(),
  /** Present whenever `updatePossible` is `false`. */
  reason: z.string().nullable(),
});
export type PanelUpdateCheckResponse = z.infer<typeof PanelUpdateCheckResponseSchema>;

/** `POST /api/v1/updates/panel/apply`'s response — an ack, mirroring `BackupJobAckSchema`: poll/stream the job (`GET /api/v1/jobs/:id[/stream]`) for progress, and `GET .../last-result` afterwards for the verdict (§6 — the job's own terminal status is not that verdict; see this module's header). */
export const PanelUpdateApplyAckSchema = z.object({ jobId: z.string() });
export type PanelUpdateApplyAck = z.infer<typeof PanelUpdateApplyAckSchema>;
