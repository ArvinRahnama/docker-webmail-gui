/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /networks`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 * Names mirror this project's own deployment topology
 * (ARCHITECTURE.md §10: a `frontend` network and an `internal: true`
 * `broker` network).
 */
import type { NetworkSummary } from '@dwg/shared';

export const FIXTURE_NETWORKS: readonly NetworkSummary[] = [
  { id: 'net_frontend000001', name: 'dwg_frontend', driver: 'bridge', scope: 'local' },
  { id: 'net_broker00000001', name: 'dwg_broker', driver: 'bridge', scope: 'local' },
];
