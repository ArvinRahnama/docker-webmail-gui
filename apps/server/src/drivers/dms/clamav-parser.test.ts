import { describe, expect, it } from 'vitest';
import { countClamavDetections, isPongReply, parseClamdVersion } from './clamav-parser.js';

describe('parseClamdVersion', () => {
  it('splits the documented ClamAV/sigVersion/sigDate reply shape', () => {
    const result = parseClamdVersion('ClamAV 0.103.11/27000/Fri Aug 14 08:00:00 2026');
    expect(result.engineVersion).toBe('ClamAV 0.103.11');
    expect(result.signatureVersion).toBe('27000');
    expect(result.signatureDate).toBe('Fri Aug 14 08:00:00 2026');
    expect(result.raw).toBe('ClamAV 0.103.11/27000/Fri Aug 14 08:00:00 2026');
  });

  it('trims surrounding whitespace before splitting', () => {
    const result = parseClamdVersion('  ClamAV 1.2.0/27500/Sat Aug 15 00:00:00 2026\n');
    expect(result.raw).toBe('ClamAV 1.2.0/27500/Sat Aug 15 00:00:00 2026');
    expect(result.engineVersion).toBe('ClamAV 1.2.0');
  });

  it('degrades to all-null fields (never a guessed split) when the shape does not match, while keeping raw', () => {
    const result = parseClamdVersion('unexpected reply with no slashes');
    expect(result.engineVersion).toBeNull();
    expect(result.signatureVersion).toBeNull();
    expect(result.signatureDate).toBeNull();
    expect(result.raw).toBe('unexpected reply with no slashes');
  });

  it('never throws on empty input', () => {
    expect(() => parseClamdVersion('')).not.toThrow();
    expect(parseClamdVersion('').engineVersion).toBeNull();
  });
});

describe('isPongReply', () => {
  it('recognises PONG case-insensitively and whitespace-trimmed', () => {
    expect(isPongReply('PONG')).toBe(true);
    expect(isPongReply('pong\n')).toBe(true);
    expect(isPongReply('  Pong  ')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPongReply('')).toBe(false);
    expect(isPongReply('ERROR')).toBe(false);
    expect(isPongReply('PONGX')).toBe(false);
  });
});

describe('countClamavDetections', () => {
  it('counts a line that names ClamAV and a positive verdict', () => {
    const log = [
      'Aug 15 10:22:31 mail clamd[123]: /var/mail/eicar.txt: Eicar-Test-Signature FOUND',
    ].join('\n');
    expect(countClamavDetections(log)).toBe(1);
  });

  it('counts a virus-attributed rejection line from the MTA integration', () => {
    const log = 'Aug 15 10:22:31 mail postfix/smtpd[1]: NOQUEUE: reject: virus found in message';
    expect(countClamavDetections(log)).toBe(1);
  });

  it('does not count an unrelated line that happens to contain "found"', () => {
    const log = 'Aug 15 10:22:31 mail postfix/smtpd[1]: connection from unknown found idle';
    expect(countClamavDetections(log)).toBe(0);
  });

  it('does not count a clam-attributed line with no positive verdict', () => {
    const log = 'Aug 15 10:22:31 mail clamd[123]: /var/mail/clean.txt: OK';
    expect(countClamavDetections(log)).toBe(0);
  });

  it('counts multiple matching lines across a multi-line log', () => {
    const log = [
      'Aug 15 10:22:31 mail clamd[123]: a.txt: Eicar-Test-Signature FOUND',
      'Aug 15 10:22:32 mail clamd[123]: b.txt: OK',
      'Aug 15 10:22:33 mail clamd[123]: c.txt: Win.Test.EICAR_HDB-1 FOUND',
    ].join('\n');
    expect(countClamavDetections(log)).toBe(2);
  });

  it('returns zero, never throwing, on empty input', () => {
    expect(() => countClamavDetections('')).not.toThrow();
    expect(countClamavDetections('')).toBe(0);
  });
});
