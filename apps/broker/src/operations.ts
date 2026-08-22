/**
 * Dispatches a validated {@link BrokerRequest} to its handler. This is
 * the broker's closed vocabulary made executable: every branch below is
 * one Docker call (via {@link DockerApi}, never `dockerode` directly —
 * see `docker-types.ts`), and the `default` branch is an exhaustiveness
 * guard, not a passthrough — TypeScript proves every real operation is
 * handled above it via the `never` narrowing, so it exists only to fail
 * loudly if that proof is ever broken, never to forward an operation
 * this file forgot to handle.
 *
 * **Scope note on "streaming" (ARCHITECTURE.md §6):** `container.logs`
 * and `container.stats` both return a single computed/decoded JSON body
 * per call here, not an open chunked connection that follows Docker
 * indefinitely. `container.logs` always asks Docker for bounded history
 * (`follow: false`) and demuxes it in one pass; `container.stats` asks
 * for one `stream:false` snapshot (docs/research/02-docker-api-security.md
 * §A.3 — this is the correct way to get a single sample with valid
 * `precpu_stats`, not `one-shot`). Live tailing/polling is a UI-facing
 * concern layered on top by repeated calls plus the server's own SSE
 * (ARCHITECTURE.md §8) — there is no real Docker daemon in this
 * environment to validate a long-lived follow connection against, and it
 * is not part of this milestone's acceptance criteria. What *is* fully
 * implemented and tested here is the hard part either design needs
 * regardless: correct demuxing (`stream-demux.ts`) and correct stats
 * maths (`stats.ts`).
 */
import type { Logger } from 'pino';
import {
  DMS_COMMAND_OPERATIONS,
  type DmsCommandOperation,
  LOGS_TAIL_DEFAULT,
  computeProtectedVolumeNames,
  type BrokerRequest,
  type ConsoleCommand,
  type ConsoleExecResponse,
  type ContainerInspectResponse,
  type ContainerListResponse,
  type ContainerLogsResponse,
  type ContainerStatsResponse,
  type ImageListResponse,
  type ImagePruneResponse,
  type LogFileSource,
  type LogsFileResponse,
  type NetworkListResponse,
  type OperationAck,
  type SystemDfResponse,
  type SystemInfoResponse,
  type SystemPingResponse,
  type SystemVersionResponse,
  type VolumeListResponse,
} from '@dwg/shared';
import type { DockerApi, RawContainerListItem } from './docker-types.js';
import {
  ContainerResolutionError,
  resolveManagedContainer,
  type DmsIdentity,
  type ManagedContainerRef,
} from './container-resolver.js';
import { demuxDockerStream } from './stream-demux.js';
import { computeContainerStats } from './stats.js';
import { BrokerError } from './errors.js';
import {
  handleDmsCommand,
  handleDmsDkimRecordRead,
  handleDmsEnvRead,
  handleDmsFileRead,
} from './dms/handlers.js';

export interface OperationDeps {
  readonly docker: DockerApi;
  readonly dms: DmsIdentity;
  readonly logger: Logger;
}

/** Narrows an operation name to the DMS command set, so the dispatch below can hand the whole group to one handler without losing type safety at the call site. */
function isDmsCommandOperation(operation: string): operation is DmsCommandOperation {
  return (DMS_COMMAND_OPERATIONS as readonly string[]).includes(operation);
}

/** Exported for `archive-routes.ts`, which needs the exact same "resolve the managed container or refuse" behaviour for the two streaming archive routes — those live outside the `/v1/ops` JSON dispatch this file otherwise owns, but must fail closed identically. */
export async function resolveOrForbid(deps: OperationDeps): Promise<ManagedContainerRef> {
  try {
    return await resolveManagedContainer(deps.docker, deps.dms);
  } catch (err) {
    if (err instanceof ContainerResolutionError) {
      deps.logger.warn(
        { reason: err.reason },
        'Refusing operation: the managed container did not resolve to exactly one allowlisted match',
      );
      throw new BrokerError(
        'FORBIDDEN',
        'The managed container could not be resolved to a single allowlisted match.',
      );
    }
    throw err;
  }
}

/** Wraps a Docker call so a daemon-side failure never reaches the caller as a raw error — full detail is logged server-side, the client gets a stable `UPSTREAM_UNAVAILABLE`. */
async function callDocker<T>(
  deps: OperationDeps,
  action: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    deps.logger.error({ err, action }, 'Docker API call failed');
    throw new BrokerError('UPSTREAM_UNAVAILABLE', 'The Docker daemon call failed.');
  }
}

