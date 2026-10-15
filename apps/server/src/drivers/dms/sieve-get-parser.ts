/**
 * Reads `doveadm sieve get -u <user> <name>` stdout back into the script
 * source exactly as stored (issue #40).
 *
 * Dovecot 2.4 (docker-mailserver 16) prints the script under a
 * `sieve script:` header line — doveadm's `pager` formatter titling the
 * one field it prints — and appends nothing after the script. Output
 * without that line, as reported for the Dovecot 2.3 builds in
 * docker-mailserver 14/15, passes through unchanged.
 *
 * Only a first line that is exactly the header is removed, LF or CRLF
 * terminated, and nothing is trimmed, so any other output comes back byte
 * for byte. A bare `sieve script:` line is not valid Sieve, so no stored
 * script can itself start with one. Never throws.
 */

const DOVEADM_SIEVE_GET_HEADER = /^sieve script:\r?\n/;

export function parseSieveGet(stdout: string): string {
  return stdout.replace(DOVEADM_SIEVE_GET_HEADER, '');
}
