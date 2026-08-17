/**
 * Generates and parses the autoresponder's Sieve script (FEATURE_MATRIX.md
 * §18; `docs/research/03-mail-stack-components.md` §5's ★5). RFC 5260's
 * `currentdate` test wraps RFC 5230's `vacation` command to give the
 * responder a genuine calendar window — the confirmed, standard pattern
 * the research doc verified against the RFC text itself, not a Dovecot
 * quirk:
 *
 * ```sieve
 * require ["date", "relational", "vacation"];
 * if allof(
 *     currentdate :value "ge" "date" "2026-08-01",
 *     currentdate :value "le" "date" "2026-08-15"
 * ) {
 *     vacation :days 7 :subject "Out of office" "...";
 * }
 * ```
 *
 * **This is the one and only place that builds this script.** The admin
 * never hand-writes Sieve for the autoresponder (FEATURE_MATRIX.md §18) —
 * {@link generateAutoresponderSieve} takes only structured fields, and
 * every string is embedded through an escaping helper that makes the
 * output syntactically safe regardless of content, never string
 * concatenation of raw admin input into the script body.
 *
 * **Round-tripping** (`getStatus` needs to redisplay a previously-saved
 * subject/message/dates in the edit form) is solved by a small
 * machine-readable header — plain `#`-comment lines, base64-encoded so
 * embedded newlines/quotes in the subject or message can never break the
 * comment syntax or desynchronise from the functional script below it —
 * rather than attempting to parse the functional Sieve back out. Sieve
 * comments are freely ignored by the interpreter, so the header changes
 * nothing about what the script actually does; it exists purely so this
 * module can read back exactly what it wrote. If the stored script was
 * hand-edited (via the general Sieve editor) and no longer starts with
 * this header, {@link parseAutoresponderSieve} returns `null` — reported
 * honestly to the admin as "unrecognised content," never a guessed
 * partial read (`sieve.ts`'s `AutoresponderStatusSchema`).
 */

export const AUTORESPONDER_SCRIPT_NAME = 'dwg-autoresponder';
const TEMPLATE_MARKER = `# ${AUTORESPONDER_SCRIPT_NAME}: v1`;
/** RFC 5230 `:days` — the response-suppression interval (don't re-send to the same sender within N days), not a calendar bound. A fixed, sensible default; not exposed as a form field (FEATURE_MATRIX.md §18 names only enable/message/subject/dates as the fields this feature manages). */
const VACATION_SUPPRESSION_DAYS = 7;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface AutoresponderInput {
  readonly subject: string;
  readonly message: string;
  /** `undefined`/omitted means "no lower bound." Must already be `YYYY-MM-DD` — see the module comment; this function re-asserts the shape as a last-line defence regardless of what schema validation ran upstream. */
  readonly startDate?: string | undefined;
  /** `undefined`/omitted means "no upper bound." */
  readonly endDate?: string | undefined;
}

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error(`autoresponder ${field} must be an ISO date (YYYY-MM-DD), got "${value}"`);
  }
}

/** Sieve `quoted-string` (RFC 5228 §2.4.2): escapes `\` and `"`, and collapses any embedded line break to a space — quoted strings are single-line by grammar, and `:subject` should be one line regardless. */
function sieveQuotedString(value: string): string {
  const singleLine = value.replace(/\r\n|\r|\n/g, ' ');
  const escaped = singleLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Sieve multi-line literal (RFC 5228 §2.4.3, `text:` ... CRLF `.` CRLF),
 * with dot-stuffing (a line beginning `.` is doubled) — the standard
 * mechanism for embedding arbitrary multi-line text (the vacation message
 * body) with no character-escaping ambiguity at all: the *only* rule is
 * "double a leading dot," so there is nothing here for adversarial content
 * to break out of.
 */
function sieveMultilineText(value: string): string {
  const normalized = value.replace(/\r\n|\r|\n/g, '\n');
  const dotStuffed = normalized
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return `text:\r\n${dotStuffed}\r\n.\r\n`;
}

function headerComment(input: AutoresponderInput): string {
  return [
    TEMPLATE_MARKER,
    `# subject: ${Buffer.from(input.subject, 'utf8').toString('base64')}`,
    `# message: ${Buffer.from(input.message, 'utf8').toString('base64')}`,
    `# start: ${input.startDate ?? 'none'}`,
    `# end: ${input.endDate ?? 'none'}`,
  ].join('\n');
}

/**
 * Builds the complete, ready-to-store Sieve script for `input`. Always
 * requires `vacation`; additionally requires `date`/`relational` only when
 * at least one date bound is present, so a responder with no date window
 * at all degrades to plain, unwrapped `vacation` — a legitimate,
 * real use case FEATURE_MATRIX.md §18 does not forbid.
 */
export function generateAutoresponderSieve(input: AutoresponderInput): string {
  if (input.startDate !== undefined) assertIsoDate(input.startDate, 'startDate');
  if (input.endDate !== undefined) assertIsoDate(input.endDate, 'endDate');

  const requires = new Set(['vacation']);
  const conditions: string[] = [];
  if (input.startDate !== undefined) {
    requires.add('date');
    requires.add('relational');
    conditions.push(`currentdate :zone "+0000" :value "ge" "date" "${input.startDate}"`);
  }
  if (input.endDate !== undefined) {
    requires.add('date');
    requires.add('relational');
    conditions.push(`currentdate :zone "+0000" :value "le" "date" "${input.endDate}"`);
  }

  const requireLine = `require [${[...requires].map((r) => `"${r}"`).join(', ')}];`;
  const vacationCommand = `vacation :days ${VACATION_SUPPRESSION_DAYS} :subject ${sieveQuotedString(input.subject)} ${sieveMultilineText(input.message)};`;

  let body: string;
  if (conditions.length === 0) {
    body = vacationCommand;
  } else if (conditions.length === 1) {
    body = `if ${conditions[0]} {\n  ${vacationCommand}\n}`;
  } else {
    body = `if allof(\n  ${conditions.join(',\n  ')}\n) {\n  ${vacationCommand}\n}`;
  }

  return `${headerComment(input)}\n${requireLine}\n${body}\n`;
}

export interface ParsedAutoresponderScript {
  readonly subject: string;
  readonly message: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

const HEADER_FIELD_PATTERN = /^# (subject|message|start|end): (.*)$/;

/**
 * The inverse of {@link generateAutoresponderSieve}'s header, and *only*
 * the header — see the module comment for why the functional Sieve below
 * it is never parsed. Returns `null` (never throws, never a partial guess)
 * when the content does not start with this module's own marker, or when
 * the base64 fields cannot be decoded.
 */
export function parseAutoresponderSieve(content: string): ParsedAutoresponderScript | null {
  if (!content.startsWith(TEMPLATE_MARKER)) return null;

  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    if (!line.startsWith('#')) break; // the header block ends at the first non-comment line
    const match = HEADER_FIELD_PATTERN.exec(line);
    if (match) fields.set(match[1] as string, (match[2] as string).trim());
  }

  const subjectB64 = fields.get('subject');
  const messageB64 = fields.get('message');
  if (subjectB64 === undefined || messageB64 === undefined) return null;

  let subject: string;
  let message: string;
  try {
    subject = Buffer.from(subjectB64, 'base64').toString('utf8');
    message = Buffer.from(messageB64, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const start = fields.get('start');
  const end = fields.get('end');
  return {
    subject,
    message,
    startDate: start !== undefined && start !== 'none' ? start : null,
    endDate: end !== undefined && end !== 'none' ? end : null,
  };
}
