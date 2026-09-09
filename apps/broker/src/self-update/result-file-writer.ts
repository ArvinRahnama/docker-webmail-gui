/**
 * The one piece of `updater-entrypoint.ts` that is pure Node filesystem
 * code with no Docker dependency at all — split into its own module
 * specifically so it is directly testable (`result-file-writer.test.ts`)
 * without importing `updater-entrypoint.ts` itself, which runs its own
 * `main()` as a side effect of being imported (by design — it is the
 * real process entrypoint, not exercised by any test, `docker-client.ts`'s
 * own "not exercised, but type-checks" boundary).
 *
 * **Real-daemon bug fixed here, found by SU-F's real-daemon CI job once
 * the container swap itself started working:** the updater and
 * `dwg-server` both run as the identical `dwg` user (uid/gid 10001 in
 * both `docker/server/Dockerfile` and `docker/broker/Dockerfile` —
 * confirmed, not the mismatch), so uid parity was never the problem. The
 * actual cause is `fs.writeFile`'s own mode handling: `writeFile` only
 * applies a `mode` at *creation* (this call is always the first write to
 * a fresh volume), and whatever `mode` is requested is still masked by
 * the writing process's own umask before it becomes the file's real
 * permissions — the same as the POSIX `open()` syscall underneath it. A
 * restrictive umask in the updater's container (unverified directly —
 * no real daemon to inspect it against here — but the observed symptom
 * is exactly consistent with one: `docker exec dwg-server cat` on the
 * file failed outright, while a root reader mounting the same volume
 * directly succeeded) would silently produce an owner-only file no
 * umask assumption should have been relied on to avoid. Fixed by an
 * explicit `chmod` after the write: unlike a `mode` option, `chmod` is
 * never subject to umask — it sets exactly the permissions requested,
 * unconditionally, which is what "any panel process needs to read this,
 * regardless of which container or user wrote it" actually requires.
 */
import { chmod, writeFile } from 'node:fs/promises';

/**
 * `rw-r--r--` — readable by any user, not just whichever container
 * happened to write it. This file's whole purpose is being read by a
 * *different* process (the new `dwg-server`, `GET .../panel/last-result`,
 * SU-C) than the one writing it (the updater), so "owner-only" was never
 * the right default to leave to `fs.writeFile`'s own umask-masked
 * behaviour in the first place — see this module's own header for the
 * real incident this fixes. Not a new *write* capability for anyone:
 * nothing about this makes the file writable by a different user, and
 * its contents are never secret (a version string, an outcome, a
 * reason).
 */
export const RESULT_FILE_MODE = 0o644;

/**
 * Writes `content` (already-serialized JSON, or any string) to `filePath`
 * and unconditionally `chmod`s it to {@link RESULT_FILE_MODE} — see this
 * module's own header for why the `chmod` step, not a `writeFile` `mode`
 * option, is the part that actually matters.
 */
export async function writeReadableFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, 'utf8');
  await chmod(filePath, RESULT_FILE_MODE);
}
