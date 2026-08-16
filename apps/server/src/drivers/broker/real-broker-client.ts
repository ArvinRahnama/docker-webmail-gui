/**
 * HTTP {@link BrokerClient} — the web tier's real path to Docker, and the
 * only one used in production (`create-broker-client.ts`). Speaks the
 * closed vocabulary from `@dwg/shared`'s `broker.ts` over `undici`, sends
 * the shared secret on every request, and validates every response
 * against the *same* schema artifact the broker validates its own output
 * against before ever sending it (ARCHITECTURE.md §3) — a malformed or
 * unexpectedly-shaped response cannot silently become "valid" data the
 * rest of the server trusts.
 */
import { request } from 'undici';
import {
  BROKER_OPS_PATH,
  BROKER_SECRET_HEADER,
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  ContainerLogsResponseSchema,
  ContainerStatsResponseSchema,
  ImageListResponseSchema,
  NetworkListResponseSchema,
  OperationAckSchema,
  SystemDfResponseSchema,
  SystemInfoResponseSchema,
  SystemPingResponseSchema,
  SystemVersionResponseSchema,
  VolumeListResponseSchema,
  type BrokerRequest,
  type ContainerInspectResponse,
  type ContainerLogLine,
  type ContainerStatsResponse,
  type ContainerSummary,
  type ImageSummary,
  type NetworkSummary,
  type SystemDfResponse,
  type SystemInfoResponse,
  type SystemPingResponse,
  type SystemVersionResponse,
  type VolumeSummary,
} from '@dwg/shared';
import type { BrokerClient, ContainerListParams, ContainerLogsParams } from './types.js';

/** Thrown for any non-2xx broker response. Carries the HTTP status and the broker's own (already-safe-to-show) message — never a raw stack trace. */
export class BrokerRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'BrokerRequestError';
    this.statusCode = statusCode;
  }
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return 'Broker request failed.';
}

export interface RealBrokerClientOptions {
  /** e.g. `http://broker:4000` — the internal-only broker network address (ARCHITECTURE.md §6). */
  readonly baseUrl: string;
  readonly sharedSecret: string;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class RealBrokerClient implements BrokerClient {
  private readonly baseUrl: string;
  private readonly sharedSecret: string;
  private readonly timeoutMs: number;

  constructor(options: RealBrokerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sharedSecret = options.sharedSecret;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(
    body: BrokerRequest,
    responseSchema: { parse(input: unknown): T },
  ): Promise<T> {
    const response = await request(`${this.baseUrl}${BROKER_OPS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BROKER_SECRET_HEADER]: this.sharedSecret,
      },
      body: JSON.stringify(body),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });

    const json: unknown = await response.body.json();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new BrokerRequestError(response.statusCode, extractErrorMessage(json));
    }

    // Never trust the broker's own response shape by assumption — parse
    // it, same as the broker parses the request it sent. A schema
    // mismatch here surfaces as a thrown ZodError, not as malformed data
    // quietly flowing into a service layer above this one.
    return responseSchema.parse(json);
  }

  async containerList(params: ContainerListParams = {}): Promise<readonly ContainerSummary[]> {
    const result = await this.call(
      { operation: 'container.list', all: params.all },
      ContainerListResponseSchema,
    );
    return result.containers;
  }

  async containerInspect(): Promise<ContainerInspectResponse> {
    return this.call({ operation: 'container.inspect' }, ContainerInspectResponseSchema);
  }

  async containerStart(): Promise<void> {
    await this.call({ operation: 'container.start' }, OperationAckSchema);
  }

  async containerStop(): Promise<void> {
    await this.call({ operation: 'container.stop' }, OperationAckSchema);
  }

  async containerRestart(): Promise<void> {
    await this.call({ operation: 'container.restart' }, OperationAckSchema);
  }

  async containerStats(): Promise<ContainerStatsResponse> {
    return this.call({ operation: 'container.stats' }, ContainerStatsResponseSchema);
  }

  async containerLogs(params: ContainerLogsParams = {}): Promise<readonly ContainerLogLine[]> {
    const result = await this.call(
      {
        operation: 'container.logs',
        tail: params.tail,
        since: params.since,
        timestamps: params.timestamps,
      },
      ContainerLogsResponseSchema,
    );
    return result.lines;
  }

  async systemPing(): Promise<SystemPingResponse> {
    return this.call({ operation: 'system.ping' }, SystemPingResponseSchema);
  }

  async systemVersion(): Promise<SystemVersionResponse> {
    return this.call({ operation: 'system.version' }, SystemVersionResponseSchema);
  }

  async systemInfo(): Promise<SystemInfoResponse> {
    return this.call({ operation: 'system.info' }, SystemInfoResponseSchema);
  }

  async systemDf(): Promise<SystemDfResponse> {
    return this.call({ operation: 'system.df' }, SystemDfResponseSchema);
  }

  async imageList(): Promise<readonly ImageSummary[]> {
    const result = await this.call({ operation: 'image.list' }, ImageListResponseSchema);
    return result.images;
  }

  async volumeList(): Promise<readonly VolumeSummary[]> {
    const result = await this.call({ operation: 'volume.list' }, VolumeListResponseSchema);
    return result.volumes;
  }

  async networkList(): Promise<readonly NetworkSummary[]> {
    const result = await this.call({ operation: 'network.list' }, NetworkListResponseSchema);
    return result.networks;
  }
}
