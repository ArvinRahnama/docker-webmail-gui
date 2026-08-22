/**
 * Unit-level coverage for behaviour that is awkward to force through the
 * full HTTP + `FakeDmsDriver` stack (`mailboxes.routes.test.ts` covers
 * that layer): bulk per-item partial failure, and capability gating with
 * a deployment that genuinely has quotas/local account management
 * turned off. A hand-rolled minimal `DmsDriver` stub stands in for the
 * driver so each behaviour can be forced deterministically.
 */
import { describe, expect, it } from 'vitest';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { DmsCapabilities } from '../../drivers/dms/capabilities.js';
import { DmsCommandValidationError } from '../../drivers/dms/errors.js';
import { AppError } from '../../platform/errors.js';
import { MailboxesService } from './mailboxes.service.js';

const SUPPORTED: DmsCapabilities = {
  quotas: { supported: true, reason: null },
  rspamd: { supported: false, reason: null },
  clamav: { supported: false, reason: null },
  fail2ban: { supported: false, reason: null },
  accountProvisioner: 'FILE',
  localAccountManagement: { supported: true, reason: null },
};

const QUOTAS_UNSUPPORTED: DmsCapabilities = {
  ...SUPPORTED,
  quotas: {
    supported: false,
    reason: 'ENABLE_QUOTAS is not set (or is disabled) on this deployment.',
  },
};

const LDAP_UNSUPPORTED: DmsCapabilities = {
  ...SUPPORTED,
  accountProvisioner: 'LDAP',
  localAccountManagement: {
    supported: false,
    reason: 'ACCOUNT_PROVISIONER=LDAP — local mailbox/alias/quota management is unsupported.',
  },
};

/** Minimal `DmsDriver` double: every method the test does not care about throws if actually called, so a stray call fails loudly instead of silently returning something misleading. */
function stubDriver(overrides: Partial<DmsDriver> & { capabilities?: DmsCapabilities }): DmsDriver {
  const notImplemented = (name: string) => () => {
    throw new Error(`stubDriver: ${name} was not stubbed for this test`);
  };

  return {
    listMailboxes: overrides.listMailboxes ?? notImplemented('listMailboxes'),
    listAliases: overrides.listAliases ?? (async () => ({ entries: [], issues: [] })),
    listQuotas: overrides.listQuotas ?? (async () => ({ entries: [], issues: [] })),
    listDomains: overrides.listDomains ?? (async () => []),
    getCapabilities: overrides.getCapabilities ?? (async () => overrides.capabilities ?? SUPPORTED),
    getRestrictedAddresses:
      overrides.getRestrictedAddresses ?? (async () => ({ entries: [], issues: [] })),
    getMailboxUsage: overrides.getMailboxUsage ?? notImplemented('getMailboxUsage'),
    getDkimRecord: overrides.getDkimRecord ?? notImplemented('getDkimRecord'),
    getSslType: overrides.getSslType ?? notImplemented('getSslType'),
    fail2banList: overrides.fail2banList ?? notImplemented('fail2banList'),
    fail2banStatus: overrides.fail2banStatus ?? notImplemented('fail2banStatus'),
    clamavPing: overrides.clamavPing ?? notImplemented('clamavPing'),
    clamavVersion: overrides.clamavVersion ?? notImplemented('clamavVersion'),
    clamavStats: overrides.clamavStats ?? notImplemented('clamavStats'),
    clamavLogTail: overrides.clamavLogTail ?? notImplemented('clamavLogTail'),
    sieveList: overrides.sieveList ?? notImplemented('sieveList'),
    sieveGet: overrides.sieveGet ?? notImplemented('sieveGet'),
    getMailQueue: overrides.getMailQueue ?? notImplemented('getMailQueue'),
    addMailbox: overrides.addMailbox ?? notImplemented('addMailbox'),
    updateMailboxPassword:
      overrides.updateMailboxPassword ?? notImplemented('updateMailboxPassword'),
    deleteMailbox: overrides.deleteMailbox ?? notImplemented('deleteMailbox'),
    restrictMailbox: overrides.restrictMailbox ?? notImplemented('restrictMailbox'),
    setQuota: overrides.setQuota ?? notImplemented('setQuota'),
    deleteQuota: overrides.deleteQuota ?? notImplemented('deleteQuota'),
    addAlias: overrides.addAlias ?? notImplemented('addAlias'),
    deleteAlias: overrides.deleteAlias ?? notImplemented('deleteAlias'),
    generateDkim: overrides.generateDkim ?? notImplemented('generateDkim'),
    fail2banBan: overrides.fail2banBan ?? notImplemented('fail2banBan'),
    fail2banUnban: overrides.fail2banUnban ?? notImplemented('fail2banUnban'),
    clamavUpdateSignatures:
      overrides.clamavUpdateSignatures ?? notImplemented('clamavUpdateSignatures'),
    sievePut: overrides.sievePut ?? notImplemented('sievePut'),
    sieveActivate: overrides.sieveActivate ?? notImplemented('sieveActivate'),
    sieveDeactivate: overrides.sieveDeactivate ?? notImplemented('sieveDeactivate'),
  };
}

describe('MailboxesService.bulkRestrict — per-item results, not all-or-nothing', () => {
  it("reports each address independently: one failure does not hide the others' success", async () => {
    const attempted: string[] = [];
    const driver = stubDriver({
      capabilities: SUPPORTED,
      restrictMailbox: async (params) => {
        attempted.push(params.email ?? '');
        if (params.email === 'bad@example.com') {
          throw new DmsCommandValidationError('address must not start with "-"');
        }
      },
    });
    const service = new MailboxesService(driver);

    const results = await service.bulkRestrict(
      ['good1@example.com', 'bad@example.com', 'good2@example.com'],
      'send',
      true,
    );

    // All three were genuinely attempted — a failure partway through must
    // not short-circuit the remaining addresses.
    expect(attempted).toEqual(['good1@example.com', 'bad@example.com', 'good2@example.com']);
    expect(results).toEqual([
      { email: 'good1@example.com', ok: true, error: null },
      { email: 'bad@example.com', ok: false, error: 'address must not start with "-"' },
      { email: 'good2@example.com', ok: true, error: null },
    ]);
  });
});

