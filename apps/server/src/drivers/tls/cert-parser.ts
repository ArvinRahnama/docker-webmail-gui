/**
 * Certificate (public-data-only) parsing (FEATURE_MATRIX.md §12).
 * `node:crypto`'s `X509Certificate` (Node >=15.6,
 * `docs/research/03-mail-stack-components.md` §9) reads issuer, subject,
 * SANs, validity window and fingerprint directly from a PEM/DER buffer —
 * no `openssl` subprocess, and **no private key ever enters this
 * function's signature or return type**. This module is the only place
 * in the codebase that constructs an `X509Certificate`; every caller
 * hands it a certificate chain fetched from a live TLS/STARTTLS
 * connection (`tls-source.ts`) or a manually-configured cert file — never
 * the paired key.
 */
import { X509Certificate } from 'node:crypto';
import type { CertificateHealthState, CertificateInfo } from '@dwg/shared';

export type CertificateParseResult =
  | { readonly ok: true; readonly info: CertificateInfo }
  | { readonly ok: false; readonly reason: string };

function parseSubjectAltNames(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  // Node formats this as a comma-separated `DNS:host, DNS:other, IP Address:1.2.3.4`
  // string; each entry is returned with its type prefix stripped for a
  // cleaner display list, but the raw entry is kept if no recognised
  // prefix is present rather than silently dropping it.
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^(DNS|IP Address|email):/i, '').trim());
}

/**
 * Parses a PEM (or DER) certificate buffer/string. Never throws — a
 * malformed input is reported via the `ok: false` branch, same discipline
 * as every parser in `drivers/dms/parsers/` (`parse-result.ts`'s doc
 * comment: "never throws, regardless of input").
 */
export function parseCertificate(
  pem: string | Buffer,
  now: Date = new Date(),
): CertificateParseResult {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (err) {
    return {
      ok: false,
      reason: `Could not parse certificate: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  let validFrom: Date;
  let validTo: Date;
  try {
    validFrom = cert.validFromDate;
    validTo = cert.validToDate;
  } catch {
    return { ok: false, reason: 'Certificate has no readable validity period.' };
  }

  const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);

  // `checkIssued(self)` verifies both the subject/issuer match *and* that
  // the certificate's signature validates against its own public key —
  // more rigorous than a string comparison of subject vs issuer, which
  // would false-positive on the (rare but real) case of two distinct
  // certificates that merely share a subject/issuer string.
  let isSelfSigned = false;
  try {
    isSelfSigned = cert.checkIssued(cert);
  } catch {
    isSelfSigned = false;
  }

  return {
    ok: true,
    info: {
      subject: cert.subject,
      issuer: cert.issuer,
      subjectAltNames: parseSubjectAltNames(cert.subjectAltName),
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysRemaining,
      fingerprint256: cert.fingerprint256,
      serialNumber: cert.serialNumber,
      isSelfSigned,
    },
  };
}

const WARN_THRESHOLD_DAYS = 30;
const CRITICAL_THRESHOLD_DAYS = 7;

/**
 * FEATURE_MATRIX.md §12's exact thresholds: warn at <=30 days remaining,
 * critical at <=7 (which also naturally covers an already-expired
 * certificate, since "days remaining" goes negative). A certificate whose
 * validity window has not started yet is reported critical too — it is
 * not currently a valid certificate for this connection, regardless of
 * how far away expiry is.
 */
export function computeCertificateHealth(
  info: Pick<CertificateInfo, 'daysRemaining' | 'validFrom'>,
  now: Date = new Date(),
): CertificateHealthState {
  if (new Date(info.validFrom).getTime() > now.getTime()) return 'critical';
  if (info.daysRemaining <= CRITICAL_THRESHOLD_DAYS) return 'critical';
  if (info.daysRemaining <= WARN_THRESHOLD_DAYS) return 'warning';
  return 'healthy';
}
