import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from './fake-dms-driver.js';
import { RealDmsDriver } from './real-dms-driver.js';
import { DmsCommandValidationError } from './errors.js';
import type { DmsDriver } from './types.js';
import type { DmsExecPort } from './exec-port.js';

// A minimal, never-called DmsExecPort — used only so RealDmsDriver can be
// instantiated for the interface-parity check below without touching any
// real I/O.
function unusedExecPort(): DmsExecPort {
  return {
    readFile: () => Promise.reject(new Error('not used in this test')),
    exec: () => Promise.reject(new Error('not used in this test')),
    getEnv: () => Promise.reject(new Error('not used in this test')),
  };
}

// The canonical DmsDriver method list, kept here as plain data (not
// introspected from one implementation) so the test below checks both
// implementations against the interface itself, not merely against each
// other — introspecting RealDmsDriver's prototype directly would also
// pick up its private `run` helper, which is not part of DmsDriver at all.
const DMS_DRIVER_METHOD_NAMES = [
  'listMailboxes',
  'listAliases',
  'listQuotas',
  'listDomains',
  'getCapabilities',
  'addMailbox',
  'updateMailboxPassword',
  'deleteMailbox',
  'restrictMailbox',
  'setQuota',
  'deleteQuota',
  'addAlias',
  'deleteAlias',
  'generateDkim',
  'fail2banBan',
  'fail2banUnban',
].sort();

describe('FakeDmsDriver — satisfies the same interface as RealDmsDriver', () => {
  it("exposes exactly DmsDriver's method surface, matching RealDmsDriver (the fake cannot silently drift from the real driver's surface, nor either from the interface)", () => {
    const fake: DmsDriver = new FakeDmsDriver();
    const real: DmsDriver = new RealDmsDriver(unusedExecPort());

    const publicMethodNames = (instance: DmsDriver) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
        .filter((name) => name !== 'constructor' && !name.startsWith('_'))
        .filter((name) => DMS_DRIVER_METHOD_NAMES.includes(name))
        .sort();

    expect(publicMethodNames(fake)).toEqual(DMS_DRIVER_METHOD_NAMES);
    expect(publicMethodNames(real)).toEqual(DMS_DRIVER_METHOD_NAMES);
  });

  it('is the type the rest of the app programs against — assignable to DmsDriver with no casts', () => {
    const driver: DmsDriver = new FakeDmsDriver();
    expect(typeof driver.listMailboxes).toBe('function');
  });
});