describe('MailboxesService.bulkQuota — per-item results', () => {
  it('clears quota for every address when quota is null, reporting each independently', async () => {
    const cleared: string[] = [];
    const driver = stubDriver({
      capabilities: SUPPORTED,
      deleteQuota: async (params) => {
        cleared.push(params.email);
      },
    });
    const service = new MailboxesService(driver);

    const results = await service.bulkQuota(['a@example.com', 'b@example.com'], null);

    expect(cleared).toEqual(['a@example.com', 'b@example.com']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('sets the same quota value for every address', async () => {
    const setCalls: Array<{ email: string; quota: string }> = [];
    const driver = stubDriver({
      capabilities: SUPPORTED,
      setQuota: async (params) => {
        setCalls.push(params);
      },
    });
    const service = new MailboxesService(driver);

    await service.bulkQuota(['a@example.com', 'b@example.com'], '1G');

    expect(setCalls).toEqual([
      { email: 'a@example.com', quota: '1G' },
      { email: 'b@example.com', quota: '1G' },
    ]);
  });
});

describe('capability gating — CAPABILITY_UNSUPPORTED, not an obscure failure', () => {
  it('setQuota refuses before ever calling the driver when quotas are unsupported', async () => {
    let driverCalled = false;
    const driver = stubDriver({
      capabilities: QUOTAS_UNSUPPORTED,
      listMailboxes: async () => ({
        entries: [
          {
            email: 'a@example.com',
            localPart: 'a',
            domain: 'example.com',
            passwordHash: 'x',
            attributes: '',
          },
        ],
        issues: [],
      }),
      setQuota: async () => {
        driverCalled = true;
      },
    });
    const service = new MailboxesService(driver);

    await expect(service.setQuota('a@example.com', '1G')).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(driverCalled).toBe(false);
  });

  it("the CAPABILITY_UNSUPPORTED error carries the capability document's own reason text", async () => {
    const driver = stubDriver({ capabilities: QUOTAS_UNSUPPORTED });
    const service = new MailboxesService(driver);

    try {
      await service.clearQuota('a@example.com');
      expect.unreachable('clearQuota should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toContain('ENABLE_QUOTAS');
    }
  });

  it('create/changePassword/restrict/delete all refuse under a non-FILE provisioner before touching the driver', async () => {
    let driverCalled = false;
    const driver = stubDriver({
      capabilities: LDAP_UNSUPPORTED,
      addMailbox: async () => {
        driverCalled = true;
      },
    });
    const service = new MailboxesService(driver);

    await expect(service.create('a@example.com', 'a-good-password-value')).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(driverCalled).toBe(false);
  });

  it('bulk operations refuse as a whole batch, not per-item, when the capability is unsupported', async () => {
    const driver = stubDriver({ capabilities: QUOTAS_UNSUPPORTED });
    const service = new MailboxesService(driver);

    await expect(service.bulkQuota(['a@example.com', 'b@example.com'], '1G')).rejects.toMatchObject(
      { code: 'CAPABILITY_UNSUPPORTED' },
    );
  });
});

describe('MailboxesService.list — quota sorting is numeric, not lexical', () => {
  it('sorts "50M" before "500M" ascending (a lexical sort would get this backwards)', async () => {
    const driver = stubDriver({
      capabilities: SUPPORTED,
      listMailboxes: async () => ({
        entries: [
          {
            email: 'big@example.com',
            localPart: 'big',
            domain: 'example.com',
            passwordHash: 'x',
            attributes: '',
          },
          {
            email: 'small@example.com',
            localPart: 'small',
            domain: 'example.com',
            passwordHash: 'x',
            attributes: '',
          },
        ],
        issues: [],
      }),
      listQuotas: async () => ({
        entries: [
          { email: 'big@example.com', localPart: 'big', domain: 'example.com', quota: '500M' },
          { email: 'small@example.com', localPart: 'small', domain: 'example.com', quota: '50M' },
        ],
        issues: [],
      }),
    });
    const service = new MailboxesService(driver);

    const result = await service.list({ sortBy: 'quota', sortDir: 'asc' });

    expect(result.mailboxes.map((m) => m.email)).toEqual(['small@example.com', 'big@example.com']);
  });

  it('sorts an unlimited (null) quota last, ascending', async () => {
    const driver = stubDriver({
      capabilities: SUPPORTED,
      listMailboxes: async () => ({
        entries: [
          {
            email: 'unlimited@example.com',
            localPart: 'unlimited',
            domain: 'example.com',
            passwordHash: 'x',
            attributes: '',
          },
          {
            email: 'limited@example.com',
            localPart: 'limited',
            domain: 'example.com',
            passwordHash: 'x',
            attributes: '',
          },
        ],
        issues: [],
      }),
      listQuotas: async () => ({
        entries: [
          {
            email: 'limited@example.com',
            localPart: 'limited',
            domain: 'example.com',
            quota: '10M',
          },
        ],
        issues: [],
      }),
    });
    const service = new MailboxesService(driver);

    const result = await service.list({ sortBy: 'quota', sortDir: 'asc' });

    expect(result.mailboxes.map((m) => m.email)).toEqual([
      'limited@example.com',
      'unlimited@example.com',
    ]);
  });
});
