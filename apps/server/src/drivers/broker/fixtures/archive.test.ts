import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import type { ReadEntry } from 'tar';
import { buildFixtureVolumeTar, buildUstarTar, fixtureVolumeTarChecksum } from './archive.js';

/**
 * Confirms the hand-rolled ustar writer (`buildUstarTar` — see that
 * file's header for why this project builds rather than captures these
 * bytes) produces archives the *real* `tar` package reads correctly —
 * the same parser `modules/backups/backup-archive.ts` runs against
 * whatever `archiveGet` returns, real broker or fake.
 */
describe('buildUstarTar', () => {
  it('round-trips through the real tar package: paths, sizes, uid/gid all survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwg-archive-test-'));
    const tarPath = join(dir, 'test.tar');
    try {
      const bytes = buildUstarTar([
        { path: 'a/one.txt', content: Buffer.from('hello'), uid: 5000, gid: 5000 },
        { path: 'a/two.txt', content: Buffer.from('a slightly longer piece of content') },
      ]);
      writeFileSync(tarPath, bytes);

      const seen: {
        path: string;
        size: number;
        uid?: number | undefined;
        gid?: number | undefined;
      }[] = [];
      await tar.list({
        file: tarPath,
        onentry: (entry: ReadEntry) => {
          seen.push({ path: entry.path, size: entry.size ?? 0, uid: entry.uid, gid: entry.gid });
        },
      });

      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ path: 'a/one.txt', size: 5, uid: 5000, gid: 5000 });
      expect(seen[1]).toMatchObject({ path: 'a/two.txt', size: 34 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers exact file content, byte for byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwg-archive-test-'));
    const tarPath = join(dir, 'test.tar');
    try {
      const content = Buffer.from('the quick brown fox jumps over the lazy dog');
      writeFileSync(tarPath, buildUstarTar([{ path: 'x/fox.txt', content }]));

      const chunks: Buffer[] = [];
      await tar.list({
        file: tarPath,
        onentry: (entry: ReadEntry) => {
          entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        },
      });

      expect(Buffer.concat(chunks).equals(content)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces a fixture per volume key that the real tar package accepts', async () => {
    for (const volumeKey of ['mail', 'mailState', 'mailLog', 'dmsConfig'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'dwg-archive-test-'));
      const tarPath = join(dir, 'volume.tar');
      try {
        writeFileSync(tarPath, buildFixtureVolumeTar(volumeKey));
        const entries: string[] = [];
        await tar.list({ file: tarPath, onentry: (entry: ReadEntry) => entries.push(entry.path) });
        expect(entries.length).toBeGreaterThan(0);
        for (const entryPath of entries) {
          expect(entryPath.startsWith(`${volumeKey}/`)).toBe(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('is deterministic: the same volume key always yields the same bytes and checksum', () => {
    const first = buildFixtureVolumeTar('mail');
    const second = buildFixtureVolumeTar('mail');
    expect(first.equals(second)).toBe(true);
    expect(fixtureVolumeTarChecksum('mail')).toBe(fixtureVolumeTarChecksum('mail'));
  });
});
