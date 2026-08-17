import { describe, expect, it } from 'vitest';
import { computeCertificateHealth, parseCertificate } from './cert-parser.js';
import {
  FIXTURE_CA_SIGNED_CERT,
  FIXTURE_MALFORMED_CERT,
  FIXTURE_SELF_SIGNED_CERT,
} from './fixtures.js';

// Fixed "now" inside the fixtures' 2026-08-16..2028-11-18 validity window,
// so every test's day-math is deterministic regardless of when it runs.
const FIXED_NOW = new Date('2027-01-01T00:00:00Z');

describe('parseCertificate', () => {
  it('parses a real self-signed certificate', () => {
    const result = parseCertificate(FIXTURE_SELF_SIGNED_CERT, FIXED_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.subject).toContain('CN=mail.example.com');
    expect(result.info.issuer).toContain('CN=mail.example.com');
    expect(result.info.isSelfSigned).toBe(true);
    expect(result.info.subjectAltNames).toEqual([
      'mail.example.com',
      'example.com',
      'www.example.com',
    ]);
    expect(result.info.serialNumber.length).toBeGreaterThan(0);
    expect(result.info.fingerprint256.length).toBeGreaterThan(0);
  });

  it('parses a CA-signed certificate and reports isSelfSigned: false', () => {
    const result = parseCertificate(FIXTURE_CA_SIGNED_CERT, FIXED_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.subject).toContain('CN=mail.example.com');
    expect(result.info.issuer).toContain('CN=Test Root CA');
    expect(result.info.isSelfSigned).toBe(false);
  });

  it('computes daysRemaining against the given "now", not the real clock', () => {
    const result = parseCertificate(FIXTURE_SELF_SIGNED_CERT, FIXED_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // notAfter = 2028-11-18; FIXED_NOW = 2027-01-01 -> comfortably >30 days.
    expect(result.info.daysRemaining).toBeGreaterThan(300);
  });

  it('never throws on malformed input — reports ok:false with a reason', () => {
    expect(() => parseCertificate(FIXTURE_MALFORMED_CERT)).not.toThrow();
    const result = parseCertificate(FIXTURE_MALFORMED_CERT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('never throws on empty or garbage input', () => {
    expect(parseCertificate('').ok).toBe(false);
    expect(parseCertificate('not a certificate at all').ok).toBe(false);
    expect(parseCertificate('\x00\x01binary garbage\xff').ok).toBe(false);
  });

  it('the parsed result never carries a privateKey-shaped field', () => {
    const result = parseCertificate(FIXTURE_SELF_SIGNED_CERT, FIXED_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.info)).not.toContain('privateKey');
    expect(JSON.stringify(result.info)).not.toMatch(/PRIVATE KEY/);
  });
});

describe('computeCertificateHealth', () => {
  const validFrom = '2026-08-16T00:00:00.000Z';

  it('is healthy well before expiry', () => {
    expect(computeCertificateHealth({ daysRemaining: 200, validFrom })).toBe('healthy');
  });

  it('warns at exactly 30 days remaining', () => {
    expect(computeCertificateHealth({ daysRemaining: 30, validFrom })).toBe('warning');
  });

  it('is healthy at 31 days remaining (boundary)', () => {
    expect(computeCertificateHealth({ daysRemaining: 31, validFrom })).toBe('healthy');
  });

  it('is critical at exactly 7 days remaining', () => {
    expect(computeCertificateHealth({ daysRemaining: 7, validFrom })).toBe('critical');
  });

  it('is warning at 8 days remaining (boundary)', () => {
    expect(computeCertificateHealth({ daysRemaining: 8, validFrom })).toBe('warning');
  });

  it('is critical for an already-expired certificate', () => {
    expect(computeCertificateHealth({ daysRemaining: -5, validFrom })).toBe('critical');
  });

  it('is critical for a certificate not yet valid, regardless of daysRemaining', () => {
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    expect(computeCertificateHealth({ daysRemaining: 400, validFrom: future })).toBe('critical');
  });
});
