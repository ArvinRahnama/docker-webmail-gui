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

import { DMS_OPERATIONS, DMS_REQUEST_SCHEMAS, DMS_RESPONSE_SCHEMAS } from './dms.js';

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
  // M9 — Docker & observability (FEATURE_MATRIX.md §24-26, §32). Four
  // narrowly-scoped additions, each still a named intent rather than a
  // passthrough: `volume.remove` targets a volume *by name* (never a
  // container spec) and is refused broker-side for any volume backing a
  // DMS data mount, re-derived fresh from the managed container's own
  // mounts every call, never from a hardcoded name
  // (`DMS_PROTECTED_MOUNT_DESTINATIONS` below); `image.prune` carries no
  // parameters at all — it always means "remove dangling images", never
  // "remove image X"; `logs.file` reads one of a fixed two-value enum of
  // in-container log files via a hardcoded path, never a client-supplied
  // one; `console.exec` runs one of a fixed enum of zero-argument
  // diagnostic commands with broker-owned argv — the client sends a
  // symbolic key, never a command string or argv array. This is
  // FEATURE_MATRIX.md §32's "restricted command console, not a shell" —
  // "A server-side allowlist of named diagnostic commands with fixed
  // argv" — in place of a general `exec.*`; there is still no operation
  // anywhere in this file that accepts argv, a path, or a container spec
  // from the caller.
  'volume.remove',
  'image.prune',
  'logs.file',
  'console.exec',
  // Panel self-management (v0.3 — FEATURE_MATRIX.md §22). `panel.restart`
  // restarts the panel's *own* server container, resolved broker-side
  // from `PANEL_SERVER_CONTAINER_NAME`/`_LABEL` config exactly as
  // `container.restart` resolves the mail container — a distinct named
  // intent, deliberately *not* a `target` field on `container.restart`,
  // so no lifecycle operation ever gains a caller-supplied "which
  // container" selector. It restarts the server only, never the broker
  // (the broker resolves the server identity and refuses if it would
  // resolve to its own container — `apps/broker/src/operations.ts`). Zero
  // parameters, the same as `image.prune`: it means exactly one thing.
  'panel.restart',
  // The docker-mailserver half (M16 — `dms.ts`). Spread rather than
  // re-listed: one source for the names, the request schemas and the
  // response map, so an operation cannot exist in one and not the others.
  ...DMS_OPERATIONS,
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
// "the" mail container has its target resolved broker-side from
// `DMS_CONTAINER_NAME`/`DMS_CONTAINER_LABEL` configuration, at request
// time (ARCHITECTURE.md §6) — there is simply no field here to put one in.
// `panel.restart` is resolved the identical way, from the separate
// `PANEL_SERVER_CONTAINER_NAME`/`_LABEL` configuration — a different
// config-known identity, still never a request field. `container.list` is
// the one operation that can address containers plural, and it is
// read-only by construction (no corresponding write/lifecycle variant
// that takes a target).
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

// ---------------------------------------------------------------------------
// M9 additions (FEATURE_MATRIX.md §24-26, §32)
// ---------------------------------------------------------------------------

/**
 * `name` targets a volume the same way Docker itself does — there is no
 * container identity here, and this is deliberately the *one* place in
 * the whole protocol that names a resource by a client-supplied string,
 * because volumes (unlike "the" managed container) are not a singleton
 * the broker can resolve on its own. Safety does not rest on this field
 * being absent; it rests on the broker independently recomputing which
 * volume names are protected from the managed container's own mounts on
 * every call (`DMS_PROTECTED_MOUNT_DESTINATIONS`,
 * `computeProtectedVolumeNames` below) and refusing before ever reaching
 * Docker's own remove call.
 */
export const VolumeRemoveRequestSchema = z
  .object({ operation: z.literal('volume.remove'), name: z.string().min(1).max(255) })
  .strict();

/**
 * No parameters. `image.prune` always means exactly one thing — remove
 * every dangling (untagged, unused) image — never "remove image X".
 * There is deliberately no operation anywhere in this protocol that
 * removes one image by id (FEATURE_MATRIX.md §24: "an image in use by
 * any container ... can never be selected for removal" is enforced by
 * there being no such selection to make at the protocol level, not only
 * by a UI that declines to offer one).
 */
