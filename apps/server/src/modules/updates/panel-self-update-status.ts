/**
 * Reads and clears `/app/data/self-update-result.json` — the one channel
 * a self-update's outcome ever reaches this process through
 * (docs/design/self-update.md §4, §6: the process that would report it
 * synchronously is deliberately about to be replaced, so it writes the
 * verdict to the `server-data` volume instead —
 * `apps/broker/src/self-update/updater.ts`, `updater-entrypoint.ts`).
 *
 * Deliberately plain local filesystem I/O, with no real-vs-fake driver
 * split unlike every other `drivers/*` port in this codebase: a file
 * under this project's own `DATA_DIR` is available in every environment
 * this process runs in, including tests (which point `dataDir` at a
 * throwaway tmp directory) — the same reasoning `BackupsRepository`/
 * `ConfigRepository` use real SQLite unconditionally rather than a faked
 * one, applied here to a file instead of a database.
 *
 * Deliberately never parses a record whose top-level `phase` is not
 * `'done'` into anything typed. An `'in-progress'` record additionally
 * carries each container's full recreate spec (`hostConfig`, mounts, the
 * rest — `RawContainerRecreateSpec`, broker-internal) for a human
 * operator's own manual recovery only (§9.7); that shape must never
 * reach this tier (ARCHITECTURE.md §2's invariant, applied here even
 * though this is a read of a local file, not a broker request — the
 * *data* is exactly the kind this project never lets past the broker
 * boundary), which is also why `@dwg/shared`'s `SelfUpdateResultSchema`
 * does not model that shape at all. Such a record is left on disk
 * untouched (never cleared) — it may still be updated by a running
 * updater, and its rollback-plan half is not this reader's to touch.
 */
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SelfUpdateResultSchema, type SelfUpdateResult } from '@dwg/shared';

export const SELF_UPDATE_RESULT_FILE_NAME = 'self-update-result.json';

/**
 * `null` when there is no verdict to report yet — no file on disk, a
 * `phase: 'in-progress'` record (still running, or the updater crashed
 * before writing a final verdict), or a file that fails to parse or
 * validate. Never throws for any of those cases: a self-update's outcome
 * is inherently best-effort to discover, the same "Unknown, not Invalid"
 * discipline this codebase applies to every other driver read
 * (AGENT_BRIEF.md §4).
 *
 * Clears (deletes) the file only when a `'done'` verdict was actually
 * read back successfully — an admin who has not yet seen it must still
 * see it on the next call; a second call after that returns `null` again
 * until the next self-update writes a new one.
 */
export async function readAndClearSelfUpdateResult(
  dataDir: string,
): Promise<SelfUpdateResult | null> {
  const filePath = join(dataDir, SELF_UPDATE_RESULT_FILE_NAME);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { readonly phase?: unknown }).phase !== 'done'
  ) {
    return null;
  }

  const result = SelfUpdateResultSchema.safeParse(parsed);
  if (!result.success) return null;

  await unlink(filePath).catch(() => {
    // Already gone (e.g. a concurrent read cleared it first) is fine —
    // the verdict was still successfully read and is still returned to
    // this caller below.
  });

  return result.data;
}
