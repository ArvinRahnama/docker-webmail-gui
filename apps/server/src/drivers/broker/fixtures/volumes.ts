/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /volumes`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 * Names mirror the four DMS volumes documented in
 * `docs/research/01-docker-mailserver.md` §6 (mail data, state, logs,
 * config) and match `FIXTURE_CONTAINER_MOUNTS` (`containers.ts`)
 * name-for-name, so a test that cross-references `volume.list` against
 * `container.inspect`'s mounts (exactly what `VolumesService` does) sees
 * a consistent fixture world. `dms-scratch` is a fifth, ordinary volume
 * with no protected mount — the one this fixture set expects removal
 * tests to succeed against.
 */
import type { VolumeSummary } from '@dwg/shared';

export const FIXTURE_VOLUMES: readonly VolumeSummary[] = [
  {
    name: 'dms-mail-data',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-mail-data/_data',
    labels: {},
  },
  {
    name: 'dms-mail-state',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-mail-state/_data',
    labels: {},
  },
  {
    name: 'dms-mail-logs',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-mail-logs/_data',
    labels: {},
  },
  {
    name: 'dms-config',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-config/_data',
    labels: {},
  },
  {
    name: 'dms-scratch',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-scratch/_data',
    labels: {},
  },
];
