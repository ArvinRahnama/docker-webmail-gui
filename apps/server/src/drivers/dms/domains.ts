/**
 * Domain derivation (`docs/research/01-docker-mailserver.md` ★1;
 * FEATURE_MATRIX.md §2). Domains are **not first-class in DMS** — there is
 * no `setup domain` command anywhere in the CLI. The set of domains DMS is
 * "responsible for" is derived purely from the domain-parts of addresses
 * already present in `postfix-accounts.cf` (real mailboxes) and
 * `postfix-virtual.cf` (aliases — the left-hand side only; see below).
 *
 * This module therefore exposes **no create/delete/enable** — there is
 * nothing upstream to call. `deriveDomains` is a pure, read-only view over
 * already-parsed entries.
 *
 * **Why only the alias left-hand side counts, not recipients:** an
 * alias's right-hand side can be a fully external address (e.g.
 * forwarding to `user@gmail.com`) — DMS is certainly not "responsible
 * for" gmail.com just because one local alias forwards there. The
 * research doc's own wording ("the domain-parts of every email address in
 * `postfix-accounts.cf` ... and `postfix-virtual.cf`") is read here as
 * referring to the addresses those files *define* (accounts, and alias
 * addresses), not delivery targets — consistent with FEATURE_MATRIX.md
 * §2's framing that "a domain exists purely because at least one account
 * or alias uses it," where "alias" means the alias address itself.
 */
import type { PostfixAccountEntry } from './parsers/postfix-accounts.js';
import type { PostfixVirtualEntry } from './parsers/postfix-virtual.js';

export interface DerivedDomain {
  /** Lowercased domain part, e.g. `example.com`. */
  readonly domain: string;
  readonly mailboxCount: number;
  readonly aliasCount: number;
  /**
   * `true` when every reference to this domain is an alias-only (catch-all
   * or otherwise) entry with no real mailbox — i.e. the domain would
   * vanish from DMS's perspective if those aliases were removed, since
   * there is no account keeping it "alive" independently.
   */
  readonly aliasOnly: boolean;
}

/**
 * Derives the sorted, deduplicated domain list from parsed accounts and
 * aliases. Takes already-parsed entries (never raw file content) so it has
 * no dependency on parser internals or file I/O — purely a projection.
 */
export function deriveDomains(
  accounts: readonly PostfixAccountEntry[],
  aliases: readonly PostfixVirtualEntry[],
): readonly DerivedDomain[] {
  const mailboxCounts = new Map<string, number>();
  const aliasCounts = new Map<string, number>();

  for (const account of accounts) {
    mailboxCounts.set(account.domain, (mailboxCounts.get(account.domain) ?? 0) + 1);
  }
  for (const alias of aliases) {
    aliasCounts.set(alias.domain, (aliasCounts.get(alias.domain) ?? 0) + 1);
  }

  const allDomains = new Set<string>([...mailboxCounts.keys(), ...aliasCounts.keys()]);

  return [...allDomains]
    .sort((a, b) => a.localeCompare(b))
    .map((domain) => {
      const mailboxCount = mailboxCounts.get(domain) ?? 0;
      const aliasCount = aliasCounts.get(domain) ?? 0;
      return {
        domain,
        mailboxCount,
        aliasCount,
        aliasOnly: mailboxCount === 0 && aliasCount > 0,
      };
    });
}
