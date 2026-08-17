/**
 * Fixture provenance: CONSTRUCTED. Illustrative output in the shape each
 * real command actually produces (`postqueue -p`, `postconf -n`,
 * `doveconf -n`, `doveadm who` — all four documented as real Postfix/
 * Dovecot diagnostics, and `apps/broker/src/operations.ts`'s
 * `CONSOLE_COMMAND_ARGV` maps `@dwg/shared`'s `CONSOLE_COMMANDS` keys to
 * exactly this argv) — not captured from a real daemon or mail stack,
 * since neither exists in this development environment. Text is
 * illustrative, written to look like typical output, not copied from any
 * real system.
 */
import type { ConsoleCommand, ConsoleExecResponse } from '@dwg/shared';

export const FIXTURE_CONSOLE_OUTPUTS: Readonly<Record<ConsoleCommand, ConsoleExecResponse>> = {
  'postqueue-p': {
    command: 'postqueue-p',
    argv: ['postqueue', '-p'],
    stdout: 'Mail queue is empty\n',
    stderr: '',
    exitCode: 0,
    durationMs: 42,
  },
  'postconf-n': {
    command: 'postconf-n',
    argv: ['postconf', '-n'],
    stdout: [
      'compatibility_level = 3.6',
      'inet_protocols = ipv4',
      'mailbox_size_limit = 0',
      'mydestination = $myhostname, localhost.localdomain, localhost',
      'myhostname = mail.example.com',
      'smtpd_banner = $myhostname ESMTP',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
    durationMs: 58,
  },
  'doveconf-n': {
    command: 'doveconf-n',
    argv: ['doveconf', '-n'],
    stdout: [
      '# 2.3.21 (abcdef1): /etc/dovecot/dovecot.conf',
      '# OS: Linux 6.8.0-generic x86_64',
      'auth_mechanisms = plain login',
      'mail_location = maildir:/var/mail/%d/%n',
      'protocols = imap pop3 lmtp sieve',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
    durationMs: 61,
  },
  'doveadm-who': {
    command: 'doveadm-who',
    argv: ['doveadm', 'who'],
    stdout:
      'username                              # sessions\nadmin@example.com                    1\n',
    stderr: '',
    exitCode: 0,
    durationMs: 37,
  },
};
