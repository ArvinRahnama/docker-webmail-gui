/**
 * Fixture provenance: **mostly CONSTRUCTED, one line CAPTURED-BY-QUOTE.**
 * No live docker-mailserver container exists in this environment
 * (ARCHITECTURE.md §9). The first entry below is copied verbatim from the
 * real upstream test fixture quoted in
 * `docs/research/01-docker-mailserver.md` §6
 * (`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/test/config/postfix-virtual.cf]`).
 * Every other line is constructed from the same documented
 * `<alias-or-@domain> <recipient1>[,<recipient2>,...]` format to exercise:
 * a plain alias, a multi-recipient alias, a catch-all (`@domain`), and an
 * alias forwarding to a fully external address — all real, distinct
 * shapes `parsers/postfix-virtual.ts` and `domains.ts` need to handle.
 *
 * Deliberately, `catchall.example.com` appears **only** here, never in
 * `postfix-accounts.ts` — an alias-only domain
 * (`docs/research/01-docker-mailserver.md` ★1; FEATURE_MATRIX.md §2), and
 * `external1@otherdomain.tld` / `externalsubscriber@gmail.com` are
 * recipients only, never a left-hand alias address, so neither
 * `otherdomain.tld`'s alias count nor `gmail.com` at all should appear as
 * a *derived* domain from this file alone (see `domains.ts`'s doc comment
 * on why recipient domains do not count).
 */

const CONFIRMED_UPSTREAM_LINE = 'alias2@localhost.localdomain external1@otherdomain.tld';

export const FIXTURE_POSTFIX_VIRTUAL_CF = [
  CONFIRMED_UPSTREAM_LINE,
  'postmaster@example.com admin@example.com',
  'sales@example.com user1@example.com,admin@example.com',
  '@catchall.example.com admin@example.com',
  'newsletter@example.com externalsubscriber@gmail.com',
].join('\n');
