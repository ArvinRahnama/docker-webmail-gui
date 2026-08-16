/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /images/json`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 */
import type { ImageSummary } from '@dwg/shared';

export const FIXTURE_IMAGES: readonly ImageSummary[] = [
  {
    id: 'sha256:8a2f1e3c9d4b',
    repoTags: ['ghcr.io/docker-mailserver/docker-mailserver:latest'],
    sizeBytes: 512_000_000,
    createdAt: 1_754_000_000,
    labels: {},
  },
  {
    id: 'sha256:1b7c6e5a2f3d',
    repoTags: ['docker-webmail-gui/server:0.1.0'],
    sizeBytes: 128_000_000,
    createdAt: 1_755_500_000,
    labels: {},
  },
];
