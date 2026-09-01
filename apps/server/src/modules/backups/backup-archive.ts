/**
 * The tar assembly, verification and restore-extraction logic behind M10
 * backups (IMPLEMENTATION_PLAN.md §2.1). This file has no HTTP/route/job
 * awareness of its own — `backups.service.ts` calls these functions from
 * inside a `JobContext`-driven closure, mirroring how `drivers/dms/*`
 * stays ignorant of Fastify. Three operations:
 *
 *  - {@link createBackupArchive}: pulls a raw `tar` per volume from the
 *    broker (`BrokerClient.archiveGet`, untouched — see that method's own
 *    doc comment for why "untouched" is what makes vmail uid/gid
 *    preservation automatic), computes per-entry and per-volume SHA-256
 *    checksums by *reading* each inner tar with the real `tar` package,
 *    and assembles one outer archive: `manifest.json` + one `<key>.tar`
 *    per volume, exactly the on-disk layout `@dwg/shared`'s `backups.ts`
 *    documents as the restorable-by-hand contract.
 *  - {@link verifyBackupArchive}: recomputes checksums against the
 *    archive's *own* `manifest.json` (read via `tar.list`, which never
 *    writes to disk — "verify... without extracting" is this function's
 *    entire design, not an incidental property) and reports every
 *    mismatch/missing/unexpected member, never throwing for an ordinarily
 *    corrupted file — that is the successful, intended outcome of a
 *    verify call, not a bug in it.
 *  - {@link extractBackupArchiveForRestore} /
 *    {@link restoreVolumesFromExtractedArchive}: the inverse of
 *    `createBackupArchive` — extraction is expected here (unlike verify),
 *    since restore must materialise the volume tars somewhere before
 *    `BrokerClient.archivePut` can stream them back into the container.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { ReadEntry } from 'tar';
import {
  APP_VERSION,
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_VOLUME_CONTAINER_PATHS,
  BACKUP_VOLUME_KEYS,
  BACKUP_VOLUME_LABELS,
  BackupManifestSchema,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupManifestVolume,
  type BackupMode,
  type BackupVolumeKey,
} from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';
import type { JobContext } from '../../platform/jobs/job-runner.js';

const MANIFEST_FILENAME = 'manifest.json';
const EXPECTED_OUTER_ENTRY_NAMES: readonly string[] = [
  MANIFEST_FILENAME,
  ...BACKUP_VOLUME_KEYS.map((key) => `${key}.tar`),
];

function volumeTarFilename(volumeKey: BackupVolumeKey): string {
  return `${volumeKey}.tar`;
}

function buildRestoreNotes(): string {
  return [
    'Restorable by hand with plain tar if this panel is unavailable — no other tool needed:',
    '  tar -xf <this-file> manifest.json',
    ...BACKUP_VOLUME_KEYS.map(
      (key) =>
        `  tar -xf <this-file> ${volumeTarFilename(key)} && tar -xf ${volumeTarFilename(key)} -C <restored ${BACKUP_VOLUME_CONTAINER_PATHS[key]}>`,
    ),
    'Every extracted entry keeps its original owner, group and mode — do not chown afterwards. The vmail account (uid/gid 5000 by default) depends on this exact preservation to keep mail delivery working.',
  ].join('\n');
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Public SHA-256 of a whole archive file — used by remote import to record a foreign backup's checksum. */
export async function hashBackupArchiveSha256(filePath: string): Promise<string> {
  return computeSha256(filePath);
}

/** Consumes one tar entry's full content, resolving with its SHA-256 and byte length. Attaches listeners synchronously so `tar.list`'s default "resume immediately after `onentry` returns" behaviour still delivers every byte to this consumer. */
function collectEntryDigest(entry: ReadEntry): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    entry.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    entry.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
    entry.on('error', reject);
  });
}

function collectEntryText(entry: ReadEntry): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    entry.on('data', (chunk: Buffer) => chunks.push(chunk));
    entry.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    entry.on('error', reject);
  });
}

/** Walks one already-downloaded volume tar, producing its manifest entry rows plus the volume-level aggregate — the per-entry checksums IMPLEMENTATION_PLAN.md §2.1 requires by name. */
async function analyzeVolumeTar(
  filePath: string,
  volumeKey: BackupVolumeKey,
): Promise<{ volume: BackupManifestVolume; entries: BackupManifestEntry[] }> {
  const entries: BackupManifestEntry[] = [];
  const pending: Promise<void>[] = [];

  await tar.list({
    file: filePath,
    onentry: (entry: ReadEntry) => {
      if (entry.type !== 'File') return; // Directories/symlinks carry no content to checksum.
      pending.push(
        collectEntryDigest(entry).then(({ sha256, size }) => {
          entries.push({ volumeKey, path: entry.path, sizeBytes: size, checksumSha256: sha256 });
        }),
      );
    },
  });
  await Promise.all(pending);

  const checksumSha256 = await computeSha256(filePath);
  const sizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  return {
    volume: {
      key: volumeKey,
      containerPath: BACKUP_VOLUME_CONTAINER_PATHS[volumeKey],
      entryCount: entries.length,
      sizeBytes,
      checksumSha256,
    },
    entries,
  };
}

