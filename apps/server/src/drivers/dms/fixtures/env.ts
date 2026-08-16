/**
 * Fixture provenance: CONSTRUCTED. No live docker-mailserver container
 * exists in this environment (ARCHITECTURE.md §9), so this is not a real
 * container's environment. It is built directly from
 * `docs/research/01-docker-mailserver.md` §9's own table of shipped
 * defaults in `mailserver.env`
 * (`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/mailserver.env]`):
 * quotas on, Rspamd/ClamAV/Fail2ban off, FILE account provisioning —
 * i.e. deliberately the *default* deployment shape, not an
 * everything-enabled one, so `FakeDmsDriver`'s capability document
 * exercises the same "off by default" reality a fresh install has.
 */

export const FIXTURE_DMS_ENV: Readonly<Record<string, string | undefined>> = {
  ENABLE_QUOTAS: '1',
  ENABLE_RSPAMD: '0',
  ENABLE_CLAMAV: '0',
  ENABLE_FAIL2BAN: '0',
  ACCOUNT_PROVISIONER: '',
  POSTMASTER_ADDRESS: 'postmaster@example.com',
};
