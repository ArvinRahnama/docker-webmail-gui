import { describe, expect, it } from 'vitest';
import type { VerifyResult } from '../mail/types.js';
import { describeVerificationFailure } from './connections.service.js';

const ok = { ok: true, message: 'fine', authFailed: false } as const;

function result(imapMessage: string | null, smtpMessage: string | null): VerifyResult {
  return {
    imap:
      imapMessage === null
        ? { ...ok, folderCount: 3 }
        : { ok: false, message: imapMessage, folderCount: null, authFailed: false },
    smtp: smtpMessage === null ? ok : { ok: false, message: smtpMessage, authFailed: false },
  };
}

describe('describeVerificationFailure', () => {
  it('names each failing protocol and points a certificate failure at Certificate name', () => {
    const message = describeVerificationFailure(
      result(
        'The mail server’s TLS certificate could not be verified.',
        'The SMTP server’s TLS certificate could not be verified.',
      ),
    );
    expect(message).toContain('IMAP: The mail server’s TLS certificate could not be verified.');
    expect(message).toContain('SMTP: The SMTP server’s TLS certificate could not be verified.');
    expect(message).toContain('Nothing was stored.');
    expect(message).toContain('Certificate name in Service settings');
  });

  it('gives no certificate hint when the server simply could not be reached', () => {
    const message = describeVerificationFailure(
      result('The mail server could not be reached.', null),
    );
    expect(message).toContain('IMAP: The mail server could not be reached.');
    expect(message).not.toContain('SMTP:');
    expect(message).not.toContain('Certificate name');
  });
});
