/**
 * Zod schemas for the public `/api/v1/docker/*` surface (M9 —
 * FEATURE_MATRIX.md §24-26, §32): containers, images, volumes, networks,
 * the log viewer, monitoring, the health centre, and the restricted
 * console. This is distinct from `@dwg/shared`'s own `broker.ts`, which is
 * the *internal* server<->broker protocol (ARCHITECTURE.md §2, §6) — the
 * web tier never imports that protocol directly. Several shapes below
 * intentionally reuse a `broker.ts` response schema verbatim
 * (`ContainerSummarySchema`, `ContainerInspectResponseSchema`,
 * `OperationAckSchema`, `ImagePruneResponseSchema`, `ContainerStatsResponseSchema`,
 * `ContainerLogsResponseSchema`, `LogsFileResponseSchema`, …) at the route/
 * client call sites rather than being redeclared under a new name here —
 * there is nothing this layer adds to them, and duplicating an identical
 * shape under a second name is exactly the kind of drift ARCHITECTURE.md §3
 * exists to prevent.
 *
 * **Recreate is deferred, not present.** It needs `container.create`, which
 * the broker deliberately lacks (docs/research/02-docker-api-security.md
 * §A.1's own note that "recreate" is not a real Engine API operation, and
 * `broker.ts`'s header on why `container.create`/`container.remove` are
 * absent from the vocabulary). No schema anywhere in this file accepts a
 * container spec, an image reference to pull, or a bind mount.
 */
import { z } from 'zod';
import { CapabilityStatusSchema } from './mail.js';
import { VolumeSummarySchema, ConsoleCommandSchema } from './broker.js';

// ---------------------------------------------------------------------------
// Volumes (FEATURE_MATRIX.md §25) — `isProtected` is computed server-side
// from the managed container's own live mounts
// (`computeProtectedVolumeNames`, broker.ts) so the UI can label a volume
// protected *before* an admin ever attempts to remove it. This is display
// only, never the safety boundary — the broker's own refusal
// (apps/broker/src/operations.ts) is what actually enforces it, re-derived
// independently on every `volume.remove` call.
// ---------------------------------------------------------------------------

export const DockerVolumeSchema = VolumeSummarySchema.extend({
  isProtected: z.boolean(),
});
export type DockerVolume = z.infer<typeof DockerVolumeSchema>;

export const DockerVolumeListResponseSchema = z.object({
  volumes: z.array(DockerVolumeSchema),
});
export type DockerVolumeListResponse = z.infer<typeof DockerVolumeListResponseSchema>;

// ---------------------------------------------------------------------------
// Monitoring (§26) — container resource stats plus host-level Docker
// system info. Read-only; nothing here is a request schema.
// ---------------------------------------------------------------------------

export const MonitoringResponseSchema = z.object({
  stats: z.object({
    cpuPercent: z.number().nonnegative(),
    memory: z.object({
      usageBytes: z.number().nonnegative(),
      limitBytes: z.number().nonnegative(),
      percent: z.number().nonnegative(),
    }),
    pids: z.number().nonnegative().nullable(),
    network: z
      .object({ rxBytes: z.number().nonnegative(), txBytes: z.number().nonnegative() })
      .nullable(),
    sampledAt: z.string(),
  }),
  system: z.object({
    containers: z.number(),
    containersRunning: z.number(),
    containersPaused: z.number(),
    containersStopped: z.number(),
    images: z.number(),
    serverVersion: z.string(),
    driver: z.string(),
    ncpu: z.number(),
    memTotal: z.number(),
  }),
  version: z.object({
    version: z.string(),
    apiVersion: z.string(),
    minApiVersion: z.string(),
    os: z.string(),
    arch: z.string(),
    kernelVersion: z.string(),
  }),
  df: z.object({
    layersSizeBytes: z.number().nonnegative(),
    imagesCount: z.number().nonnegative(),
    containersCount: z.number().nonnegative(),
    volumesCount: z.number().nonnegative(),
    buildCacheBytes: z.number().nonnegative(),
  }),
});
export type MonitoringResponse = z.infer<typeof MonitoringResponseSchema>;

// ---------------------------------------------------------------------------
// Health centre (§26) — `healthy | warning | critical | unknown` per check
// (matching `apps/web/src/components/status/status.ts`'s existing
// vocabulary exactly, so `HealthIndicator`/`StatusBadge` render these
// values with no translation step), each with its **own** timestamp.
// `apps/server/src/modules/docker/health.service.ts` makes one independent
// broker call per check and catches its own failure — no check's result is
// ever derived from another's, and a partial outage shows exactly which
// checks are affected rather than collapsing everything to one state.
// ---------------------------------------------------------------------------

export const HEALTH_CHECK_STATES = ['healthy', 'warning', 'critical', 'unknown'] as const;
export type HealthCheckState = (typeof HEALTH_CHECK_STATES)[number];
export const HealthCheckStateSchema = z.enum(HEALTH_CHECK_STATES);

export const HEALTH_CHECK_IDS = ['broker', 'managed-container', 'docker-daemon'] as const;
export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];
export const HealthCheckIdSchema = z.enum(HEALTH_CHECK_IDS);

export const HealthCheckSchema = z.object({
  id: HealthCheckIdSchema,
  label: z.string(),
  state: HealthCheckStateSchema,
  /** Safe-to-show detail — `null` when healthy and there is nothing more to say. */
  message: z.string().nullable(),
  /** ISO 8601 — this check's own observation instant, never a shared page-load timestamp. */
  checkedAt: z.string(),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthCentreResponseSchema = z.object({
  checks: z.array(HealthCheckSchema),
});
export type HealthCentreResponse = z.infer<typeof HealthCentreResponseSchema>;

// ---------------------------------------------------------------------------
// Restricted console (§32) — behind `ENABLE_EXEC_CONSOLE`, off by default
// (AGENT_BRIEF.md §4: "Restricted allowlisted command console, off by
// default. Never an unrestricted or host shell."). Modelled as a
// `CapabilityStatusSchema` for the same reason every other flag-gated
// feature in this codebase is (`MailCapabilitiesResponseSchema`) — the web
// tier renders one consistent "unsupported/disabled" shape everywhere
// rather than a bespoke boolean per feature.
// ---------------------------------------------------------------------------

export const ConsoleAvailabilityResponseSchema = z.object({
  capability: CapabilityStatusSchema,
});
export type ConsoleAvailabilityResponse = z.infer<typeof ConsoleAvailabilityResponseSchema>;

/** The request body for `POST /api/v1/docker/console/exec` — a bare symbolic command key, never argv (see broker.ts's `ConsoleCommandSchema`, which this reuses directly). */
export const ConsoleCommandRequestSchema = z.object({
  command: ConsoleCommandSchema,
});
export type ConsoleCommandRequest = z.infer<typeof ConsoleCommandRequestSchema>;
