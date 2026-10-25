/**
 * Test-only tar builder for the restore guard's suites. **Constructed, not
 * captured:** written by hand against the POSIX ustar/PAX header layout
 * (IEEE Std 1003.1-2001). The layout the tests use — entries rooted at
 * `mail/` — is what Docker Engine 29.9.1's archive GET returned for
 * `/var/mail` from a throwaway container.
 */
export interface TarFixtureEntry {
  readonly name: string;
  readonly type?: string;
  readonly content?: string;
  readonly linkName?: string;
  /** Overrides the size field — to model a PAX `size` record carrying the real one. */
  readonly sizeField?: number;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

export function header(entry: TarFixtureEntry, contentLength: number): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(entry.name.slice(0, 100), 0, 'utf8');
  block.write(octal(0o644, 8), 100, 'latin1');
  block.write(octal(5000, 8), 108, 'latin1');
  block.write(octal(5000, 8), 116, 'latin1');
  block.write(octal(entry.sizeField ?? contentLength, 12), 124, 'latin1');
  block.write(octal(0, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(entry.type ?? '0', 156, 'latin1');
  if (entry.linkName !== undefined) block.write(entry.linkName, 157, 'utf8');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(content: Buffer): Buffer {
  const remainder = content.length % 512;
  return remainder === 0 ? content : Buffer.concat([content, Buffer.alloc(512 - remainder)]);
}

export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

/** A complete archive of `entries`, end-of-archive blocks included. */
export function tarOf(entries: readonly TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    parts.push(header(entry, content.length), padded(content));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
