/**
 * Fixture tar archives for {@link FakeBrokerClient}'s `archiveGet`/
 * `archivePut` (M10 backups/restore). **Not a capture** — there is no
 * Docker daemon on this development machine to run `docker archive get`
 * against, so unlike this project's other fixtures these are
 * *constructed*, by hand, directly against the documented POSIX
 * ustar `tar` header format (IEEE Std 1003.1-2001, §"Extended tar
 * Format"; the same format `apps/server/src/drivers/dms/*` never has to
 * touch, since the real archive bytes come from `apps/broker`'s
 * `dockerode`, not from this project). AGENT_BRIEF.md §3 rule 8 requires
 * exactly this disclosure: this header says plainly that these bytes are
 * built, not observed.
 *
 * Each fixture file is owned by uid/gid 5000 — the documented DMS `vmail`
 * account (IMPLEMENTATION_PLAN.md §2.1) — so a test exercising restore's
 * "ownership survives untouched" property has something real to assert
 * against even without a live container.
 */
import { createHash } from 'node:crypto';
import type { BackupVolumeKey } from '@dwg/shared';

const HEADER_SIZE = 512;
const VMAIL_UID = 5000;
const VMAIL_GID = 5000;
const FIXTURE_MTIME = Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000);

export interface UstarEntry {
  readonly path: string;
  readonly content: Buffer;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly mtimeSeconds?: number;
}

function octalField(value: number, length: number): Buffer {
  const field = Buffer.alloc(length, 0);
  // `length - 1` digits of octal, left-padded with '0', then a trailing
  // NUL — the standard ustar numeric-field encoding.
  const digits = value.toString(8).padStart(length - 1, '0');
  field.write(digits, 0, length - 1, 'ascii');
  return field;
}

function textField(value: string, length: number): Buffer {
  const field = Buffer.alloc(length, 0);
  field.write(value, 0, Math.min(value.length, length), 'utf8');
  return field;
}

/** Builds one 512-byte ustar header for a regular file entry, checksum included. */
function buildHeader(entry: Required<UstarEntry>): Buffer {
  const header = Buffer.alloc(HEADER_SIZE, 0);
  textField(entry.path, 100).copy(header, 0);
  octalField(entry.mode, 8).copy(header, 100);
  octalField(entry.uid, 8).copy(header, 108);
  octalField(entry.gid, 8).copy(header, 116);
  octalField(entry.content.length, 12).copy(header, 124);
  octalField(entry.mtimeSeconds, 12).copy(header, 136);
  // Checksum field starts as 8 ASCII spaces for the purpose of computing
  // the sum below, per spec.
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii'); // typeflag '0' — regular file
  header.write('ustar', 257, 5, 'ascii'); // magic
  header.write('\0', 262, 1, 'ascii');
  header.write('00', 263, 2, 'ascii'); // version

  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  header.write(`${checksum}\0 `, 148, 8, 'ascii');

  return header;
}

/** Pads `buffer` up to the next multiple of 512 bytes with zeros (tar's block size). */
function padToBlockSize(buffer: Buffer): Buffer {
  const remainder = buffer.length % HEADER_SIZE;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(HEADER_SIZE - remainder, 0)]);
}

/**
 * Builds a complete, valid ustar `tar` archive from in-memory entries —
 * readable by the real `tar` package (`tar.list`/`tar.create` output is
 * what this project's `modules/backups/backup-archive.ts` actually
 * parses), so a test exercising the fake driver exercises the same
 * parsing code path a real broker response would.
 */
export function buildUstarTar(entries: readonly UstarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const full: Required<UstarEntry> = {
      uid: VMAIL_UID,
      gid: VMAIL_GID,
      mode: 0o644,
      mtimeSeconds: FIXTURE_MTIME,
      ...entry,
    };
    parts.push(buildHeader(full));
    parts.push(padToBlockSize(full.content));
  }
  // End-of-archive marker: two zeroed 512-byte blocks (POSIX ustar spec).
  parts.push(Buffer.alloc(HEADER_SIZE * 2, 0));
  return Buffer.concat(parts);
}

function fixtureFile(volumeKey: BackupVolumeKey, name: string, text: string): UstarEntry {
  return { path: `${volumeKey}/${name}`, content: Buffer.from(text, 'utf8') };
}

/**
 * One small, deterministic tar per volume key — enough to exercise
 * manifest generation (entry counts, per-entry and per-volume checksums)
 * and restore's round trip without pretending this is what a real DMS
 * install's multi-gigabyte `/var/mail` contains.
 */
const FIXTURE_VOLUME_ENTRIES: Readonly<Record<BackupVolumeKey, readonly UstarEntry[]>> = {
  mail: [
    fixtureFile('mail', 'example.com/admin/cur/README.txt', 'Fixture mailbox content.\n'),
    fixtureFile('mail', 'example.com/admin/new/placeholder.txt', 'Fixture new-mail placeholder.\n'),
  ],
  mailState: [
    fixtureFile('mailState', 'dovecot-uidvalidity.txt', 'Fixture Dovecot index state.\n'),
  ],
  mailLog: [fixtureFile('mailLog', 'mail.log', 'Fixture mail.log line.\n')],
  dmsConfig: [
    fixtureFile('dmsConfig', 'postfix-virtual.cf', '# Fixture postfix-virtual.cf\n'),
    fixtureFile('dmsConfig', 'postfix-accounts.cf', '# Fixture postfix-accounts.cf\n'),
  ],
};

const fixtureTarCache = new Map<BackupVolumeKey, Buffer>();

/** The fixture tar for one volume key, built once and memoised (these are pure functions of the constant above, so recomputing per call would be wasted work, not fresher data). */
export function buildFixtureVolumeTar(volumeKey: BackupVolumeKey): Buffer {
  const cached = fixtureTarCache.get(volumeKey);
  if (cached) return cached;
  const built = buildUstarTar(FIXTURE_VOLUME_ENTRIES[volumeKey]);
  fixtureTarCache.set(volumeKey, built);
  return built;
}

/** SHA-256 of a fixture volume tar — used by `fake-broker-client.test.ts`/`backup-archive.test.ts` to assert against a known value without recomputing it inline at every call site. */
export function fixtureVolumeTarChecksum(volumeKey: BackupVolumeKey): string {
  return createHash('sha256').update(buildFixtureVolumeTar(volumeKey)).digest('hex');
}
