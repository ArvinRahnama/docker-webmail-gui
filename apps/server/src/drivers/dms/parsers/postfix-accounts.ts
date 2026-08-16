/**
 * Parser for `postfix-accounts.cf` — the authoritative account list under
 * `ACCOUNT_PROVISIONER=FILE` (`docs/research/01-docker-mailserver.md` §6).
 * Format, confirmed against the upstream repo's own test fixture:
 *
 * ```
 * <email>|<hash>[|<user_attributes>]
 * ```
 *
 * e.g. `user1@domainone.tld|{SHA512-CRYPT}$6$UMGnThsSm0IFgzEw$Byn...`.
 * The third field ("usually empty" per the research doc) is preserved
 * verbatim and never interpreted — this parser has no need to understand
 * it. The hash itself is opaque here too: it is read only to be displayed
 * as "a hash is set", never decoded, verified or compared — this project
 * never implements mail-password cryptography (FEATURE_MATRIX.md §6).
 */
import { isBlankOrComment, splitEmailAddress, splitLines } from './shared.js';
import type { ParseIssue, ParseResult } from './parse-result.js';

export interface PostfixAccountEntry {
  readonly email: string;
  readonly localPart: string;
  readonly domain: string;
  /** Opaque `{SCHEME}...` hash string, e.g. `{SHA512-CRYPT}$6$...` — never decoded or compared here. */
  readonly passwordHash: string;
  /** Third pipe-delimited field, verbatim. Empty string when absent. */
  readonly attributes: string;
}

export function parsePostfixAccounts(content: string): ParseResult<PostfixAccountEntry> {
  const entries: PostfixAccountEntry[] = [];
  const issues: ParseIssue[] = [];

  splitLines(content).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (isBlankOrComment(line)) return;

    const lineNumber = index + 1;
    const fields = line.split('|').map((field) => field.trim());

    if (fields.length < 2 || fields.length > 3) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: `expected "email|hash" or "email|hash|attributes" (2 or 3 pipe-delimited fields), found ${fields.length}`,
      });
      return;
    }

    const [emailField, hashField, attributesField] = fields as [string, string, string?];

    const split = splitEmailAddress(emailField);
    if (!split) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: `"${emailField}" is not a valid email address`,
      });
      return;
    }

    if (hashField.length === 0) {
      issues.push({ line: lineNumber, raw: rawLine, reason: 'password hash field is empty' });
      return;
    }

    entries.push({
      email: split.address,
      localPart: split.localPart,
      domain: split.domain,
      passwordHash: hashField,
      attributes: attributesField ?? '',
    });
  });

  return { entries, issues };
}
