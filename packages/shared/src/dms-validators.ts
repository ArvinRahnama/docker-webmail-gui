/**
 * Leaf-value validation for the **write path** (`commands.ts`).
 *
 * This is deliberately a separate, stricter rule set from the *read*-path
 * helpers in `parsers/shared.ts`. Reading an existing `.cf` file must
 * accept whatever DMS itself already wrote (permissive); building a new
 * `setup` invocation must reject anything that could be mistaken for a
 * command-line flag or that falls outside a plausible address/domain/quota
 * shape (strict) — see `parsers/shared.ts`'s own doc comment on
 * `splitEmailAddress`, which draws this same line.
 *
 * Every validator here returns `null` for a valid value, or a
 * human-readable reason string for an invalid one — never throws. Argv
 * arrays are already structurally immune to shell injection (there is no
 * shell to interpret `;`, backticks, `$()`, or a newline embedded in a
 * single array element — see ARCHITECTURE.md §5's "argv arrays only"
 * rule), so rejecting those payloads here is defence in depth plus the
 * simple fact that none of those characters can appear in a real email
 * address, domain, quota, IP, or DKIM selector anyway. A leading `-` is
 * rejected for an independent reason: even a perfectly-passed argv element
 * can still be misread as a flag by the *target* program's own argument
 * parser (`setup`/`addmailuser`/etc.), so a value shaped like a flag is
 * refused outright rather than trusted to be inert.
 */

// eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them
const CONTAINS_CONTROL_CHAR = /[\x00-\x1F\x7F]/;

const LOCAL_PART_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}._%+-]*[\p{L}\p{N}])?$/u;
const DOMAIN_LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

function isValidDomainShape(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  // Require at least two labels (a real FQDN, not a bare hostname) — DMS
  // domains are DNS domains a mail server answers for, matching every
  // real example in the research doc (e.g. `localhost.localdomain`,
  // `domainone.tld`).
  if (labels.length < 2) return false;
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && DOMAIN_LABEL_PATTERN.test(label),
  );
}

/** Validates a bare domain (no local part) — used for DKIM's `domain` argument. */
export function validateDomain(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'domain must not be empty';
  if (value.startsWith('-')) {
    return 'domain must not start with "-" (would be read as a command-line flag)';
  }
  if (/\s/.test(value) || CONTAINS_CONTROL_CHAR.test(value)) {
    return 'domain must not contain whitespace or control characters';
  }
  if (!isValidDomainShape(value)) return `"${value}" is not a valid domain`;
  return null;
}

export interface ValidateAddressOptions {
  /** Accept a catch-all `@domain` (empty local part) — valid on the left-hand side of an alias, never for a mailbox or a recipient. */
  readonly allowCatchAll?: boolean;
}

/** Validates `local@domain` (or, if `allowCatchAll`, a bare `@domain`) for use as a single argv element. */
export function validateAddressForArgv(
  value: string,
  options: ValidateAddressOptions = {},
): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'address must not be empty';
  if (value.startsWith('-')) {
    return 'address must not start with "-" (would be read as a command-line flag)';
  }
  if (/\s/.test(value) || CONTAINS_CONTROL_CHAR.test(value)) {
    return 'address must not contain whitespace or control characters';
  }

  const atCount = (value.match(/@/g) ?? []).length;
  if (atCount !== 1) return 'address must contain exactly one "@"';
  const atIndex = value.indexOf('@');
  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  if (localPart.length === 0) {
    if (!options.allowCatchAll) return 'address is missing a local part before "@"';
  } else if (!LOCAL_PART_PATTERN.test(localPart)) {
    return `"${localPart}" is not a valid local part (letters, numbers, and . _ % + - only, not leading/trailing punctuation)`;
  }

  if (!isValidDomainShape(domain)) return `"${domain}" is not a valid domain`;
  return null;
}

const QUOTA_PATTERN = /^[0-9]+[bBkKmMgGtT]?$/;

