/**
 * Parser for `postfix-virtual.cf` — DMS's alias/forward table
 * (`docs/research/01-docker-mailserver.md` §6; FEATURE_MATRIX.md §4).
 *
 * **`postfix-aliases.cf` does not exist in DMS.** The research doc
 * confirmed this by searching the full upstream repo tree — any code or
 * copy assuming that filename is wrong. This file, `postfix-virtual.cf`,
 * is the actual alias data table (a Postfix "virtual alias map").
 *
 * Format, confirmed against the upstream repo's own test fixture:
 *
 * ```
 * <alias-or-@domain> <recipient1>[,<recipient2>,...]
 * ```
 *
 * e.g. `alias2@localhost.localdomain external1@otherdomain.tld`. The
 * left-hand side is either a full address (`alias@domain`) or a catch-all
 * (`@domain`, empty local part) — both valid. The right-hand side is one
 * or more recipients; the research doc documents comma-joining for
 * multiple targets, but real Postfix virtual-alias files also tolerate
 * whitespace-separated recipients, so both separators are accepted here
 * rather than treating a whitespace-separated line as malformed. A
 * recipient can itself be a local mailbox, another alias (Postfix resolves
 * recursively), or a fully external address — "forwarding" is not a
 * separate mechanism (FEATURE_MATRIX.md §5), so no recipient shape is
 * special-cased here.
 */
import { isBlankOrComment, splitAliasAddress, splitEmailAddress, splitLines } from './shared.js';
import type { ParseIssue, ParseResult } from './parse-result.js';

export interface PostfixVirtualEntry {
  /** The left-hand side exactly as given, e.g. `alias@domain.tld` or `@domain.tld`. */
  readonly address: string;
  /** `true` for a catch-all (`@domain`) left-hand side. */
  readonly isCatchAll: boolean;
  /** Empty string for a catch-all entry. */
  readonly localPart: string;
  readonly domain: string;
  /** Every recipient on the right-hand side, in file order, comma/whitespace splits both accepted. Always at least one element. */
  readonly recipients: readonly string[];
}

/** Splits a `postfix-virtual.cf` line's trimmed content into `[address, recipientsRaw]`, or `null` if there is no whitespace-separated second field at all. */
function splitAddressAndRecipients(trimmedLine: string): readonly [string, string] | null {
  const match = /^(\S+)\s+(.+)$/.exec(trimmedLine);
  if (!match) return null;
  const address = match[1] as string;
  const recipientsRaw = match[2] as string;
  return [address, recipientsRaw];
}

export function parsePostfixVirtual(content: string): ParseResult<PostfixVirtualEntry> {
  const entries: PostfixVirtualEntry[] = [];
  const issues: ParseIssue[] = [];

  splitLines(content).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (isBlankOrComment(line)) return;

    const lineNumber = index + 1;
    const split = splitAddressAndRecipients(line);
    if (!split) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason:
          'expected "<alias-or-@domain> <recipient1>[,<recipient2>,...]" (no recipient field found)',
      });
      return;
    }
    const [addressField, recipientsRaw] = split;

    const addressSplit = splitAliasAddress(addressField);
    if (!addressSplit) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: `"${addressField}" is not a valid alias address or @domain catch-all`,
      });
      return;
    }

    const recipientTokens = recipientsRaw
      .split(/[,\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (recipientTokens.length === 0) {
      issues.push({ line: lineNumber, raw: rawLine, reason: 'no recipients listed' });
      return;
    }

    const invalidRecipient = recipientTokens.find((token) => splitEmailAddress(token) === null);
    if (invalidRecipient !== undefined) {
      issues.push({
        line: lineNumber,
        raw: rawLine,
        reason: `recipient "${invalidRecipient}" is not a valid email address`,
      });
      return;
    }

    entries.push({
      address: addressSplit.address,
      isCatchAll: addressField.startsWith('@'),
      localPart: addressSplit.localPart,
      domain: addressSplit.domain,
      recipients: recipientTokens,
    });
  });

  return { entries, issues };
}
