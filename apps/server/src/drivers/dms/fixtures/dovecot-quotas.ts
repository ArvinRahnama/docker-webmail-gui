/**
 * Fixture provenance: **mostly CONSTRUCTED, one line CAPTURED-BY-QUOTE.**
 * No live docker-mailserver container exists in this environment
 * (ARCHITECTURE.md §9). The first entry below is copied verbatim from the
 * real shipped example file quoted in
 * `docs/research/01-docker-mailserver.md` §6
 * (`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/config-examples/dovecot-quotas.cf]`)
 * — note its domain part is literally the word `domain`, a placeholder in
 * upstream's own shipped example, preserved here verbatim rather than
 * "corrected" to a realistic-looking FQDN. Every other line is
 * constructed from the same documented `<email>:<quota>` colon-delimited
 * format, intentionally covering only a subset of `postfix-accounts.ts`'s
 * fixture mailboxes — quotas are optional per mailbox, so a fixture where
 * every account has one would understate what the parser and driver need
 * to handle.
 */

const CONFIRMED_UPSTREAM_LINE = 'user@domain:50M';

export const FIXTURE_DOVECOT_QUOTAS_CF = [
  CONFIRMED_UPSTREAM_LINE,
  'admin@example.com:2G',
  'user1@example.com:500M',
].join('\n');
