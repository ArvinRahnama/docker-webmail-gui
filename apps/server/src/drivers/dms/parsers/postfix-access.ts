/**
 * Parser for `postfix-send-access.cf` / `postfix-receive-access.cf` — the
 * two files `setup email restrict add|del send|receive <EMAIL>` writes
 * (`docs/research/01-docker-mailserver.md` §8: "writes the address into
 * `postfix-send-access.cf` / `postfix-receive-access.cf` with a Postfix
 * `REJECT`, blocking it at the SMTP layer"). This is the *read* half of
 * FEATURE_MATRIX.md §3's "Restrict sending / receiving" — without it,
 * this project would only ever be able to fire a restrict command, never
 * honestly display whether one is already in effect.
 *
 * Format: standard Postfix `access(5)` lookup-table syntax, one
 * `pattern␣␣action` pair per line (`docs/research/01-docker-mailserver.md`
 * gives no single confirmed literal example line, so this parser follows
 * the documented, standard Postfix map convention rather than inventing
 * DMS-specific structure — the same posture `postfix-virtual.ts` already
 * takes for whitespace/comma-separated recipients).
 *
 * Deliberately permissive on the *action* column: `restrict-access` (the
 * script backing `setup email restrict`) only ever writes `REJECT`, but a
 * hand-edited access file could legally contain `OK`, `DUNNO`, or a
 * numeric SMTP code. Any pattern that is not a full email address (e.g. a
 * bare domain or IP block used for an unrelated access rule) is skipped,
 * not reported as an issue — this file is not exclusively ours to own,
 * and a line this feature did not write is not a parse *error*.
 */
import { isBlankOrComment, splitEmailAddress, splitLines } from './shared.js';
import type { ParseIssue, ParseResult } from './parse-result.js';

export interface PostfixAccessEntry {
  readonly email: string;
  readonly localPart: string;
  readonly domain: string;
  /** Verbatim action text, e.g. `REJECT`. Callers treat exactly `REJECT` (case-insensitive) as "restricted" — see `modules/mail/mailboxes.service.ts`. */
  readonly action: string;
}

function splitPatternAndAction(trimmedLine: string): readonly [string, string] | null {
  const match = /^(\S+)\s+(.+)$/.exec(trimmedLine);
  if (!match) return null;
  return [match[1] as string, (match[2] as string).trim()];
}

export function parsePostfixAccess(content: string): ParseResult<PostfixAccessEntry> {
  const entries: PostfixAccessEntry[] = [];
  const issues: ParseIssue[] = [];

  splitLines(content).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (isBlankOrComment(line)) return;

    const lineNumber = index + 1;
    const split = splitPatternAndAction(line);
    if (!split) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: 'expected "<pattern> <action>" (no whitespace-separated action found)',
      });
      return;
    }
    const [pattern, action] = split;

    // A pattern that is not a full mailbox address is a legitimate Postfix
    // access-map entry this feature simply did not write (e.g. a bare
    // domain, an IP/CIDR block) — silently out of scope, not malformed.
    const addressSplit = splitEmailAddress(pattern);
    if (!addressSplit) return;

    if (action.length === 0) {
      issues.push({ line: lineNumber, raw: rawLine, reason: 'action field is empty' });
      return;
    }

    entries.push({
      email: addressSplit.address,
      localPart: addressSplit.localPart,
      domain: addressSplit.domain,
      action,
    });
  });

  return { entries, issues };
}

/** `true` for exactly `REJECT` (case-insensitive) — the only action `setup email restrict add` ever writes. Any other action (e.g. `OK`, a hand-edited entry) is real data but is not what this feature considers "restricted". */
export function isRestrictAction(action: string): boolean {
  return action.toUpperCase() === 'REJECT';
}
