/**
 * The pass-through guard `PUT /v1/archive/:volumeKey` streams every restore
 * through (`archive-routes.ts`).
 *
 * **Why restore writes into the parent directory.** Docker's own
 * `GET /containers/{id}/archive?path=/var/mail` roots every entry at the
 * path's basename (`mail/`, `mail/example.com/...`), and its
 * `PUT .../archive?path=X` extracts *into* `X`. Writing a backup's
 * `mail.tar` back to `/var/mail` therefore produced `/var/mail/mail/...` —
 * observed on Docker Engine 29.9.1 with a throwaway container. The exact
 * inverse of the GET is a PUT into the parent (`/var`), which lands
 * `mail/...` back on `/var/mail` with every header's uid/gid/mode intact.
 *
 * **Why this guard exists.** Extracting into the parent widens what a tar
 * could touch from `/var/mail` to all of `/var`. This guard keeps the old
 * boundary: every entry must sit under the volume's own root name (`mail/`),
 * a hard link must point under it too, and no entry may sit beneath a
 * symlink the same stream created. Bytes pass through untouched — the guard
 * only reads headers — so ownership preservation is unaffected.
 *
 * The header walk mirrors Go's `archive/tar` reader (what the Docker daemon
 * parses with): PAX `path`/`linkpath`/`size` overrides, GNU long names
 * (which win over PAX), header-only entry types carrying no data, and the
 * USTAR/STAR prefix fields. Anything that reader would interpret differently
 * from this walk — a bad checksum, an unknown entry type, GNU sparse
 * entries — is refused, so the guard and the daemon always agree on where
 * each entry starts.
 *
 * On a violation the guard ends its output at the last entry boundary
 * (Docker sees a clean end of archive, so the request never hangs), drops
 * the rest of the input, and records {@link RestoreTarGuard.rejection} for
 * the route to report. Entries before the violation were already extracted
 * — streaming a multi-gigabyte volume leaves no way to look ahead — but none
 * of them were outside the volume's root.
 */
import { Transform, type TransformCallback } from 'node:stream';

const BLOCK_SIZE = 512;
/** Go's `archive/tar` refuses PAX and GNU long-name bodies above 1 MiB; refusing them here too keeps the two walks in step. */
const MAX_META_BODY_BYTES = 1024 * 1024;

/** Entry types Go treats as header-only: their size field is ignored and no data follows. */
const HEADER_ONLY_TYPES = new Set(['1', '2', '3', '4', '5', '6']);
/** Entry types a Docker archive can contain. Anything else (GNU sparse `S`, volume headers, ...) is refused rather than guessed at. */
const ACCEPTED_ENTRY_TYPES = new Set(['0', '\0', '7', ...HEADER_ONLY_TYPES]);

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

/** Parses a numeric header field: octal text, or GNU base-256 when the high bit is set. `null` when malformed. */
function readNumber(block: Buffer, offset: number, length: number): number | null {
  const first = block[offset]!;
  if ((first & 0x80) !== 0) {
    if ((first & 0x40) !== 0) return null; // negative
    let value = first & 0x3f;
    for (let i = offset + 1; i < offset + length; i += 1) value = value * 256 + block[i]!;
    return Number.isSafeInteger(value) ? value : null;
  }
  const text = readString(block, offset, length).trim();
  if (text === '') return 0;
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
}

