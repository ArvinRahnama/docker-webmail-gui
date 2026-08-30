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
 *
 * The set models the shared-host reality the visibility filter exists for
 * (FEATURE_MATRIX.md §22-26): the managed mail server and the panel's own
 * two containers, a roundcube webmail stack (webmail GUI + its database),
 * and two entirely unrelated host containers that must never be visible
 * through the panel. `FakeBrokerClient` applies the same
 * `isContainerVisible` the real broker does, so development and tests see
 * exactly the narrowed view production does.
 */
import type { ContainerInspectResponse, ContainerSummary } from '@dwg/shared';

/** The managed mail container — the one every lifecycle/inspect/stats/logs op resolves to, and the only container whose state `FakeBrokerClient` toggles on start/stop. */
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
  {
    id: 'a1b2c3d4e5f6',
    names: ['dwg-server'],
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-server:0.2.0',
    state: 'running',
    status: 'Up 3 hours (healthy)',
    labels: {},
    createdAt: 1_755_100_000,
  },
  {
    id: 'b2c3d4e5f6a1',
    names: ['dwg-broker'],
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.2.0',
    state: 'running',
    status: 'Up 3 hours (healthy)',
    labels: {},
    createdAt: 1_755_100_000,
  },
  {
    id: 'c3d4e5f6a1b2',
    names: ['roundcube'],
    image: 'roundcube/roundcubemail:latest',
    state: 'running',
    status: 'Up 2 hours',
    labels: {},
    createdAt: 1_755_200_000,
  },
  {
    id: 'd4e5f6a1b2c3',
    names: ['roundcube-db'],
    image: 'mariadb:11',
    state: 'running',
    status: 'Up 2 hours',
    labels: {},
    createdAt: 1_755_200_000,
  },
  // Unrelated host containers — running, but neither a config-known
  // identity nor a pattern match, so the panel never surfaces them.
  {
    id: 'e5f6a1b2c3d4',
    names: ['nginx-proxy-manager'],
    image: 'jc21/nginx-proxy-manager:latest',
    state: 'running',
    status: 'Up 5 days',
    labels: {},
    createdAt: 1_753_000_000,
  },
  {
    id: 'f6a1b2c3d4e5',
    names: ['owner-website'],
    image: 'owner/website:latest',
    state: 'running',
    status: 'Up 5 days',
    labels: {},
    createdAt: 1_753_000_000,
  },
];

/**
 * Which named volumes and networks each fixture container is attached to —
 * the fake's stand-in for the `Mounts`/`NetworkSettings.Networks` the real
 * broker reads from `GET /containers/json` (`RawContainerListItem`). The
 * fake derives its *visible* volume/network sets from these exactly as the
 * broker does (`operations.ts`): a volume/network is visible iff a visible
 * container is attached to it. Keyed by container name.
 */
export interface FixtureContainerAttachments {
  readonly volumes: readonly string[];
  readonly networks: readonly string[];
}

export const FIXTURE_CONTAINER_ATTACHMENTS: Readonly<Record<string, FixtureContainerAttachments>> =
  {
    mailserver: {
      volumes: ['dms-mail-data', 'dms-mail-state', 'dms-mail-logs', 'dms-config', 'dms-scratch'],
      networks: ['mailserver_net'],
    },
    'dwg-server': {
      volumes: ['dwg-server-data', 'dwg-server-backups'],
      networks: ['dwg-frontend', 'dwg-broker', 'mailserver_net'],
    },
    'dwg-broker': { volumes: [], networks: ['dwg-broker'] },
    roundcube: { volumes: [], networks: ['mailserver_net'] },
    'roundcube-db': { volumes: ['roundcube-db-data'], networks: ['mailserver_net'] },
    'nginx-proxy-manager': { volumes: ['npm-data'], networks: ['npm_default'] },
    'owner-website': { volumes: ['site-data'], networks: ['npm_default'] },
  };

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
