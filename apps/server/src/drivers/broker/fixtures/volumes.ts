/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /volumes`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 * Names mirror the four DMS volumes documented in
 * IMPLEMENTATION_PLAN.md §2.1 (mail data, state, logs, config), purely
 * for developer-facing plausibility — this fixture carries no real mail
 * data.
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
    name: 'dms-config',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/dms-config/_data',
    labels: {},
  },
];
