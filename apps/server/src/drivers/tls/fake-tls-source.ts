/**
 * Deterministic, in-memory {@link TlsCertificateSourcePort} — the
 * development default and every TLS module test's double, mirroring
 * `drivers/dns/fake-resolver.ts`. Opens no socket of any kind.
 */
import { X509Certificate } from 'node:crypto';
import { FIXTURE_SELF_SIGNED_CERT } from './fixtures.js';
import type {
  StartTlsProtocol,
  TlsCertificateFetchResult,
  TlsCertificateSourcePort,
} from './types.js';

function pemToDer(pem: string): Buffer {
  return new X509Certificate(pem).raw;
}

const DEFAULT_FIXTURE_DER = pemToDer(FIXTURE_SELF_SIGNED_CERT);

export class FakeTlsCertificateSource implements TlsCertificateSourcePort {
  private readonly implicitResults = new Map<string, TlsCertificateFetchResult>();
  private readonly startTlsResults = new Map<string, TlsCertificateFetchResult>();
  private defaultResult: TlsCertificateFetchResult = {
    reachable: true,
    der: DEFAULT_FIXTURE_DER,
    error: null,
  };

  /** Sets the result for every port not individually configured. */
  setDefault(result: TlsCertificateFetchResult): this {
    this.defaultResult = result;
    return this;
  }

  setImplicit(port: number, result: TlsCertificateFetchResult): this {
    this.implicitResults.set(String(port), result);
    return this;
  }

  setStartTls(port: number, protocol: StartTlsProtocol, result: TlsCertificateFetchResult): this {
    this.startTlsResults.set(`${port}:${protocol}`, result);
    return this;
  }

  async fetchImplicitTlsCertificate(
    _host: string,
    port: number,
  ): Promise<TlsCertificateFetchResult> {
    return this.implicitResults.get(String(port)) ?? this.defaultResult;
  }

  async fetchStartTlsCertificate(
    _host: string,
    port: number,
    protocol: StartTlsProtocol,
  ): Promise<TlsCertificateFetchResult> {
    return this.startTlsResults.get(`${port}:${protocol}`) ?? this.defaultResult;
  }
}

/** A result representing an unreachable port — for tests/dev exercising the degraded path. */
export function unreachableResult(reason: string): TlsCertificateFetchResult {
  return { reachable: false, der: null, error: reason };
}
