/**
 * Parsers for two kinds of line in docker-mailserver's combined mail log
 * (`/var/log/mail/mail.log`, read through the broker's `logs.file`):
 *
 *  - **User spam reports** written by docker/dms/dwg/sender-report:
 *      `<time> <host> dwg-sender-report: action=ham user=a@x ip=1.2.3.4 from=b@y`
 *  - **SMTP refusals** Postfix logs, e.g.
 *      `<time> <host> postfix/smtpd[977]: NOQUEUE: reject: RCPT from unknown[1.2.3.4]: 550 5.1.1 <a@x>: Recipient address rejected: ...; from=<b@y> to=<a@x> proto=ESMTP helo=<h>`
 *      `<time> <host> postfix/cleanup[949]: E954D9514: milter-reject: END-OF-MESSAGE from unknown[1.2.3.4]: 5.7.1 ClamAV FOUND VIRUS "Eicar-Signature"; from=<b@y> to=<a@x> proto=ESMTP helo=<h>`
 *
 * Every pattern is anchored on the syslog prefix — the program name comes
 * from the logging process, not from anything a sender controls — so a
 * hostile HELO name or address quoted inside some other line can never be
 * read as a report or a reject. Formats are pinned to lines captured from
 * docker-mailserver 16 on 2026-11-12 (`maillog-parser.test.ts`).
 */
import type { RejectionCategory, RejectedMailEntry, SenderReportAction } from '@dwg/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `<timestamp> <host> <program>[pid]: <message>`. DMS 16 writes RFC 3339
 * timestamps; the traditional `Nov 12 05:23:35` form (no year) is accepted
 * too, for older images and custom rsyslog setups.
 */
const SYSLOG_PREFIX =
  /^(?:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))|([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d:\d\d:\d\d))\s+\S+\s+([\w./-]+?)(?:\[\d+\])?:\s(.*)$/;

interface SyslogLine {
  readonly at: string;
  readonly program: string;
  readonly message: string;
}

function parseSyslogLine(line: string, now: Date): SyslogLine | null {
  const match = SYSLOG_PREFIX.exec(line);
  if (match === null) return null;
  const [, iso, month, day, time, program, message] = match;
  let at: string;
  if (iso !== undefined) {
    // JavaScript dates hold milliseconds; DMS logs microseconds.
    const parsed = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
    if (Number.isNaN(parsed)) return null;
    at = new Date(parsed).toISOString();
  } else {
    const monthIndex = MONTHS.indexOf(month as string);
    if (monthIndex < 0) return null;
    // No year in the traditional format: the most recent such date that is
    // not in the future.
    let year = now.getUTCFullYear();
    const candidate = () =>
      Date.parse(
        `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}Z`,
      );
    if (candidate() > now.getTime() + 86_400_000) year -= 1;
    const parsed = candidate();
    if (Number.isNaN(parsed)) return null;
    at = new Date(parsed).toISOString();
  }
  return { at, program: program as string, message: message as string };
}

// ---------------------------------------------------------------------------
// User spam / not-spam reports
// ---------------------------------------------------------------------------

export interface ParsedSenderReport {
  readonly at: string;
  readonly action: SenderReportAction;
  readonly user: string;
  readonly from: string | null;
  readonly ip: string | null;
  /** The whole log line — the dedupe key. */
  readonly line: string;
}

const REPORT_MESSAGE = /^action=(ham|spam) user=(\S+) ip=(\S+) from=(\S+)$/;

export function parseSenderReportLine(
  line: string,
  now: Date = new Date(),
): ParsedSenderReport | null {
  const syslog = parseSyslogLine(line, now);
  if (syslog === null || syslog.program !== 'dwg-sender-report') return null;
  const match = REPORT_MESSAGE.exec(syslog.message);
  if (match === null) return null;
  const [, action, user, ip, from] = match as unknown as [
    string,
    SenderReportAction,
    string,
    string,
    string,
  ];
  return {
    at: syslog.at,
    action,
    user: user.toLowerCase(),
    from: from === '-' ? null : from.toLowerCase(),
    // Postfix brackets an IPv6 client as `[IPv6:2001:db8::1]`.
    ip: ip === '-' ? null : ip.replace(/^ipv6:/i, '').toLowerCase(),
    line,
  };
}

