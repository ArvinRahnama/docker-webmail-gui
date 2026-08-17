/**
 * Strict hostname validation — the SSRF gate for DNS diagnostics
 * (SECURITY.md §3.4: "Domains are validated against a strict hostname
 * pattern before ever reaching a DNS resolver"). This is the project's
 * main SSRF surface because the domain is admin-supplied; the mitigation
 * is that we only ever perform DNS *resolution* (never an HTTP fetch to a
 * resolved or user-supplied host — `real-resolver.ts` never opens a TCP
 * connection), and every value reaching a resolver call passes through
 * here first.
 *
 * Deliberately independent of `drivers/dms/validators.ts`'s
 * `validateDomain` (a different module, for a different threat: argv
 * injection into a `setup` command, not SSRF into a resolver) even though
 * the shapes are similar — this keeps the DNS driver self-contained and
 * lets its own tests assert the injection/SSRF properties it actually
 * cares about without depending on the DMS driver's own reasoning.
 */

// eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them
const CONTAINS_CONTROL_CHAR = /[\x00-\x1F\x7F]/;

const LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * The final label must contain at least one letter — a well-established
 * validation heuristic (matching RFC 1123's "highest-level component
 * label will be alphabetic" guidance) that also structurally rejects an
 * IPv4-literal string like `127.0.0.1` or `10.0.0.5` from ever being
 * treated as a "domain" here. That matters because `propagation.ts`
 * queries a *fixed* list of public resolvers by IP for a domain's
 * records, never a caller-supplied resolver — so admitting an IP-shaped
 * "domain" would not itself grant a caller control over which host we
 * query, but rejecting it anyway keeps this validator strict-by-default
 * rather than relying on that separate control alone.
 */
function looksLikeIpLiteral(finalLabel: string): boolean {
  return !/[a-zA-Z]/.test(finalLabel);
}

export interface HostnameValidationResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * Validates an admin-supplied value is a plausible DNS domain name before
 * it is used in any resolver call. Never throws. Rejects anything
 * shell/injection-shaped (control characters, whitespace) even though a
 * resolver call is not a shell invocation — defence in depth, and the
 * same value often ends up echoed back in an error message or log line.
 */
export function validateHostnameForDns(value: string): HostnameValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'domain must not be empty' };
  }
  if (value.length > 253) {
    return { ok: false, error: 'domain must not exceed 253 characters' };
  }
  if (/\s/.test(value) || CONTAINS_CONTROL_CHAR.test(value)) {
    return { ok: false, error: 'domain must not contain whitespace or control characters' };
  }
  // Rejects shell metacharacters, path separators and anything else that
  // is not a plain hostname character — a single allowlist check rather
  // than a denylist of "dangerous" characters, so nothing unanticipated
  // slips through.
  if (!/^[a-zA-Z0-9.-]+$/.test(value)) {
    return {
      ok: false,
      error: 'domain must contain only letters, numbers, "." and "-"',
    };
  }
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    return { ok: false, error: 'domain must not have empty labels' };
  }

  const labels = value.split('.');
  if (labels.length < 2) {
    return { ok: false, error: 'domain must have at least two labels, e.g. "example.com"' };
  }
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) {
      return { ok: false, error: `"${label}" is not a valid domain label` };
    }
  }

  const finalLabel = labels[labels.length - 1] as string;
  if (looksLikeIpLiteral(finalLabel)) {
    return { ok: false, error: 'domain must not be an IP address literal' };
  }

  return { ok: true, error: null };
}

/** Convenience boolean wrapper for call sites that only need the yes/no. */
export function isValidHostnameForDns(value: string): boolean {
  return validateHostnameForDns(value).ok;
}
