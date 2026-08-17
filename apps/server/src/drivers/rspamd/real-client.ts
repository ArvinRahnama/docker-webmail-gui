/**
 * Real {@link RspamdClientPort}, speaking the controller's HTTP API over
 * `undici` — same library and error-shape conventions as
 * `drivers/broker/real-broker-client.ts`. Auth is the documented
 * `Password` header (`docs/research/03-mail-stack-components.md` §1);
 * `secure_ip` allow-listing (typically `127.0.0.1`, the realistic
 * container-internal path) means the password can be `null` for a
 * deployment that relies on it instead.
 *
 * `/saveactions` and `/savesymbols`' exact request-body shape is
 * `[INFERRED]` (never independently confirmed against a live controller
 * this session) — the array-of-one-object form sent here mirrors what
 * `/actions`/`/symbols` themselves are documented to return, the most
 * defensible guess absent a confirmed spec. If a real deployment expects
 * a different shape, the request fails with a non-2xx status, surfaced
 * through the same `RspamdResult` error path as any other failure —
 * never silently "succeeding" without having changed anything.
 */
import { request } from 'undici';
import type { RspamdClientPort, RspamdResult } from './types.js';

export interface RealRspamdClientOptions {
  readonly baseUrl: string;
  readonly password: string | null;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class RealRspamdClient implements RspamdClientPort {
  private readonly baseUrl: string;
  private readonly password: string | null;
  private readonly timeoutMs: number;

  constructor(options: RealRspamdClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.password = options.password;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.password ? { Password: this.password } : {}), ...extra };
  }

  private async getJson(path: string): Promise<RspamdResult<unknown>> {
    try {
      const response = await request(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
      const body: unknown = await response.body.json().catch(() => null);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { ok: false, error: `Rspamd ${path} returned HTTP ${response.statusCode}.` };
      }
      return { ok: true, value: body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Rspamd request failed.' };
    }
  }

  private async postRaw(
    path: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<RspamdResult<void>> {
    try {
      const response = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'text/plain', ...extraHeaders }),
        body,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
      await response.body.text().catch(() => '');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { ok: false, error: `Rspamd ${path} returned HTTP ${response.statusCode}.` };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Rspamd request failed.' };
    }
  }

  async getStat(): Promise<RspamdResult<unknown>> {
    return this.getJson('/stat');
  }

  async getSymbols(): Promise<RspamdResult<unknown>> {
    return this.getJson('/symbols');
  }

  async getActions(): Promise<RspamdResult<unknown>> {
    return this.getJson('/actions');
  }

  async learnSpam(message: string): Promise<RspamdResult<void>> {
    return this.postRaw('/learnspam', message);
  }

  async learnHam(message: string): Promise<RspamdResult<void>> {
    return this.postRaw('/learnham', message);
  }

  async saveActionThreshold(action: string, score: number): Promise<RspamdResult<void>> {
    return this.postRaw('/saveactions', JSON.stringify([{ action, value: score }]), {
      'content-type': 'application/json',
    });
  }

  async saveSymbolScore(symbol: string, score: number): Promise<RspamdResult<void>> {
    return this.postRaw('/savesymbols', JSON.stringify([{ name: symbol, score }]), {
      'content-type': 'application/json',
    });
  }
}

export function createRealRspamdClient(options: RealRspamdClientOptions): RspamdClientPort {
  return new RealRspamdClient(options);
}
