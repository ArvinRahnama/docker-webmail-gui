/**
 * Resolves "the managed mail container" from configuration alone, never
 * from anything a request carried — the load-bearing part of the
 * ARCHITECTURE.md §6 promise that "the web tier never sends a container
 * ID." Docker itself has no per-container access control
 * (docs/research/02-docker-api-security.md §B.5); this module is the
 * entirety of that control for this project.
 *
 * Every lifecycle/inspect/stats/logs operation calls
 * {@link resolveManagedContainer} fresh, at request time, rather than
 * caching an id once — a rename or recreation of the target container
 * between requests must not silently keep operating on a stale id.
 */
import type { DockerApi, RawContainerListItem } from './docker-types.js';

export interface DmsIdentity {
  readonly containerName: string;
  /** Raw `key=value` selector, e.g. `"com.docker-webmail-gui.role=mail"`, or `null`. */
  readonly containerLabel: string | null;
}

export interface ManagedContainerRef {
  readonly id: string;
  readonly name: string;
}

export type ContainerResolutionReason = 'not-found' | 'ambiguous';

/** Thrown when configuration does not resolve to exactly one container. Fail closed — never guess which one is "the" mail container. */
export class ContainerResolutionError extends Error {
  readonly reason: ContainerResolutionReason;

  constructor(reason: ContainerResolutionReason, message: string) {
    super(message);
    this.name = 'ContainerResolutionError';
    this.reason = reason;
  }
}

function parseLabelSelector(selector: string): { readonly key: string; readonly value: string } {
  const eq = selector.indexOf('=');
  if (eq === -1) return { key: selector, value: '' };
  return { key: selector.slice(0, eq), value: selector.slice(eq + 1) };
}

/**
 * `DMS_CONTAINER_LABEL` is documented (`.env.example`) as an
 * *alternative* way to identify the container — for deployments where the
 * name is unpredictable (generated suffixes, orchestrator-assigned
 * names) but a stable label is applied. So: label wins when configured,
 * name is the fallback. Matching is always **exact**, never Docker's own
 * `filters={"name":[...]}, which does *substring* matching — `name:
 * "mailserver"` would also match a container literally named
 * `"mailserver-old"` or `"not-mailserver"` through that filter. This
 * function always lists broadly and matches client-side against the
 * full, exact value instead, so that substring-match pitfall cannot
 * reach this project's allowlist.
 */
function matchesIdentity(container: RawContainerListItem, dms: DmsIdentity): boolean {
  if (dms.containerLabel !== null) {
    const { key, value } = parseLabelSelector(dms.containerLabel);
    return container.labels[key] === value;
  }
  return container.names.includes(dms.containerName);
}

/**
 * Resolves the managed mail container. Lists **all** containers
 * (`all: true`, so a stopped target is still resolvable for `start`) and
 * matches exactly. Zero matches or more than one match both fail closed
 * via {@link ContainerResolutionError} — the caller (`operations.ts`)
 * maps either outcome to a `FORBIDDEN` response, never to "pick the first
 * one" or "pick the most recent one".
 */
export async function resolveManagedContainer(
  docker: DockerApi,
  dms: DmsIdentity,
): Promise<ManagedContainerRef> {
  const all = await docker.listContainers({ all: true });
  const matches = all.filter((candidate) => matchesIdentity(candidate, dms));

  if (matches.length === 0) {
    throw new ContainerResolutionError(
      'not-found',
      `No container matches the configured identity (${describeIdentity(dms)}).`,
    );
  }
  if (matches.length > 1) {
    throw new ContainerResolutionError(
      'ambiguous',
      `${matches.length} containers match the configured identity (${describeIdentity(dms)}); refusing to guess which one is "the" mail container.`,
    );
  }

  const match = matches[0];
  if (match === undefined) {
    // Unreachable given the length checks above; satisfies
    // noUncheckedIndexedAccess without a non-null assertion.
    throw new ContainerResolutionError(
      'not-found',
      'No container matches the configured identity.',
    );
  }
  return { id: match.id, name: match.names[0] ?? dms.containerName };
}

function describeIdentity(dms: DmsIdentity): string {
  return dms.containerLabel !== null
    ? `label="${dms.containerLabel}"`
    : `name="${dms.containerName}"`;
}