export function parseSenderReports(
  lines: readonly string[],
  now: Date = new Date(),
): ParsedSenderReport[] {
  const reports: ParsedSenderReport[] = [];
  for (const line of lines) {
    const report = parseSenderReportLine(line, now);
    if (report !== null) reports.push(report);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// SMTP refusals
// ---------------------------------------------------------------------------

/** `NOQUEUE: reject: RCPT from host[ip]:port: 550 5.1.1 <reason>; from=<a> to=<b> ...` — smtpd and postscreen (which separates fields with commas). */
const NOQUEUE_REJECT =
  /^NOQUEUE: reject: (\S+) from ([^[\s]*)\[([^\]]+)\](?::\d+)?: (\d{3}) (\d\.\d{1,3}\.\d{1,3}) (.*?); from=<([^>]*)>,? to=<([^>]*)>/;

/** `<queue-id>: milter-reject: END-OF-MESSAGE from host[ip]: 5.7.1 <reason>; from=<a> to=<b> ...` — Rspamd's verdicts, including ClamAV's. */
const MILTER_ACTION =
  /^\w+: milter-(reject|discard|hold): (\S+) from ([^[\s]*)\[([^\]]+)\]: (?:(\d\.\d{1,3}\.\d{1,3}) )?(.*?); from=<([^>]*)>,? to=<([^>]*)>/;

function stripAddressPrefix(reason: string): string {
  // smtpd prefixes the reason with the address it is about: `<a@x>: Recipient ...`.
  return reason.replace(/^<[^>]*>:\s*/, '').trim();
}

export function categoriseRejection(reason: string, milter: boolean): RejectionCategory {
  const text = reason.toLowerCase();
  if (/virus|malware|clamav/.test(text)) return 'virus';
  if (milter) return 'spam';
  if (/greylist|policy|relay access denied/.test(text)) return 'policy';
  if (/recipient address rejected|user unknown|mailbox unavailable/.test(text)) return 'recipient';
  if (/sender address rejected/.test(text)) return 'sender';
  if (/client host rejected|blocked using|helo command rejected|service unavailable/.test(text))
    return 'client';
  if (/spam/.test(text)) return 'spam';
  return 'other';
}

function nullIfEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 || value === 'unknown' ? null : value;
}

export function parseRejectLine(line: string, now: Date = new Date()): RejectedMailEntry | null {
  const syslog = parseSyslogLine(line, now);
  if (syslog === null || !syslog.program.startsWith('postfix')) return null;

  const noqueue = NOQUEUE_REJECT.exec(syslog.message);
  if (noqueue !== null) {
    const [, , host, ip, code, enhanced, rawReason, from, to] = noqueue;
    const reason = stripAddressPrefix(rawReason as string);
    return {
      at: syslog.at,
      source: 'postfix',
      category: categoriseRejection(reason, false),
      temporary: (code as string).startsWith('4'),
      clientIp: nullIfEmpty(ip),
      clientHost: nullIfEmpty(host),
      from: nullIfEmpty(from),
      to: to ? [to] : [],
      subject: null,
      score: null,
      smtpCode: `${code} ${enhanced}`,
      reason,
    };
  }

  const milter = MILTER_ACTION.exec(syslog.message);
  if (milter !== null) {
    const [, kind, , host, ip, enhanced, rawReason, from, to] = milter;
    let reason = stripAddressPrefix(rawReason as string);
    if (kind === 'discard') reason = `Discarded: ${reason}`;
    if (kind === 'hold') reason = `Held in the queue: ${reason}`;
    return {
      at: syslog.at,
      source: 'postfix',
      category: categoriseRejection(reason, true),
      temporary: enhanced !== undefined && enhanced.startsWith('4'),
      clientIp: nullIfEmpty(ip),
      clientHost: nullIfEmpty(host),
      from: nullIfEmpty(from),
      to: to ? [to] : [],
      subject: null,
      score: null,
      smtpCode: enhanced ?? null,
      reason,
    };
  }

  return null;
}

export function parseRejectLines(
  lines: readonly string[],
  now: Date = new Date(),
): RejectedMailEntry[] {
  const entries: RejectedMailEntry[] = [];
  for (const line of lines) {
    const entry = parseRejectLine(line, now);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
