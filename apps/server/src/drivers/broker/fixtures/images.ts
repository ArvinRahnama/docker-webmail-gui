/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /images/json`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 * `sha256:8a2f1e3c9d4b` deliberately matches `FIXTURE_CONTAINERS[0].image`
 * (`containers.ts`) — the fixture world's one "in use" image, so a test
 * that cross-references images against running containers
 * (`ImagesService`) has something real to find. The two `<none>:<none>`
 * entries are dangling: one unused (the cleanup path should remove it),
 * one still referenced by a stopped container's image id (the rare case
 * where a dangling image is nonetheless in use, and cleanup must still
 * leave it alone) — see `FIXTURE_CONTAINERS` for the stopped container
 * that references `sha256:dangling00in0use`.
 */
import type { ImagePruneResponse, ImageSummary } from '@dwg/shared';

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
  {
    id: 'sha256:dangling000000',
    repoTags: [],
    sizeBytes: 84_000_000,
    createdAt: 1_753_000_000,
    labels: {},
  },
  {
    id: 'sha256:dangling00in0use',
    repoTags: [],
    sizeBytes: 96_000_000,
    createdAt: 1_752_000_000,
    labels: {},
  },
];

/**
 * What `image.prune` removes from the fixture world above: only
 * `sha256:dangling000000` (the unused dangling image) — `SpaceReclaimed`
 * matches that one image's own `sizeBytes`. `sha256:dangling00in0use` is
 * deliberately left alone, mirroring real Docker behaviour (a dangling
 * image still referenced by a stopped container's `Image` id is never
 * removed by a prune, per this file's own header) and matching this
 * project's own guarantee that a prune can never remove an image still in
 * use by any container (FEATURE_MATRIX.md §24).
 */
export const FIXTURE_IMAGE_PRUNE_RESULT: ImagePruneResponse = {
  imagesDeleted: ['sha256:dangling000000'],
  spaceReclaimedBytes: 84_000_000,
};
