/**
 * Defensive parser for `setup fail2ban`'s plain-text banned-IP listing
 * (FEATURE_MATRIX.md's "Deferred to runtime verification" table:
 * "`setup fail2ban status` output shape ... [UNCERTAIN] ... Show raw
 * output if parsing fails"). Rather than committing to an assumed table
 * layout that could silently break on a docker-mailserver upgrade, this
 * extracts every IPv4/IPv6-shaped token from the raw text — a real
 * signal that degrades gracefully (worst case: an admin sees the same
 * information in `raw` that the extraction also surfaced structurally)
 * instead of a brittle line-by-line format assumption that could parse
 * zero rows silently.
 */

const IPV4_TOKEN_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
// A deliberately permissive IPv6 token matcher (mirrors `drivers/dms/validators.ts`'s
// own IPV6_PATTERN reasoning: this is a text-extraction aid, not a full
// RFC 4291 validator) — requires at least 4 colon-separated groups
// (3 colons) specifically to avoid matching an `HH:MM:SS` timestamp
// (which is 3 groups / 2 colons) if one appears elsewhere in the raw
// `setup fail2ban` output; a real IPv6 address is essentially never
// abbreviated down to exactly 3 groups.
const IPV6_TOKEN_PATTERN = /\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){3,7}\b/g;

export interface Fail2banListResult {
  readonly bannedIps: readonly string[];
  /** The unmodified `setup fail2ban` output — always returned so the UI can fall back to it verbatim if the extraction above looks wrong for a future DMS version. */
  readonly raw: string;
}

export function parseFail2banList(output: string): Fail2banListResult {
  const found = new Set<string>();
  for (const match of output.matchAll(IPV4_TOKEN_PATTERN)) found.add(match[0]);
  for (const match of output.matchAll(IPV6_TOKEN_PATTERN)) found.add(match[0]);
  return { bannedIps: [...found].sort(), raw: output };
}