export const ImagePruneRequestSchema = z.object({ operation: z.literal('image.prune') }).strict();

/**
 * The fixed, closed enum of non-container-stdout log sources
 * (FEATURE_MATRIX.md §19-21's "log sources are a fixed server-side
 * enum" — this is that enum). Each maps, broker-side only, to one
 * hardcoded absolute path inside the managed container
 * (`docs/research/01-docker-mailserver.md` §11: `/var/log/mail/mail.log`,
 * `/var/log/mail/fail2ban.log`). There is no path field anywhere in this
 * schema — a client can select *which* fixed file, never *where*.
 */
export const LOG_FILE_SOURCES = ['mail', 'fail2ban'] as const;
export type LogFileSource = (typeof LOG_FILE_SOURCES)[number];
export const LogFileSourceSchema = z.enum(LOG_FILE_SOURCES);

export const LogsFileRequestSchema = z
  .object({
    operation: z.literal('logs.file'),
    source: LogFileSourceSchema,
    tail: z.number().int().min(LOGS_TAIL_MIN).max(LOGS_TAIL_MAX).optional(),
  })
  .strict();

/**
 * The restricted command console's entire vocabulary
 * (FEATURE_MATRIX.md §32; docs/research/02-docker-api-security.md §C.4:
 * "prefer named actions over a shell"). Every member is a real,
 * zero-argument, read-only diagnostic command — nothing here ever takes
 * a caller-supplied target (a mailbox, a queue id, a path). The broker
 * owns the argv each key maps to (`apps/broker/src/operations.ts`); nothing
 * resembling an argv array or a shell string appears in this schema, so
 * there is no field a compromised web tier could use to widen this list
 * even by one flag.
 */
export const CONSOLE_COMMANDS = ['postqueue-p', 'postconf-n', 'doveconf-n', 'doveadm-who'] as const;
export type ConsoleCommand = (typeof CONSOLE_COMMANDS)[number];
export const ConsoleCommandSchema = z.enum(CONSOLE_COMMANDS);

export const ConsoleExecRequestSchema = z
  .object({ operation: z.literal('console.exec'), command: ConsoleCommandSchema })
  .strict();

/**
 * No parameters — `panel.restart` always means "restart the panel's own
 * server container," whose identity the broker resolves from
 * configuration (`PANEL_SERVER_CONTAINER_NAME`/`_LABEL`), never from
 * anything in this request. There is no `target` field here, and none on
 * `container.restart` either: the two restartable containers this product
 * knows about are addressed by two distinct operation *names*, so a
 * compromised web tier can only ever ask to restart the mail container or
 * the panel server — the exact set the broker will act on — and can never
 * name a third, nor the broker itself.
 */
export const PanelRestartRequestSchema = z
  .object({ operation: z.literal('panel.restart') })
  .strict();

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
  VolumeRemoveRequestSchema,
  ImagePruneRequestSchema,
  LogsFileRequestSchema,
  ConsoleExecRequestSchema,
  PanelRestartRequestSchema,
  ...DMS_REQUEST_SCHEMAS,
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
/**
 * One entry from Docker's own inspect `Mounts` array, reduced to exactly
 * the fields this project has a use for: `type`/`name` to recognise a
 * named volume, `destination` to test it against
 * {@link DMS_PROTECTED_MOUNT_DESTINATIONS}. Deliberately omits the host
 * `Source` path — nothing downstream needs it, and leaving it out keeps
 * this response (like `ContainerInspectResponseSchema` as a whole)
 * unable to round-trip into anything resembling a container spec.
 */
export const ContainerMountSchema = z.object({
  /** Docker's own vocabulary (`bind`/`volume`/`tmpfs`/`npipe`/…), passed through as an open string per this project's stated preference (ARCHITECTURE.md §11.2) rather than a closed enum we do not own. */
  type: z.string(),
  /** The volume name, when `type === 'volume'`. `null` for a bind mount or any other type. */
  name: z.string().nullable(),
  /** Path inside the container this mount is attached at. */
  destination: z.string(),
});
export type ContainerMount = z.infer<typeof ContainerMountSchema>;

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
  mounts: z.array(ContainerMountSchema),
});
export type ContainerInspectResponse = z.infer<typeof ContainerInspectResponseSchema>;

