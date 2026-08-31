/**
 * Pure retention selection — given a set of backups and a policy, which ids
 * should be deleted. No I/O: the caller (local staging cleanup, or remote
 * pruning after a verified upload) decides *where* to delete; this only
 * decides *what*, so it is trivially unit-testable and identical for local
 * and remote.
 *
 * Two invariants the policy can never override, because losing them would
 * mean losing the only copy of the newest data:
 *   1. The single most recent backup is never selected, whatever `keep` or
 *      `maxAgeDays` say.
 *   2. A caller-named `protectedId` (typically the backup just created, or the
 *      one just verified on the remote) is never selected.
 *
 * Beyond those, a backup is selected if it falls outside the newest `keep`
 * *or* is strictly older than `maxAgeDays` days — the two caps combine, so a
 * generous `keep` still can't keep something past a tight age cap, and a
 * generous age cap still can't keep more than `keep`.
 */

export interface RetentionCandidate {
  readonly id: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

export interface RetentionPolicy {
  /** Newest N to keep. */
  readonly keep: number;
  /** Age cap in days; `null` disables age pruning (count-only). */
  readonly maxAgeDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function selectBackupsForDeletion(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date,
  protectedId?: string,
): string[] {
  if (candidates.length === 0) return [];

  // Newest first, so index 0 is the most recent and "beyond keep" is a simple
  // index comparison.
  const sorted = [...candidates].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const newestId = sorted[0]!.id;
  const ageThresholdMs =
    policy.maxAgeDays !== null ? now.getTime() - policy.maxAgeDays * DAY_MS : null;

  const toDelete: string[] = [];
  sorted.forEach((candidate, index) => {
    if (candidate.id === newestId) return; // invariant 1
    if (protectedId !== undefined && candidate.id === protectedId) return; // invariant 2

    const beyondKeep = index >= policy.keep;
    const tooOld =
      ageThresholdMs !== null && new Date(candidate.createdAt).getTime() < ageThresholdMs;
    if (beyondKeep || tooOld) toDelete.push(candidate.id);
  });
  return toDelete;
}
