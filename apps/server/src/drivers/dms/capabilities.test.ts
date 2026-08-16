import { describe, expect, it } from 'vitest';
import { detectCapabilities } from './capabilities.js';

describe('detectCapabilities — shipped defaults when env is empty (docs/research/01-docker-mailserver.md §9)', () => {
  it('quotas default ON (ENABLE_QUOTAS ships =1)', () => {
    expect(detectCapabilities({}).quotas).toEqual({ supported: true, reason: null });
  });

  it('rspamd defaults OFF (ENABLE_RSPAMD ships =0)', () => {
    const result = detectCapabilities({});
    expect(result.rspamd.supported).toBe(false);
    expect(result.rspamd.reason).toEqual(expect.any(String));
  });

  it('clamav defaults OFF (ENABLE_CLAMAV ships =0)', () => {
    expect(detectCapabilities({}).clamav.supported).toBe(false);
  });

  it('fail2ban defaults OFF (ENABLE_FAIL2BAN ships =0)', () => {
    expect(detectCapabilities({}).fail2ban.supported).toBe(false);
  });

  it('account provisioner defaults to FILE when ACCOUNT_PROVISIONER is unset', () => {
    expect(detectCapabilities({}).accountProvisioner).toBe('FILE');
  });

  it('local account management is supported when provisioner is FILE', () => {
    expect(detectCapabilities({}).localAccountManagement).toEqual({
      supported: true,
      reason: null,
    });
  });
});

describe('detectCapabilities — explicit values override defaults', () => {
  it('ENABLE_QUOTAS=0 disables quotas', () => {
    expect(detectCapabilities({ ENABLE_QUOTAS: '0' }).quotas.supported).toBe(false);
  });

  it('ENABLE_QUOTAS=false (word form) disables quotas', () => {
    expect(detectCapabilities({ ENABLE_QUOTAS: 'false' }).quotas.supported).toBe(false);
  });

  it('ENABLE_RSPAMD=1 enables rspamd', () => {
    expect(detectCapabilities({ ENABLE_RSPAMD: '1' }).rspamd).toEqual({
      supported: true,
      reason: null,
    });
  });

  it('ENABLE_CLAMAV=true (word form) enables clamav', () => {
    expect(detectCapabilities({ ENABLE_CLAMAV: 'true' }).clamav.supported).toBe(true);
  });

  it('ENABLE_FAIL2BAN=1 enables fail2ban', () => {
    expect(detectCapabilities({ ENABLE_FAIL2BAN: '1' }).fail2ban.supported).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(detectCapabilities({ ENABLE_RSPAMD: '  TRUE  ' }).rspamd.supported).toBe(true);
  });

  it('an unrecognised flag value falls back to the documented default rather than guessing', () => {
    expect(detectCapabilities({ ENABLE_RSPAMD: 'yes-please' }).rspamd.supported).toBe(false);
  });
});

describe('detectCapabilities — LDAP disables local account management (an explicit acceptance criterion)', () => {
  it('reports LDAP as the provisioner', () => {
    expect(detectCapabilities({ ACCOUNT_PROVISIONER: 'LDAP' }).accountProvisioner).toBe('LDAP');
  });

  it('marks local account management unsupported under LDAP, with a reason', () => {
    const result = detectCapabilities({ ACCOUNT_PROVISIONER: 'LDAP' });
    expect(result.localAccountManagement.supported).toBe(false);
    expect(result.localAccountManagement.reason).toContain('LDAP');
  });

  it('is case-insensitive on the provisioner value', () => {
    expect(detectCapabilities({ ACCOUNT_PROVISIONER: 'ldap' }).accountProvisioner).toBe('LDAP');
  });

  it('OIDC is also non-FILE and also disables local account management', () => {
    const result = detectCapabilities({ ACCOUNT_PROVISIONER: 'OIDC' });
    expect(result.accountProvisioner).toBe('OIDC');
    expect(result.localAccountManagement.supported).toBe(false);
  });

  it('an unrecognised provisioner value is reported as UNKNOWN, never guessed as FILE', () => {
    const result = detectCapabilities({ ACCOUNT_PROVISIONER: 'something-else' });
    expect(result.accountProvisioner).toBe('UNKNOWN');
    expect(result.localAccountManagement.supported).toBe(false);
  });
});

describe('detectCapabilities — every unsupported status carries a non-empty reason; every supported one carries null', () => {
  it('holds for a fully-disabled deployment', () => {
    const result = detectCapabilities({
      ENABLE_QUOTAS: '0',
      ENABLE_RSPAMD: '0',
      ENABLE_CLAMAV: '0',
      ENABLE_FAIL2BAN: '0',
      ACCOUNT_PROVISIONER: 'LDAP',
    });
    for (const status of [
      result.quotas,
      result.rspamd,
      result.clamav,
      result.fail2ban,
      result.localAccountManagement,
    ]) {
      expect(status.supported).toBe(false);
      expect(typeof status.reason).toBe('string');
      expect((status.reason as string).length).toBeGreaterThan(0);
    }
  });

  it('holds for a fully-enabled deployment', () => {
    const result = detectCapabilities({
      ENABLE_QUOTAS: '1',
      ENABLE_RSPAMD: '1',
      ENABLE_CLAMAV: '1',
      ENABLE_FAIL2BAN: '1',
      ACCOUNT_PROVISIONER: 'FILE',
    });
    for (const status of [
      result.quotas,
      result.rspamd,
      result.clamav,
      result.fail2ban,
      result.localAccountManagement,
    ]) {
      expect(status).toEqual({ supported: true, reason: null });
    }
  });
});