export interface CreateBackupArchiveParams {
  readonly broker: BrokerClient;
  readonly backupDir: string;
  readonly backupId: string;
  readonly mode: BackupMode;
  readonly createdBy: { readonly adminId: string | null; readonly label: string };
  /** `ContainerInspectResponse.image` at backup time, or `null` if it could not be resolved — see `BackupManifestSchema`'s own doc comment. */
  readonly dmsImageDigest: string | null;
}

export interface CreatedBackupArchive {
  readonly filePath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly manifest: BackupManifest;
}

/**
 * Pulls all four volumes, assembles the outer archive, and returns its
 * final location plus the manifest it wrote inside — the caller
 * (`backups.service.ts`) is responsible for persisting a `backups` row
 * from the result. Always cleans up its own temp working directory, even
 * on failure.
 */
export async function createBackupArchive(
  params: CreateBackupArchiveParams,
  ctx: JobContext,
): Promise<CreatedBackupArchive> {
  const { broker, backupDir, backupId, mode, createdBy, dmsImageDigest } = params;
  const tmpDir = join(backupDir, 'tmp', backupId);
  await mkdir(tmpDir, { recursive: true });

  try {
    const volumes: BackupManifestVolume[] = [];
    const entries: BackupManifestEntry[] = [];
    let progress = 5;
    ctx.setProgress(progress);

    for (const volumeKey of BACKUP_VOLUME_KEYS) {
      const label = BACKUP_VOLUME_LABELS[volumeKey];
      ctx.log('info', `Archiving ${label} (${BACKUP_VOLUME_CONTAINER_PATHS[volumeKey]})...`);

      const stream = await broker.archiveGet(volumeKey);
      const volumeTarPath = join(tmpDir, volumeTarFilename(volumeKey));
      await pipeline(stream, createWriteStream(volumeTarPath));

      const analyzed = await analyzeVolumeTar(volumeTarPath, volumeKey);
      volumes.push(analyzed.volume);
      entries.push(...analyzed.entries);

      progress = Math.min(progress + 20, 90);
      ctx.setProgress(progress);
      ctx.log(
        'info',
        `${label}: ${analyzed.entries.length} entr${analyzed.entries.length === 1 ? 'y' : 'ies'}, ${analyzed.volume.sizeBytes} byte(s).`,
      );
    }

    const manifest: BackupManifest = BackupManifestSchema.parse({
      schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      panelVersion: APP_VERSION,
      dmsImageDigest,
      createdAt: new Date().toISOString(),
      createdBy,
      mode,
      volumes,
      entries,
      notes: buildRestoreNotes(),
    } satisfies BackupManifest);

    await writeFile(join(tmpDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');

    ctx.log('info', 'Assembling final archive...');
    await mkdir(backupDir, { recursive: true });
    const filePath = join(backupDir, `${backupId}.tar`);
    await tar.create({ file: filePath, cwd: tmpDir, gzip: false }, [
      MANIFEST_FILENAME,
      ...BACKUP_VOLUME_KEYS.map(volumeTarFilename),
    ]);

    const checksumSha256 = await computeSha256(filePath);
    const { size: sizeBytes } = await stat(filePath);

    ctx.setProgress(100);
    ctx.log('info', `Backup complete (${sizeBytes} byte(s)).`);

    return { filePath, checksumSha256, sizeBytes, manifest };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Reads an archive's own `manifest.json` — the reference manifest for verifying a foreign backup imported from a remote (there is no panel-stored manifest for one the panel never created). */
export async function readManifestFromArchive(filePath: string): Promise<BackupManifest> {
  let manifestText: string | null = null;
  await tar.list({
    file: filePath,
    onentry: (entry: ReadEntry) => {
      if (entry.path !== MANIFEST_FILENAME) return;
      const pending = collectEntryText(entry);
      // `list()`'s default resume-after-onentry means we must not await
      // here — the value is picked up below only after this whole
      // `tar.list` call resolves, by which point the entry (a small JSON
      // file) has certainly finished streaming.
      void pending.then((text) => {
        manifestText = text;
      });
    },
  });
  if (manifestText === null) {
    throw new Error(`Archive has no ${MANIFEST_FILENAME} member.`);
  }
  const parsed: unknown = JSON.parse(manifestText);
  return BackupManifestSchema.parse(parsed);
}

export interface VerifyBackupArchiveResult {
  readonly ok: boolean;
  /** Always present when `ok` is `false` — every reason found, joined, never just "failed". `null` when `ok` is `true`. */
  readonly reason: string | null;
}

/**
 * Recomputes checksums and validates archive structure **without
 * extracting** (`tar.list`, never `tar.extract`) — an unverified backup is
 * never presented as a safety net, so this function's honesty is the
 * feature. Never throws for a corrupted or tampered archive: that is a
 * normal, reportable outcome (`{ ok: false, reason }`), not a bug.
 */
export async function verifyBackupArchive(
  filePath: string,
  expectedManifest: BackupManifest,
): Promise<VerifyBackupArchiveResult> {
  try {
    const archiveManifest = await readManifestFromArchive(filePath);
    const reasons: string[] = [];

    if (archiveManifest.createdAt !== expectedManifest.createdAt) {
      reasons.push(
        "The archive's own manifest.json does not match the panel's recorded manifest (createdAt differs) — the file on disk may have been replaced.",
      );
    }

    const seenNames = new Set<string>();
    const pending: Promise<void>[] = [];

    await tar.list({
      file: filePath,
      onentry: (entry: ReadEntry) => {
        seenNames.add(entry.path);
        if (entry.path === MANIFEST_FILENAME) return;

        const volumeKey = entry.path.replace(/\.tar$/, '');
        const expectedVolume = archiveManifest.volumes.find((volume) => volume.key === volumeKey);
        pending.push(
          collectEntryDigest(entry).then(({ sha256 }) => {
            if (expectedVolume === undefined) {
              reasons.push(`Unexpected archive member: ${entry.path}`);
            } else if (sha256 !== expectedVolume.checksumSha256) {
              reasons.push(
                `Checksum mismatch for ${entry.path}: manifest.json says ${expectedVolume.checksumSha256}, actual content hashes to ${sha256}.`,
              );
            }
          }),
        );
      },
    });
    await Promise.all(pending);

    for (const expectedName of EXPECTED_OUTER_ENTRY_NAMES) {
      if (!seenNames.has(expectedName)) reasons.push(`Missing archive member: ${expectedName}`);
    }
    if (seenNames.size !== EXPECTED_OUTER_ENTRY_NAMES.length) {
      reasons.push(
        `Archive has ${seenNames.size} member(s); expected exactly ${EXPECTED_OUTER_ENTRY_NAMES.length}.`,
      );
    }

    return reasons.length > 0
      ? { ok: false, reason: reasons.join(' ') }
      : { ok: true, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Archive is unreadable or malformed: ${message}` };
  }
}

/**
 * Extracts the outer archive to `destDir` (a real extraction, unlike
 * `verifyBackupArchive` — restore has no way to avoid it, since the
 * volume tars must land on disk before {@link restoreVolumesFromExtractedArchive}
 * can stream them into the container) and returns the manifest it finds
 * there. Caller is responsible for cleaning up `destDir` afterwards.
 */
export async function extractBackupArchiveForRestore(
  filePath: string,
  destDir: string,
): Promise<BackupManifest> {
  await mkdir(destDir, { recursive: true });
  await tar.extract({ file: filePath, cwd: destDir });
  const manifestRaw = await readFile(join(destDir, MANIFEST_FILENAME), 'utf8');
  return BackupManifestSchema.parse(JSON.parse(manifestRaw));
}

/**
 * Streams each extracted volume tar back into the container via
 * `BrokerClient.archivePut`, one at a time — restore's actual data
 * mutation. Callers must have already confirmed the container is stopped;
 * this function performs no such check (see `types.ts`'s `archivePut` doc
 * comment).
 */
export async function restoreVolumesFromExtractedArchive(
  broker: BrokerClient,
  destDir: string,
  ctx: JobContext,
): Promise<void> {
  let progress = 10;
  ctx.setProgress(progress);

  for (const volumeKey of BACKUP_VOLUME_KEYS) {
    const label = BACKUP_VOLUME_LABELS[volumeKey];
    ctx.log('info', `Restoring ${label} (${BACKUP_VOLUME_CONTAINER_PATHS[volumeKey]})...`);
    const volumeTarPath = join(destDir, volumeTarFilename(volumeKey));
    await broker.archivePut(volumeKey, createReadStream(volumeTarPath));
    progress = Math.min(progress + 20, 95);
    ctx.setProgress(progress);
  }

  ctx.log(
    'info',
    'Restore complete. The container remains stopped — start it explicitly once you are ready to resume mail service.',
  );
  ctx.setProgress(100);
}
