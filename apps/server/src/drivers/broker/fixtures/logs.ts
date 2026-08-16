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
