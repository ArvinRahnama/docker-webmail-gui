/**
 * The broker's own, minimal view of Docker — deliberately not
 * `dockerode`'s types. This interface names only the handful of fields
 * this project actually surfaces (never `HostConfig`, never a full
 * inspect payload), and it is the seam that makes every other module in
 * this app testable with a hand-built stub instead of a real Docker
 * socket (there is none on this development machine — see
 * `docker-client.ts` for the one file that adapts a real `dockerode`
 * instance to this shape).
 */

export interface RawContainerListItem {
  readonly id: string;
  /** Leading `/` already stripped (Docker returns names as `/mailserver`). */
  readonly names: readonly string[];
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Unix seconds. */
  readonly createdAt: number;
  /**
   * Named volumes this container mounts — the `Name` of each `Mounts`
   * entry whose `Type` is `volume` (from `GET /containers/json`'s own
   * `Mounts` array). The input to deriving the *visible volume set* from
   * the visible containers (`operations.ts`'s `volume.list` filter), so
   * the panel never enumerates volumes belonging to unrelated host
   * containers. Bind mounts and anonymous mounts contribute nothing here.
   */
  readonly mountVolumeNames: readonly string[];
  /**
   * Networks this container is attached to — the keys of `GET
   * /containers/json`'s `NetworkSettings.Networks`. The input to deriving
   * the *visible network set* from the visible containers
   * (`operations.ts`'s `network.list` filter). Present for stopped
   * containers too, since Docker retains their network config.
   */
  readonly networkNames: readonly string[];
}

/**
 * One entry from Docker inspect's own `Mounts` array, reduced to exactly
 * the fields `@dwg/shared`'s `ContainerMountSchema` needs — deliberately
 * the same shape (`type`/`name`/`destination`) so `operations.ts` can pass
 * this straight through (and into `computeProtectedVolumeNames`) with no
 * mapping step to forget. `name` is `null` for a bind mount or any type
 * other than `volume`, matching Docker's own optional `Name` field.
 */
export interface RawContainerMount {
  readonly type: string;
  readonly name: string | null;
  readonly destination: string;
}

/**
 * `stdin`, when present, is written to the exec's standard input and the
 * stream is then closed. This is the only channel a password or a Sieve
 * script body ever travels over: an argv element is visible in `ps` to
 * anything else inside the container, which is precisely why
 * docker-mailserver's own `setup email add` reads its password from a
 * prompt rather than a flag (`docs/research/01-docker-mailserver.md` ★3).
 */
export interface RawExecOptions {
  readonly stdin?: string;
}

export interface RawContainerInspect {
  readonly id: string;
  /** Leading `/` already stripped. */
  readonly name: string;
  readonly image: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Whether the container was created with a TTY — decides which branch `stream-demux.ts` takes for its logs. */
  readonly tty: boolean;
  readonly restartCount: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: {
    readonly status: string;
    readonly running: boolean;
    readonly paused: boolean;
    readonly restarting: boolean;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly exitCode: number;
    readonly health: string | null;
  };
  /**
   * The managed container's own live mounts — the sole input to
   * {@link computeProtectedVolumeNames [@dwg/shared]}'s protected-volume
   * derivation (`operations.ts`'s `volume.remove` handler). Never includes
   * the host `Source` path, mirroring `ContainerMountSchema`'s own
   * omission of it.
   */
  readonly mounts: readonly RawContainerMount[];
}

export interface RawVersion {
  readonly version: string;
  readonly apiVersion: string;
  readonly minApiVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly kernelVersion: string;
}

export interface RawSystemInfo {
  readonly containers: number;
  readonly containersRunning: number;
  readonly containersPaused: number;
  readonly containersStopped: number;
  readonly images: number;
  readonly serverVersion: string;
  readonly driver: string;
  readonly ncpu: number;
  readonly memTotal: number;
}

