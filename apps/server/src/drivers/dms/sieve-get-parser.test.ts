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

  // Captured 2026-10-21 from ghcr.io/docker-mailserver/docker-mailserver:16
  // (v16.0.1, Dovecot 2.4.1-4): each script stored with `doveadm sieve put`,
  // then `doveadm sieve get -u tester@example.test <name>` stdout compared
  // with `cat ~/sieve/<name>.sieve`. Output = header + the file, nothing after.
  it.each([
    {
      name: 'Default (ends with a newline)',
      stdout:
        'sieve script:\nrequire ["fileinto"];\nif header :contains "subject" "spam" {\n  fileinto "Junk";\n}\n',
      onDisk:
        'require ["fileinto"];\nif header :contains "subject" "spam" {\n  fileinto "Junk";\n}\n',
    },
    {
      name: 'NoTrailingNewline',
      stdout: 'sieve script:\nrequire ["fileinto"];\nkeep;',
      onDisk: 'require ["fileinto"];\nkeep;',
    },
  ])(
    'captured Dovecot 2.4.1 output for $name reads back as the file on disk',
    ({ stdout, onDisk }) => {
      expect(parseSieveGet(stdout)).toBe(onDisk);
    },
  );
});
