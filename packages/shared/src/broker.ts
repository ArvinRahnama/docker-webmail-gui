/**
 * The broker protocol (M4 — ARCHITECTURE.md §6, §2.1; SECURITY.md §3.1,
 * §4.1; docs/research/02-docker-api-security.md §A, §B). This is the
 * *entire* vocabulary the web tier can use to talk to Docker: a closed
 * enum of operation names plus a discriminated union of per-operation
 * request schemas, each `.strict()` so an unrecognised field is a
 * validation failure, not a silently-dropped one.
 *
 * This file is deliberately as small as the operations it names. There is
 * no field anywhere in it that can carry a bind mount, a capability, a
 * `HostConfig`, or a container specification — see
 * `packages/shared/src/broker.test.ts` for a test that proves this by
 * construction (poisoning every operation's minimal body with each
 * dangerous key and asserting rejection), not just by inspection.
 *
 * **Deliberately omitted:** `container.create`, `container.remove`, and
 * any `exec.*` operation. `container.create` is the root-equivalent call
 * (docs/research/02-docker-api-security.md §B.1 — `HostConfig.Binds`,
 * `Privileged`, `CapAdd`, `PidMode` each independently reach the host).
 * `exec` hijacks the HTTP connection into a live shell inside the mail
 * container (§C) and is opt-in, off by default, even once it exists
 * (SECURITY.md §3.13). Both are later milestones, not oversights here —
 * this comment is the record of that decision.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Operation enum
// ---------------------------------------------------------------------------

export const BROKER_OPERATIONS = [
  'container.list',
  'container.inspect',
  'container.start',
  'container.stop',
  'container.restart',
  'container.stats',
  'container.logs',
  'system.ping',
  'system.version',
  'system.info',
  'system.df',
  'image.list',
  'volume.list',
  'network.list',
] as const;

export type BrokerOperation = (typeof BROKER_OPERATIONS)[number];
export const BrokerOperationSchema = z.enum(BROKER_OPERATIONS);

/** Header carrying the shared secret (ARCHITECTURE.md §6), compared constant-time on the broker side. */
export const BROKER_SECRET_HEADER = 'x-broker-secret';

/** The broker's single HTTP route. One endpoint, one auth gate, one closed vocabulary — see apps/broker/src/app.ts. */
export const BROKER_OPS_PATH = '/v1/ops';

// ---------------------------------------------------------------------------
// Request schemas
//
// None of these carry a container id. Every operation below that targets
// "the" mail container (everything except `container.list`) has its
// target resolved broker-side from `DMS_CONTAINER_NAME`/`DMS_CONTAINER_LABEL`
// configuration, at request time (ARCHITECTURE.md §6) — there is simply no
// field here to put one in. `container.list` is the one operation that can
// address containers plural, and it is read-only by construction (no
// corresponding write/lifecycle variant that takes a target).
// ---------------------------------------------------------------------------

export const ContainerListRequestSchema = z
  .object({
    operation: z.literal('container.list'),
    /** Docker's own default: only running containers. `true` includes stopped ones. */
    all: z.boolean().optional(),
  })
  .strict();

export const ContainerInspectRequestSchema = z
  .object({ operation: z.literal('container.inspect') })
  .strict();

export const ContainerStartRequestSchema = z
  .object({ operation: z.literal('container.start') })
  .strict();

export const ContainerStopRequestSchema = z
  .object({ operation: z.literal('container.stop') })
  .strict();

export const ContainerRestartRequestSchema = z
  .object({ operation: z.literal('container.restart') })
  .strict();

export const ContainerStatsRequestSchema = z
  .object({ operation: z.literal('container.stats') })
  .strict();

/** Default/min/max for `container.logs`' `tail` — bounded so a client can never ask the broker to buffer an unbounded amount of log history. */
export const LOGS_TAIL_MIN = 1;
export const LOGS_TAIL_MAX = 5000;
export const LOGS_TAIL_DEFAULT = 200;

export const ContainerLogsRequestSchema = z
  .object({
    operation: z.literal('container.logs'),
    tail: z.number().int().min(LOGS_TAIL_MIN).max(LOGS_TAIL_MAX).optional(),
    /** Unix seconds. Only bounds *which* history is returned — never a path, never free text. */
    since: z.number().int().nonnegative().optional(),
    timestamps: z.boolean().optional(),
  })
  .strict();

export const SystemPingRequestSchema = z.object({ operation: z.literal('system.ping') }).strict();
export const SystemVersionRequestSchema = z
  .object({ operation: z.literal('system.version') })
  .strict();
export const SystemInfoRequestSchema = z.object({ operation: z.literal('system.info') }).strict();
export const SystemDfRequestSchema = z.object({ operation: z.literal('system.df') }).strict();

