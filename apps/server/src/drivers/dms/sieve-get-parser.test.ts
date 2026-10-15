import { describe, expect, it } from 'vitest';
import { parseSieveGet } from './sieve-get-parser.js';

const SCRIPT =
  'require ["fileinto"];\nif header :contains "subject" "spam" {\n  fileinto "Junk";\n}\n';

describe('parseSieveGet', () => {
  it('strips the Dovecot 2.4 "sieve script:" header line (LF)', () => {
    expect(parseSieveGet(`sieve script:\n${SCRIPT}`)).toBe(SCRIPT);
  });

  it('strips the Dovecot 2.4 "sieve script:" header line (CRLF), leaving the body untouched', () => {
    const crlfScript = SCRIPT.replace(/\n/g, '\r\n');
    expect(parseSieveGet(`sieve script:\r\n${crlfScript}`)).toBe(crlfScript);
  });

  it('returns Dovecot 2.3 output with no header byte-for-byte unchanged', () => {
    expect(parseSieveGet(SCRIPT)).toBe(SCRIPT);
  });

  it('returns an empty script when the output is only the header line', () => {
    expect(parseSieveGet('sieve script:\n')).toBe('');
    expect(parseSieveGet('sieve script:\r\n')).toBe('');
  });

  it('keeps a later "sieve script:" line that is part of the body', () => {
    const body = '# sieve script:\nsieve script:\nkeep;\n';
    expect(parseSieveGet(body)).toBe(body);
    expect(parseSieveGet(`sieve script:\n${body}`)).toBe(body);
    expect(parseSieveGet(`sieve script:\nsieve script:\nkeep;\n`)).toBe('sieve script:\nkeep;\n');
  });

  it('does not strip a first line that only resembles the header', () => {
    for (const output of [
      'sieve script: \nkeep;\n',
      ' sieve script:\nkeep;\n',
      'Sieve script:\nkeep;\n',
      'sieve script:keep;\n',
      'sieve script:',
    ]) {
      expect(parseSieveGet(output)).toBe(output);
    }
  });

  it('preserves a body with no trailing newline and returns empty output unchanged', () => {
    expect(parseSieveGet('sieve script:\nkeep;')).toBe('keep;');
    expect(parseSieveGet('')).toBe('');
  });
});