/** Validates a Dovecot quota value, e.g. `50M`, `2G` (`docs/research/01-docker-mailserver.md` §6, §7). */
export function validateQuota(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'quota must not be empty';
  if (!QUOTA_PATTERN.test(value)) {
    return 'quota must be digits optionally followed by a single unit letter, e.g. "50M" or "2G"';
  }
  return null;
}

const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/**
 * Deliberately permissive-but-bounded IPv6 matcher: full RFC 4291
 * validation (zone IDs, embedded IPv4, elision rules) is out of scope for
 * what is fundamentally an injection guard, not a network library. It
 * accepts the common forms and rejects any character outside hex digits
 * and `:`, which is sufficient to reject every injection payload this
 * module is tested against while accepting real addresses.
 */
const IPV6_PATTERN = /^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}$/;

/** Validates an IPv4 or IPv6 address for `setup fail2ban ban|unban`. */
export function validateIpAddress(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'IP address must not be empty';
  if (value.startsWith('-')) {
    return 'IP address must not start with "-" (would be read as a command-line flag)';
  }
  if (IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value)) return null;
  return `"${value}" is not a valid IPv4 or IPv6 address`;
}

const SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Validates a DKIM selector token (`docs/research/01-docker-mailserver.md` §7). */
export function validateDkimSelector(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'selector must not be empty';
  if (!SELECTOR_PATTERN.test(value)) {
    return 'selector may only contain letters, numbers, "-" and "_", and must start with a letter or number';
  }
  return null;
}

const VALID_DKIM_KEYSIZES = [1024, 2048, 4096] as const;
// The public `DkimKeysize` type lives in `security.ts` (`DkimKeysizeSchema`)
// and is identical; exporting a second one from here would give the package
// two names for one concept and an ambiguous re-export from `index.ts`.

/** Validates a DKIM key size — only 1024/2048/4096 are accepted (`docs/research/01-docker-mailserver.md` §7). */
export function validateDkimKeysize(value: number): string | null {
  if (!(VALID_DKIM_KEYSIZES as readonly number[]).includes(value)) {
    return `keysize must be one of ${VALID_DKIM_KEYSIZES.join(', ')}`;
  }
  return null;
}

/** Validates a mailbox password is present. Strength/generation policy is a different feature (FEATURE_MATRIX.md §6) — this only guards against the empty-password case DMS's own script itself rejects. */
export function validatePassword(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'password must not be empty';
  return null;
}

// eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them, mirrors CONTAINS_CONTROL_CHAR above
const SIEVE_NAME_CONTROL_CHAR = /[\x00-\x1F\x7F]/;
/** Letters, numbers, `-`, `_`, `.` — enough to name a script meaningfully (`dwg-autoresponder`, `my.filter`) without resembling a path segment or a flag. */
const SIEVE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Validates a `doveadm sieve` script name (FEATURE_MATRIX.md §17/§18) —
 * the argv leaf for `sieve get|put|activate`'s trailing `<name>`. Rejects
 * anything that could be mistaken for a flag or a path component (`.`/`..`
 * alone, or an embedded `/`), matching this file's own "a value shaped
 * like a flag is refused outright" convention.
 */
export function validateSieveScriptName(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'script name must not be empty';
  }
  if (value.startsWith('-')) {
    return 'script name must not start with "-" (would be read as a command-line flag)';
  }
  if (value === '.' || value === '..') {
    return 'script name must not be "." or ".."';
  }
  if (value.includes('/') || value.includes('\\')) {
    return 'script name must not contain a path separator';
  }
  if (SIEVE_NAME_CONTROL_CHAR.test(value) || /\s/.test(value)) {
    return 'script name must not contain whitespace or control characters';
  }
  if (!SIEVE_SCRIPT_NAME_PATTERN.test(value)) {
    return 'script name may only contain letters, numbers, "-", "_" and "." (max 128 characters), and must start with a letter or number';
  }
  return null;
}
