/**
 * Fixture provenance: CONSTRUCTED from the documented `GET
 * /containers/{id}/stats` response shape and the CPU/memory formulas in
 * docs/research/02-docker-api-security.md §A.3 — not captured from a
 * real daemon (none available in this environment). Represents an
 * already-*computed* snapshot: the broker performs the CPU%/memory%
 * maths server-side (`apps/broker/src/stats.ts`), so the raw
 * multi-field Docker stats payload never reaches the web tier or its
 * fixtures — only `ContainerStatsResponseSchema`'s shape does.
 */
import type { ContainerStatsResponse } from '@dwg/shared';

export const FIXTURE_CONTAINER_STATS: ContainerStatsResponse = {
  cpuPercent: 4.37,
  memory: { usageBytes: 314_572_800, limitBytes: 2_147_483_648, percent: 14.65 },
  pids: 12,
  network: { rxBytes: 1_048_576, txBytes: 524_288 },
  sampledAt: '2026-08-16T12:00:00.000Z',
};
