import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_VOLUME_ARCHIVE_ROOTS,
  BACKUP_VOLUME_CONTAINER_PATHS,
  BACKUP_VOLUME_KEYS,
} from '@dwg/shared';
import { RestoreTarGuard, restoreTargetFor } from './restore-tar-guard.js';
import { header, paxRecord, tarOf, type TarFixtureEntry as Entry } from './tar-fixture.js';

/** Streams `input` through a guard in chunks of `chunkSize`, returning what came out and the verdict. */
async function guard(
  input: Buffer,
  rootName = 'mail',
  chunkSize = 7,
): Promise<{ output: Buffer; rejection: string | null }> {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    chunks.push(input.subarray(offset, offset + chunkSize));
  }
  const tarGuard = new RestoreTarGuard(rootName);
  Readable.from(chunks).pipe(tarGuard);
  const out: Buffer[] = [];
  for await (const chunk of tarGuard) out.push(chunk as Buffer);
  return { output: Buffer.concat(out), rejection: tarGuard.rejection };
}

const MAIL_VOLUME: Entry[] = [
  { name: 'mail/', type: '5' },
  { name: 'mail/example.com/', type: '5' },
  { name: 'mail/example.com/admin/cur/msg1', content: 'hello' },
  { name: 'mail/example.com/admin/cur/msg2', content: 'x'.repeat(1300) },
];

describe('RestoreTarGuard', () => {
  it('passes a volume archive rooted at its own name through byte for byte, at any chunking', async () => {
    const input = tarOf(MAIL_VOLUME);
    for (const chunkSize of [1, 7, 512, 513, input.length]) {
      const { output, rejection } = await guard(input, 'mail', chunkSize);
      expect(rejection).toBeNull();
      expect(output.equals(input)).toBe(true);
    }
  });

  it('accepts entries written with a leading ./', async () => {
    const { rejection } = await guard(tarOf([{ name: './mail/a', content: 'a' }]));
    expect(rejection).toBeNull();
  });

  it('refuses an entry outside the root and forwards nothing from it onwards', async () => {
    const good = tarOf([{ name: 'mail/a', content: 'a' }]).subarray(0, 1024);
    const input = Buffer.concat([good, tarOf([{ name: 'lib/evil', content: 'pwned' }])]);
    const { output, rejection } = await guard(input);
    expect(rejection).toMatch(/"lib\/evil" is outside mail\//);
    // Only the admitted entry reached Docker, ending on a block boundary.
    expect(output.equals(good)).toBe(true);
  });

  it('refuses the parent directory itself, .. components and absolute paths', async () => {
    for (const name of ['./', 'mail/../lib/x', '/var/mail/x', 'mailbox/x']) {
      const { rejection } = await guard(tarOf([{ name, content: 'x' }]));
      expect(rejection, name).not.toBeNull();
    }
  });

  it('refuses a hard link pointing outside the root', async () => {
    const { rejection } = await guard(
      tarOf([{ name: 'mail/link', type: '1', linkName: 'lib/target' }]),
    );
    expect(rejection).toMatch(/hard link "mail\/link" points outside mail\//);
  });

  it('allows a symlink, but refuses any later entry beneath it', async () => {
    const symlinkOnly = await guard(tarOf([{ name: 'mail/sl', type: '2', linkName: '/etc' }]));
    expect(symlinkOnly.rejection).toBeNull();

    const through = await guard(
      tarOf([
        { name: 'mail/sl', type: '2', linkName: '..' },
        { name: 'mail/sl/lib/evil', content: 'x' },
      ]),
    );
    expect(through.rejection).toMatch(/beneath a symlink/);
  });

  it('uses a PAX path override — and refuses one that escapes, holding back its preamble', async () => {
    const accepted = await guard(
      tarOf([
        { name: 'PaxHeaders/x', type: 'x', content: paxRecord('path', 'mail/long/name') },
        { name: 'truncated', content: 'x' },
      ]),
    );
    expect(accepted.rejection).toBeNull();

    const refused = await guard(
      tarOf([
        { name: 'PaxHeaders/x', type: 'x', content: paxRecord('path', 'lib/evil') },
        { name: 'mail/looks-fine', content: 'x' },
      ]),
    );
    expect(refused.rejection).toMatch(/"lib\/evil" is outside mail\//);
    expect(refused.output.length).toBe(0);
  });

  it('follows a PAX size override, so data bytes are never parsed as a header', async () => {
    // The data carries a block that would look like an outside entry if the
    // guard trusted the header's size field (0) over the PAX record (512).
    const smuggled = header({ name: 'lib/evil' }, 0).toString('latin1');
    const input = tarOf([
      { name: 'PaxHeaders/x', type: 'x', content: paxRecord('size', '512') },
      { name: 'mail/file', content: smuggled, sizeField: 0 },
    ]);
    const { rejection } = await guard(input);
    expect(rejection).toBeNull();
  });

  it('lets a GNU long name win over a PAX path, as Go does', async () => {
    const { rejection } = await guard(
      tarOf([
        { name: 'PaxHeaders/x', type: 'x', content: paxRecord('path', 'mail/fine') },
        { name: '././@LongLink', type: 'L', content: 'lib/evil\0' },
        { name: 'mail/fine', content: 'x' },
      ]),
    );
    expect(rejection).toMatch(/"lib\/evil" is outside/);
  });

  it('refuses a corrupted header checksum and unsupported entry types', async () => {
    const corrupt = tarOf([{ name: 'mail/a', content: 'a' }]);
    corrupt[0] = 'n'.charCodeAt(0);
    expect((await guard(corrupt)).rejection).toMatch(/invalid checksum/);

    const sparse = await guard(tarOf([{ name: 'mail/sparse', type: 'S', content: 'x' }]));
    expect(sparse.rejection).toMatch(/unsupported type "S"/);
  });

  it('reports an archive cut off mid-entry', async () => {
    const whole = tarOf([{ name: 'mail/a', content: 'x'.repeat(2000) }]);
    const { rejection } = await guard(whole.subarray(0, 1000));
    expect(rejection).toMatch(/ends partway through an entry/);
  });
});

describe('restoreTargetFor', () => {
  it('extracts each volume into its parent, rooted at the name shared/ documents', () => {
    expect(restoreTargetFor('/var/mail')).toEqual({ parentPath: '/var', rootName: 'mail' });
    expect(restoreTargetFor('/tmp/docker-mailserver')).toEqual({
      parentPath: '/tmp',
      rootName: 'docker-mailserver',
    });
    for (const key of BACKUP_VOLUME_KEYS) {
      expect(restoreTargetFor(BACKUP_VOLUME_CONTAINER_PATHS[key]).rootName).toBe(
        BACKUP_VOLUME_ARCHIVE_ROOTS[key],
      );
    }
  });
});
