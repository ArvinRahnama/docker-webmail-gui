/**
 * Small helpers shared by every parser in this directory
 * (`docs/research/01-docker-mailserver.md` §6). Kept deliberately tiny and
 * dependency-free so each parser file stays independently readable.
 */

/** Splits file content into raw lines, tolerating `\n`, `\r\n` and a lone trailing `\r`. */
export function splitLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  return content.split(/\r\n|\r|\n/);
}

/** True for a blank (whitespace-only) line or a whole-line `#` comment — both are silently skipped, never reported as issues. */
export function isBlankOrComment(trimmedLine: string): boolean {
  return trimmedLine.length === 0 || trimmedLine.startsWith('#');
}

export interface SplitAddress {
  /** The address exactly as given (trimmed of surrounding whitespace only — case and unicode preserved). */
  readonly address: string;
  readonly localPart: string;
  /** Lowercased, since domain/hostname comparison is case-insensitive; `localPart` is left as-is because the local part of an address is not. */
  readonly domain: string;
}

/**
 * Whitespace or control characters anywhere in the value: the only
 * character-set restriction the *parser* applies. This is a read path over
 * a file DMS itself writes, so punctuation that is entirely legitimate in
 * real addresses (hyphens, dots, plus signs, underscores, unicode/IDN
 * characters per RFC 6531 SMTPUTF8) must never be rejected here. Stricter
 * shape rules (e.g. "no leading hyphen", to stop an address being mistaken
 * for a CLI flag) belong to `commands.ts`'s *write*-path validation, not to
 * reading a file that already exists on disk.
 */
// eslint-disable-next-line no-control-regex -- deliberately matching control chars (incl. \r\n) to reject them
const CONTAINS_WHITESPACE_OR_CONTROL_CHAR = /[\s\x00-\x1F\x7F]/;

/**
 * Splits `local@domain` on the *last* `@` (the domain part can never
 * legitimately contain one, whereas an unusual-but-technically-legal local
 * part in principle could). Returns `null` for anything that is not
 * exactly one non-empty local part and one non-empty domain part with no
 * whitespace or control characters anywhere.
 */
export function splitEmailAddress(value: string): SplitAddress | null {
  if (value.length === 0) return null;
  if (CONTAINS_WHITESPACE_OR_CONTROL_CHAR.test(value)) return null;

  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) return null;
  if (value.indexOf('@') !== atIndex) return null; // more than one '@'

  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  if (localPart.length === 0 || domain.length === 0) return null;

  return { address: value, localPart, domain: domain.toLowerCase() };
}

/**
 * Like {@link splitEmailAddress} but also accepts a catch-all alias
 * address (`@domain.tld` — empty local part), which is valid on the
 * left-hand side of `postfix-virtual.cf` but never in
 * `postfix-accounts.cf`.
 */
export function splitAliasAddress(value: string): SplitAddress | null {
  if (value.length === 0) return null;
  if (CONTAINS_WHITESPACE_OR_CONTROL_CHAR.test(value)) return null;

  if (value.startsWith('@')) {
    const domain = value.slice(1);
    if (domain.length === 0 || value.indexOf('@', 1) !== -1) return null;
    return { address: value, localPart: '', domain: domain.toLowerCase() };
  }

  return splitEmailAddress(value);
}
