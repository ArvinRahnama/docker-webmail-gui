/**
 * The job system (M10 — ARCHITECTURE.md §7.5; IMPLEMENTATION_PLAN.md §3).
 * Backup, restore and verify all exceed a request's lifetime. This file is
 * the shared vocabulary for that: a closed set of job types, a small
 * status machine, and the API/SSE shapes both server and web import —
 * mirroring how `broker.ts` is the closed vocabulary for broker
 * operations. There is deliberately no generic "run arbitrary work" job
 * type: a job is always one of the named kinds below, each with its own
 * server-side handler (`apps/server/src/platform/jobs/job-runner.ts`).
 */
import { z } from 'zod';
import { JsonValueSchema } from './api.js';

/**
 * Every long-running operation this product runs through the job runner.
 * `update.apply` (the docker-mailserver comparison) is deliberately
 * absent — applying *that* update needs `container.create`/recreate,
 * which the broker does not expose as a general operation
 * (docs/research/02-docker-api-security.md §A.1), so that step is
 * refused before anything is ever enqueued
 * (`modules/updates/updates.service.ts`) rather than modelled as a job
 * that could never finish.
 *
 * `panel.selfUpdate` is a genuinely different case, not an exception to
 * the rule above: it never asks the broker for `container.create`/
 * `container.remove` directly (those remain absent from
 * `BROKER_OPERATIONS` — `broker.ts`). It calls the one broker operation
 * that *does* exist for this, `panel.selfUpdateApply`, which launches a
 * detached updater that performs the recreate internally
 * (docs/design/self-update.md §1) — the same "named intent, no passthrough
 * spec" discipline every other operation in this protocol already
 * follows, just for the one operation whose job is to recreate a
 * container. This job type's `execute()` therefore *can* finish (or, in
 * production, simply never gets the chance to report back before its own
 * process is replaced — `modules/updates/panel-self-update.service.ts`'s
 * own header, and this file's `JOB_ACTIVE_STATUSES` doc comment on why
 * that is expected, not a bug).
 */
export const JOB_TYPES = [
  'backup.create',
  'backup.verify',
  'backup.restore',
  // M13 — remote destinations: uploading a finished backup (also used for the
  // reconcile sweep) and importing/pulling one back from the remote. Both are
  // whole-archive transfers, so they run as jobs like create/verify/restore.
  'backup.upload',
  'backup.import',
  // Panel self-update (docs/design/self-update.md — SU-C). See this
  // constant's own header for why this one *is* modelled as a job despite
  // `update.apply`'s neighbouring absence.
  'panel.selfUpdate',
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JobTypeSchema = z.enum(JOB_TYPES);

/**
 * `queued` -> `running` -> one of `succeeded` | `failed` | `cancelled`.
 * The runner (`job-runner.ts`) is the only writer of this column; nothing
 * else in the app transitions a job's status directly.
 */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JobStatusSchema = z.enum(JOB_STATUSES);

/**
 * Statuses a job can still be cancelled from, and the set the startup
 * recovery sweep (`job-runner.ts`) treats as "interrupted by a process
 * restart". Ordinarily accurate for every job type — but a
 * `panel.selfUpdate` job left `running` here is *expected*, even on a
 * fully successful self-update: the server process reporting it is
 * deliberately about to be replaced (docs/design/self-update.md §6), so
 * this sweep marking that row `failed: interrupted` describes what
 * genuinely happened to *that request*, but is never the self-update's
 * real verdict — see `modules/updates/panel-self-update.service.ts`'s own
 * header for where that verdict actually comes from instead.
 */
export const JOB_ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['queued', 'running']);
export function isActiveJobStatus(status: JobStatus): boolean {
  return JOB_ACTIVE_STATUSES.has(status);
}

export const JOB_LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type JobLogLevel = (typeof JOB_LOG_LEVELS)[number];
export const JobLogLevelSchema = z.enum(JOB_LOG_LEVELS);

export const JobSchema = z.object({
  id: z.string(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  /** 0-100. The runner only ever moves this forward within one job; it is never inferred from elapsed time. */
  progress: z.number().min(0).max(100),
  createdByAdminId: z.string().nullable(),
  createdByLabel: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Safe-to-show failure summary — never a raw stack trace, matching `AppError`'s own discipline (`platform/errors.ts`). */
  errorMessage: z.string().nullable(),
  /** Small, job-type-specific detail (e.g. `{ backupId }`) — never a secret; see `platform/audit.ts`'s identical discipline for `details`. */
  metadata: JsonValueSchema,
});
export type Job = z.infer<typeof JobSchema>;

export const JobLogEntrySchema = z.object({
  id: z.string(),
  jobId: z.string(),
  loggedAt: z.string(),
  level: JobLogLevelSchema,
  message: z.string(),
});
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>;

export const JobListResponseSchema = z.object({ jobs: z.array(JobSchema) });
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const JobDetailResponseSchema = z.object({
  job: JobSchema,
  logs: z.array(JobLogEntrySchema),
});
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;

/**
 * SSE payload shape for `GET /api/v1/jobs/:id/stream` (ARCHITECTURE.md
 * §8). `snapshot` carries the job's full current row (sent immediately on
 * connect, and again after every state change) so a client that reloads
 * mid-job never has to reconstruct progress from a log tail; `log` carries
 * one new `job_logs` row as it is written. A discriminated union so the
 * client's `JSON.parse` result narrows correctly with no separate type
 * guard to maintain.
 */
export const JobStreamEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), job: JobSchema }),
  z.object({ kind: z.literal('log'), entry: JobLogEntrySchema }),
]);
export type JobStreamEvent = z.infer<typeof JobStreamEventSchema>;
