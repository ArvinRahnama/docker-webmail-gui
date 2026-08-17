/**
 * `apps/server/src/drivers/tls` — TLS certificate diagnostics driver (M8;
 * FEATURE_MATRIX.md §12). Mirrors `drivers/dns/index.ts`'s shape.
 */
export {
  parseCertificate,
  computeCertificateHealth,
  type CertificateParseResult,
} from './cert-parser.js';
export type {
  TlsCertificateSourcePort,
  TlsCertificateFetchResult,
  StartTlsProtocol,
} from './types.js';
export { STARTTLS_PROTOCOLS } from './types.js';
export { RealTlsCertificateSource, createRealTlsCertificateSource } from './real-tls-source.js';
export { FakeTlsCertificateSource, unreachableResult } from './fake-tls-source.js';
export { createTlsCertificateSource } from './create-tls-source.js';
export {
  LineReader,
  negotiateSmtpStartTls,
  negotiateImapStartTls,
  negotiatePop3StartTls,
  type NegotiableSocket,
} from './starttls.js';
