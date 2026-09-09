/**
 * Direct coverage of the real-daemon permissions bug this module fixes
 * (see its own header): `dwg-server` reads this file as a *different*
 * process than the one that wrote it, so the file's mode has to be
 * genuinely world-readable regardless of whatever umask happened to be
 * in effect when it was written — never something left to
 * `fs.writeFile`'s own umask-masked `mode` option. This is the one part
 * of the whole updater that is pure Node filesystem code with no Docker
 * dependency, which is exactly why it was split out of
 * `updater-entrypoint.ts` (never itself exercised by a test — it runs
 * its own `main()` as an import side effect) into its own module.
 */
import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RESULT_FILE_MODE, writeReadableFile } from './result-file-writer.js';

const originalUmask = process.umask();

afterEach(() => {
  // A test-wide mutation of process-global state — always restored, so a
  // restrictive umask set to exercise one test can never leak into
  // another test in this file or any other running in the same worker.
  process.umask(originalUmask);
});

function tmpFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwg-result-file-writer-test-'));
  return join(dir, 'self-update-result.json');
}

describe('writeReadableFile', () => {
  it('writes the exact contents given', async () => {
    const filePath = tmpFilePath();
    await writeReadableFile(filePath, '{"outcome":"success"}');
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"outcome":"success"}');
  });

  it('produces a world-readable file even under a restrictive umask — the real incident this fixes', async () => {
    // 0o077: strips every group/other bit a plain `writeFile({mode: ...})`
    // would otherwise have relied on staying set. If this test used a
    // `mode` option on `writeFile` instead of `writeReadableFile`'s own
    // explicit `chmod`, it would fail here exactly the way the real
    // updater container did — `docker exec dwg-server cat` returning
    // nothing under `set -eu`, a different user unable to read what the
    // updater wrote.
    process.umask(0o077);
    const filePath = tmpFilePath();

    await writeReadableFile(filePath, '{"outcome":"success"}');

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(RESULT_FILE_MODE);
    // Spelled out, not just the numeric comparison above: group and
    // other must both be able to read the file, which is the entire
    // point — a different container's user is exactly "other" here.
    expect(mode & 0o044).toBe(0o044);
  });

  it('re-applies the mode on a second write to the same path, matching how the updater writes the in-progress then done phases', async () => {
    process.umask(0o077);
    const filePath = tmpFilePath();

    await writeReadableFile(filePath, '{"phase":"in-progress"}');
    await writeReadableFile(filePath, '{"phase":"done"}');

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(RESULT_FILE_MODE);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"phase":"done"}');
  });
});
