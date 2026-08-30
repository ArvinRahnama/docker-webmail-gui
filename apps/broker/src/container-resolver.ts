/**
 * Resolves a container from configuration alone, never from anything a
 * request carried — the load-bearing part of the ARCHITECTURE.md §6
 * promise that "the web tier never sends a container ID." Docker itself
 * has no per-container access control
 * (docs/research/02-docker-api-security.md §B.5); this module is the
 * entirety of that control for this project.
 *
 * Two config-known identities flow through here: the managed mail
 * container (`DMS_CONTAINER_NAME`/`_LABEL`), resolved for every
 * lifecycle/inspect/stats/logs operation, and the panel's own server
 * container (`PANEL_SERVER_CONTAINER_NAME`/`_LABEL`), resolved for
 * `panel.restart`. Both go through {@link resolveContainerByIdentity} so
 * "resolve exactly one container, from config, or fail closed" is written
 * once. Every call resolves fresh, at request time, rather than caching an
 * id — a rename or recreation of the target between requests must not
 * silently keep operating on a stale id.
 */
import { matchesServiceIdentity, type ServiceIdentity } from '@dwg/shared';
import type { DockerApi, RawContainerListItem } from './docker-types.js';

/** A container's config-known identity — name, or a `key=value` label that wins when set. Re-exported alias of `@dwg/shared`'s `ServiceIdentity`, so the broker's own modules keep the name they have always used. */
export type DmsIdentity = ServiceIdentity;

export interface ManagedContainerRef {
  readonly id: string;
  readonly name: string;
}

export type ContainerResolutionReason = 'not-found' | 'ambiguous';

/** Thrown when configuration does not resolve to exactly one container. Fail closed — never guess which one is "the" target. */
export class ContainerResolutionError extends Error {
  readonly reason: ContainerResolutionReason;

  constructor(reason: ContainerResolutionReason, message: string) {
    super(message);
    this.name = 'ContainerResolutionError';
    this.reason = reason;
  }
}

function describeIdentity(identity: ServiceIdentity): string {
  return identity.containerLabel !== null
    ? `label="${identity.containerLabel}"`
    : `name="${identity.containerName}"`;
}

/**
 * Picks the single container in `candidates` matching `identity`, or
 * throws {@link ContainerResolutionError}. Pure over an already-fetched
 * list, so a caller that needs the full list for something else (e.g.
 * `panel.restart`'s broker-self guard) can resolve without a second Docker
 * call. Zero matches or more than one both fail closed — never "pick the
 * first" or "pick the most recent".
 */
export function selectSingleMatch(
  candidates: readonly RawContainerListItem[],
  identity: ServiceIdentity,
  describe: string,
): ManagedContainerRef {
  const matches = candidates.filter((candidate) => matchesServiceIdentity(candidate, identity));

  if (matches.length === 0) {
    throw new ContainerResolutionError(
      'not-found',
      `No container matches the configured ${describe} identity (${describeIdentity(identity)}).`,
    );
  }
  if (matches.length > 1) {
    throw new ContainerResolutionError(
      'ambiguous',
      `${matches.length} containers match the configured ${describe} identity (${describeIdentity(identity)}); refusing to guess which one is "the" ${describe}.`,
    );
  }

  const match = matches[0];
  if (match === undefined) {
    // Unreachable given the length checks above; satisfies
    // noUncheckedIndexedAccess without a non-null assertion.
    throw new ContainerResolutionError(
      'not-found',
      `No container matches the configured identity.`,
    );
  }
  return { id: match.id, name: match.names[0] ?? identity.containerName };
}

/**
 * Resolves one container by its config-known identity. Lists **all**
 * containers (`all: true`, so a stopped target is still resolvable for
 * `start`) and matches exactly via {@link selectSingleMatch}. `describe`
 * is the human noun used in a resolution error ("mail container", "panel
 * server").
 */
export async function resolveContainerByIdentity(
  docker: DockerApi,
  identity: ServiceIdentity,
  describe: string,
): Promise<ManagedContainerRef> {
  const all = await docker.listContainers({ all: true });
  return selectSingleMatch(all, identity, describe);
}

/** Resolves the managed mail container (`operations.ts`'s lifecycle/inspect/stats/logs handlers). Thin wrapper over {@link resolveContainerByIdentity}. */
export async function resolveManagedContainer(
  docker: DockerApi,
  dms: DmsIdentity,
): Promise<ManagedContainerRef> {
  return resolveContainerByIdentity(docker, dms, 'mail container');
}
