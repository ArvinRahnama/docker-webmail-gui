import { describe, expect, it } from 'vitest';
import {
  buildAliasAddCommand,
  buildAliasDeleteCommand,
  buildAliasListCommand,
  buildConfigDkimCommand,
  buildEmailAddCommand,
  buildEmailDeleteCommand,
  buildEmailListCommand,
  buildEmailRestrictCommand,
  buildEmailUpdateCommand,
  buildFail2banBanCommand,
  buildFail2banListCommand,
  buildFail2banLogCommand,
  buildFail2banStatusCommand,
  buildFail2banUnbanCommand,
  buildQuotaDeleteCommand,
  buildQuotaSetCommand,
  type CommandResult,
  type DeleteMailboxParams,
} from './commands.js';

// ---------------------------------------------------------------------------
// Injection sweep — every builder, fed every payload. FEATURE_MATRIX.md §0
// Rule 1 / SECURITY.md §3.2's own acceptance test: each must be rejected
// outright, or (if ever accepted) survive as exactly one argv element,
// never split into several, and never introduce a shell.
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS = ['; rm -rf /', '$(id)', '`id`', 'a\nb', '-leadinghyphen'] as const;

/** Asserts the "reject or carry inertly as one element" contract for a single builder call. */
function expectRejectedOrInert(result: CommandResult, payload: string) {
  if (!result.ok) {
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    return;
  }
  const argv = result.command.argv;
  // The payload must appear as exactly one whole element (never split into
  // multiple argv entries by any internal join/split logic).
  expect(argv.filter((element) => element === payload)).toHaveLength(1);
  for (const element of argv) {
    expect(element).not.toBe('sh');
    expect(element).not.toBe('bash');
    expect(element).not.toBe('-c');
  }
}

