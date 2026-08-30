/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /networks`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 *
 * Names match `FIXTURE_CONTAINER_ATTACHMENTS` (`containers.ts`): the mail
 * server's network and the panel's own frontend/broker networks are
 * attached to visible containers and so are visible; `npm_default` and the
 * default `bridge` are attached to no visible container and are hidden —
 * exactly what deriving the visible network set from the visible
 * containers gives (`operations.ts`).
 */
import type { NetworkSummary } from '@dwg/shared';

export const FIXTURE_NETWORKS: readonly NetworkSummary[] = [
  { id: 'net_mailserver0001', name: 'mailserver_net', driver: 'bridge', scope: 'local' },
  { id: 'net_frontend000001', name: 'dwg-frontend', driver: 'bridge', scope: 'local' },
  { id: 'net_broker00000001', name: 'dwg-broker', driver: 'bridge', scope: 'local' },
  // Unrelated / default host networks — hidden.
  { id: 'net_npmdefault0001', name: 'npm_default', driver: 'bridge', scope: 'local' },
  { id: 'net_bridge00000001', name: 'bridge', driver: 'bridge', scope: 'local' },
];
