/**
 * Volumes service (M9 — FEATURE_MATRIX.md §25). `isProtected` is a
 * **display hint only** — computed the same way the broker itself computes
 * it (`computeProtectedVolumeNames`, `@dwg/shared`), from the managed
 * container's own live mounts, so the UI can label a volume protected
 * *before* an admin ever attempts to remove it. It is never the safety
 * boundary: `remove()` below still just forwards to the broker's
 * `volume.remove`, which independently re-derives the same protected set
 * and refuses server-side regardless of what this method displayed
 * (`apps/broker/src/operations.ts`'s `handleVolumeRemove`). If the managed
 * container cannot currently be inspected, every volume is shown as
 * unprotected rather than the list failing outright — a display
 * degradation, never a false claim of safety, since the broker's own
 * refusal is unaffected either way.
 */
import { computeProtectedVolumeNames, type DockerVolume } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class VolumesService {
  constructor(private readonly broker: BrokerClient) {}

  async list(): Promise<readonly DockerVolume[]> {
    const [volumes, managed] = await Promise.all([
      this.broker.volumeList(),
      this.broker.containerInspect().catch(() => null),
    ]);
    const protectedNames = managed
      ? computeProtectedVolumeNames(managed.mounts)
      : new Set<string>();
    return volumes.map((volume) => ({ ...volume, isProtected: protectedNames.has(volume.name) }));
  }

  /** Refuses (via the broker's own `403`) when `name` backs a protected DMS data mount — see the class doc comment. */
  async remove(name: string): Promise<void> {
    await this.broker.volumeRemove(name);
  }
}