export interface RawSystemDf {
  readonly layersSizeBytes: number;
  readonly imagesCount: number;
  readonly containersCount: number;
  readonly volumesCount: number;
  readonly buildCacheBytes: number;
}

export interface RawImage {
  readonly id: string;
  readonly repoTags: readonly string[];
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface RawVolume {
  readonly name: string;
  readonly driver: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface RawNetwork {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// Container stats — field names deliberately mirror Docker's own raw JSON
// (snake_case, `cpu_stats.cpu_usage.total_usage`, …) rather than being
// translated to camelCase, so the correspondence with the formulas quoted
// verbatim in docs/research/02-docker-api-security.md §A.3 stays
// visually checkable against this file, field for field. A real
// `dockerode` `ContainerStats` value (see `docker-client.ts`) already
// satisfies this shape structurally — no manual mapping needed for stats
// specifically, which is why `DockerApi.statsContainer` below returns it
// almost unadapted.
// ---------------------------------------------------------------------------

export interface RawCpuUsage {
  readonly total_usage: number;
  /**
   * Unset on cgroup v2 hosts (docs/research/02-docker-api-security.md
   * §A.3) — optional here to model that reality, even though `dockerode`'s
   * own (optimistic) types claim it is always present.
   */
  readonly percpu_usage?: readonly number[];
}

export interface RawCpuStats {
  readonly cpu_usage: RawCpuUsage;
  readonly system_cpu_usage?: number;
  readonly online_cpus?: number;
}

export interface RawMemoryStatsDetail {
  /** Present on cgroup v1 hosts. */
  readonly cache?: number;
  /** Present on cgroup v2 hosts. */
  readonly inactive_file?: number;
}

export interface RawMemoryStats {
  readonly usage: number;
  readonly limit: number;
  readonly stats: RawMemoryStatsDetail;
}

export interface RawNetworkStats {
  readonly rx_bytes: number;
  readonly tx_bytes: number;
}

export interface RawContainerStats {
  readonly cpu_stats: RawCpuStats;
  readonly precpu_stats: RawCpuStats;
  readonly memory_stats: RawMemoryStats;
  readonly pids_stats?: { readonly current?: number };
  readonly networks?: Readonly<Record<string, RawNetworkStats>>;
}

export interface RawLogsOptions {
  readonly tail: number;
  readonly since?: number;
  readonly timestamps: boolean;
}

/**
 * Result of `pruneImages()` — already reduced to the two fields
 * `ImagePruneResponseSchema` (`@dwg/shared`) needs. `imagesDeleted` is
 * image *ids* only (the `Deleted` half of Docker's own
 * `Untagged`/`Deleted` pair per removed image) — see `docker-client.ts`
 * for why the `Untagged` half is dropped.
 */
export interface RawImagePruneResult {
  readonly imagesDeleted: readonly string[];
  readonly spaceReclaimedBytes: number;
}

/**
 * Result of one exec run to completion. Always the full, buffered
 * stdout/stderr of a single short-lived diagnostic command (never a
 * live/streamed session) — see `console.exec`'s and `logs.file`'s fixed,
 * zero-argument-or-broker-owned-argv command sets in
 * `apps/broker/src/operations.ts`, neither of which ever runs anything
 * long-lived enough for unbounded buffering to be a real concern.
 */
export interface RawExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The broker's entire Docker vocabulary. Every method here is one Docker
 * Engine API call (docs/research/02-docker-api-security.md §A.1) — there
 * is no generic `call(method, path, body)` escape hatch, mirroring the
 * closed vocabulary one layer up in `@dwg/shared`'s `BrokerOperation`.
 */
export interface DockerApi {
  ping(): Promise<void>;
  version(): Promise<RawVersion>;
  info(): Promise<RawSystemInfo>;
  df(): Promise<RawSystemDf>;
  listContainers(options: { readonly all: boolean }): Promise<readonly RawContainerListItem[]>;
  inspectContainer(id: string): Promise<RawContainerInspect>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  restartContainer(id: string): Promise<void>;
  statsContainer(id: string): Promise<RawContainerStats>;
  /** Always bounded (`follow: false` at the Docker API level) — see apps/broker/src/operations.ts for the scope note on live tailing. */
  logsContainer(id: string, options: RawLogsOptions): Promise<Buffer>;
  listImages(): Promise<readonly RawImage[]>;
  listVolumes(): Promise<readonly RawVolume[]>;
  listNetworks(): Promise<readonly RawNetwork[]>;
  /**
   * Removes one volume **by name** — the one place this interface accepts
   * a bare string identifier rather than resolving identity itself, matching
   * `VolumeRemoveRequestSchema` (`@dwg/shared`) one layer up. Callers
   * (`operations.ts`) must run the protected-mount check before ever
   * reaching this method; this method itself performs no such check, so it
   * is not by itself a safety boundary — see that file's `volume.remove`
   * handler.
   */
  removeVolume(name: string): Promise<void>;
  /**
   * Always "remove every dangling image" — there is no by-name/by-id
   * overload, matching `ImagePruneRequestSchema`'s complete absence of
   * parameters (`@dwg/shared`). See `docker-client.ts` for the Docker-side
   * default this relies on.
   */
  pruneImages(): Promise<RawImagePruneResult>;
  /**
   * Runs one command **to completion** inside the managed container and
   * returns its buffered output plus exit code — never a live/attached
   * session. `argv` is always broker-constructed (`operations.ts`'s fixed
   * `console.exec` command map, or its hardcoded `logs.file` `tail`
   * invocation); this method has no way to distinguish the two callers and
   * enforces nothing about `argv`'s origin itself; the callers are the
   * boundary. Implementations must pass `argv` as `Cmd` verbatim (never
   * wrapped in a shell) and must never set `Privileged`
   * (docs/research/02-docker-api-security.md §C.1, §A.4).
   */
  execContainer(
    id: string,
    argv: readonly string[],
    options?: RawExecOptions,
  ): Promise<RawExecResult>;
  /**
   * Streams a `tar` of one absolute path inside the container, untouched —
   * exactly Docker's own `GET /containers/{id}/archive?path=…` response
   * body (docker-mailserver's data volumes, `docs/research/01-docker-mailserver.md`
   * §6, §11), byte for byte. This is the mechanism behind M10 backups
   * (`apps/server/src/modules/backups/backup-archive.ts`): the whole
   * point of never re-serialising this stream is that every entry's
   * original uid/gid/mode/mtime — including the vmail 5000:5000 ownership
   * FEATURE_MATRIX.md §27 calls out by name — survives round-trip
   * untouched. `path` is always one of the four broker-owned constants in
   * `archive-routes.ts`'s `ARCHIVE_VOLUME_PATHS`, never a caller-supplied
   * string — this method itself enforces nothing about `path`'s origin,
   * exactly like `execContainer`'s `argv` above; the caller is the
   * boundary.
   */
  getContainerArchive(id: string, path: string): Promise<NodeJS.ReadableStream>;
  /**
   * Writes a `tar` stream into the container at one absolute path,
   * replacing whatever is there — the restore half of
   * {@link getContainerArchive}. Docker's own `PUT
   * .../archive` extracts the tar's entries using the uid/gid/mode
   * recorded in *their own headers*, not the caller's identity, which is
   * what makes vmail ownership preservation automatic for a backup this
   * project never re-serialised (see `getContainerArchive`'s doc comment)
   * — there is no separate chown step anywhere in this codebase because
   * none is needed. Callers (`modules/backups/backup-archive.ts`) must
   * confirm the target container is stopped before calling this — restore
   * is Tier 4 and this method performs no such check itself.
   */
  putContainerArchive(id: string, path: string, tarStream: NodeJS.ReadableStream): Promise<void>;
}
