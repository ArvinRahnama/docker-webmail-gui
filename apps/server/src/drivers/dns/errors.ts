/**
 * Classifies a thrown DNS lookup error into exactly one of `'missing'` or
 * `'unknown'` — never `'invalid'` (`@dwg/shared`'s `DnsRecordState`;
 * FEATURE_MATRIX.md §10: "resolver failure yields `Unknown` and not
 * `Invalid`"). Every checker in this driver funnels its resolver
 * try/catch through this one function so the missing-vs-unknown line is
 * drawn identically everywhere, rather than re-decided ad hoc per record
 * type.
 *
 * Node's DNS bindings (c-ares) surface a small, well-known set of error
 * codes on `NodeJS.ErrnoException#code` — `[CONFIRMED: nodejs.org/api/dns.html`
 * "Error codes" section`]`. `ENOTFOUND`/`ENODATA` are *authoritative*
 * negative answers: the resolver reached an authority and got a
 * definitive "nothing here," which is exactly what `'missing'` means.
 * Everything else (timeouts, `SERVFAIL`, connection refusal, an
 * unrecognised code, a non-DNS error) means we never got a trustworthy
 * answer at all, which is exactly what `'unknown'` means — the default
 * for anything not explicitly recognised as a negative answer, so a
 * future/unfamiliar error code fails toward "grey," never toward
 * "invalid" or a fabricated "missing."
 */

const AUTHORITATIVE_NEGATIVE_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

export type DnsFailureClass = 'missing' | 'unknown';

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function classifyDnsError(err: unknown): DnsFailureClass {
  const code = errorCode(err);
  if (code !== null && AUTHORITATIVE_NEGATIVE_CODES.has(code)) {
    return 'missing';
  }
  return 'unknown';
}

/** Safe-to-show summary of a DNS failure for an issue/error message — never a raw stack trace. */
export function describeDnsError(err: unknown): string {
  const code = errorCode(err);
  if (code !== null) return `DNS lookup failed (${code})`;
  if (err instanceof Error) return `DNS lookup failed: ${err.message}`;
  return 'DNS lookup failed';
}
