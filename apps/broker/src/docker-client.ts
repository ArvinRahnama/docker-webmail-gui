/**
 * The one file in this app that touches `dockerode` directly. Everything
 * else depends only on the minimal {@link DockerApi} interface in
 * `docker-types.ts`, so this adapter is the single place a real Docker
 * client's quirks (its optimistic types, its 304-on-already-stopped
 * behaviour, its `any`-typed `info()`/`df()`) get translated into this
 * project's own honest shape. Not exercised by tests — there is no
 * Docker daemon on this development machine — but it type-checks against
 * `@types/dockerode`, which is real signal even without a live socket.
 */
import Dockerode from 'dockerode';
import type {
  DockerApi,
  RawContainerListItem,
  RawContainerInspect,
  RawContainerMount,
  RawContainerStats,
  RawExecResult,
  RawImage,
  RawImagePruneResult,
  RawLogsOptions,
  RawNetwork,
  RawSystemDf,
  RawSystemInfo,
  RawVersion,
  RawVolume,
} from './docker-types.js';
import { DockerStreamDemuxer, type DemuxedFrame } from './stream-demux.js';

/** Docker prefixes container names with `/` (`GET /containers/json`'s `Names`, inspect's `Name`). Strip it so this app's own vocabulary deals in plain names throughout. */
export function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

function toContainerListItem(raw: Dockerode.ContainerInfo): RawContainerListItem {
  return {
    id: raw.Id,
    names: raw.Names.map(stripLeadingSlash),
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    labels: raw.Labels,
    createdAt: raw.Created,
  };
}

function toContainerMount(
  raw: Dockerode.ContainerInspectInfo['Mounts'][number],
): RawContainerMount {
  return {
    type: raw.Type,
    name: raw.Name ?? null,
    destination: raw.Destination,
  };
}

function toContainerInspect(raw: Dockerode.ContainerInspectInfo): RawContainerInspect {
  return {
    id: raw.Id,
    name: stripLeadingSlash(raw.Name),
    image: raw.Image,
    createdAt: raw.Created,
    tty: raw.Config.Tty,
    restartCount: raw.RestartCount,
    labels: raw.Config.Labels,
    state: {
      status: raw.State.Status,
      running: raw.State.Running,
      paused: raw.State.Paused,
      restarting: raw.State.Restarting,
      startedAt: raw.State.StartedAt,
      finishedAt: raw.State.FinishedAt,
      exitCode: raw.State.ExitCode,
      health: raw.State.Health?.Status ?? null,
    },
    mounts: raw.Mounts.map(toContainerMount),
  };
}

function toVersion(raw: Dockerode.DockerVersion): RawVersion {
  return {
    version: raw.Version,
    apiVersion: raw.ApiVersion,
    minApiVersion: raw.MinAPIVersion,
    os: raw.Os,
    arch: raw.Arch,
    kernelVersion: raw.KernelVersion,
  };
}

function toImage(raw: Dockerode.ImageInfo): RawImage {
  return {
    id: raw.Id,
    repoTags: raw.RepoTags ?? [],
    sizeBytes: raw.Size,
    createdAt: raw.Created,
    labels: raw.Labels,
  };
}

function toVolume(raw: Dockerode.VolumeInspectInfo): RawVolume {
  return {
    name: raw.Name,
    driver: raw.Driver,
    mountpoint: raw.Mountpoint,
    labels: raw.Labels,
  };
}

function toNetwork(raw: Dockerode.NetworkInspectInfo): RawNetwork {
  return {
    id: raw.Id,
    name: raw.Name,
    driver: raw.Driver,
    scope: raw.Scope,
  };
}

// `info()`/`df()` are typed `Promise<any>` by @types/dockerode itself —
// there is no ambient type to trust here, so fields are read defensively
// by the exact names documented in
// docs/research/02-docker-api-security.md §A.1, with safe fallbacks
// rather than a throw if a future daemon version renames or drops one.

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toSystemInfo(raw: unknown): RawSystemInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    containers: asNumber(r.Containers),
    containersRunning: asNumber(r.ContainersRunning),
    containersPaused: asNumber(r.ContainersPaused),
    containersStopped: asNumber(r.ContainersStopped),
    images: asNumber(r.Images),
    serverVersion: asString(r.ServerVersion),
    driver: asString(r.Driver),
    ncpu: asNumber(r.NCPU),
    memTotal: asNumber(r.MemTotal),
  };
}

function toSystemDf(raw: unknown): RawSystemDf {
  const r = (raw ?? {}) as Record<string, unknown>;
  const buildCache = asArray(r.BuildCache) as Array<{ Size?: unknown }>;
  const buildCacheBytes = buildCache.reduce((sum, entry) => sum + asNumber(entry?.Size), 0);
  return {
    layersSizeBytes: asNumber(r.LayersSize),
    imagesCount: asArray(r.Images).length,
    containersCount: asArray(r.Containers).length,
    volumesCount: asArray(r.Volumes).length,
    buildCacheBytes,
  };
}