export const ImageListRequestSchema = z.object({ operation: z.literal('image.list') }).strict();
export const VolumeListRequestSchema = z.object({ operation: z.literal('volume.list') }).strict();
export const NetworkListRequestSchema = z.object({ operation: z.literal('network.list') }).strict();

/**
 * Every request schema, in enum order. Exported (not just embedded in the
 * union below) so `broker.test.ts` can iterate all of them generically —
 * both to build the union and to run the "no dangerous field" security
 * test — without either list being able to silently drift from the other.
 */
export const BROKER_REQUEST_SCHEMAS = [
  ContainerListRequestSchema,
  ContainerInspectRequestSchema,
  ContainerStartRequestSchema,
  ContainerStopRequestSchema,
  ContainerRestartRequestSchema,
  ContainerStatsRequestSchema,
  ContainerLogsRequestSchema,
  SystemPingRequestSchema,
  SystemVersionRequestSchema,
  SystemInfoRequestSchema,
  SystemDfRequestSchema,
  ImageListRequestSchema,
  VolumeListRequestSchema,
  NetworkListRequestSchema,
] as const;

/**
 * The operation contract itself: a closed enum plus a discriminated union
 * of per-operation request schemas (as specified — see this milestone's
 * brief). Zod's discriminated union already gives us both required
 * rejections for free: an `operation` value outside the enum matches no
 * member and fails; a recognised `operation` with an extra field fails
 * its member's `.strict()`. There is no default/passthrough branch
 * anywhere in this file that could forward an unrecognised shape.
 */
export const BrokerRequestSchema = z.discriminatedUnion('operation', [...BROKER_REQUEST_SCHEMAS]);
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * `state`/`status` strings are Docker's own vocabulary ("running",
 * "exited", "restarting", …), passed through as open strings rather than
 * pinned to a hardcoded enum — matching this project's own stated
 * preference (ARCHITECTURE.md §11.2) for reporting reality over guessing
 * at a closed set we do not own and Docker could extend.
 */
export const ContainerSummarySchema = z.object({
  id: z.string(),
  names: z.array(z.string()),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  labels: z.record(z.string(), z.string()),
  /** Unix seconds — Docker's own `Created` field shape for `GET /containers/json`. */
  createdAt: z.number(),
});
export type ContainerSummary = z.infer<typeof ContainerSummarySchema>;

export const ContainerListResponseSchema = z.object({
  containers: z.array(ContainerSummarySchema),
});
export type ContainerListResponse = z.infer<typeof ContainerListResponseSchema>;

/**
 * Deliberately bounded — this is a *description* of the resolved managed
 * container's observable state, never the vehicle for a container spec.
 * It has no `HostConfig`, no `Mounts`, no `NetworkSettings`: the broker's
 * own inspect adapter (apps/broker/src/docker-client.ts) picks only these
 * fields out of Docker's full inspect payload, so there is nothing here
 * to round-trip into a future "recreate" request even by accident.
 */
export const ContainerInspectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  /** ISO 8601 — Docker's own inspect `Created` field shape. */
  createdAt: z.string(),
  state: z.object({
    status: z.string(),
    running: z.boolean(),
    paused: z.boolean(),
    restarting: z.boolean(),
    startedAt: z.string(),
    finishedAt: z.string(),
    exitCode: z.number(),
    /** `null` when the container has no configured healthcheck. */
    health: z.string().nullable(),
  }),
  restartCount: z.number(),
  labels: z.record(z.string(), z.string()),
});
export type ContainerInspectResponse = z.infer<typeof ContainerInspectResponseSchema>;

/** Uniform acknowledgement for the lifecycle operations (start/stop/restart) — nothing more to say than "done". */
export const OperationAckSchema = z.object({ ok: z.literal(true) });
export type OperationAck = z.infer<typeof OperationAckSchema>;

/**
 * Already-computed, not raw. The broker performs the CPU%/memory% maths
 * (docs/research/02-docker-api-security.md §A.3, cgroup v1/v2 branch —
 * apps/broker/src/stats.ts) and this is the only shape that ever leaves
 * it — the web tier never sees Docker's ~40-field raw stats payload.
 */
export const ContainerStatsResponseSchema = z.object({
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
  /** ISO 8601 — when the broker took this snapshot (this project's own clock, not Docker's `read`/`preread` fields). */
  sampledAt: z.string(),
});
export type ContainerStatsResponse = z.infer<typeof ContainerStatsResponseSchema>;

export const LogStreamNameSchema = z.enum(['stdout', 'stderr']);
export type LogStreamName = z.infer<typeof LogStreamNameSchema>;