describe('commands — injection payloads are rejected or carried inertly, across every builder', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`buildEmailAddCommand rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(
        buildEmailAddCommand({ email: payload, password: 'hunter2pass' }),
        payload,
      );
    });

    it(`buildEmailUpdateCommand rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(
        buildEmailUpdateCommand({ email: payload, password: 'hunter2pass' }),
        payload,
      );
    });

    it(`buildEmailDeleteCommand rejects/inerts "${payload}" as an email`, () => {
      expectRejectedOrInert(
        buildEmailDeleteCommand({ emails: [payload], mailData: 'keep' }),
        payload,
      );
    });

    it(`buildEmailRestrictCommand rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(
        buildEmailRestrictCommand({ action: 'add', scope: 'send', email: payload }),
        payload,
      );
    });

    it(`buildAliasAddCommand rejects/inerts "${payload}" as the alias`, () => {
      expectRejectedOrInert(
        buildAliasAddCommand({ alias: payload, recipient: 'ok@example.com' }),
        payload,
      );
    });

    it(`buildAliasAddCommand rejects/inerts "${payload}" as the recipient`, () => {
      expectRejectedOrInert(
        buildAliasAddCommand({ alias: 'ok@example.com', recipient: payload }),
        payload,
      );
    });

    it(`buildAliasDeleteCommand rejects/inerts "${payload}" as the alias`, () => {
      expectRejectedOrInert(
        buildAliasDeleteCommand({ alias: payload, recipient: 'ok@example.com' }),
        payload,
      );
    });

    it(`buildQuotaSetCommand rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(buildQuotaSetCommand({ email: payload, quota: '50M' }), payload);
    });

    it(`buildQuotaSetCommand rejects/inerts "${payload}" as the quota`, () => {
      expectRejectedOrInert(
        buildQuotaSetCommand({ email: 'ok@example.com', quota: payload }),
        payload,
      );
    });

    it(`buildQuotaDeleteCommand rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(buildQuotaDeleteCommand({ email: payload }), payload);
    });

    it(`buildConfigDkimCommand rejects/inerts "${payload}" as the selector`, () => {
      expectRejectedOrInert(buildConfigDkimCommand({ selector: payload }), payload);
    });

    it(`buildConfigDkimCommand rejects/inerts "${payload}" as a domain`, () => {
      expectRejectedOrInert(buildConfigDkimCommand({ domains: [payload] }), payload);
    });

    it(`buildFail2banBanCommand rejects/inerts "${payload}" as the IP`, () => {
      expectRejectedOrInert(buildFail2banBanCommand({ ip: payload }), payload);
    });

    it(`buildFail2banUnbanCommand rejects/inerts "${payload}" as the IP`, () => {
      expectRejectedOrInert(buildFail2banUnbanCommand({ ip: payload }), payload);
    });
  }

  it('every injection payload is actually rejected outright by this implementation (strict allowlisting), not merely inert', () => {
    // Documents the *actual* chosen behaviour (reject) on top of the
    // looser contract enforced above: this project's validators are
    // strict whitelists, so no payload in the sweep is ever accepted.
    for (const payload of INJECTION_PAYLOADS) {
      expect(buildEmailAddCommand({ email: payload, password: 'x' }).ok).toBe(false);
    }
  });
});

describe('commands — no builder ever emits sh, bash or -c', () => {
  it('scans a representative call to every builder for a shell or -c', () => {
    const results: CommandResult[] = [
      buildEmailAddCommand({ email: 'a@example.com', password: 'p' }),
      buildEmailUpdateCommand({ email: 'a@example.com', password: 'p' }),
      buildEmailDeleteCommand({ emails: ['a@example.com'], mailData: 'delete' }),
      buildEmailDeleteCommand({ emails: ['a@example.com'], mailData: 'keep' }),
      buildEmailRestrictCommand({ action: 'add', scope: 'send', email: 'a@example.com' }),
      buildEmailListCommand(),
      buildAliasAddCommand({ alias: 'a@example.com', recipient: 'b@example.com' }),
      buildAliasDeleteCommand({ alias: 'a@example.com', recipient: 'b@example.com' }),
      buildAliasListCommand(),
      buildQuotaSetCommand({ email: 'a@example.com', quota: '50M' }),
      buildQuotaDeleteCommand({ email: 'a@example.com' }),
      buildConfigDkimCommand({ keysize: 2048, selector: 'mail', domains: ['example.com'] }),
      buildFail2banListCommand(),
      buildFail2banBanCommand({ ip: '203.0.113.5' }),
      buildFail2banUnbanCommand({ ip: '203.0.113.5' }),
      buildFail2banLogCommand(),
      buildFail2banStatusCommand(),
    ];

    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.command.argv[0]).toBe('setup');
      for (const element of result.command.argv) {
        expect(element).not.toBe('sh');
        expect(element).not.toBe('bash');
        expect(element).not.toBe('-c');
        expect(element.includes('&&')).toBe(false);
        expect(element.includes('|')).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// email del: the flag must be impossible to omit.
// ---------------------------------------------------------------------------

describe('commands — setup email del always carries an explicit -y or -n', () => {
  it('is a compile-time error to omit mailData — TypeScript rejects the call', () => {
    // @ts-expect-error — mailData is required with no default; omitting it must not type-check.
    buildEmailDeleteCommand({ emails: ['user@example.com'] });
  });

  it('rejects at runtime too, if a caller bypasses the type system (e.g. unvalidated JSON input)', () => {
    const bypassed = { emails: ['user@example.com'] } as unknown as DeleteMailboxParams;
    const result = buildEmailDeleteCommand(bypassed);
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-union mailData value even past a type-system bypass', () => {
    const bypassed = {
      emails: ['user@example.com'],
      mailData: 'maybe',
    } as unknown as DeleteMailboxParams;
    const result = buildEmailDeleteCommand(bypassed);
    expect(result.ok).toBe(false);
  });

  it('"delete" produces -y', () => {
    const result = buildEmailDeleteCommand({ emails: ['user@example.com'], mailData: 'delete' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'email', 'del', '-y', 'user@example.com']);
  });

  it('"keep" produces -n', () => {
    const result = buildEmailDeleteCommand({ emails: ['user@example.com'], mailData: 'keep' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'email', 'del', '-n', 'user@example.com']);
  });

  it('supports multiple accounts in one call, per ★4', () => {
    const result = buildEmailDeleteCommand({
      emails: ['a@example.com', 'b@example.com'],
      mailData: 'delete',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.argv).toEqual([
        'setup',
        'email',
        'del',
        '-y',
        'a@example.com',
        'b@example.com',
      ]);
    }
  });

  it('rejects an empty email list', () => {
    const result = buildEmailDeleteCommand({ emails: [], mailData: 'delete' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Passwords: stdin only, never argv.
// ---------------------------------------------------------------------------

describe('commands — passwords go to stdin, never argv', () => {
  it('buildEmailAddCommand keeps the password out of argv and formats stdin as entry+confirm', () => {
    const result = buildEmailAddCommand({ email: 'user@example.com', password: 'S3cret!Pass' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.argv).toEqual(['setup', 'email', 'add', 'user@example.com']);
    expect(result.command.argv.join(' ')).not.toContain('S3cret!Pass');
    expect(result.command.stdin).toBe('S3cret!Pass\nS3cret!Pass\n');
  });

  it('buildEmailUpdateCommand keeps the password out of argv and formats stdin as entry+confirm', () => {
    const result = buildEmailUpdateCommand({ email: 'user@example.com', password: 'AnotherPass9' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.argv).toEqual(['setup', 'email', 'update', 'user@example.com']);
    expect(result.command.stdin).toBe('AnotherPass9\nAnotherPass9\n');
  });

  it('rejects an empty password', () => {
    const result = buildEmailAddCommand({ email: 'user@example.com', password: '' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy-path / shape tests per builder family.
// ---------------------------------------------------------------------------

describe('commands — email', () => {
  it('buildEmailListCommand', () => {
    const result = buildEmailListCommand();
    expect(result).toEqual({ ok: true, command: { argv: ['setup', 'email', 'list'] } });
  });

  it('buildEmailRestrictCommand — list omits the email entirely', () => {
    const result = buildEmailRestrictCommand({ action: 'list', scope: 'receive' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'email', 'restrict', 'list', 'receive']);
  });

  it('buildEmailRestrictCommand — add without an email is rejected', () => {
    const result = buildEmailRestrictCommand({ action: 'add', scope: 'send' });
    expect(result.ok).toBe(false);
  });

  it('buildEmailRestrictCommand — del with a valid email', () => {
    const result = buildEmailRestrictCommand({
      action: 'del',
      scope: 'send',
      email: 'user@example.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.argv).toEqual([
        'setup',
        'email',
        'restrict',
        'del',
        'send',
        'user@example.com',
      ]);
    }
  });
});

describe('commands — alias', () => {
  it('buildAliasAddCommand accepts a catch-all alias', () => {
    const result = buildAliasAddCommand({ alias: '@example.com', recipient: 'dump@example.com' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.argv).toEqual([
        'setup',
        'alias',
        'add',
        '@example.com',
        'dump@example.com',
      ]);
    }
  });

  it('buildAliasAddCommand rejects a catch-all as the recipient', () => {
    const result = buildAliasAddCommand({ alias: 'x@example.com', recipient: '@example.com' });
    expect(result.ok).toBe(false);
  });

  it('buildAliasDeleteCommand', () => {
    const result = buildAliasDeleteCommand({ alias: 'a@example.com', recipient: 'b@example.com' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.argv).toEqual([
        'setup',
        'alias',
        'del',
        'a@example.com',
        'b@example.com',
      ]);
    }
  });

  it('buildAliasListCommand', () => {
    expect(buildAliasListCommand()).toEqual({
      ok: true,
      command: { argv: ['setup', 'alias', 'list'] },
    });
  });

  it('a recipient may be a fully external address (forwarding is the same mechanism, FEATURE_MATRIX.md §5)', () => {
    const result = buildAliasAddCommand({ alias: 'a@example.com', recipient: 'user@gmail.com' });
    expect(result.ok).toBe(true);
  });
});

describe('commands — quota', () => {
  it('buildQuotaSetCommand with a valid quota', () => {
    const result = buildQuotaSetCommand({ email: 'user@example.com', quota: '2G' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'quota', 'set', 'user@example.com', '2G']);
  });

  it('buildQuotaSetCommand rejects a malformed quota', () => {
    expect(buildQuotaSetCommand({ email: 'user@example.com', quota: 'lots' }).ok).toBe(false);
    expect(buildQuotaSetCommand({ email: 'user@example.com', quota: '' }).ok).toBe(false);
  });

  it('buildQuotaDeleteCommand', () => {
    const result = buildQuotaDeleteCommand({ email: 'user@example.com' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'quota', 'del', 'user@example.com']);
  });
});

describe('commands — config dkim', () => {
  it('with no arguments at all', () => {
    expect(buildConfigDkimCommand()).toEqual({
      ok: true,
      command: { argv: ['setup', 'config', 'dkim'] },
    });
  });

  it('with every argument supplied', () => {
    const result = buildConfigDkimCommand({
      keysize: 4096,
      selector: 'mail2026',
      domains: ['example.com', 'example.org'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.argv).toEqual([
        'setup',
        'config',
        'dkim',
        'keysize',
        '4096',
        'selector',
        'mail2026',
        'domain',
        'example.com,example.org',
      ]);
    }
  });

  it('rejects a keysize outside 1024/2048/4096', () => {
    expect(buildConfigDkimCommand({ keysize: 512 }).ok).toBe(false);
    expect(buildConfigDkimCommand({ keysize: 3000 }).ok).toBe(false);
  });

  it('rejects an empty domains list', () => {
    expect(buildConfigDkimCommand({ domains: [] }).ok).toBe(false);
  });
});

describe('commands — fail2ban', () => {
  it('buildFail2banListCommand', () => {
    expect(buildFail2banListCommand()).toEqual({
      ok: true,
      command: { argv: ['setup', 'fail2ban'] },
    });
  });

  it('buildFail2banBanCommand accepts a valid IPv4', () => {
    const result = buildFail2banBanCommand({ ip: '203.0.113.5' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command.argv).toEqual(['setup', 'fail2ban', 'ban', '203.0.113.5']);
  });

  it('buildFail2banBanCommand accepts a valid IPv6', () => {
    const result = buildFail2banBanCommand({ ip: '2001:db8::1' });
    expect(result.ok).toBe(true);
  });

  it('buildFail2banBanCommand rejects a malformed IP', () => {
    expect(buildFail2banBanCommand({ ip: 'not-an-ip' }).ok).toBe(false);
    expect(buildFail2banBanCommand({ ip: '999.999.999.999' }).ok).toBe(false);
  });

  it('buildFail2banUnbanCommand', () => {
    const result = buildFail2banUnbanCommand({ ip: '203.0.113.5' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.command.argv).toEqual(['setup', 'fail2ban', 'unban', '203.0.113.5']);
  });

  it('buildFail2banLogCommand', () => {
    expect(buildFail2banLogCommand()).toEqual({
      ok: true,
      command: { argv: ['setup', 'fail2ban', 'log'] },
    });
  });

  it('buildFail2banStatusCommand', () => {
    expect(buildFail2banStatusCommand()).toEqual({
      ok: true,
      command: { argv: ['setup', 'fail2ban', 'status'] },
    });
  });
});

describe('commands — unicode addresses are accepted on the write path too', () => {
  it('buildEmailAddCommand accepts a unicode local part and domain', () => {
    const result = buildEmailAddCommand({ email: '用户@例え.jp', password: 'hunter2pass' });
    expect(result.ok).toBe(true);
  });
});
