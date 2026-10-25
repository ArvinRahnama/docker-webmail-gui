/**
 * Removes the panel's own images from versions older than the one now
 * running. Neither update path ever did this: the self-updater
 * (`updater.ts`) pulls the new `repo:X.Y.Z` pair and recreates both
 * containers, and an installer re-run does `docker compose pull` + `up`, but
 * both leave every earlier `docker-webmail-gui-server`/`-broker` tag on the
 * host — a few hundred MB per release, accumulating forever.
 *
 * **Why the broker does it at startup, and not the updater at its end.** The
 * updater runs in a container of the *previous* broker image (it has to —
 * `launch-updater.ts`), so that image is in use until the updater exits, and
 * Docker refuses to delete it. The new broker starts while the updater is
 * still finishing, so {@link startStaleImageCleanup} waits a couple of
 * minutes and then sweeps periodically: the leftover is picked up once its
 * last container is gone, and an installer-driven upgrade is covered by the
 * same code.
 *
 * What counts as stale, conservatively:
 *  - **every** tag on the image is under one of the panel's two
 *    repositories (an image someone also tagged elsewhere is left alone);
 *  - it carries at least one exact `X.Y.Z` tag, and every such tag is
 *    *older* than the running version — so a newer image pulled ahead of
 *    time, or the current one, is never touched, and an operator who
 *    deliberately runs an older release keeps the newer one;
 *  - no container, running or stopped, was created from it.
 *
 * Removal goes tag by tag and is never forced, so Docker's own checks are
 * the final say: it will not delete an image any container still uses.
 */
import type { Logger } from 'pino';
import type { DockerApi, RawImage } from '../docker-types.js';

/** First sweep after startup — long enough for the updater container that launched this broker to have exited. */
export const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
/** Later sweeps — a cheap list of images and containers, nearly always a no-op. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** `-1`/`0`/`1` like a comparator; both arguments must be exact `X.Y.Z`. */
function compareVersions(a: string, b: string): number {
  const left = EXACT_VERSION.exec(a)!;
  const right = EXACT_VERSION.exec(b)!;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function splitTag(reference: string): { readonly repository: string; readonly tag: string } {
  const colon = reference.lastIndexOf(':');
  // A colon before the last `/` belongs to a registry port, not a tag.
  if (colon === -1 || colon < reference.lastIndexOf('/')) return { repository: reference, tag: '' };
  return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}

/** Whether `image` is a previous release of the panel — see the module header for the exact rule. */
export function isStalePanelImage(
  image: RawImage,
  repositories: readonly string[],
  runningVersion: string,
): boolean {
  if (!EXACT_VERSION.test(runningVersion) || image.repoTags.length === 0) return false;
  let hasVersionTag = false;
  for (const reference of image.repoTags) {
    const { repository, tag } = splitTag(reference);
    if (!repositories.includes(repository)) return false;
    if (EXACT_VERSION.test(tag)) {
      if (compareVersions(tag, runningVersion) >= 0) return false;
      hasVersionTag = true;
    }
  }
  return hasVersionTag;
}

export interface StaleImageCleanupDeps {
  readonly docker: DockerApi;
  /** The running panel version (`APP_VERSION`) — only images strictly older than this are removed. */
  readonly runningVersion: string;
  /** Both panel repositories, plus their registry-override equivalents when one is configured. */
  readonly repositories: readonly string[];
  readonly logger: Logger;
}

/** One sweep. Returns the tags it removed; a tag Docker refuses to remove is logged and the image skipped. */
export async function removeStalePanelImages(
  deps: StaleImageCleanupDeps,
): Promise<readonly string[]> {
  const [images, containers] = await Promise.all([
    deps.docker.listImages(),
    deps.docker.listContainers({ all: true }),
  ]);
  // A container's `image` is the reference it was created with, or the bare
  // image id once that reference no longer points at it — check both.
  const inUse = new Set(containers.map((container) => container.image));

  const removed: string[] = [];
  for (const image of images) {
    if (!isStalePanelImage(image, deps.repositories, deps.runningVersion)) continue;
    if (inUse.has(image.id) || image.repoTags.some((reference) => inUse.has(reference))) continue;
    for (const reference of image.repoTags) {
      try {
        await deps.docker.removeImage(reference);
        removed.push(reference);
      } catch (err) {
        deps.logger.warn({ err, image: reference }, 'Could not remove a previous panel image');
        break;
      }
    }
  }
  if (removed.length > 0) {
    deps.logger.info({ removed }, 'Removed images left behind by earlier panel versions');
  }
  return removed;
}

export interface StaleImageCleanupHandle {
  stop(): void;
}

/** Arms the delayed first sweep and the periodic ones. Both timers are `.unref()`d, and a failed sweep is logged, never thrown. */
export function startStaleImageCleanup(
  deps: StaleImageCleanupDeps,
  timing: { readonly firstDelayMs: number; readonly intervalMs: number } = {
    firstDelayMs: FIRST_SWEEP_DELAY_MS,
    intervalMs: SWEEP_INTERVAL_MS,
  },
): StaleImageCleanupHandle {
  const sweep = (): void => {
    void removeStalePanelImages(deps).catch((err: unknown) => {
      deps.logger.warn({ err }, 'Previous panel image cleanup failed');
    });
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    sweep();
    interval = setInterval(sweep, timing.intervalMs);
    interval.unref();
  }, timing.firstDelayMs);
  first.unref();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval !== null) clearInterval(interval);
    },
  };
}