function checksumMatches(block: Buffer): boolean {
  const recorded = readNumber(block, 148, 8);
  if (recorded === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return recorded === unsigned || recorded === signed;
}

/** The entry name as Go assembles it from the header alone: the prefix field joined on for USTAR/PAX (155 bytes) and STAR (131 bytes), never for GNU or V7. */
function headerName(block: Buffer): string {
  const name = readString(block, 0, 100);
  const magic = block.subarray(257, 263).toString('latin1');
  if (magic !== 'ustar\0') return name;
  const isStar = block.subarray(508, 512).toString('latin1') === 'tar\0';
  const prefix = readString(block, 345, isStar ? 131 : 155);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** Parses PAX extended-header records (`"<len> <key>=<value>\n"`). `null` when malformed. */
function parsePaxRecords(body: Buffer): Map<string, string> | null {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) return null;
    const lengthText = body.subarray(offset, space).toString('latin1');
    if (!/^[0-9]+$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const end = offset + length;
    if (length <= space - offset + 1 || end > body.length || body[end - 1] !== 0x0a) return null;
    const record = body.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) return null;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return records;
}

function roundUpToBlock(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

function quoted(path: string): string {
  return JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}…` : path);
}

/** Path components after dropping `.` and empty ones, or `null` for an absolute path or any `..`. */
function components(path: string): string[] | null {
  if (path.startsWith('/')) return null;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  return parts.includes('..') ? null : parts;
}

export class RestoreTarGuard extends Transform {
  /** Why the archive was cut short, or `null` while every entry has stayed inside the volume's root. Read once the consumer has finished. */
  rejection: string | null = null;

  private buffered: Buffer = Buffer.alloc(0);
  /** Entry data bytes (padding included) still to pass through before the next header. */
  private dataRemaining = 0;
  /** PAX / GNU long-name blocks read but not yet forwarded, so a refused entry's preamble never reaches Docker. */
  private held: Buffer[] = [];
  private paxRecords: Map<string, string> | null = null;
  private gnuLongName: string | null = null;
  private gnuLongLink: string | null = null;
  private readonly symlinks = new Set<string>();
  /** Set once the end-of-archive block has been seen; everything after it passes through as-is. */
  private ended = false;

  /** @param rootName the volume's own directory name — the basename Docker's GET roots its entries at (`mail` for `/var/mail`). */
  constructor(private readonly rootName: string) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.rejection !== null) {
      callback(); // drain and discard the rest of the upload
      return;
    }
    if (this.ended) {
      this.push(chunk);
      callback();
      return;
    }
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    this.walk();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (
      this.rejection === null &&
      !this.ended &&
      (this.buffered.length > 0 || this.held.length > 0 || this.dataRemaining > 0)
    ) {
      this.rejection = 'The archive ends partway through an entry.';
    }
    callback();
  }

  private reject(reason: string): void {
    this.rejection = reason;
    this.buffered = Buffer.alloc(0);
    this.held = [];
    this.push(null);
  }

  private consume(length: number): Buffer {
    const taken = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return taken;
  }

  private walk(): void {
    while (this.rejection === null) {
      if (this.ended) {
        if (this.buffered.length > 0) this.push(this.consume(this.buffered.length));
        return;
      }
      if (this.dataRemaining > 0) {
        if (this.buffered.length === 0) return;
        const length = Math.min(this.dataRemaining, this.buffered.length);
        this.push(this.consume(length));
        this.dataRemaining -= length;
        continue;
      }
      if (this.buffered.length < BLOCK_SIZE) return;

      const header = this.buffered.subarray(0, BLOCK_SIZE);
      if (header.every((byte) => byte === 0)) {
        if (this.held.length > 0) {
          this.reject('The archive has an extended header with no entry after it.');
          return;
        }
        this.ended = true;
        continue;
      }
      if (!checksumMatches(header)) {
        this.reject('The archive has a header with an invalid checksum.');
        return;
      }
      const ownSize = readNumber(header, 124, 12);
      if (ownSize === null) {
        this.reject('The archive has a header with an invalid size.');
        return;
      }

      const type = String.fromCharCode(header[156]!);
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (ownSize > MAX_META_BODY_BYTES) {
          this.reject('The archive has an oversized extended header.');
          return;
        }
        const total = BLOCK_SIZE + roundUpToBlock(ownSize);
        if (this.buffered.length < total) return; // wait for the whole body
        const body = this.buffered.subarray(BLOCK_SIZE, BLOCK_SIZE + ownSize);
        if (!this.readMetaHeader(type, body)) return;
        this.held.push(this.consume(total));
        continue;
      }
      if (!ACCEPTED_ENTRY_TYPES.has(type)) {
        this.reject(`The archive has an entry of unsupported type ${JSON.stringify(type)}.`);
        return;
      }
      if (!this.admitEntry(header, type, ownSize)) return;
    }
  }

  /** Records a PAX / GNU long-name header's effect on the next entry. Returns `false` after rejecting. */
  private readMetaHeader(type: string, body: Buffer): boolean {
    if (type === 'L' || type === 'K') {
      const nul = body.indexOf(0);
      const value = body.subarray(0, nul === -1 ? body.length : nul).toString('utf8');
      // Go ignores an empty GNU long name, so it must not override anything here either.
      if (type === 'L') this.gnuLongName = value === '' ? null : value;
      else this.gnuLongLink = value === '' ? null : value;
      return true;
    }
    const records = parsePaxRecords(body);
    if (records === null) {
      this.reject('The archive has a malformed PAX header.');
      return false;
    }
    // A global header is returned by Go as an entry of its own and ignored by
    // Docker's extraction; only a local one changes the next entry.
    if (type === 'x') this.paxRecords = records;
    return true;
  }

  /** Validates one real entry and forwards it (with any held preamble). Returns `false` after rejecting. */
  private admitEntry(header: Buffer, rawType: string, ownSize: number): boolean {
    const pax = this.paxRecords;
    const name = this.gnuLongName ?? pax?.get('path') ?? headerName(header);
    const linkName = this.gnuLongLink ?? pax?.get('linkpath') ?? readString(header, 157, 100);
    let size = ownSize;
    const paxSize = pax?.get('size');
    if (paxSize !== undefined) {
      if (!/^[0-9]+$/.test(paxSize) || !Number.isSafeInteger(Number(paxSize))) {
        this.reject('The archive has a PAX header with an invalid size.');
        return false;
      }
      size = Number(paxSize);
    }
    this.paxRecords = null;
    this.gnuLongName = null;
    this.gnuLongLink = null;

    // Go turns an old-style regular entry whose name ends in `/` into a directory.
    const type = rawType === '\0' && name.endsWith('/') ? '5' : rawType;

    const problem = this.problemWith(type, name, linkName);
    if (problem !== null) {
      this.reject(problem);
      return false;
    }

    for (const block of this.held) this.push(block);
    this.held = [];
    this.push(this.consume(BLOCK_SIZE));
    this.dataRemaining = HEADER_ONLY_TYPES.has(type) ? 0 : roundUpToBlock(size);
    return true;
  }

  private problemWith(type: string, name: string, linkName: string): string | null {
    const parts = components(name);
    if (parts === null || parts[0] !== this.rootName) {
      return `The archive entry ${quoted(name)} is outside ${this.rootName}/.`;
    }
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (this.symlinks.has(parts.slice(0, depth).join('/'))) {
        return `The archive entry ${quoted(name)} is beneath a symlink it created.`;
      }
    }
    if (type === '1') {
      const target = components(linkName);
      if (target === null || target[0] !== this.rootName) {
        return `The archive hard link ${quoted(name)} points outside ${this.rootName}/.`;
      }
    }
    if (type === '2') this.symlinks.add(parts.join('/'));
    return null;
  }
}

/** Splits a broker-owned volume path into where restore extracts (`/var`) and the root name its archive entries carry (`mail`). */
export function restoreTargetFor(volumePath: string): {
  readonly parentPath: string;
  readonly rootName: string;
} {
  const slash = volumePath.lastIndexOf('/');
  return {
    parentPath: slash <= 0 ? '/' : volumePath.slice(0, slash),
    rootName: volumePath.slice(slash + 1),
  };
}