function isDockerStatusCode(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode?: unknown }).statusCode === status
  );
}

/**
 * Start/stop document a `304` ("already started"/"already stopped") as a
 * legitimate, documented outcome
 * (docs/research/02-docker-api-security.md §A.1) — not an error. The
 * caller asked for a *state*, not a state *transition*, so this treats it
 * as success rather than surfacing a spurious failure for an idempotent
 * request. Restart has no documented 304, so it is deliberately not
 * wrapped here — inventing behaviour the research doc never confirmed
 * would be a worse bug than leaving it alone.
 */
async function idempotentLifecycleCall(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (isDockerStatusCode(err, 304)) return;
    throw err;
  }
}

/**
 * Drains an exec's hijacked duplex stream to completion, decoding it
 * incrementally with {@link DockerStreamDemuxer} as chunks arrive —
 * exactly the class's intended use (`stream-demux.ts`'s own doc comment)
 * — rather than buffering raw bytes first and decoding once, so a frame
 * split across two chunk-boundary-adjacent `data` events is handled the
 * same way it would be for a live `follow` connection. Every command this
 * broker ever execs (`operations.ts`'s fixed `console.exec` map and
 * `logs.file`'s hardcoded `tail` invocation) is short-lived and
 * non-interactive, so buffering its complete decoded output in memory
 * before returning is the right tradeoff — there is no streaming
 * exec/attach UI in this project (ARCHITECTURE.md — no general `exec.*`
 * operation exists at all).
 */
function collectExecFrames(stream: NodeJS.ReadableStream): Promise<DemuxedFrame[]> {
  return new Promise((resolve, reject) => {
    const demuxer = new DockerStreamDemuxer();
    const frames: DemuxedFrame[] = [];
    stream.on('data', (chunk: Buffer) => {
      frames.push(...demuxer.push(chunk));
    });
    stream.on('end', () => resolve(frames));
    stream.on('error', (err: Error) => reject(err));
  });
}

function joinFrames(frames: readonly DemuxedFrame[], kind: DemuxedFrame['stream']): string {
  return frames
    .filter((frame) => frame.stream === kind)
    .map((frame) => frame.data.toString('utf8'))
    .join('');
}

