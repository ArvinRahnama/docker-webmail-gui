/**
 * Parses the **public** DKIM DNS record file docker-mailserver writes
 * (`docs/research/01-docker-mailserver.md` §7: `<selector>.txt`, next to
 * the `<selector>.private` key file this project never reads —
 * FEATURE_MATRIX.md §11: "Private keys are never returned by any API and
 * never rendered"). There is no other module in this codebase that reads
 * `.private`, and this one's own input type (a `.txt` file's text) makes
 * it structurally impossible to receive the private key by accident.
 *
 * The file is RFC 1035 zone-file syntax, e.g.:
 *
 * ```
 * mail._domainkey	IN	TXT	( "v=DKIM1; h=sha256; k=rsa; "
 * 	  "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1..." )  ; ----- DKIM key mail for example.com
 * ```
 *
 * A DNS TXT record's value is one or more quoted character-strings (each
 * up to 255 bytes per RFC 1035 §3.3.14) that concatenate into the
 * logical value — this parser's only job is finding every quoted
 * substring, in order, and joining them, which is exactly what a
 * resolver does when it hands back `resolveTxt`'s chunk array (mirrors
 * `drivers/dns`'s own `joinTxtRecord` helper, applied to a file instead
 * of a resolver response).
 */

/**
 * Extracts and joins every double-quoted substring in `content`, in
 * order. Returns `null` if none are found (unparseable/unexpected
 * format) — never throws, never guesses at a value, matching every other
 * parser in this driver (`parsers/parse-result.ts`'s doc comment).
 */
export function parseDkimZoneFileValue(content: string): string | null {
  const matches = [...content.matchAll(/"((?:[^"\\]|\\.)*)"/g)];

  if (matches.length === 0) {
    // No quoted strings at all. That is not necessarily unparseable: under
    // `ENABLE_RSPAMD=1` docker-mailserver does not use `opendkim-genkey`,
    // and the file it writes
    // (`rspamd/dkim/rsa-<bits>-<selector>-<domain>.public.dns.txt`) holds
    // the bare record value on one line, unquoted:
    //
    //   v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0…
    //
    // Captured from a live docker-mailserver 15.1.0 on 2026-08-23 (see
    // `fixtures/dkim-rspamd.ts`). Before this branch, a real Rspamd
    // deployment's DKIM record parsed as `null` and the panel reported the
    // key as unparseable — while the key existed and was perfectly valid.
    //
    // Accepted only when it actually looks like a DKIM record, so an
    // unrelated file's contents still fail rather than being echoed back
    // to an admin as though they were a DNS value.
    const bare = content.trim();
    return /^v=DKIM1\b/i.test(bare) ? bare.replace(/\s+/g, ' ') : null;
  }

  const joined = matches
    .map((match) => (match[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    .join('');

  return joined.trim().length > 0 ? joined.trim() : null;
}

export interface DkimZoneRecord {
  readonly name: string;
  readonly value: string;
}

/**
 * Builds the full public record (owner name + value) from a `.txt`
 * file's content plus the already-validated `domain`/`selector` this
 * file was read for. The owner name is **constructed**, not parsed out
 * of the file's own leading column — a zone file conventionally writes
 * it relative to the zone origin (e.g. `mail._domainkey`, no trailing
 * dot), which is fragile to depend on when this module already knows
 * the true owner name from the selector/domain that were used to locate
 * the file in the first place.
 */
export function parseDkimZoneFile(
  content: string,
  domain: string,
  selector: string,
): DkimZoneRecord | null {
  const value = parseDkimZoneFileValue(content);
  if (value === null) return null;
  return { name: `${selector}._domainkey.${domain}`, value };
}
