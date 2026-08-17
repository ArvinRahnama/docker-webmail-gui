import { describe, expect, it } from 'vitest';
import { isValidHostnameForDns, validateHostnameForDns } from './hostname.js';

describe('validateHostnameForDns', () => {
  it('accepts plain domains', () => {
    expect(validateHostnameForDns('example.com').ok).toBe(true);
    expect(validateHostnameForDns('mail.example.co.uk').ok).toBe(true);
    expect(validateHostnameForDns('sub-domain.example.com').ok).toBe(true);
    expect(validateHostnameForDns('xn--bcher-kva.example').ok).toBe(true); // punycode label
  });

  it('rejects empty and oversized input', () => {
    expect(validateHostnameForDns('').ok).toBe(false);
    expect(validateHostnameForDns('a'.repeat(254)).ok).toBe(false);
  });

  it('rejects a bare hostname with no TLD', () => {
    expect(validateHostnameForDns('localhost').ok).toBe(false);
  });

  it('rejects empty labels', () => {
    expect(validateHostnameForDns('.example.com').ok).toBe(false);
    expect(validateHostnameForDns('example.com.').ok).toBe(false);
    expect(validateHostnameForDns('example..com').ok).toBe(false);
  });

  it('rejects IPv4-literal "domains"', () => {
    expect(validateHostnameForDns('127.0.0.1').ok).toBe(false);
    expect(validateHostnameForDns('10.0.0.5').ok).toBe(false);
    expect(validateHostnameForDns('169.254.169.254').ok).toBe(false); // cloud metadata address shape
  });

  it.each([
    'example.com; rm -rf /',
    'example.com`id`',
    'example.com$(whoami)',
    'example.com\nX-Injected: 1',
    'example.com\r\nSet-Cookie: a=b',
    '../../etc/passwd',
    'example.com/../../secret',
    'example.com admin',
    'example.com\t',
    'javascript:alert(1)',
    'http://example.com',
    'example.com:8080',
    '<script>alert(1)</script>.com',
    'example_com.example.com'.replace('_', String.fromCharCode(0)),
  ])('rejects injection/non-hostname payload %j', (payload) => {
    const result = validateHostnameForDns(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a label starting or ending with a hyphen', () => {
    expect(validateHostnameForDns('-example.com').ok).toBe(false);
    expect(validateHostnameForDns('example-.com').ok).toBe(false);
  });

  it('isValidHostnameForDns mirrors validateHostnameForDns.ok', () => {
    expect(isValidHostnameForDns('example.com')).toBe(true);
    expect(isValidHostnameForDns('not a domain')).toBe(false);
  });
});