/** Builds a {@link DockerApi} backed by a real `dockerode` client against `socketPath`. Connecting is lazy — `dockerode` does not touch the socket until the first call, so constructing this is safe even in a process where the Docker socket may not (yet) exist. */
export function createRealDockerApi(socketPath: string): DockerApi {
  const docker = new Dockerode({ socketPath });

  return {
    async ping() {
      await docker.ping();
    },

    async version() {
      return toVersion(await docker.version());
    },

    async info() {
      return toSystemInfo(await docker.info());
    },

    async df() {
      return toSystemDf(await docker.df());
    },

    async listContainers(options) {
      const raw = await docker.listContainers({ all: options.all });
      return raw.map(toContainerListItem);
    },

    async inspectContainer(id) {
      const raw = await docker.getContainer(id).inspect();
      return toContainerInspect(raw);
    },

    async startContainer(id) {
      await idempotentLifecycleCall(() => docker.getContainer(id).start());
    },

    async stopContainer(id) {
      await idempotentLifecycleCall(() => docker.getContainer(id).stop());
    },

    async restartContainer(id) {
      await docker.getContainer(id).restart();
    },

    async statsContainer(id): Promise<RawContainerStats> {
      // `stream: false` (without `one-shot`) makes the daemon wait its
      // own ~1s internal sampling window and return one JSON object with
      // *both* cpu_stats and precpu_stats meaningfully populated — unlike
      // `one-shot: true`, which skips that wait and zeroes precpu_stats,
      // making CPU% uncomputable from a single read
      // (docs/research/02-docker-api-security.md §A.3). A real
      // `Dockerode.ContainerStats` value already satisfies
      // `RawContainerStats` structurally (docker-types.ts), so no manual
      // field mapping is needed here.
      return docker.getContainer(id).stats({ stream: false });
    },

    async logsContainer(id, options: RawLogsOptions) {
      // `follow: false` — Docker returns the bounded historical output
      // and closes; `dockerode` buffers it into one Buffer rather than a
      // stream in this mode. See apps/broker/src/operations.ts for the
      // scope note on why live tailing is not wired here in M4.
      return docker.getContainer(id).logs({
        stdout: true,
        stderr: true,
        follow: false,
        tail: options.tail,
        since: options.since,
        timestamps: options.timestamps,
      });
    },

    async listImages() {
      const raw = await docker.listImages();
      return raw.map(toImage);
    },

    async listVolumes() {
      const raw = await docker.listVolumes();
      return raw.Volumes.map(toVolume);
    },

    async listNetworks() {
      const raw = await docker.listNetworks();
      return raw.map(toNetwork);
    },

    async removeVolume(name): Promise<void> {
      // No `force` — an in-use volume 409s and surfaces to the caller as
      // an ordinary upstream failure via `callDocker` (operations.ts);
      // the *protected* case never reaches this method at all (that
      // check happens before this is ever called, see docker-types.ts's
      // doc comment on this method).
      await docker.getVolume(name).remove();
    },

    async pruneImages(): Promise<RawImagePruneResult> {
      // No filters constructed or passed: Docker's own documented
      // default for `POST /images/prune` with no `dangling` filter
      // prunes only dangling (untagged, unused) images — the same
      // default `docker image prune` (without `-a`) uses. [INFERRED —
      // the operation table in
      // docs/research/02-docker-api-security.md §A.1 lists the filter
      // but does not spell out its default] This already *is*
      // `image.prune`'s whole contract (@dwg/shared broker.ts: "always
      // means remove dangling images, never remove image X"), so there
      // is nothing to construct here beyond the bare call — and
      // @types/dockerode's `pruneImages(options?: {})` signature has no
      // typed room for a filters object regardless.
      const raw = await docker.pruneImages();
      // Real daemons have been observed returning `ImagesDeleted: null`
      // (not `[]`) when nothing was pruned, despite @types/dockerode
      // claiming a bare array — defensive fallback here mirrors
      // `toSystemInfo`/`toSystemDf` above, which apply the same
      // treatment to fields Docker's own JSON is looser about than its
      // types claim.
      const deleted = raw.ImagesDeleted ?? [];
      return {
        // Only the `Deleted` half of each `{Untagged, Deleted}` pair:
        // `Untagged` records a tag removed from an image that may still
        // exist under another tag, which is not "deleted" in the sense
        // `ImagePruneResponseSchema` documents ("Image IDs actually
        // deleted").
        imagesDeleted: deleted
          .map((entry) => entry.Deleted)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
        spaceReclaimedBytes: raw.SpaceReclaimed ?? 0,
      };
    },

    async getContainerArchive(id, path): Promise<NodeJS.ReadableStream> {
      // `dockerode`'s `getArchive` maps straight onto `GET
      // /containers/{id}/archive?path=…` and resolves with the raw
      // response stream — no buffering, no decoding, so what
      // `archive-routes.ts` pipes to its own HTTP response is exactly
      // what Docker sent.
      return docker.getContainer(id).getArchive({ path });
    },

    async putContainerArchive(id, path, tarStream): Promise<void> {
      // `dockerode`'s `putArchive` maps onto `PUT
      // /containers/{id}/archive?path=…`, streaming the request body
      // through unmodified. `path` here is the *directory* Docker
      // extracts into — for this project's four fixed volume paths
      // (`/var/mail`, …) that is always the path itself, matching how
      // `getContainerArchive` reads that same path.
      await docker.getContainer(id).putArchive(tarStream, { path });
    },

    async execContainer(id, argv, options): Promise<RawExecResult> {
      const container = docker.getContainer(id);
      const stdin = options?.stdin;
      const exec = await container.exec({
        // Spread into a fresh mutable array: `argv` arrives as
        // `readonly string[]` (docker-types.ts), `ExecCreateOptions.Cmd`
        // wants a plain `string[]`.
        Cmd: [...argv],
        AttachStdout: true,
        AttachStderr: true,
        // Only attached when there is something to write. An exec with
        // stdin attached and never closed would hang the command waiting
        // for input that is not coming — the exact failure mode
        // `setup email del` has without an explicit -y/-n.
        ...(stdin === undefined ? {} : { AttachStdin: true }),
        // Never a PTY: keeps the stream in the documented multiplexed
        // format (§A.2) `stream-demux.ts` already decodes, and none of
        // this broker's fixed diagnostic commands are interactive.
        Tty: false,
        // `Privileged` deliberately omitted — never set (§A.4, §C.1).
      });
      const stream = await exec.start(
        stdin === undefined
          ? { Detach: false, Tty: false }
          : // `hijack` upgrades the connection to a bidirectional stream,
            // which is what makes the socket writable at all; without it
            // dockerode returns a read-only response stream.
            { Detach: false, Tty: false, hijack: true, stdin: true },
      );
      if (stdin !== undefined) {
        // Written before frames are collected, and ended immediately: the
        // command is waiting on EOF, and `collectExecFrames` below waits
        // on the stream's own end, so a stdin left open would deadlock the
        // two against each other.
        stream.write(stdin);
        stream.end();
      }
      const frames = await collectExecFrames(stream);
      const inspection = await exec.inspect();
      return {
        stdout: joinFrames(frames, 'stdout'),
        stderr: joinFrames(frames, 'stderr'),
        // `ExitCode` is `null` while the exec is still running; the
        // stream has already ended (its `end` event fired) by the time
        // we reach this inspect call, so a real `null` here would mean
        // the daemon disagrees with its own stream framing — defensive,
        // not an expected path.
        exitCode: inspection.ExitCode ?? -1,
      };
    },
  };
}
