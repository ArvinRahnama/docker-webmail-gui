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
