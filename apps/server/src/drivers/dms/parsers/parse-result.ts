/**
 * Shared result shape for every DMS config-file parser
 * (`docs/research/01-docker-mailserver.md` §6; FEATURE_MATRIX.md §0 Rule
 * 1: "Reads parse state; writes use the CLI"). DMS ships no
 * machine-readable output anywhere, so these parsers are the *entire* read
 * path for mailbox/alias/quota state — a parser that throws on a
 * malformed line, or silently drops it, is how an admin comes to believe
 * a mailbox was deleted when it was not.
 *
 * Every parser in this directory therefore:
 *
 *  - never throws, regardless of input (empty string, binary garbage,
 *    a truncated last line, whatever);
 *  - returns every line it *could* parse as an {@link ParseResult.entries}
 *    element;
 *  - returns every line it *could not* parse as a {@link ParseResult.issues}
 *    element, carrying the 1-based line number and the untouched raw
 *    text, so a caller can show "3 accounts loaded, 1 line could not be
 *    read" instead of silently "3 accounts loaded".
 */
export interface ParseIssue {
  /** 1-based line number in the original file. */
  readonly line: number;
  /** The raw, unmodified line text that could not be parsed. */
  readonly raw: string;
  /** Human-readable reason, safe to show an admin — never a stack trace or internal detail. */
  readonly reason: string;
}

export interface ParseResult<T> {
  readonly entries: readonly T[];
  readonly issues: readonly ParseIssue[];
}