function toContainerSummary(
  raw: RawContainerListItem,
): ContainerListResponse['containers'][number] {
  return {
    id: raw.id,
    names: [...raw.names],
    image: raw.image,
    state: raw.state,
    status: raw.status,
    labels: { ...raw.labels },
    createdAt: raw.createdAt,
  };
}

async function handleContainerList(
  body: Extract<BrokerRequest, { operation: 'container.list' }>,
  deps: OperationDeps,
): Promise<ContainerListResponse> {
  const raw = await callDocker(deps, 'container.list', () =>
    deps.docker.listContainers({ all: body.all ?? false }),
  );
  return { containers: raw.map(toContainerSummary) };
}

async function handleContainerInspect(deps: OperationDeps): Promise<ContainerInspectResponse> {
  const ref = await resolveOrForbid(deps);
  const raw = await callDocker(deps, 'container.inspect', () =>
    deps.docker.inspectContainer(ref.id),
  );
  return {
    id: raw.id,
    name: raw.name,
    image: raw.image,
    createdAt: raw.createdAt,
    state: { ...raw.state },
    restartCount: raw.restartCount,
    labels: { ...raw.labels },
    mounts: raw.mounts.map((mount) => ({ ...mount })),
  };
}

async function handleContainerStart(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.start', () => deps.docker.startContainer(ref.id));
  return { ok: true };
}

async function handleContainerStop(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.stop', () => deps.docker.stopContainer(ref.id));
  return { ok: true };
}

async function handleContainerRestart(deps: OperationDeps): Promise<OperationAck> {
  const ref = await resolveOrForbid(deps);
  await callDocker(deps, 'container.restart', () => deps.docker.restartContainer(ref.id));
  return { ok: true };
}

async function handleContainerStats(deps: OperationDeps): Promise<ContainerStatsResponse> {
  const ref = await resolveOrForbid(deps);
  const raw = await callDocker(deps, 'container.stats', () => deps.docker.statsContainer(ref.id));
  const computed = computeContainerStats(raw);
  return { ...computed, sampledAt: new Date().toISOString() };
}

async function handleContainerLogs(
  body: Extract<BrokerRequest, { operation: 'container.logs' }>,
  deps: OperationDeps,
): Promise<ContainerLogsResponse> {
  const ref = await resolveOrForbid(deps);
  const inspection = await callDocker(deps, 'container.inspect', () =>
    deps.docker.inspectContainer(ref.id),
  );
  const buffer = await callDocker(deps, 'container.logs', () =>
    deps.docker.logsContainer(ref.id, {
      tail: body.tail ?? LOGS_TAIL_DEFAULT,
      timestamps: body.timestamps ?? false,
      // Spread rather than `since: body.since`: with
      // `exactOptionalPropertyTypes` (tsconfig.base.json), an optional
      // property must be *omitted* to mean "absent", not explicitly set
      // to `undefined` — this keeps "since was not requested" and
      // "since was requested as undefined" from being conflated.
      ...(body.since !== undefined ? { since: body.since } : {}),
    }),
  );
  const frames = demuxDockerStream(buffer, { tty: inspection.tty });
  return {
    lines: frames.map((frame) => ({ stream: frame.stream, data: frame.data.toString('utf8') })),
  };
}

async function handleSystemPing(deps: OperationDeps): Promise<SystemPingResponse> {
  // A successful `ping()` proves the daemon is reachable but its
  // resolved value is untyped and Docker puts the interesting field
  // (`Api-Version`) in a response *header* rather than the body
  // (docs/research/02-docker-api-security.md §A.0) — not something this
  // project's minimal `DockerApi.ping()` (Promise<void>) surfaces. Ping
  // first for the liveness check on its own terms, then read the same
  // field from `version()`'s well-documented JSON body, which every
  // daemon that answered ping will also answer.
  await callDocker(deps, 'system.ping', () => deps.docker.ping());
  const version = await callDocker(deps, 'system.version', () => deps.docker.version());
  return { apiVersion: version.apiVersion };
}

async function handleSystemVersion(deps: OperationDeps): Promise<SystemVersionResponse> {
  return callDocker(deps, 'system.version', () => deps.docker.version());
}

async function handleSystemInfo(deps: OperationDeps): Promise<SystemInfoResponse> {
  return callDocker(deps, 'system.info', () => deps.docker.info());
}

async function handleSystemDf(deps: OperationDeps): Promise<SystemDfResponse> {
  return callDocker(deps, 'system.df', () => deps.docker.df());
}

async function handleImageList(deps: OperationDeps): Promise<ImageListResponse> {
  const raw = await callDocker(deps, 'image.list', () => deps.docker.listImages());
  return {
    images: raw.map((image) => ({
      ...image,
      repoTags: [...image.repoTags],
      labels: { ...image.labels },
    })),
  };
}

