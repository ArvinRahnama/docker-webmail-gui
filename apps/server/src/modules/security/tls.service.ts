/**
 * TLS certificate status (FEATURE_MATRIX.md §12). Connects to the DMS
 * container's own mail ports (`config.dms.containerName` — a fixed,
 * operator-configured hostname, never admin-supplied per request, so
 * this is not the SSRF surface SECURITY.md §3.4 is about) and reports
 * exactly what each presents. **No Let's Encrypt issuance anywhere in
 * this file** — `acmeDocsHref` is a static link to external
 * documentation, never an outbound action this code performs.
 */
import {
  computeCertificateHealth,
  parseCertificate,
  type StartTlsProtocol,
  type TlsCertificateSourcePort,
} from '../../drivers/tls/index.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { TlsEndpointProtocol, TlsEndpointResult, TlsStatusResponse } from '@dwg/shared';

/** DMS's official SSL/ACME-integration documentation — status is shown, issuance is not performed (FEATURE_MATRIX.md §12). */
const ACME_DOCS_HREF =
  'https://docker-mailserver.github.io/docker-mailserver/latest/config/security/ssl/';

interface EndpointDefinition {
  readonly protocol: TlsEndpointProtocol;
  readonly port: number;
  readonly label: string;
  readonly kind: 'implicit' | 'starttls';
  readonly startTlsProtocol?: StartTlsProtocol;
}

/** The DMS-default-enabled mail ports (`docs/research/01-docker-mailserver.md` §9) — not an exhaustive protocol list, but the real, commonly-checked set. */
const ENDPOINTS: readonly EndpointDefinition[] = [
  {
    protocol: 'smtp-starttls',
    port: 25,
    label: 'SMTP (STARTTLS)',
    kind: 'starttls',
    startTlsProtocol: 'smtp',
  },
  {
    protocol: 'submission-starttls',
    port: 587,
    label: 'Submission (STARTTLS)',
    kind: 'starttls',
    startTlsProtocol: 'smtp',
  },
  { protocol: 'smtps', port: 465, label: 'SMTPS (implicit TLS)', kind: 'implicit' },
  { protocol: 'imaps', port: 993, label: 'IMAPS (implicit TLS)', kind: 'implicit' },
  { protocol: 'pop3s', port: 995, label: 'POP3S (implicit TLS)', kind: 'implicit' },
];

export class TlsService {
  constructor(
    private readonly dmsDriver: DmsDriver,
    private readonly source: TlsCertificateSourcePort,
    private readonly mailHost: string,
  ) {}

  async getStatus(): Promise<TlsStatusResponse> {
    const [sslType, endpoints] = await Promise.all([
      this.dmsDriver.getSslType(),
      Promise.all(ENDPOINTS.map((endpoint) => this.checkEndpoint(endpoint))),
    ]);

    return {
      sslType,
      checkedAt: new Date().toISOString(),
      endpoints,
      acmeDocsHref: ACME_DOCS_HREF,
    };
  }

  private async checkEndpoint(endpoint: EndpointDefinition): Promise<TlsEndpointResult> {
    const result =
      endpoint.kind === 'implicit'
        ? await this.source.fetchImplicitTlsCertificate(this.mailHost, endpoint.port)
        : await this.source.fetchStartTlsCertificate(
            this.mailHost,
            endpoint.port,
            // Only ever undefined for `kind: 'implicit'`, handled by the branch above.
            endpoint.startTlsProtocol ?? 'smtp',
          );

    if (!result.reachable || result.der === null) {
      return {
        protocol: endpoint.protocol,
        port: endpoint.port,
        label: endpoint.label,
        reachable: false,
        certificate: null,
        health: 'unknown',
        error: result.error ?? 'Unreachable.',
      };
    }

    const parsed = parseCertificate(result.der);
    if (!parsed.ok) {
      return {
        protocol: endpoint.protocol,
        port: endpoint.port,
        label: endpoint.label,
        reachable: true,
        certificate: null,
        health: 'unknown',
        error: parsed.reason,
      };
    }

    return {
      protocol: endpoint.protocol,
      port: endpoint.port,
      label: endpoint.label,
      reachable: true,
      certificate: parsed.info,
      health: computeCertificateHealth(parsed.info),
      error: null,
    };
  }
}
