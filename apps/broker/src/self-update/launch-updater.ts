/**
 * Composes the detached updater container's spec and launches it
 * (docs/design/self-update.md §1) — the one place `panel.selfUpdateApply`
 * (`operations.ts`) hands off from "the request that triggered this" to
 * a container whose lifetime is independent of the process running that
 * request. Every field of the spec below is a fixed, broker-composed
 * constant or a value read from Docker's own state (the broker's own
 * currently-running image and `hostConfig`); none of it ever originates
 * from a `BrokerRequest` — the same discipline every other operation in
 * this codebase already follows, applied to the one operation that needs
 * to create a container at all.
 *
 * **Real-daemon bug fixed here, invisible to every fake-`DockerApi` test
 * (SU-F's first real run found it):** the updater's `hostConfig` used to
 * be hand-composed from scratch (`Binds` + `AutoRemove` only). That
 * silently dropped `GroupAdd` — `docker/compose.yaml`'s
 * `group_add: [DOCKER_GID]` on `broker:` itself, the host's own `docker`
 * group GID, which is what actually lets the non-root `dwg` user read
 * and write `/var/run/docker.sock` (bind-mounting the socket *file* does
 * not by itself grant a process permission to use it — group membership
 * does). A hand-composed `hostConfig` with the right `Binds` entry but no
 * `GroupAdd` therefore builds and starts a container that can be bound to
 * the socket and still get `EACCES` on its very first Docker API call —
 * exactly matching what the first real run observed: `apply` returned
 * `{started:true}` (the broker itself launched the updater successfully),
 * but neither panel container was ever touched, and `AutoRemove` erased
 * every trace of why. Fixed by **cloning the broker's own currently-
 * running `hostConfig`** the same "opaque, byte-for-byte" way every other
 * recreate in this feature already works (`RawContainerRecreateSpec`,
 * `docker-types.ts`) — `GroupAdd`, `CapDrop`, `SecurityOpt`,
 * `ReadonlyRootfs`, `NetworkMode`, resource limits, all of it, unread and
 * undecided-on — plus the one thing genuinely specific to the updater:
 * one extra `Binds` entry for the server-data volume, appended to
 * whatever `Binds` the broker already has (which already includes the
 * docker-socket bind, so there is nothing left to hand-compose there
 * either) — see {@link withUpdaterHostConfig}.
 */
import type { DockerApi } from '../docker-types.js';

/** Fixed name — a second launch always removes a leftover from a previous run first (see below) rather than colliding with it. */
export const SELF_UPDATE_UPDATER_CONTAINER_NAME = 'dwg-self-update-updater';

/** The alternate command this container runs instead of `apps/broker/dist/index.js` — `updater-entrypoint.ts`'s own compiled output. */
const UPDATER_ENTRYPOINT_COMMAND = ['node', 'apps/broker/dist/self-update/updater-entrypoint.js'];

/**
 * The same named volume already mounted into `dwg-server` at `/app/data`
 * (`docker/compose.yaml`'s `volumes.server-data.name`) — mounted into the
 * updater at the identical container path so `updater.ts`'s status-file
 * write (docs/design/self-update.md §4, §9.7) lands exactly where the new
 * `dwg-server` process already looks for it, with no new volume to
 * provision. Docker's `Binds` syntax accepts a named volume the same way
 * it accepts a host path (`name:containerPath`), so this needs nothing
 * beyond the one extra bind entry below.
 */
const SERVER_DATA_VOLUME_BIND = 'dwg-server-data:/app/data';

/**
 * Reads only `Binds` out of the broker's own cloned `hostConfig` — to
 * append the one extra bind the updater needs beyond whatever the broker
 * itself already has (which already includes the docker-socket bind,
 * `docker/compose.yaml`) — and layers `AutoRemove: true` on top. Every
 * other field is passed through completely untouched: this function
 * never reads, interprets, or decides anything based on `GroupAdd`,
 * `NetworkMode`, `CapDrop`, or any other entry, matching
 * `RawContainerRecreateSpec`'s own "opaque, byte-for-byte" discipline —
 * this is the one narrow, named exception (`Binds`, to append one entry),
 * not a general license to reach into the rest of the object.
 */
function withUpdaterHostConfig(
  brokerHostConfig: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const existingBinds = Array.isArray(brokerHostConfig.Binds) ? brokerHostConfig.Binds : [];
  return {
    ...brokerHostConfig,
    Binds: [...existingBinds, SERVER_DATA_VOLUME_BIND],
    AutoRemove: true,
  };
}

export interface UpdaterLaunchTarget {
  /** The broker's own currently-running image reference — the updater runs the *current* broker code, never the (not yet pulled, at launch time) target version. See docs/design/self-update.md §1. */
  readonly brokerOwnImage: string;
  /** The broker's own currently-running `hostConfig`, cloned via `docker inspect` (`inspectContainerForRecreate`, never hand-composed) — see this file's own header for exactly why. */
  readonly brokerHostConfig: Readonly<Record<string, unknown>>;
  /** The broker's own currently-running `networkingConfig`, cloned the same way — keeps the updater on the same (`internal: true`) network the broker itself is confined to, rather than falling back to Docker's default bridge network. Functionally the updater never needs network reachability at all (every Docker API call it makes goes over the bind-mounted socket, performed daemon-side using the *host's* networking — docs/design/self-update.md §1's "Registry access from an `internal: true` network"); this is purely a defense-in-depth placement match, not something the updater's own operation depends on. */
  readonly brokerNetworkingConfig: Readonly<Record<string, unknown>>;
  readonly serverContainerName: string;
  readonly brokerContainerName: string;
  readonly serverImageRef: string;
  readonly brokerImageRef: string;
}

export async function launchUpdater(docker: DockerApi, target: UpdaterLaunchTarget): Promise<void> {
  // Best-effort cleanup of a stale updater container left behind by a
  // previous run (crashed before its own AutoRemove could apply) — never
  // lets a leftover name collision block a legitimate retry.
  const all = await docker.listContainers({ all: true });
  const stale = all.find((container) =>
    container.names.includes(SELF_UPDATE_UPDATER_CONTAINER_NAME),
  );
  if (stale !== undefined) {
    await docker.removeContainer(stale.id, { force: true }).catch(() => undefined);
  }

  const { id } = await docker.createContainer({
    name: SELF_UPDATE_UPDATER_CONTAINER_NAME,
    image: target.brokerOwnImage,
    cmd: UPDATER_ENTRYPOINT_COMMAND,
    env: [
      `DWG_SELF_UPDATE_SERVER_CONTAINER_NAME=${target.serverContainerName}`,
      `DWG_SELF_UPDATE_BROKER_CONTAINER_NAME=${target.brokerContainerName}`,
      `DWG_SELF_UPDATE_SERVER_IMAGE_REF=${target.serverImageRef}`,
      `DWG_SELF_UPDATE_BROKER_IMAGE_REF=${target.brokerImageRef}`,
    ],
    labels: {},
    hostConfig: withUpdaterHostConfig(target.brokerHostConfig),
    networkingConfig: target.brokerNetworkingConfig,
  });
  await docker.startContainer(id);
}
