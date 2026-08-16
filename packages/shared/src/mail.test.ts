import { describe, expect, it } from 'vitest';
import {
  AliasSummarySchema,
  BulkQuotaMailboxRequestSchema,
  BulkRestrictMailboxRequestSchema,
  CreateMailboxRequestSchema,
  DeleteMailboxRequestSchema,
  DomainSummarySchema,
  MailCapabilitiesResponseSchema,
  MailDataChoiceSchema,
  MailboxSummarySchema,
  QuotaReportEntrySchema,
  QuotaValueSchema,
  RestrictMailboxRequestSchema,
} from './mail.js';

describe('DomainSummarySchema', () => {
  it('accepts a well-formed derived domain, including an alias-only one', () => {
    const result = DomainSummarySchema.safeParse({
      domain: 'example.com',
      mailboxCount: 0,
      aliasCount: 2,
      aliasOnly: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative count', () => {
    const result = DomainSummarySchema.safeParse({
      domain: 'example.com',
      mailboxCount: -1,
      aliasCount: 0,
      aliasOnly: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('MailDataChoiceSchema / DeleteMailboxRequestSchema — no default (FEATURE_MATRIX.md §3)', () => {
  it('accepts exactly "delete" and "keep"', () => {
    expect(MailDataChoiceSchema.safeParse('delete').success).toBe(true);
    expect(MailDataChoiceSchema.safeParse('keep').success).toBe(true);
  });

  it('rejects anything else, including an empty value', () => {
    expect(MailDataChoiceSchema.safeParse('purge').success).toBe(false);
    expect(MailDataChoiceSchema.safeParse('').success).toBe(false);
    expect(MailDataChoiceSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects a delete request with mailData omitted — the choice can never be defaulted', () => {
    expect(DeleteMailboxRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('QuotaValueSchema', () => {
  it('accepts digits with an optional single unit letter', () => {
    for (const value of ['50M', '2G', '1024', '10k', '5T']) {
      expect(QuotaValueSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects a shell-metacharacter payload', () => {
    for (const value of ['; rm -rf /', '$(id)', '10M; rm', '-10M', '']) {
      expect(QuotaValueSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('RestrictMailboxRequestSchema', () => {
  it('requires an explicit boolean, not an implied toggle', () => {
    const missingFlag = RestrictMailboxRequestSchema.safeParse({ scope: 'send' });
    expect(missingFlag.success).toBe(false);
  });

  it('accepts a well-formed restrict-on and restrict-off request', () => {
    expect(
      RestrictMailboxRequestSchema.safeParse({ scope: 'send', restricted: true }).success,
    ).toBe(true);
    expect(
      RestrictMailboxRequestSchema.safeParse({ scope: 'receive', restricted: false }).success,
    ).toBe(true);
  });

  it('rejects a scope outside send/receive', () => {
    expect(
      RestrictMailboxRequestSchema.safeParse({ scope: 'login', restricted: true }).success,
    ).toBe(false);
  });
});

describe('bulk mailbox requests — restrict and quota only, never delete', () => {
  it('BulkRestrictMailboxRequestSchema requires at least one address', () => {
    const result = BulkRestrictMailboxRequestSchema.safeParse({
      addresses: [],
      scope: 'send',
      restricted: true,
    });
    expect(result.success).toBe(false);
  });

  it('BulkQuotaMailboxRequestSchema accepts a null quota to clear it in bulk', () => {
    const result = BulkQuotaMailboxRequestSchema.safeParse({
      addresses: ['a@example.com', 'b@example.com'],
      quota: null,
    });
    expect(result.success).toBe(true);
  });

  it('BulkQuotaMailboxRequestSchema rejects an invalid quota value', () => {
    const result = BulkQuotaMailboxRequestSchema.safeParse({
      addresses: ['a@example.com'],
      quota: 'unlimited',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateMailboxRequestSchema', () => {
  it('enforces the new-password policy, not the login/submitted one', () => {
    const result = CreateMailboxRequestSchema.safeParse({
      email: 'new@example.com',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });
});

describe('MailboxSummarySchema', () => {
  it('models restriction as two independent booleans, never a single "disabled" flag', () => {
    const result = MailboxSummarySchema.safeParse({
      email: 'user@example.com',
      localPart: 'user',
      domain: 'example.com',
      quota: '2G',
      restricted: { send: true, receive: false },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null quota for an unlimited mailbox', () => {
    const result = MailboxSummarySchema.safeParse({
      email: 'user@example.com',
      localPart: 'user',
      domain: 'example.com',
      quota: null,
      restricted: { send: false, receive: false },
    });
    expect(result.success).toBe(true);
  });
});

describe('response schemas tolerate an already-on-disk address a strict .email() would reject', () => {
  // dovecot-quotas.cf's own shipped upstream example line is literally
  // "user@domain:50M" — no TLD (FEATURE_MATRIX.md §7's fixture
  // provenance note). A response schema that cannot round-trip data DMS
  // itself already wrote would make reading real, existing config a
  // crash instead of a display — the read path must stay as permissive
  // as parsers/shared.ts already is, all the way out to the wire.
  const legacyShapedAddress = 'user@domain';

  it('MailboxSummarySchema accepts it', () => {
    const result = MailboxSummarySchema.safeParse({
      email: legacyShapedAddress,
      localPart: 'user',
      domain: 'domain',
      quota: null,
      restricted: { send: false, receive: false },
    });
    expect(result.success).toBe(true);
  });

  it('QuotaReportEntrySchema accepts it', () => {
    const result = QuotaReportEntrySchema.safeParse({
      email: legacyShapedAddress,
      domain: 'domain',
      quota: '50M',
      usage: null,
      percentUsed: null,
    });
    expect(result.success).toBe(true);
  });

  it('but CreateMailboxRequestSchema still refuses it as *new* input', () => {
    // The asymmetry is deliberate: refusing to create a new account with
    // this address is a reasonable guardrail; refusing to *display* an
    // account that already has it is a bug (this is the exact crash this
    // pair of tests exists to guard against — see mail.ts's comment on
    // MailboxSummarySchema.email).
    const result = CreateMailboxRequestSchema.safeParse({
      email: legacyShapedAddress,
      password: 'a-perfectly-good-password-123',
    });
    expect(result.success).toBe(false);
  });
});

describe('AliasSummarySchema — one mechanism for aliases and forwarding', () => {
  it('accepts internal, external and mixed types', () => {
    for (const type of ['internal', 'external', 'mixed'] as const) {
      const result = AliasSummarySchema.safeParse({
        id: 'opaque-id',
        address: 'sales@example.com',
        isCatchAll: false,
        domain: 'example.com',
        recipients: ['a@example.com'],
        type,
      });
      expect(result.success, type).toBe(true);
    }
  });

  it('rejects an alias with zero recipients', () => {
    const result = AliasSummarySchema.safeParse({
      id: 'opaque-id',
      address: 'sales@example.com',
      isCatchAll: false,
      domain: 'example.com',
      recipients: [],
      type: 'internal',
    });
    expect(result.success).toBe(false);
  });
});

describe('MailCapabilitiesResponseSchema', () => {
  it('round-trips a fully-supported capability document', () => {
    const doc = {
      quotas: { supported: true, reason: null },
      rspamd: { supported: false, reason: 'ENABLE_RSPAMD is not set on this deployment.' },
      clamav: { supported: false, reason: 'ENABLE_CLAMAV is not set on this deployment.' },
      fail2ban: { supported: false, reason: 'ENABLE_FAIL2BAN is not set on this deployment.' },
      accountProvisioner: 'FILE',
      localAccountManagement: { supported: true, reason: null },
    };
    expect(MailCapabilitiesResponseSchema.safeParse(doc).success).toBe(true);
  });
});
