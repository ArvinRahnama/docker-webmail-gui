/**
 * The claims `handlers.ts` makes about the docker-mailserver vocabulary,
 * asserted rather than commented (M16).
 *
 * Four properties, each of which is the reason a specific design choice
 * was made instead of the obvious one:
 *
 *  1. A file read selects a row in a broker-owned table. There is no
 *     input that reaches the path.
 *  2. An environment read returns six allowlisted keys — a credential
 *     sitting in the mail container's environment does not come back.
 *  3. A password reaches the container over stdin and appears in no argv
 *     element.
 *  4. Nothing anywhere reads a DKIM `.private` key.
 */
import { describe, expect, it } from 'vitest';
import { DMS_CONFIG_FILE_KEYS, DMS_ENV_KEYS } from '@dwg/shared';
import type { Logger } from 'pino';
import type { DockerApi, RawContainerListItem, RawExecOptions } from '../docker-types.js';
import type { OperationDeps } from '../operations.js';
import {
  handleDmsCommand,
  handleDmsDkimRecordRead,
  handleDmsEnvRead,
  handleDmsFileRead,
} from './handlers.js';

interface RecordedExec {
  readonly argv: readonly string[];
  readonly stdin: string | undefined;
}

function harness(stdout = ''): { deps: OperationDeps; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const managed: RawContainerListItem = {
    id: 'container-id',
    names: ['mailserver'],
    image: 'mailserver:latest',
    state: 'running',
    status: 'Up',
    labels: {},
    createdAt: 1_700_000_000,
  };
  const docker = {
    listContainers: async () => [managed],
    execContainer: async (_id: string, argv: readonly string[], options?: RawExecOptions) => {
      calls.push({ argv, stdin: options?.stdin });
      return { stdout, stderr: '', exitCode: 0 };
    },
  } as unknown as DockerApi;

  const logger = {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;

  return {
    deps: { docker, dms: { containerName: 'mailserver', containerLabel: null }, logger },
    calls,
  };
}

describe('dms.file.read — a symbolic key, never a path', () => {
  it('maps every key in the enum to an absolute path under the DMS config directory', async () => {
    for (const file of DMS_CONFIG_FILE_KEYS) {
      const { deps, calls } = harness('content');
      await handleDmsFileRead({ operation: 'dms.file.read', file }, deps);
      const [call] = calls;
      expect(call).toBeDefined();
      expect(call?.argv[0]).toBe('cat');
      expect(call?.argv[1]).toMatch(/^\/tmp\/docker-mailserver\/[a-z-]+\.cf$/);
    }
  });

  it('covers every key — a key added to the enum with no path would throw here', async () => {
    const seen = new Set<string>();
    for (const file of DMS_CONFIG_FILE_KEYS) {
      const { deps, calls } = harness('x');
      await handleDmsFileRead({ operation: 'dms.file.read', file }, deps);
      const path = calls[0]?.argv[1];
      expect(path, `no path mapped for key "${file}"`).toBeDefined();
      seen.add(path as string);
    }
    // Distinct paths: two keys quietly pointing at one file would be a
    // copy-paste bug this assertion is cheap enough to keep catching.
    expect(seen.size).toBe(DMS_CONFIG_FILE_KEYS.length);
  });

  it('reports a missing file as null rather than an error — a fresh install has written none of them', async () => {
    const calls: RecordedExec[] = [];
    const docker = {
      listContainers: async () => [
        {
          id: 'container-id',
          names: ['mailserver'],
          image: 'i',
          state: 'running',
          status: 'Up',
          labels: {},
          createdAt: 1,
        },
      ],
      execContainer: async (_id: string, argv: readonly string[]) => {
        calls.push({ argv, stdin: undefined });
        return { stdout: '', stderr: 'No such file or directory', exitCode: 1 };
      },
    } as unknown as DockerApi;
    const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;
    const deps: OperationDeps = {
      docker,
      dms: { containerName: 'mailserver', containerLabel: null },
      logger,
    };

    const result = await handleDmsFileRead(
      { operation: 'dms.file.read', file: 'postfix-accounts' },
      deps,
    );
    expect(result.content).toBeNull();
  });
});

describe('dms.env.read — six keys, not the container environment', () => {
  it('returns only allowlisted keys, and drops a credential sitting beside them', async () => {
    const { deps } = harness(
      [
        'ENABLE_QUOTAS=1',
        'ENABLE_RSPAMD=1',
        'SSL_TYPE=letsencrypt',
        // The whole reason this handler filters at all.
        'RSPAMD_PASSWORD=hunter2',
        'AWS_SECRET_ACCESS_KEY=very-secret',
        'POSTMASTER_ADDRESS=postmaster@example.com',
      ].join('\n'),
    );

    const { env } = await handleDmsEnvRead(deps);

    expect(env).toEqual({
      ENABLE_QUOTAS: '1',
      ENABLE_RSPAMD: '1',
      SSL_TYPE: 'letsencrypt',
    });
    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('very-secret');
    for (const key of Object.keys(env)) {
      expect(DMS_ENV_KEYS as readonly string[]).toContain(key);
    }
  });

  it('ignores a malformed line rather than letting it introduce a key', async () => {
    const { deps } = harness(
      ['not-an-assignment', '=leading-equals', 'ENABLE_CLAMAV=1'].join('\n'),
    );
    const { env } = await handleDmsEnvRead(deps);
    expect(env).toEqual({ ENABLE_CLAMAV: '1' });
  });
});

describe('dms command operations — the broker builds the argv', () => {
  it('sends a password over stdin and puts it in no argv element', async () => {
    const { deps, calls } = harness();

    await handleDmsCommand(
      { operation: 'dms.email.add', email: 'new@example.com', password: 'a-real-password' },
      deps,
    );

    const [call] = calls;
    expect(call?.argv).toEqual(['setup', 'email', 'add', 'new@example.com']);
    expect(call?.argv.join(' ')).not.toContain('a-real-password');
    expect(call?.stdin).toBe('a-real-password\na-real-password\n');
  });

  it('sends a Sieve script body over stdin, not argv', async () => {
    const { deps, calls } = harness();
    await handleDmsCommand(
      {
        operation: 'dms.sieve.put',
        user: 'a@example.com',
        script: 'vacation',
        content: 'require ["vacation"]; vacation "away";',
      },
      deps,
    );
    expect(calls[0]?.argv).toEqual(['doveadm', 'sieve', 'put', '-u', 'a@example.com', 'vacation']);
    expect(calls[0]?.stdin).toContain('vacation "away"');
  });

  it('always carries an explicit -y/-n on a mailbox delete', async () => {
    for (const [mailData, flag] of [
      ['delete', '-y'],
      ['keep', '-n'],
    ] as const) {
      const { deps, calls } = harness();
      await handleDmsCommand(
        { operation: 'dms.email.del', emails: ['gone@example.com'], mailData },
        deps,
      );
      expect(calls[0]?.argv).toContain(flag);
    }
  });

  it('returns a non-zero exit rather than throwing — a missing script is diagnostic, not a broker failure', async () => {
    const docker = {
      listContainers: async () => [
        {
          id: 'c',
          names: ['mailserver'],
          image: 'i',
          state: 'running',
          status: 'Up',
          labels: {},
          createdAt: 1,
        },
      ],
      execContainer: async () => ({ stdout: '', stderr: 'not found', exitCode: 68 }),
    } as unknown as DockerApi;
    const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;

    const result = await handleDmsCommand(
      { operation: 'dms.sieve.get', user: 'a@example.com', script: 'missing' },
      { docker, dms: { containerName: 'mailserver', containerLabel: null }, logger },
    );

    expect(result.exitCode).toBe(68);
    expect(result.stderr).toBe('not found');
  });

  it('rejects a value the builder refuses, as a validation failure', async () => {
    const { deps } = harness();
    await expect(
      handleDmsCommand(
        // Structurally valid for the transport, refused by the builder:
        // `list` needs no address, `add` does.
        { operation: 'dms.email.restrict', action: 'add', scope: 'send' },
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe('dms.dkim.record.read — the public record only', () => {
  it('reads the .txt record and never a .private key', async () => {
    const { deps, calls } = harness('v=DKIM1; k=rsa; p=MIIB...');

    await handleDmsDkimRecordRead(
      { operation: 'dms.dkim.record.read', domain: 'example.com', selector: 'mail' },
      deps,
    );

    const path = calls[0]?.argv[1] ?? '';
    expect(path).toBe('/tmp/docker-mailserver/opendkim/keys/example.com/mail.txt');
    expect(path).not.toContain('.private');
  });

  it('constructs no path anywhere in this module that names a .private key file', async () => {
    // The enforcement behind FEATURE_MATRIX.md §11 is an absence, and an
    // absence is only durable if something notices when it ends.
    //
    // Comments are stripped before the check: this file's own prose says
    // ".private" repeatedly, explaining why no code does. Asserting
    // against the raw text would make the explanation fail the test that
    // the explanation is about.
    const fs = await import('node:fs/promises');
    const text = await fs.readFile(new URL('./handlers.ts', import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('.private');
    // And the stripping actually worked — otherwise this test passes for
    // the wrong reason on a file that has no comments left to strip.
    expect(code).toContain('handleDmsDkimRecordRead');
  });
});
