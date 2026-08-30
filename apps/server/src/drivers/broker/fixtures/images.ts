/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /images/json`
 * response fields in docs/research/02-docker-api-security.md §A.1 — not
 * captured from a real daemon (none available in this environment).
 *
 * The set matches the containers fixture (`containers.ts`): the mail
 * server, panel server/broker and roundcube images are visible by
 * pattern; `mariadb:11` is visible only because the visible `roundcube-db`
 * container runs it (the "image of a visible container" rule); the
 * nginx-proxy-manager image and the dangling image are unrelated host
 * cruft and hidden. `image.prune` still reclaims the dangling one
 * host-wide regardless of what the filtered list shows.
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
    repoTags: ['ghcr.io/arvinrahnama/docker-webmail-gui-server:0.2.0'],
    sizeBytes: 128_000_000,
    createdAt: 1_755_500_000,
    labels: {},
  },
  {
    id: 'sha256:2c8d7f6b3e4a',
    repoTags: ['ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.2.0'],
    sizeBytes: 96_000_000,
    createdAt: 1_755_500_000,
    labels: {},
  },
  {
    id: 'sha256:3d9e8a7c4f5b',
    repoTags: ['roundcube/roundcubemail:latest'],
    sizeBytes: 420_000_000,
    createdAt: 1_754_500_000,
    labels: {},
  },
  {
    // Visible only by reference — `roundcube-db` (a visible container)
    // runs it, though its repository name matches no pattern.
    id: 'sha256:4ea9b8d5c6f7',
    repoTags: ['mariadb:11'],
    sizeBytes: 380_000_000,
    createdAt: 1_754_500_000,
    labels: {},
  },
  {
    // Unrelated host image — hidden.
    id: 'sha256:5fb0c9e6d7a8',
    repoTags: ['jc21/nginx-proxy-manager:latest'],
    sizeBytes: 210_000_000,
    createdAt: 1_753_000_000,
    labels: {},
  },
  {
    // Dangling (untagged) — hidden from the list; still prunable host-wide.
    id: 'sha256:dangling000000',
    repoTags: [],
    sizeBytes: 84_000_000,
    createdAt: 1_753_000_000,
    labels: {},
  },
];

/**
 * What `image.prune` removes from the fixture world above: only
 * `sha256:dangling000000` (the unused dangling image) — `SpaceReclaimed`
 * matches that one image's own `sizeBytes`. Prune is host-wide and
 * independent of the visibility filter: it always means "remove every
 * dangling image", never "remove image X" (FEATURE_MATRIX.md §24).
 */
export const FIXTURE_IMAGE_PRUNE_RESULT: ImagePruneResponse = {
  imagesDeleted: ['sha256:dangling000000'],
  spaceReclaimedBytes: 84_000_000,
};
