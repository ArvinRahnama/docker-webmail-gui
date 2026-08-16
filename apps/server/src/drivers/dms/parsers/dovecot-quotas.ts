/**
 * Parser for `dovecot-quotas.cf` — per-mailbox Dovecot quota limits,
 * consulted only under `ACCOUNT_PROVISIONER=FILE`
 * (`docs/research/01-docker-mailserver.md` §6, §8; FEATURE_MATRIX.md §7).
 *
 * Format, confirmed against the upstream repo's shipped example file:
 *
 * ```
 * <email>:<quota>
 * ```
 *
 * e.g. `user@domain:50M`. This is the *limit* DMS/Dovecot enforces, not
 * current usage — usage is a live `doveadm quota get` reading
 * (FEATURE_MATRIX.md §7), out of scope for a file parser. The quota value
 * itself is preserved verbatim (e.g. `50M`, `2G`) and never converted to
 * bytes here; that is a display-layer concern.
 */
import { isBlankOrComment, splitEmailAddress, splitLines } from './shared.js';
import type { ParseIssue, ParseResult } from './parse-result.js';

export interface DovecotQuotaEntry {
  readonly email: string;
  readonly localPart: string;
  readonly domain: string;
  /** Verbatim quota value, e.g. `50M`, `2G`. Never parsed into bytes here. */
  readonly quota: string;
}

export function parseDovecotQuotas(content: string): ParseResult<DovecotQuotaEntry> {
  const entries: DovecotQuotaEntry[] = [];
  const issues: ParseIssue[] = [];

  splitLines(content).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (isBlankOrComment(line)) return;

    const lineNumber = index + 1;
    // Split on the *first* colon only: an email's local part can in
    // principle be unusual, but never contains a literal ':' per
    // splitEmailAddress's shared control/whitespace rule set is silent on
    // ':' specifically — so we deliberately do not split on the *last*
    // colon here, since a quota value is always a plain size token
    // (digits + optional unit) that never itself contains ':'.
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: 'expected "email:quota" (no colon delimiter found)',
      });
      return;
    }

    const emailField = line.slice(0, colonIndex).trim();
    const quotaField = line.slice(colonIndex + 1).trim();

    const split = splitEmailAddress(emailField);
    if (!split) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: `"${emailField}" is not a valid email address`,
      });
      return;
    }

    if (quotaField.length === 0) {
      issues.push({ line: lineNumber, raw: rawLine, reason: 'quota field is empty' });
      return;
    }

    entries.push({
      email: split.address,
      localPart: split.localPart,
      domain: split.domain,
      quota: quotaField,
    });
  });

  return { entries, issues };
}
