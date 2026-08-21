/**
 * The update comparison surface (M10 — IMPLEMENTATION_PLAN.md §2.2).
 * Implements steps 1-3 of that section's model in full: resolve the
 * running image digest via inspect, query the registry for the newest
 * matching tag's digest, and report current vs available plus the same
 * backup-gate facts restore's pre-flight reports (one recent-verified-
 * backup concept for the whole product — `@dwg/shared`'s
 * `UpdateStatusResponseSchema` doc comment).
 *
 * **Steps 4-6 (pull with progress, recreate, rollback) are deliberately
 * not implemented here.** Recreating the managed container needs
 * `container.create`, which the broker deliberately lacks
 * (AGENT_BRIEF.md: "Do not add it. Implement everything up to that point
 * and report the apply step as deferred") — and pulling an image the
 * panel could never actually deploy has no standalone value, so it is
 * bundled into that same, clearly-stated deferral rather than half-built
 * on its own. `applyRefused` is that deferral made observable: a real
 * route an admin can call, that always explains exactly why, audited
 * every time — never a silent 404.
 */
import type { UpdateStatusResponse } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';
import type { RegistryClientPort } from '../../drivers/registry/types.js';
import { AppError } from '../../platform/errors.js';
import type { BackupsRepository } from '../backups/backups.repository.js';

/** Linked, never scraped (IMPLEMENTATION_PLAN.md §2.2 step 3) — the real, upstream docker-mailserver project's GitHub Releases page. */
export const RELEASE_NOTES_URL = 'https://github.com/docker-mailserver/docker-mailserver/releases';

/**
 * Always present, unconditionally (`@dwg/shared`'s own doc comment on
 * this field: "the honesty requirement is unconditional") — reverting the
 * image digest is real; it cannot undo data or schema migrations DMS
 * performed while running the newer version, because DMS does not
 * version its on-disk state. Promising a clean rollback would be the
 * single most dangerous lie this product could tell (IMPLEMENTATION_PLAN.md
 * §2.2).
 */
export const ROLLBACK_CAVEAT =
  'Rolling back reverts the running image to its previous digest — that part is real. It cannot undo any data or configuration-file migration docker-mailserver performed while running the newer version, because docker-mailserver does not version its on-disk state. If the update you are rolling back from changed mail storage or config file formats, reverting the image alone will not undo that; restoring from a backup taken before the update is the only way to do that.';

export const APPLY_REFUSED_MESSAGE =
  'Applying an update requires recreating the managed container, which requires a Docker operation (container.create) the broker deliberately does not have — see ARCHITECTURE.md §2. This panel cannot perform that step yet. Update the container through your own deployment process (e.g. `docker compose pull && docker compose up -d`); this page will reflect the new digest on the next check.';

export class UpdatesService {
  constructor(
    private readonly broker: BrokerClient,
    private readonly registry: RegistryClientPort,
    private readonly backupsRepository: BackupsRepository,
  ) {}

  async getStatus(): Promise<UpdateStatusResponse> {
    const checkedAt = new Date().toISOString();

    const inspection = await this.broker.containerInspect();
    const currentDigest = inspection.image;

    const images = await this.broker.imageList();
    const matchingImage = images.find((image) => image.id === currentDigest);
    const repoTags = matchingImage ? [...matchingImage.repoTags] : [];

    // `available` stays `null` — Unknown, not "no update" — whenever
    // there is nothing to check against (no matching local image/tag) or
    // the registry could not be reached (`resolveTagDigest`'s own
    // "never throws" contract).
    let available: UpdateStatusResponse['available'] = null;
    const reference = repoTags[0];
    if (reference !== undefined) {
      const digest = await this.registry.resolveTagDigest(reference);
      if (digest !== null) {
        available = { digest, checkedAt };
      }
    }

    const updateAvailable =
      available !== null && currentDigest !== null && available.digest !== currentDigest;

    const mostRecentVerified = this.backupsRepository.mostRecentVerified();

    return {
      current: { digest: currentDigest, repoTags },
      available,
      updateAvailable,
      checkedAt,
      releaseNotesUrl: RELEASE_NOTES_URL,
      recentVerifiedBackupExists: mostRecentVerified !== null,
      mostRecentVerifiedBackupAt: mostRecentVerified?.verifiedAt ?? null,
      rollbackCaveat: ROLLBACK_CAVEAT,
    };
  }

  /** Always refuses — see this file's header. Never returns; the route calls this purely for the thrown `AppError`. */
  applyRefused(): never {
    throw new AppError('CAPABILITY_UNSUPPORTED', APPLY_REFUSED_MESSAGE);
  }
}
