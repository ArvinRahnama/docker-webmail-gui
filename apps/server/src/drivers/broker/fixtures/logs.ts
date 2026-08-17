/**
 * Fixture provenance: CONSTRUCTED. Representative Postfix/Dovecot-style
 * log lines in the shape the broker's demuxed `container.logs` response
 * produces (`apps/broker/src/stream-demux.ts`,
 * docs/research/02-docker-api-security.md §A.2) — not captured from a
 * real daemon. The message text itself is illustrative, written to look
 * like typical DMS log output, not copied from any real mail server.
 */
import type { ContainerLogLine } from '@dwg/shared';

export const FIXTURE_LOG_LINES: readonly ContainerLogLine[] = [
  { stream: 'stdout', data: 'postfix/smtpd[142]: connect from unknown[203.0.113.7]' },
  {
    stream: 'stdout',
    data: 'postfix/smtpd[142]: 4B2F1C0001: client=unknown[203.0.113.7]',
  },
  {
    stream: 'stderr',
    data: 'dovecot: imap-login: Login: user=<admin@example.com>, method=PLAIN, rip=203.0.113.7',
  },
  { stream: 'stdout', data: 'postfix/qmgr[98]: 4B2F1C0001: removed' },
];

/**
 * Fixture provenance: CONSTRUCTED, standard-syslog-shaped lines matching
 * the format `docs/research/01-docker-mailserver.md` §11 describes for
 * `/var/log/mail/mail.log` (plain syslog text, not structured/JSON) —
 * not captured from a real daemon. Deliberately includes a full
 * single-recipient delivery's worth of Postfix lines (client connect,
 * queued, delivered) plus one line with two `dsn=`/`status=`-bearing
 * tokens, so `parsePostfixLogLine` (`modules/docker/postfix-log-parser.ts`)
 * has real per-field content to extract in tests: queue id, from, to,
 * relay, delay, dsn and status all appear at least once across these
 * lines. Message text is illustrative, written to look like typical
 * Postfix output — not copied from a real mail server.
 */
export const FIXTURE_MAIL_LOG_LINES: readonly string[] = [
  'Aug 15 10:23:01 mailserver postfix/smtpd[142]: connect from unknown[203.0.113.7]',
  'Aug 15 10:23:01 mailserver postfix/smtpd[142]: 4B2F1C0001: client=unknown[203.0.113.7]',
  'Aug 15 10:23:02 mailserver postfix/cleanup[145]: 4B2F1C0001: message-id=<a1b2c3@example.com>',
  'Aug 15 10:23:02 mailserver postfix/qmgr[98]: 4B2F1C0001: from=<sender@example.com>, size=1234, nrcpt=1 (queue active)',
  'Aug 15 10:23:05 mailserver postfix/smtp[150]: 4B2F1C0001: to=<rcpt@example.org>, relay=mx.example.org[198.51.100.9]:25, delay=1.2, delays=0.1/0/0.5/0.6, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as D34F2)',
  'Aug 15 10:23:05 mailserver postfix/qmgr[98]: 4B2F1C0001: removed',
  'Aug 15 10:24:11 mailserver postfix/smtpd[151]: NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 554 5.7.1 Relay access denied',
];

/**
 * Fixture provenance: CONSTRUCTED, matching the fail2ban log format
 * `docs/research/01-docker-mailserver.md` §11 documents at
 * `/var/log/mail/fail2ban.log` — not captured from a real daemon.
 */
export const FIXTURE_FAIL2BAN_LOG_LINES: readonly string[] = [
  '2026-08-15 10:20:03,441 fail2ban.filter [1]: INFO [dovecot] Found 203.0.113.9',
  '2026-08-15 10:20:03,512 fail2ban.actions [1]: NOTICE [dovecot] Ban 203.0.113.9',
];