/**
 * The four DMS data paths inside the managed mail container
 * (`docs/research/01-docker-mailserver.md` §6, §11; FEATURE_MATRIX.md
 * §25, §27): mail data, Dovecot/Fail2ban state, mail logs, and the
 * config/DKIM/TLS directory. A volume mounted at any of these can never
 * be removed through this panel — the single most destructive operation
 * the product could perform. Identified **dynamically**, from the
 * managed container's own live `Mounts`, every time — never a hardcoded
 * volume *name*, because different deployments name their volumes
 * differently (compose project prefixes, operator-chosen names). This is
 * the one fixed fact both the broker (which enforces the block) and the
 * server (which labels a volume "protected" in the UI before an admin
 * even attempts to remove it) share — see {@link computeProtectedVolumeNames}.
 */
export const DMS_PROTECTED_MOUNT_DESTINATIONS = [
  '/var/mail',
  '/var/mail-state',
  '/var/log/mail',
  '/tmp/docker-mailserver',
] as const;

/**
 * Reduces a container's mounts to the set of volume *names* that back a
 * protected DMS data path. Pure and total: an empty/no-match input
 * yields an empty set, never a throw — callers (broker enforcement,
 * server display) both treat "not in this set" as "removable", so this
 * function failing open on a genuinely empty mounts array (e.g. the
 * managed container briefly unresolvable) is the correct, fail-safe
 * default only when paired with the broker's own separate refusal to act
 * at all when the container does not resolve (`resolveOrForbid` in
 * `apps/broker/src/operations.ts`) — this function alone is not the
 * safety boundary, the combination is.
 */
export function computeProtectedVolumeNames(
  mounts: readonly ContainerMount[],
): ReadonlySet<string> {
  const protectedDestinations: ReadonlySet<string> = new Set(DMS_PROTECTED_MOUNT_DESTINATIONS);
  const names = new Set<string>();
  for (const mount of mounts) {
    if (
      mount.type === 'volume' &&
      mount.name !== null &&
      protectedDestinations.has(mount.destination)
    ) {
      names.add(mount.name);
    }
  }
  return names;
}

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

// ---------------------------------------------------------------------------
// M9 response schemas
// ---------------------------------------------------------------------------

export const ImagePruneResponseSchema = z.object({
  /** Image IDs actually deleted — always a subset of the dangling set; Docker itself never deletes an image a container (running or stopped) still references, even under this filter. */
  imagesDeleted: z.array(z.string()),
  spaceReclaimedBytes: z.number().nonnegative(),
});
export type ImagePruneResponse = z.infer<typeof ImagePruneResponseSchema>;

/** Plain text lines — unlike `ContainerLogLineSchema`, there is no stdout/stderr split; a tailed file is one stream. */
export const LogsFileResponseSchema = z.object({ lines: z.array(z.string()) });
export type LogsFileResponse = z.infer<typeof LogsFileResponseSchema>;

export const ConsoleExecResponseSchema = z.object({
  command: ConsoleCommandSchema,
  /** The exact argv the broker ran — echoed back so the audit trail the server writes never has to trust its own memory of the mapping. */
  argv: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
});
export type ConsoleExecResponse = z.infer<typeof ConsoleExecResponseSchema>;

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
  'volume.remove': OperationAckSchema,
  'image.prune': ImagePruneResponseSchema,
  'logs.file': LogsFileResponseSchema,
  'console.exec': ConsoleExecResponseSchema,
  'panel.restart': OperationAckSchema,
  ...DMS_RESPONSE_SCHEMAS,
} satisfies Record<BrokerOperation, z.ZodTypeAny>;

/** The broker's minimal internal error envelope — distinct from `ApiErrorEnvelopeSchema` (`api.ts`), which is the public `/api/v1/*` contract. This one is internal-only, between the server and the broker. */
export const BrokerErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type BrokerErrorEnvelope = z.infer<typeof BrokerErrorEnvelopeSchema>;
