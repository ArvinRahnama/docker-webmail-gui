import { describe, expect, it } from 'vitest';
import {
  assertFetchableUrl,
  guardedLookup,
  isPublicAddress,
  SafeFetchError,
} from './safe-fetch.js';

describe('SSRF guard: address classification', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::169.254.169.254',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses non-https, non-default ports, credentials, IP literals and local names before any network I/O', () => {
    for (const url of [
      'http://example.com/client.json',
      'https://example.com:8443/client.json',
      'https://user:pw@example.com/client.json',
      'https://127.0.0.1/client.json',
      'https://[::1]/client.json',
      'https://localhost/client.json',
      'https://metadata/client.json',
    ]) {
      expect(() => assertFetchableUrl(new URL(url)), url).toThrow(SafeFetchError);
    }
    expect(() =>
      assertFetchableUrl(new URL('https://chatgpt.com/oauth/client.json')),
    ).not.toThrow();
  });

  it('the connection-time DNS guard refuses a name that resolves to loopback', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup('localhost', {}, (err) => resolve(err));
    });
    expect(error?.code).toBe('EDWGSSRF');
  });
});
