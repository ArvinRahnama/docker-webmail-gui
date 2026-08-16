/**
 * Fixture provenance: **mostly CONSTRUCTED, one line CAPTURED-BY-QUOTE.**
 * There is no live docker-mailserver container in this environment
 * (ARCHITECTURE.md §9), so nothing here is `setup email list` output or a
 * file read from a running container.
 *
 * The first entry below (`user1@domainone.tld`) is copied verbatim from
 * the real upstream test fixture quoted in
 * `docs/research/01-docker-mailserver.md` §6
 * (`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/test/config/relay-hosts/postfix-accounts.cf]`) —
 * a genuine example line from docker-mailserver's own repo, reused here
 * rather than retyped. Every other line is constructed from the same
 * documented `<email>|<hash>` pipe-delimited format
 * (`docs/research/01-docker-mailserver.md` §6) to exercise multiple
 * mailboxes across multiple domains; their hash bodies are an obviously
 * placeholder string, not a real `doveadm pw` digest — this project never
 * decodes or verifies these hashes (see `parsers/postfix-accounts.ts`),
 * so nothing depends on the hash being cryptographically real.
 */

const CONFIRMED_UPSTREAM_LINE =
  'user1@domainone.tld|{SHA512-CRYPT}$6$UMGnThsSm0IFgzEw$BynVshxudpGQHDRQaF4b7wb57A7NazGZcBUakYYLflp7J4E3UHK2qo/C1qXMCkRlYFlTd.SuwCsCKb7zBaUkb/';

const PLACEHOLDER_HASH =
  '{SHA512-CRYPT}$6$fixtureSaltOnly$notARealDoveadmDigestThisIsFixtureDataOnlyXX';

export const FIXTURE_POSTFIX_ACCOUNTS_CF = [
  CONFIRMED_UPSTREAM_LINE,
  `admin@example.com|${PLACEHOLDER_HASH}`,
  `user1@example.com|${PLACEHOLDER_HASH}`,
  `sales@example.com|${PLACEHOLDER_HASH}`,
  `info@otherdomain.tld|${PLACEHOLDER_HASH}`,
].join('\n');