async function handleVolumeList(deps: OperationDeps): Promise<VolumeListResponse> {
  const raw = await callDocker(deps, 'volume.list', () => deps.docker.listVolumes());
  return { volumes: raw.map((volume) => ({ ...volume, labels: { ...volume.labels } })) };
}

async function handleNetworkList(deps: OperationDeps): Promise<NetworkListResponse> {
  const raw = await callDocker(deps, 'network.list', () => deps.docker.listNetworks());
  return { networks: raw.map((network) => ({ ...network })) };
}

// ---------------------------------------------------------------------------
// M9 additions (FEATURE_MATRIX.md §24-26, §32) — see @dwg/shared's
// broker.ts header for the four properties every handler below preserves:
// `volume.remove` targets a volume by name and is refused for any
// protected DMS mount; `image.prune` takes no parameters and always means
// "dangling only"; `logs.file` reads a fixed, broker-hardcoded path per
// enum value; `console.exec` runs one of a fixed, zero-argument,
// broker-owned-argv command set.
// ---------------------------------------------------------------------------

async function handleVolumeRemove(
  body: Extract<BrokerRequest, { operation: 'volume.remove' }>,
  deps: OperationDeps,
): Promise<OperationAck> {
  // Fail closed if the managed container itself does not resolve —
  // `computeProtectedVolumeNames` alone is not the safety boundary (its
  // own doc comment, @dwg/shared broker.ts); the combination with this
  // refusal is. Re-inspected fresh on every call, never cached, so a
  // volume that was unmounted from the managed container since the last
  // call is judged by its *current* mounts, not a stale set.
  const ref = await resolveOrForbid(deps);
  const inspection = await callDocker(deps, 'volume.remove', () =>
    deps.docker.inspectContainer(ref.id),
  );
  const protectedNames = computeProtectedVolumeNames(inspection.mounts);
  if (protectedNames.has(body.name)) {
    deps.logger.warn(
      { volume: body.name },
      'Refusing to remove a volume backing a protected DMS data mount',
    );
    throw new BrokerError(
      'FORBIDDEN',
      'This volume backs a protected mail-data mount and cannot be removed.',
    );
  }
  await callDocker(deps, 'volume.remove', () => deps.docker.removeVolume(body.name));
  return { ok: true };
}

async function handleImagePrune(deps: OperationDeps): Promise<ImagePruneResponse> {
  const result = await callDocker(deps, 'image.prune', () => deps.docker.pruneImages());
  return {
    imagesDeleted: [...result.imagesDeleted],
    spaceReclaimedBytes: result.spaceReclaimedBytes,
  };
}

/**
 * The fixed, broker-owned mapping from {@link LogFileSource} to an
 * absolute path *inside* the managed container
 * (docs/research/01-docker-mailserver.md §11: `setup debug
 * show-mail-logs` runs `cat /var/log/mail/mail.log`; `setup fail2ban log`
 * runs `cat /var/log/mail/fail2ban.log`). There is no client-facing field
 * anywhere that could name a different path — see `LogsFileRequestSchema`
 * (@dwg/shared) — and this map's keys are exhaustively checked against
 * `LogFileSource` by the `Record` annotation itself, so a future enum
 * addition without a matching path here is a compile error, not a
 * runtime gap.
 */
const LOG_FILE_PATHS: Record<LogFileSource, string> = {
  mail: '/var/log/mail/mail.log',
  fail2ban: '/var/log/mail/fail2ban.log',
};

/**
 * Splits `tail`'s buffered stdout into lines, dropping the single empty
 * trailing element a bare `split('\n')` would otherwise produce from the
 * trailing newline `tail`/`cat` always emit after the last line — without
 * this, every response would carry one spurious blank final line.
 */
function splitTrimmedLines(text: string): string[] {
  if (text.length === 0) return [];
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.length === 0 ? [] : withoutTrailingNewline.split('\n');
}

