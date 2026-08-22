/**
 * Parser for `postqueue -j` (M11 — dashboard's "Mail queue" tile,
 * FEATURE_MATRIX.md §1; `docs/research/03-mail-stack-components.md` §3).
 * Confirmed format: **JSON Lines** — one JSON object per queue file, one
 * line each, no wrapping array, no separate "counts only" flag. "Per-queue
 * counts: run `postqueue -j`, group-count by `queue_name` ... cheap to
 * count client-side" (§3) — this module returns every parsed entry via
 * the same {@link ParseResult} shape every other DMS reader uses
 * (`parse-result.ts`); the caller (`modules/dashboard`) does the grouping,
 * matching the research doc's own guidance rather than baking one grouping
 * policy into the parser.
 *
 * Deliberately narrow: only the fields a dashboard tile needs
 * (`queueName`, `queueId`, `arrivalTime`, `messageSizeBytes`, `sender`,
 * `recipientCount`) are extracted. The full per-recipient detail
 * (`recipients[].address`/`delay_reason`/`bounce_reason`) belongs to a
 * queue *management* page — inspecting and flushing individual messages —
 * which is out of scope here (IMPLEMENTATION_PLAN.md's milestone table
 * assigns M11 "Dashboard, command palette, global search, notifications",
 * not a mail-queue page; UX_ARCHITECTURE.md §5.2's "Mail > Queue... earns
 * a page" is a recommendation with no milestone attached to it). Extending
 * this parser to the full shape when that page is scoped is a additive,
 * not a rewrite.
 *
 * Never throws, matching every other parser in this directory: a line
 * that is not valid JSON, or valid JSON missing a required field, becomes
 * a {@link ParseIssue} rather than aborting the whole read.
 */
import type { ParseIssue, ParseResult } from './parse-result.js';

export const MAIL_QUEUE_NAMES = ['incoming', 'active', 'deferred', 'hold'] as const;
export type MailQueueName = (typeof MAIL_QUEUE_NAMES)[number];

export interface MailQueueEntry {
  readonly queueName: MailQueueName;
  readonly queueId: string;
  /** Seconds since epoch — `postqueue -j`'s own unit (§3), not milliseconds. */
  readonly arrivalTime: number;
  readonly messageSizeBytes: number;
  readonly sender: string;
  readonly recipientCount: number;
}

function isMailQueueName(value: unknown): value is MailQueueName {
  return typeof value === 'string' && (MAIL_QUEUE_NAMES as readonly string[]).includes(value);
}

function parseLine(raw: string, lineNumber: number): MailQueueEntry | ParseIssue {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { line: lineNumber, raw, reason: 'Not valid JSON.' };
  }

  if (typeof json !== 'object' || json === null) {
    return { line: lineNumber, raw, reason: 'Expected a JSON object.' };
  }
  const obj = json as Record<string, unknown>;

  if (!isMailQueueName(obj.queue_name)) {
    return { line: lineNumber, raw, reason: `Missing or unrecognised "queue_name".` };
  }
  if (typeof obj.queue_id !== 'string' || obj.queue_id.length === 0) {
    return { line: lineNumber, raw, reason: 'Missing "queue_id".' };
  }
  if (typeof obj.arrival_time !== 'number') {
    return { line: lineNumber, raw, reason: 'Missing or non-numeric "arrival_time".' };
  }
  if (typeof obj.message_size !== 'number') {
    return { line: lineNumber, raw, reason: 'Missing or non-numeric "message_size".' };
  }
  if (typeof obj.sender !== 'string') {
    return { line: lineNumber, raw, reason: 'Missing "sender".' };
  }
  const recipientCount = Array.isArray(obj.recipients) ? obj.recipients.length : 0;

  return {
    queueName: obj.queue_name,
    queueId: obj.queue_id,
    arrivalTime: obj.arrival_time,
    messageSizeBytes: obj.message_size,
    sender: obj.sender,
    recipientCount,
  };
}

function isIssue(value: MailQueueEntry | ParseIssue): value is ParseIssue {
  return 'reason' in value;
}

export function parsePostqueueJson(output: string): ParseResult<MailQueueEntry> {
  const entries: MailQueueEntry[] = [];
  const issues: ParseIssue[] = [];

  const lines = output.split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return; // Postfix emits nothing at all for an empty queue — a blank line is not a malformed entry.
    const result = parseLine(trimmed, index + 1);
    if (isIssue(result)) {
      issues.push(result);
    } else {
      entries.push(result);
    }
  });

  return { entries, issues };
}

/** Tallies {@link ParseResult.entries} by `queueName` — the exact grouping the research doc describes (§3), kept here so `modules/dashboard` and any future queue page share one implementation rather than two. Every {@link MAIL_QUEUE_NAMES} key is always present, zero-filled, so a caller never has to guess whether an absent key means zero or "not computed". */
export function countByQueueName(
  entries: readonly MailQueueEntry[],
): Readonly<Record<MailQueueName, number>> {
  const counts = Object.fromEntries(MAIL_QUEUE_NAMES.map((name) => [name, 0])) as Record<
    MailQueueName,
    number
  >;
  for (const entry of entries) {
    counts[entry.queueName] += 1;
  }
  return counts;
}
