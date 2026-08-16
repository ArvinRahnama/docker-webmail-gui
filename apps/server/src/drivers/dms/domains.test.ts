import { describe, expect, it } from 'vitest';
import { deriveDomains } from './domains.js';
import { parsePostfixAccounts } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual } from './parsers/postfix-virtual.js';

function accounts(content: string) {
  return parsePostfixAccounts(content).entries;
}
function aliases(content: string) {
  return parsePostfixVirtual(content).entries;
}

describe('deriveDomains — no domain CRUD exists (FEATURE_MATRIX.md §2)', () => {
  it('exposes no create/delete/enable function — deriveDomains is the entire module surface for this concern', async () => {
    const domainsModule: Record<string, unknown> = await import('./domains.js');
    const exportedNames = Object.keys(domainsModule);
    expect(exportedNames).toEqual(['deriveDomains']);
    for (const name of exportedNames) {
      expect(name).not.toMatch(/create|delete|remove|enable|disable/i);
    }
  });
});

describe('deriveDomains — basic derivation', () => {
  it('returns nothing for no accounts and no aliases', () => {
    expect(deriveDomains([], [])).toEqual([]);
  });

  it('derives a domain from a single account', () => {
    const result = deriveDomains(accounts('user@example.com|{SHA512-CRYPT}$6$aaa'), []);
    expect(result).toEqual([
      { domain: 'example.com', mailboxCount: 1, aliasCount: 0, aliasOnly: false },
    ]);
  });

  it('counts multiple mailboxes on the same domain', () => {
    const content = [
      'a@example.com|{SHA512-CRYPT}$6$aaa',
      'b@example.com|{SHA512-CRYPT}$6$bbb',
    ].join('\n');
    const result = deriveDomains(accounts(content), []);
    expect(result).toEqual([
      { domain: 'example.com', mailboxCount: 2, aliasCount: 0, aliasOnly: false },
    ]);
  });

  it('returns domains sorted and deduplicated across multiple accounts', () => {
    const content = [
      'a@zeta.tld|{SHA512-CRYPT}$6$aaa',
      'b@alpha.tld|{SHA512-CRYPT}$6$bbb',
      'c@alpha.tld|{SHA512-CRYPT}$6$ccc',
    ].join('\n');
    const result = deriveDomains(accounts(content), []);
    expect(result.map((d) => d.domain)).toEqual(['alpha.tld', 'zeta.tld']);
  });
});

describe('deriveDomains — alias-only domains (an explicit acceptance criterion)', () => {
  it('derives a domain that appears only via an alias, with no mailbox at all', () => {
    const result = deriveDomains([], aliases('alias@onlyalias.tld external@somewhere.tld'));
    expect(result).toEqual([
      { domain: 'onlyalias.tld', mailboxCount: 0, aliasCount: 1, aliasOnly: true },
    ]);
  });

  it('derives a domain that appears only via a catch-all alias', () => {
    const result = deriveDomains([], aliases('@catchall.tld dump@somewhere.tld'));
    expect(result).toEqual([
      { domain: 'catchall.tld', mailboxCount: 0, aliasCount: 1, aliasOnly: true },
    ]);
  });

  it('does NOT count an alias recipient domain as a derived domain (recipients can be external, e.g. gmail.com)', () => {
    const result = deriveDomains([], aliases('forward@example.com externaluser@gmail.com'));
    expect(result.map((d) => d.domain)).toEqual(['example.com']);
    expect(result.find((d) => d.domain === 'gmail.com')).toBeUndefined();
  });
});

describe('deriveDomains — addresses in both files (an explicit acceptance criterion)', () => {
  it('merges mailbox and alias counts for the same domain into a single entry, not two', () => {
    const domain = deriveDomains(
      accounts('user@example.com|{SHA512-CRYPT}$6$aaa'),
      aliases('sales@example.com person@example.com'),
    );
    expect(domain).toEqual([
      { domain: 'example.com', mailboxCount: 1, aliasCount: 1, aliasOnly: false },
    ]);
  });

  it('a domain with both a mailbox and an alias is not aliasOnly', () => {
    const domain = deriveDomains(
      accounts('user@example.com|{SHA512-CRYPT}$6$aaa'),
      aliases('sales@example.com person@example.com'),
    );
    expect(domain[0]?.aliasOnly).toBe(false);
  });

  it('handles disjoint domains across both files, each with its own correct counts', () => {
    const result = deriveDomains(
      accounts('u@withmailbox.tld|{SHA512-CRYPT}$6$aaa'),
      aliases('a@aliasonly.tld x@external.tld'),
    );
    expect(result).toEqual([
      { domain: 'aliasonly.tld', mailboxCount: 0, aliasCount: 1, aliasOnly: true },
      { domain: 'withmailbox.tld', mailboxCount: 1, aliasCount: 0, aliasOnly: false },
    ]);
  });
});

describe('deriveDomains — unicode / IDN domains', () => {
  it('derives a unicode domain correctly', () => {
    const result = deriveDomains(accounts('用户@例え.jp|{SHA512-CRYPT}$6$aaa'), []);
    expect(result).toEqual([
      { domain: '例え.jp', mailboxCount: 1, aliasCount: 0, aliasOnly: false },
    ]);
  });
});
