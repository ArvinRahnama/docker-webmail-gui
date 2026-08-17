/**
 * Fixture provenance: **CONSTRUCTED**, not captured — there is no live
 * docker-mailserver container in this environment (ARCHITECTURE.md §9).
 * The shape matches `docs/research/01-docker-mailserver.md` §7's
 * confirmed description of `opendkim-genkey`'s `<selector>.txt` output
 * (RFC 1035 zone-file syntax, one owner name / class / type / a
 * parenthesised, multi-quoted-string TXT value). The base64 key body is
 * an obviously placeholder string, not real key material — this project
 * never parses it as anything but opaque text to relay verbatim.
 */

export const FIXTURE_DKIM_TXT_FILE = [
  'mail._domainkey\tIN\tTXT\t( "v=DKIM1; h=sha256; k=rsa; "',
  '\t  "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDNotARealKeyThisIsFixtureDataOnlyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXwIDAQAB" )  ; ----- DKIM key mail for example.com',
].join('\n');

/** Same content, but with the closing quote/paren missing — exercises the parser's malformed-input path. */
export const FIXTURE_DKIM_TXT_FILE_TRUNCATED =
  'mail._domainkey\tIN\tTXT\t( "v=DKIM1; h=sha256; k=rsa';