async function handleLogsFile(
  body: Extract<BrokerRequest, { operation: 'logs.file' }>,
  deps: OperationDeps,
): Promise<LogsFileResponse> {
  const ref = await resolveOrForbid(deps);
  const path = LOG_FILE_PATHS[body.source];
  const tail = body.tail ?? LOGS_TAIL_DEFAULT;
  // `tail`'s count is a bounded integer (LOGS_TAIL_MIN..LOGS_TAIL_MAX,
  // @dwg/shared), passed as its own argv element — never concatenated
  // into a string — so even though it is caller-influenced, it cannot
  // carry a shell metacharacter or widen the command beyond "print the
  // last N lines of this one broker-chosen file".
  const result = await callDocker(deps, 'logs.file', () =>
    deps.docker.execContainer(ref.id, ['tail', '-n', String(tail), path]),
  );
  if (result.exitCode !== 0) {
    deps.logger.error(
      { source: body.source, exitCode: result.exitCode, stderr: result.stderr },
      'logs.file: tail exited non-zero',
    );
    throw new BrokerError('UPSTREAM_UNAVAILABLE', 'Could not read the requested log file.');
  }
  return { lines: splitTrimmedLines(result.stdout) };
}

/**
 * The restricted console's entire argv table — one fixed, zero-argument
 * argv array per {@link ConsoleCommand} (@dwg/shared's
 * `CONSOLE_COMMANDS`). The client sends only the symbolic key; every
 * element of every argv below is a literal this file owns, never
 * interpolated from, or extended by, anything a caller sent. The `Record`
 * annotation makes coverage a compile-time property the same way
 * `LOG_FILE_PATHS` above does.
 */
const CONSOLE_COMMAND_ARGV: Record<ConsoleCommand, readonly string[]> = {
  'postqueue-p': ['postqueue', '-p'],
  'postconf-n': ['postconf', '-n'],
  'doveconf-n': ['doveconf', '-n'],
  'doveadm-who': ['doveadm', 'who'],
};

async function handleConsoleExec(
  body: Extract<BrokerRequest, { operation: 'console.exec' }>,
  deps: OperationDeps,
): Promise<ConsoleExecResponse> {
  const ref = await resolveOrForbid(deps);
  const argv = CONSOLE_COMMAND_ARGV[body.command];
  const startedAt = Date.now();
  const result = await callDocker(deps, 'console.exec', () =>
    deps.docker.execContainer(ref.id, argv),
  );
  // Non-zero exit is not thrown here, unlike `logs.file` above: this
  // response schema has a real place to put it (`exitCode`, echoed
  // alongside `stdout`/`stderr`), and a command like `doveadm who`
  // exiting non-zero for "no active sessions" is diagnostic information
  // for the caller to render, not a broker failure.
  return {
    command: body.command,
    argv: [...argv],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
  };
}

export async function handleOperation(body: BrokerRequest, deps: OperationDeps): Promise<unknown> {
  switch (body.operation) {
    case 'container.list':
      return handleContainerList(body, deps);
    case 'container.inspect':
      return handleContainerInspect(deps);
    case 'container.start':
      return handleContainerStart(deps);
    case 'container.stop':
      return handleContainerStop(deps);
    case 'container.restart':
      return handleContainerRestart(deps);
    case 'container.stats':
      return handleContainerStats(deps);
    case 'container.logs':
      return handleContainerLogs(body, deps);
    case 'system.ping':
      return handleSystemPing(deps);
    case 'system.version':
      return handleSystemVersion(deps);
    case 'system.info':
      return handleSystemInfo(deps);
    case 'system.df':
      return handleSystemDf(deps);
    case 'image.list':
      return handleImageList(deps);
    case 'volume.list':
      return handleVolumeList(deps);
    case 'network.list':
      return handleNetworkList(deps);
    case 'volume.remove':
      return handleVolumeRemove(body, deps);
    case 'image.prune':
      return handleImagePrune(deps);
    case 'logs.file':
      return handleLogsFile(body, deps);
    case 'console.exec':
      return handleConsoleExec(body, deps);
    // M16 — the docker-mailserver vocabulary (`dms/handlers.ts`). The
    // three state reads are named individually; every command operation
    // shares one handler, because the thing that differs between them is
    // which broker-owned builder produces the argv, and that mapping is a
    // table in `dms/handlers.ts` rather than 26 cases here.
    case 'dms.file.read':
      return handleDmsFileRead(body, deps);
    case 'dms.env.read':
      return handleDmsEnvRead(deps);
    case 'dms.dkim.record.read':
      return handleDmsDkimRecordRead(body, deps);
    default: {
      if (isDmsCommandOperation(body.operation)) {
        return handleDmsCommand(
          body as Extract<BrokerRequest, { operation: DmsCommandOperation }>,
          deps,
        );
      }
      // Exhaustiveness guard, not a passthrough — see the file header.
      // Exhaustiveness still holds: every non-DMS-command operation is a
      // `case` above, and the guard directly above returns for the DMS
      // command set, so anything reaching here is genuinely unhandled.
      throw new BrokerError(
        'VALIDATION_FAILED',
        `Unhandled operation: ${JSON.stringify(body.operation)}`,
      );
    }
  }
}
