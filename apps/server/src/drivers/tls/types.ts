/**
 * `TlsCertificateSourcePort` — fetches the certificate actually served on
 * a mail port, mirroring the `DnsLookupPort`/`DmsExecPort` port pattern:
 * real logic (`tls.service.ts`) depends on this interface, not a
 * concrete socket implementation, so it is testable against a fixture
 * fake with no live network (`fake-tls-source.ts`;
 * IMPLEMENTATION_PLAN.md §2.4's "No live Rspamd/ClamAV/DNS" applies
 * equally to live TLS connections here). `real-tls-source.ts` is a
 * genuine, usable-today implementation — like the DNS driver, this needs
 * no broker, since the connection originates from the Node server
 * process itself.
 *
 * Returns **DER bytes**, not PEM text: `getPeerCertificate()`'s `raw`
 * field is already DER, and `node:crypto`'s `X509Certificate` (used by
 * `cert-parser.ts`) accepts DER directly — no PEM round-trip needed.
 * Never returns anything key-shaped; there is no method here that could.
 */

export interface TlsCertificateFetchResult {
  readonly reachable: boolean;
  readonly der: Buffer | null;
  /** Safe-to-show reason when `reachable` is false or `der` is null. */
  readonly error: string | null;
}

export const STARTTLS_PROTOCOLS = ['smtp', 'imap', 'pop3'] as const;
export type StartTlsProtocol = (typeof STARTTLS_PROTOCOLS)[number];

export interface TlsCertificateSourcePort {
  /** Implicit TLS (465 SMTPS, 993 IMAPS, 995 POP3S): connect and hand back whatever certificate the TLS handshake presents. */
  fetchImplicitTlsCertificate(
    host: string,
    port: number,
    timeoutMs?: number,
  ): Promise<TlsCertificateFetchResult>;
  /** STARTTLS (25/587 SMTP, 143 IMAP, 110 POP3): speak the plaintext protocol first, then upgrade (`starttls.ts`). */
  fetchStartTlsCertificate(
    host: string,
    port: number,
    protocol: StartTlsProtocol,
    timeoutMs?: number,
  ): Promise<TlsCertificateFetchResult>;
}
