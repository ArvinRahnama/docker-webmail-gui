/**
 * Fixture provenance: CONSTRUCTED, not captured. There is no Docker
 * daemon available in this development environment (ARCHITECTURE.md §9),
 * so this is not real `docker inspect` / `GET /containers/json` output.
 * It is a plausible shape built directly from the documented Engine API
 * fields in docs/research/02-docker-api-security.md §A.1 (`GET
 * /containers/json`, `GET /containers/{id}/json`) and this project's own
 * `ContainerSummarySchema`/`ContainerInspectResponseSchema`
 * (`@dwg/shared`). Replace with a real captured fixture once a daemon is
 * available (IMPLEMENTATION_PLAN.md §2.4 / M12).
 */
import type { ContainerInspectResponse, ContainerSummary } from '@dwg/shared';

export const FIXTURE_CONTAINER_ID = '3f2c1a9b8e7d';

/** A second, non-allowlisted, stopped container — exercises "not managed by this panel, read-only" rendering and, via its image reference, the "dangling but still in use" image-cleanup edge case (`images.ts`). Never matches the configured DMS identity (name or label), so it never affects `resolveManagedContainer`. */
export const FIXTURE_OTHER_CONTAINER_ID = '9c8b7a6f5e4d';

export const FIXTURE_CONTAINERS: readonly ContainerSummary[] = [
  {
    id: FIXTURE_CONTAINER_ID,
    names: ['mailserver'],
    image: 'ghcr.io/docker-mailserver/docker-mailserver:latest',
    state: 'running',
    status: 'Up 3 hours (healthy)',
    labels: { 'com.docker-webmail-gui.role': 'mail' },
    createdAt: 1_755_000_000,
  },
  {
    id: FIXTURE_OTHER_CONTAINER_ID,
    names: ['old-webapp'],
    image: 'sha256:dangling00in0use',
    state: 'exited',
    status: 'Exited (0) 3 weeks ago',
    labels: {},
    createdAt: 1_750_000_000,
  },
];

/**
 * Mirrors the four DMS data mounts documented in
 * `docs/research/01-docker-mailserver.md` §6 — one named volume per
 * protected destination, plus a fifth ordinary (non-protected) volume so
 * fixture-driven tests can assert that protection is per-mount, not
 * "every volume this container happens to use".
 */
export const FIXTURE_CONTAINER_MOUNTS: ContainerInspectResponse['mounts'] = [
  { type: 'volume', name: 'dms-mail-data', destination: '/var/mail' },
  { type: 'volume', name: 'dms-mail-state', destination: '/var/mail-state' },
  { type: 'volume', name: 'dms-mail-logs', destination: '/var/log/mail' },
  { type: 'volume', name: 'dms-config', destination: '/tmp/docker-mailserver' },
  { type: 'volume', name: 'dms-scratch', destination: '/scratch' },
];

export const FIXTURE_CONTAINER_INSPECT_RUNNING: ContainerInspectResponse = {
  id: FIXTURE_CONTAINER_ID,
  name: 'mailserver',
  image: 'ghcr.io/docker-mailserver/docker-mailserver:latest',
  createdAt: '2026-08-12T09:00:00.000Z',
  state: {
    status: 'running',
    running: true,
    paused: false,
    restarting: false,
    startedAt: '2026-08-15T06:00:00.000Z',
    finishedAt: '0001-01-01T00:00:00Z',
    exitCode: 0,
    health: 'healthy',
  },
  restartCount: 0,
  labels: { 'com.docker-webmail-gui.role': 'mail' },
  mounts: FIXTURE_CONTAINER_MOUNTS,
};

export const FIXTURE_CONTAINER_INSPECT_STOPPED: ContainerInspectResponse = {
  ...FIXTURE_CONTAINER_INSPECT_RUNNING,
  state: {
    ...FIXTURE_CONTAINER_INSPECT_RUNNING.state,
    status: 'exited',
    running: false,
    health: null,
    finishedAt: '2026-08-16T10:00:00.000Z',
    exitCode: 0,
  },
};