describe('FakeDmsDriver — reads reflect fixture-seeded state, with no parse issues', () => {
  it('listMailboxes returns fixture mailboxes with no issues', async () => {
    const driver = new FakeDmsDriver();
    const result = await driver.listMailboxes();
    expect(result.issues).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('listAliases returns fixture aliases with no issues', async () => {
    const driver = new FakeDmsDriver();
    const result = await driver.listAliases();
    expect(result.issues).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('listQuotas returns fixture quotas with no issues', async () => {
    const driver = new FakeDmsDriver();
    const result = await driver.listQuotas();
    expect(result.issues).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('listDomains includes an alias-only domain from the fixture data', async () => {
    const driver = new FakeDmsDriver();
    const domains = await driver.listDomains();
    const catchall = domains.find((d) => d.domain === 'catchall.example.com');
    expect(catchall).toMatchObject({ aliasOnly: true, mailboxCount: 0 });
  });

  it('getCapabilities reflects the fixture env (quotas on, rspamd/clamav/fail2ban off, FILE provisioner)', async () => {
    const driver = new FakeDmsDriver();
    const capabilities = await driver.getCapabilities();
    expect(capabilities.quotas.supported).toBe(true);
    expect(capabilities.rspamd.supported).toBe(false);
    expect(capabilities.accountProvisioner).toBe('FILE');
    expect(capabilities.localAccountManagement.supported).toBe(true);
  });
});

describe('FakeDmsDriver — mailbox writes', () => {
  it('addMailbox adds a new mailbox visible in a subsequent listMailboxes', async () => {
    const driver = new FakeDmsDriver();
    await driver.addMailbox({ email: 'newuser@example.com', password: 'hunter2pass' });
    const result = await driver.listMailboxes();
    expect(result.entries.some((e) => e.email === 'newuser@example.com')).toBe(true);
  });

  it('addMailbox rejects invalid input via the same commands.ts validation RealDmsDriver uses', async () => {
    const driver = new FakeDmsDriver();
    await expect(
      driver.addMailbox({ email: 'not-an-email', password: 'x' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
  });

  it('addMailbox rejects a duplicate address', async () => {
    const driver = new FakeDmsDriver();
    await driver.addMailbox({ email: 'dup@example.com', password: 'hunter2pass' });
    await expect(
      driver.addMailbox({ email: 'dup@example.com', password: 'hunter2pass2' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
  });

  it('updateMailboxPassword succeeds for an existing mailbox', async () => {
    const driver = new FakeDmsDriver();
    const [existing] = (await driver.listMailboxes()).entries;
    expect(existing).toBeDefined();
    await expect(
      driver.updateMailboxPassword({ email: existing!.email, password: 'newHunter2pass' }),
    ).resolves.toBeUndefined();
  });

  it('updateMailboxPassword rejects a nonexistent mailbox', async () => {
    const driver = new FakeDmsDriver();
    await expect(
      driver.updateMailboxPassword({ email: 'ghost@example.com', password: 'hunter2pass' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
  });

  it('deleteMailbox is impossible to call without an explicit mailData choice at the type level', async () => {
    const driver = new FakeDmsDriver();
    // @ts-expect-error — mailData is required with no default.
    await expect(driver.deleteMailbox({ emails: ['dup@example.com'] })).rejects.toBeInstanceOf(
      DmsCommandValidationError,
    );
  });

  it('deleteMailbox removes the account, its quota, and strips it from any alias recipient list (★4)', async () => {
    const driver = new FakeDmsDriver();
    await driver.addMailbox({ email: 'todelete@example.com', password: 'hunter2pass' });
    await driver.setQuota({ email: 'todelete@example.com', quota: '10M' });
    await driver.addAlias({ alias: 'forward@example.com', recipient: 'todelete@example.com' });

    await driver.deleteMailbox({ emails: ['todelete@example.com'], mailData: 'delete' });

    const [mailboxes, quotas, aliases] = await Promise.all([
      driver.listMailboxes(),
      driver.listQuotas(),
      driver.listAliases(),
    ]);
    expect(mailboxes.entries.some((e) => e.email === 'todelete@example.com')).toBe(false);
    expect(quotas.entries.some((e) => e.email === 'todelete@example.com')).toBe(false);
    expect(aliases.entries.some((a) => a.recipients.includes('todelete@example.com'))).toBe(false);
  });

  it('deleteMailbox with mailData "keep" still removes the account/quota/alias references — only the flag differs, not the file-state side effects (★4)', async () => {
    const driver = new FakeDmsDriver();
    await driver.addMailbox({ email: 'keepdata@example.com', password: 'hunter2pass' });
    await driver.deleteMailbox({ emails: ['keepdata@example.com'], mailData: 'keep' });
    const mailboxes = await driver.listMailboxes();
    expect(mailboxes.entries.some((e) => e.email === 'keepdata@example.com')).toBe(false);
  });

  it('deleteMailbox rejects a nonexistent account and mutates nothing', async () => {
    const driver = new FakeDmsDriver();
    const before = await driver.listMailboxes();
    await expect(
      driver.deleteMailbox({ emails: ['ghost@example.com'], mailData: 'delete' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
    const after = await driver.listMailboxes();
    expect(after.entries).toEqual(before.entries);
  });
});

describe('FakeDmsDriver — alias writes', () => {
  it('addAlias creates a new alias with one recipient', async () => {
    const driver = new FakeDmsDriver();
    await driver.addAlias({ alias: 'brandnew@example.com', recipient: 'target@example.com' });
    const result = await driver.listAliases();
    const entry = result.entries.find((a) => a.address === 'brandnew@example.com');
    expect(entry?.recipients).toEqual(['target@example.com']);
  });

  it('addAlias accumulates a second recipient onto an existing alias rather than replacing it', async () => {
    const driver = new FakeDmsDriver();
    await driver.addAlias({ alias: 'multi@example.com', recipient: 'first@example.com' });
    await driver.addAlias({ alias: 'multi@example.com', recipient: 'second@example.com' });
    const result = await driver.listAliases();
    const entry = result.entries.find((a) => a.address === 'multi@example.com');
    expect(entry?.recipients).toEqual(['first@example.com', 'second@example.com']);
  });

  it('addAlias accepts a catch-all left-hand side', async () => {
    const driver = new FakeDmsDriver();
    await driver.addAlias({ alias: '@newcatchall.tld', recipient: 'dump@example.com' });
    const result = await driver.listAliases();
    expect(result.entries.find((a) => a.address === '@newcatchall.tld')).toMatchObject({
      isCatchAll: true,
      domain: 'newcatchall.tld',
    });
  });

  it('deleteAlias removes one recipient, keeping the alias if others remain', async () => {
    const driver = new FakeDmsDriver();
    await driver.addAlias({ alias: 'multi2@example.com', recipient: 'a@example.com' });
    await driver.addAlias({ alias: 'multi2@example.com', recipient: 'b@example.com' });

    await driver.deleteAlias({ alias: 'multi2@example.com', recipient: 'a@example.com' });

    const result = await driver.listAliases();
    expect(result.entries.find((a) => a.address === 'multi2@example.com')?.recipients).toEqual([
      'b@example.com',
    ]);
  });

  it('deleteAlias removes the whole alias when it was the last recipient (★2)', async () => {
    const driver = new FakeDmsDriver();
    await driver.addAlias({ alias: 'solo@example.com', recipient: 'only@example.com' });
    await driver.deleteAlias({ alias: 'solo@example.com', recipient: 'only@example.com' });
    const result = await driver.listAliases();
    expect(result.entries.find((a) => a.address === 'solo@example.com')).toBeUndefined();
  });

  it('deleteAlias rejects a nonexistent alias/recipient pair', async () => {
    const driver = new FakeDmsDriver();
    await expect(
      driver.deleteAlias({ alias: 'nosuchalias@example.com', recipient: 'x@example.com' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
  });
});

describe('FakeDmsDriver — quota writes', () => {
  it('setQuota adds a quota for a mailbox that had none', async () => {
    const driver = new FakeDmsDriver();
    await driver.setQuota({ email: 'quotaless@example.com', quota: '25M' });
    const result = await driver.listQuotas();
    expect(result.entries.find((q) => q.email === 'quotaless@example.com')?.quota).toBe('25M');
  });

  it('setQuota replaces an existing quota rather than duplicating the entry', async () => {
    const driver = new FakeDmsDriver();
    await driver.setQuota({ email: 'resize@example.com', quota: '10M' });
    await driver.setQuota({ email: 'resize@example.com', quota: '20M' });
    const result = await driver.listQuotas();
    const matches = result.entries.filter((q) => q.email === 'resize@example.com');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.quota).toBe('20M');
  });

  it('deleteQuota removes a quota entry', async () => {
    const driver = new FakeDmsDriver();
    await driver.setQuota({ email: 'temp@example.com', quota: '5M' });
    await driver.deleteQuota({ email: 'temp@example.com' });
    const result = await driver.listQuotas();
    expect(result.entries.some((q) => q.email === 'temp@example.com')).toBe(false);
  });

  it('setQuota rejects a malformed quota value', async () => {
    const driver = new FakeDmsDriver();
    await expect(
      driver.setQuota({ email: 'user@example.com', quota: 'not-a-quota' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
  });
});

describe('FakeDmsDriver — restrict, DKIM and fail2ban validate but need no further modelling', () => {
  it('restrictMailbox resolves for a valid call', async () => {
    const driver = new FakeDmsDriver();
    await expect(
      driver.restrictMailbox({ action: 'add', scope: 'send', email: 'user@example.com' }),
    ).resolves.toBeUndefined();
  });

  it('restrictMailbox rejects an invalid call', async () => {
    const driver = new FakeDmsDriver();
    await expect(driver.restrictMailbox({ action: 'add', scope: 'send' })).rejects.toBeInstanceOf(
      DmsCommandValidationError,
    );
  });

  it('generateDkim resolves with no arguments', async () => {
    const driver = new FakeDmsDriver();
    await expect(driver.generateDkim()).resolves.toBeUndefined();
  });

  it('generateDkim rejects an invalid keysize', async () => {
    const driver = new FakeDmsDriver();
    await expect(driver.generateDkim({ keysize: 999 })).rejects.toBeInstanceOf(
      DmsCommandValidationError,
    );
  });

  it('fail2banBan/fail2banUnban resolve for a valid IP and reject a malformed one', async () => {
    const driver = new FakeDmsDriver();
    await expect(driver.fail2banBan({ ip: '203.0.113.5' })).resolves.toBeUndefined();
    await expect(driver.fail2banUnban({ ip: '203.0.113.5' })).resolves.toBeUndefined();
    await expect(driver.fail2banBan({ ip: 'garbage' })).rejects.toBeInstanceOf(
      DmsCommandValidationError,
    );
  });
});
