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
  RawContainerStats,
  RawImage,
  RawLogsOptions,
  RawNetwork,
  RawSystemDf,
  RawSystemInfo,
  RawVersion,
  RawVolume,
} from './docker-types.js';

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
  };
}
