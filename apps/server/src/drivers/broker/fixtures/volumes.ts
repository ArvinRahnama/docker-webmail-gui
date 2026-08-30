/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /volumes`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 *
 * Names match `FIXTURE_CONTAINER_ATTACHMENTS` (`containers.ts`): the five
 * DMS volumes and the two panel volumes belong to visible containers and
 * so are visible; `roundcube-db-data` belongs to the visible roundcube
 * database; `npm-data` and `site-data` belong to unrelated host
 * containers and are hidden. `dms-scratch` is the one ordinary
 * (non-protected) DMS volume removal tests expect to succeed against.
 */
import type { VolumeSummary } from '@dwg/shared';

function volume(name: string): VolumeSummary {
  return { name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${name}/_data`, labels: {} };
}

export const FIXTURE_VOLUMES: readonly VolumeSummary[] = [
  volume('dms-mail-data'),
  volume('dms-mail-state'),
  volume('dms-mail-logs'),
  volume('dms-config'),
  volume('dms-scratch'),
  volume('dwg-server-data'),
  volume('dwg-server-backups'),
  volume('roundcube-db-data'),
  // Unrelated host volumes — hidden.
  volume('npm-data'),
  volume('site-data'),
];
