import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readAndClearSelfUpdateResult,
  SELF_UPDATE_RESULT_FILE_NAME,
} from './panel-self-update-status.js';

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'dwg-self-update-status-test-'));
}

const DONE_SUCCESS = {
  phase: 'done',
  outcome: 'success',
  fromVersion: '0.2.0',
  toVersion: '0.3.0',
  failedAt: null,
  reason: null,
};

describe('readAndClearSelfUpdateResult', () => {
  it('returns null when no status file exists', async () => {
    const dataDir = tmpDataDir();
    await expect(readAndClearSelfUpdateResult(dataDir)).resolves.toBeNull();
  });

  it('reads a finished (phase: done) record and clears the file, so a second read returns null', async () => {
    const dataDir = tmpDataDir();
    const filePath = join(dataDir, SELF_UPDATE_RESULT_FILE_NAME);
    writeFileSync(filePath, JSON.stringify(DONE_SUCCESS));

    const first = await readAndClearSelfUpdateResult(dataDir);
    expect(first).toEqual({
      outcome: 'success',
      fromVersion: '0.2.0',
      toVersion: '0.3.0',
      failedAt: null,
      reason: null,
    });

    // Cleared — an admin who has already seen the verdict does not see it
    // again on the next poll.
    const second = await readAndClearSelfUpdateResult(dataDir);
    expect(second).toBeNull();
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('reports a failed/rolled-back verdict exactly as written, including a null fromVersion', async () => {
    const dataDir = tmpDataDir();
    writeFileSync(
      join(dataDir, SELF_UPDATE_RESULT_FILE_NAME),
      JSON.stringify({
        phase: 'done',
        outcome: 'failed',
        fromVersion: null,
        toVersion: '0.4.0',
        failedAt: 'pre-flight',
        reason: 'Could not pull one or both target images: network unreachable',
      }),
    );

    const result = await readAndClearSelfUpdateResult(dataDir);
    expect(result).toEqual({
      outcome: 'failed',
      fromVersion: null,
      toVersion: '0.4.0',
      failedAt: 'pre-flight',
      reason: 'Could not pull one or both target images: network unreachable',
    });
  });

  it('ignores (returns null for, and never clears) a phase: in-progress record — it is a rollback plan for a human, not a verdict', async () => {
    const dataDir = tmpDataDir();
    const filePath = join(dataDir, SELF_UPDATE_RESULT_FILE_NAME);
    // A real in-progress record also carries a `rollbackPlan` with each
    // container's full recreate spec (hostConfig, mounts, ...) — deliberately
    // NOT reproduced here, since this reader must never even attempt to
    // parse that shape into anything typed (see this module's own header).
    // The `phase` field alone is enough to prove it is left alone.
    writeFileSync(filePath, JSON.stringify({ phase: 'in-progress', toVersion: '0.4.0' }));

    const result = await readAndClearSelfUpdateResult(dataDir);
    expect(result).toBeNull();

    // Untouched — still on disk, unlike the 'done' case above.
    await expect(readFile(filePath, 'utf8')).resolves.toContain('in-progress');
  });

  it('returns null, never throws, for malformed JSON', async () => {
    const dataDir = tmpDataDir();
    writeFileSync(join(dataDir, SELF_UPDATE_RESULT_FILE_NAME), 'not valid json{{{');
    await expect(readAndClearSelfUpdateResult(dataDir)).resolves.toBeNull();
  });

  it('returns null, never throws, for a well-formed but schema-invalid done record', async () => {
    const dataDir = tmpDataDir();
    writeFileSync(
      join(dataDir, SELF_UPDATE_RESULT_FILE_NAME),
      JSON.stringify({ phase: 'done', outcome: 'not-a-real-outcome' }),
    );
    await expect(readAndClearSelfUpdateResult(dataDir)).resolves.toBeNull();
  });
});