/** One already-demuxed line/frame (docs/research/02-docker-api-security.md §A.2) — the web tier never touches Docker's raw 8-byte-header framing. */
export const ContainerLogLineSchema = z.object({
  stream: LogStreamNameSchema,
  data: z.string(),
});
export type ContainerLogLine = z.infer<typeof ContainerLogLineSchema>;

export const ContainerLogsResponseSchema = z.object({
  lines: z.array(ContainerLogLineSchema),
});
export type ContainerLogsResponse = z.infer<typeof ContainerLogsResponseSchema>;

export const SystemPingResponseSchema = z.object({
  apiVersion: z.string(),
});
export type SystemPingResponse = z.infer<typeof SystemPingResponseSchema>;

export const SystemVersionResponseSchema = z.object({
  version: z.string(),
  apiVersion: z.string(),
  minApiVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  kernelVersion: z.string(),
});
export type SystemVersionResponse = z.infer<typeof SystemVersionResponseSchema>;

export const SystemInfoResponseSchema = z.object({
  containers: z.number(),
  containersRunning: z.number(),
  containersPaused: z.number(),
  containersStopped: z.number(),
  images: z.number(),
  serverVersion: z.string(),
  driver: z.string(),
  ncpu: z.number(),
  memTotal: z.number(),
});
export type SystemInfoResponse = z.infer<typeof SystemInfoResponseSchema>;

export const SystemDfResponseSchema = z.object({
  layersSizeBytes: z.number().nonnegative(),
  imagesCount: z.number().nonnegative(),
  containersCount: z.number().nonnegative(),
  volumesCount: z.number().nonnegative(),
  buildCacheBytes: z.number().nonnegative(),
});
export type SystemDfResponse = z.infer<typeof SystemDfResponseSchema>;

export const ImageSummarySchema = z.object({
  id: z.string(),
  repoTags: z.array(z.string()),
  sizeBytes: z.number().nonnegative(),
  createdAt: z.number(),
  labels: z.record(z.string(), z.string()),
});
export type ImageSummary = z.infer<typeof ImageSummarySchema>;

export const ImageListResponseSchema = z.object({ images: z.array(ImageSummarySchema) });
export type ImageListResponse = z.infer<typeof ImageListResponseSchema>;

export const VolumeSummarySchema = z.object({
  name: z.string(),
  driver: z.string(),
  mountpoint: z.string(),
  labels: z.record(z.string(), z.string()),
});
export type VolumeSummary = z.infer<typeof VolumeSummarySchema>;

export const VolumeListResponseSchema = z.object({ volumes: z.array(VolumeSummarySchema) });
export type VolumeListResponse = z.infer<typeof VolumeListResponseSchema>;

export const NetworkSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
  scope: z.string(),
});
export type NetworkSummary = z.infer<typeof NetworkSummarySchema>;

export const NetworkListResponseSchema = z.object({ networks: z.array(NetworkSummarySchema) });
export type NetworkListResponse = z.infer<typeof NetworkListResponseSchema>;

/**
 * Operation name -> response schema. `satisfies Record<BrokerOperation, …>`
 * makes the mapping's completeness a compile-time property: adding an
 * operation to {@link BROKER_OPERATIONS} without adding its response
 * schema here is a type error, not a runtime gap discovered later
 * (ARCHITECTURE.md §3 — the same schema artifact backs validation and
 * types). Both the broker (validating its own output before it ever
 * leaves the process) and `RealBrokerClient` (validating what it
 * receives) index this same map by the same operation name.
 */
export const BROKER_RESPONSE_SCHEMAS = {
  'container.list': ContainerListResponseSchema,
  'container.inspect': ContainerInspectResponseSchema,
  'container.start': OperationAckSchema,
  'container.stop': OperationAckSchema,
  'container.restart': OperationAckSchema,
  'container.stats': ContainerStatsResponseSchema,
  'container.logs': ContainerLogsResponseSchema,
  'system.ping': SystemPingResponseSchema,
  'system.version': SystemVersionResponseSchema,
  'system.info': SystemInfoResponseSchema,
  'system.df': SystemDfResponseSchema,
  'image.list': ImageListResponseSchema,
  'volume.list': VolumeListResponseSchema,
  'network.list': NetworkListResponseSchema,
} satisfies Record<BrokerOperation, z.ZodTypeAny>;

/** The broker's minimal internal error envelope — distinct from `ApiErrorEnvelopeSchema` (`api.ts`), which is the public `/api/v1/*` contract. This one is internal-only, between the server and the broker. */
export const BrokerErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type BrokerErrorEnvelope = z.infer<typeof BrokerErrorEnvelopeSchema>;
