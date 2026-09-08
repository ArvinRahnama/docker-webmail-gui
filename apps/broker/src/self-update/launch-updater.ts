/**
 * Composes the detached updater container's spec and launches it
 * (docs/design/self-update.md §1) — the one place `panel.selfUpdateApply`
 * (`operations.ts`) hands off from "the request that triggered this" to
 * a container whose lifetime is independent of the process running that
 * request. Every field of the spec below is a fixed, broker-composed
 * constant or a value read from Docker's own state (the broker's own
 * currently-running image); none of it ever originates from a
 * `BrokerRequest` — the same discipline every other operation in this
 * codebase already follows, applied to the one operation that needs to
 * create a container at all.
 */
import type { DockerApi } from '../docker-types.js';

/** Fixed name — a second launch always removes a leftover from a previous run first (see below) rather than colliding with it. */
export const SELF_UPDATE_UPDATER_CONTAINER_NAME = 'dwg-self-update-updater';

/** The alternate command this container runs instead of `apps/broker/dist/index.js` — `updater-entrypoint.ts`'s own compiled output. */
const UPDATER_ENTRYPOINT_COMMAND = ['node', 'apps/broker/dist/self-update/updater-entrypoint.js'];

/** The same bind `dwg-broker` itself has (`docker/compose.yaml`) — nothing wider. `AutoRemove` means a successful (or failed-and-rolled-back) run cleans itself up without needing a separate sweep. */
const DOCKER_SOCKET_BIND = '/var/run/docker.sock:/var/run/docker.sock';

export interface UpdaterLaunchTarget {
  /** The broker's own currently-running image reference — the updater runs the *current* broker code, never the (not yet pulled, at launch time) target version. See docs/design/self-update.md §1. */
  readonly brokerOwnImage: string;
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
    hostConfig: { Binds: [DOCKER_SOCKET_BIND], AutoRemove: true },
    networkingConfig: {},
  });
  await docker.startContainer(id);
}
